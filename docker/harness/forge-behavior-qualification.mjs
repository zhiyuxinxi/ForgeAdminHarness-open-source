import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NATIVE_TOOL_CALL_ID = /^call_[A-Za-z0-9_-]{1,128}(?:\|fc_[A-Za-z0-9_-]{1,128})?$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export class ForgeBehaviorQualificationError extends Error {
  constructor(code, message) { super(message); this.name = 'ForgeBehaviorQualificationError'; this.code = code; }
}
function fail(code, message) { throw new ForgeBehaviorQualificationError(code, message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`); }
function safe(value, label, pattern = SAFE) { if (typeof value !== 'string' || !pattern.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`); return value; }
function toolCallId(value) {
  if (typeof value !== 'string' || (!UUID.test(value) && !NATIVE_TOOL_CALL_ID.test(value))) fail('SCHEMA_INVALID', 'callId is invalid.');
  return value;
}
function bounded(value, label, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('SCHEMA_INVALID', `${label} is outside its allowed bound.`); return value; }
function uniqueStrings(value, label, { allowEmpty = false } = {}) { if (!Array.isArray(value) || !allowEmpty && value.length === 0 || value.some((item) => typeof item !== 'string' || !SAFE.test(item)) || new Set(value).size !== value.length) fail('SCHEMA_INVALID', `${label} is invalid.`); return [...value].sort(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function freeze(value) { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function relativePath(value, label) { if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) fail('SCHEMA_INVALID', `${label} must be a normalized repository-relative path.`); return value; }

function normalizeCase(value) {
  exact(value, ['id', 'contractVersion', 'prompt', 'promptSha256', 'taskProfile', 'phaseRole', 'expectedRouteClass', 'requiredSkillCalls', 'allowedSkillCalls', 'forbiddenSkillCalls', 'maxSkillCalls', 'mutationPolicy', 'changedPathPolicy', 'requiredOutputSections', 'designArtifactPolicy', 'requiredPassingTests', 'implementationCompletedClaim', ...(Object.hasOwn(value, 'maximumToolCalls') ? ['maximumToolCalls'] : [])], 'behavior qualification case');
  const requiredSkillCalls = uniqueStrings(value.requiredSkillCalls, 'requiredSkillCalls', { allowEmpty: true });
  const allowedSkillCalls = uniqueStrings(value.allowedSkillCalls, 'allowedSkillCalls', { allowEmpty: true });
  const forbiddenSkillCalls = uniqueStrings(value.forbiddenSkillCalls, 'forbiddenSkillCalls', { allowEmpty: true });
  if (requiredSkillCalls.some((skill) => !allowedSkillCalls.includes(skill)) || allowedSkillCalls.some((skill) => forbiddenSkillCalls.includes(skill))) fail('CASE_CONTRACT_INVALID', 'Skill allow, require, and forbid sets conflict.');
  exact(value.mutationPolicy, ['mode', 'minimumCalls', 'maximumCalls'], 'mutationPolicy');
  if (!['none', 'bounded'].includes(value.mutationPolicy.mode)) fail('SCHEMA_INVALID', 'mutationPolicy.mode is invalid.');
  const minimumCalls = bounded(value.mutationPolicy.minimumCalls, 'minimumCalls', 0, 100);
  const maximumCalls = bounded(value.mutationPolicy.maximumCalls, 'maximumCalls', 0, 100);
  if (minimumCalls > maximumCalls || value.mutationPolicy.mode === 'none' && (minimumCalls !== 0 || maximumCalls !== 0)) fail('CASE_CONTRACT_INVALID', 'mutationPolicy bounds conflict with its mode.');
  exact(value.changedPathPolicy, ['minimumPaths', 'maximumPaths'], 'changedPathPolicy');
  const minimumPaths = bounded(value.changedPathPolicy.minimumPaths, 'minimumPaths', 0, 100);
  const maximumPaths = bounded(value.changedPathPolicy.maximumPaths, 'maximumPaths', 0, 100);
  if (minimumPaths > maximumPaths) fail('CASE_CONTRACT_INVALID', 'changedPathPolicy bounds conflict.');
  if (!['none', 'forbidden'].includes(value.designArtifactPolicy) || typeof value.implementationCompletedClaim !== 'boolean') fail('SCHEMA_INVALID', 'case completion policy is invalid.');
  return freeze({
    id: safe(value.id, 'case.id'), contractVersion: safe(value.contractVersion, 'contractVersion'), prompt: relativePath(value.prompt, 'prompt'), promptSha256: safe(value.promptSha256, 'promptSha256', SHA256), taskProfile: safe(value.taskProfile, 'taskProfile'), phaseRole: safe(value.phaseRole, 'phaseRole'), expectedRouteClass: safe(value.expectedRouteClass, 'expectedRouteClass'),
    requiredSkillCalls, allowedSkillCalls, forbiddenSkillCalls, maxSkillCalls: bounded(value.maxSkillCalls, 'maxSkillCalls', 0, 50), mutationPolicy: { mode: value.mutationPolicy.mode, minimumCalls, maximumCalls }, changedPathPolicy: { minimumPaths, maximumPaths }, requiredOutputSections: uniqueStrings(value.requiredOutputSections, 'requiredOutputSections'), designArtifactPolicy: value.designArtifactPolicy, requiredPassingTests: bounded(value.requiredPassingTests, 'requiredPassingTests', 0, 100), implementationCompletedClaim: value.implementationCompletedClaim,
    ...(Object.hasOwn(value, 'maximumToolCalls') ? { maximumToolCalls: bounded(value.maximumToolCalls, 'maximumToolCalls', 0, 1000) } : {}),
  });
}

export async function loadForgeBehaviorQualificationSuite({ repositoryRoot, suitePath = 'tests/fixtures/forge-behavior-qualification/suite.json' }) {
  const root = path.resolve(repositoryRoot);
  const absoluteSuite = path.resolve(root, suitePath);
  if (!absoluteSuite.startsWith(`${root}${path.sep}`)) fail('PATH_ESCAPE', 'suitePath escapes repositoryRoot.');
  const parsed = JSON.parse(await readFile(absoluteSuite, 'utf8'));
  exact(parsed, ['schemaVersion', 'suiteType', 'suiteVersion', 'cases'], 'behavior qualification suite');
  if (parsed.schemaVersion !== 1 || parsed.suiteType !== 'forge-model/behavior-qualification-suite' || !Array.isArray(parsed.cases) || parsed.cases.length === 0) fail('SCHEMA_INVALID', 'behavior qualification suite header is invalid.');
  const cases = parsed.cases.map(normalizeCase);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) fail('CASE_ID_DUPLICATE', 'behavior qualification case IDs must be unique.');
  for (const item of cases) {
    const promptPath = path.resolve(path.dirname(absoluteSuite), item.prompt);
    if (!promptPath.startsWith(`${path.dirname(absoluteSuite)}${path.sep}`)) fail('PATH_ESCAPE', `Prompt escapes suite directory: ${item.id}`);
    if (sha256(await readFile(promptPath)) !== item.promptSha256) fail('PROMPT_INTEGRITY_INVALID', `Prompt digest mismatch: ${item.id}`);
  }
  return freeze({ schemaVersion: 1, suiteType: parsed.suiteType, suiteVersion: safe(parsed.suiteVersion, 'suiteVersion'), cases });
}

function normalizeTrace(value) {
  exact(value, ['schemaVersion', 'traceType', 'runId', 'caseId', 'taskProfile', 'phaseRole', 'promptSha256', 'skillCalls', 'toolCalls', 'routeSnapshot', 'outputSections', 'changedPaths', 'designArtifacts', 'tests', 'implementationCompletedClaim', 'attestation'], 'behavior trace');
  if (value.schemaVersion !== 1 || value.traceType !== 'forge-model/behavior-trace' || typeof value.implementationCompletedClaim !== 'boolean') fail('SCHEMA_INVALID', 'behavior trace header is invalid.');
  const skillCalls = uniqueStrings(value.skillCalls, 'skillCalls', { allowEmpty: true });
  if (!Array.isArray(value.toolCalls)) fail('SCHEMA_INVALID', 'toolCalls must be an array.');
  const toolCalls = value.toolCalls.map((item) => { exact(item, ['callId', 'category', 'toolName', 'target'], 'tool call'); if (!['read', 'mutation'].includes(item.category) || typeof item.target !== 'string' || item.target.length === 0 || item.target.length > 512 || /[\u0000-\u001f]/u.test(item.target)) fail('SCHEMA_INVALID', 'tool call is invalid.'); return { callId: toolCallId(item.callId), category: item.category, toolName: safe(item.toolName, 'toolName'), target: item.target }; });
  if (new Set(toolCalls.map((item) => item.callId)).size !== toolCalls.length) fail('SCHEMA_INVALID', 'toolCalls contain duplicate call IDs.');
  exact(value.routeSnapshot, ['routeClass', 'selectedSkills', 'fullSuiteLoaded'], 'routeSnapshot');
  if (typeof value.routeSnapshot.fullSuiteLoaded !== 'boolean') fail('SCHEMA_INVALID', 'routeSnapshot.fullSuiteLoaded is invalid.');
  const selectedSkills = uniqueStrings(value.routeSnapshot.selectedSkills, 'routeSnapshot.selectedSkills', { allowEmpty: true });
  if (!Array.isArray(value.changedPaths) || !Array.isArray(value.designArtifacts)) fail('SCHEMA_INVALID', 'changedPaths and designArtifacts must be arrays.');
  const changedPaths = value.changedPaths.map((item) => relativePath(item, 'changedPath'));
  if (new Set(changedPaths).size !== changedPaths.length) fail('SCHEMA_INVALID', 'changedPaths contain duplicates.');
  const designArtifacts = value.designArtifacts.map((item) => relativePath(item, 'designArtifact'));
  if (!Array.isArray(value.tests)) fail('SCHEMA_INVALID', 'tests must be an array.');
  const tests = value.tests.map((item) => { exact(item, ['commandSha256', 'exitCode', 'receiptId'], 'test observation'); return { commandSha256: safe(item.commandSha256, 'commandSha256', SHA256), exitCode: bounded(item.exitCode, 'exitCode', 0, 255), receiptId: safe(item.receiptId, 'receiptId') }; });
  return freeze({ schemaVersion: 1, traceType: value.traceType, runId: safe(value.runId, 'runId', UUID), caseId: safe(value.caseId, 'caseId'), taskProfile: safe(value.taskProfile, 'taskProfile'), phaseRole: safe(value.phaseRole, 'phaseRole'), promptSha256: safe(value.promptSha256, 'promptSha256', SHA256), skillCalls, toolCalls, routeSnapshot: { routeClass: safe(value.routeSnapshot.routeClass, 'routeClass'), selectedSkills, fullSuiteLoaded: value.routeSnapshot.fullSuiteLoaded }, outputSections: uniqueStrings(value.outputSections, 'outputSections', { allowEmpty: true }), changedPaths, designArtifacts, tests, implementationCompletedClaim: value.implementationCompletedClaim, attestation: value.attestation });
}

function blocked(caseContract, reasonCode) { return freeze({ status: 'blocked', caseId: caseContract.id, behaviorPassed: false, qualificationEligible: false, qualificationDenominator: 'excluded-platform-blocker', reasonCodes: [reasonCode], writerAuthorized: false }); }

export async function evaluateForgeBehaviorQualification({ caseContract, trace }, protectedContext = {}) {
  const contract = normalizeCase(caseContract);
  const observed = normalizeTrace(trace);
  if (typeof protectedContext.verifyProtectedBehaviorTrace !== 'function') return blocked(contract, 'PROTECTED_TRACE_REQUIRED');
  let verified = false;
  try { verified = await protectedContext.verifyProtectedBehaviorTrace({ caseContract: contract, trace: observed, attestation: observed.attestation }); } catch { return blocked(contract, 'PROTECTED_TRACE_VERIFICATION_FAILED'); }
  if (verified !== true) return blocked(contract, 'PROTECTED_TRACE_VERIFICATION_FAILED');
  const reasons = [];
  if (observed.caseId !== contract.id || observed.taskProfile !== contract.taskProfile || observed.phaseRole !== contract.phaseRole || observed.promptSha256 !== contract.promptSha256) reasons.push('CASE_BINDING_MISMATCH');
  if (observed.routeSnapshot.routeClass !== contract.expectedRouteClass || observed.routeSnapshot.fullSuiteLoaded || JSON.stringify(observed.routeSnapshot.selectedSkills) !== JSON.stringify(observed.skillCalls)) reasons.push('ROUTE_SNAPSHOT_INVALID');
  if (contract.requiredSkillCalls.some((skill) => !observed.skillCalls.includes(skill)) || observed.skillCalls.some((skill) => !contract.allowedSkillCalls.includes(skill)) || observed.skillCalls.some((skill) => contract.forbiddenSkillCalls.includes(skill)) || observed.skillCalls.length > contract.maxSkillCalls) reasons.push('SKILL_ROUTE_OVERLOAD');
  if (Object.hasOwn(contract, 'maximumToolCalls') && observed.toolCalls.length > contract.maximumToolCalls) reasons.push('TOOL_CALL_BOUND_VIOLATION');
  const mutationCalls = observed.toolCalls.filter((item) => item.category === 'mutation').length;
  if (mutationCalls < contract.mutationPolicy.minimumCalls || mutationCalls > contract.mutationPolicy.maximumCalls) reasons.push(contract.mutationPolicy.mode === 'none' ? 'READONLY_SIDE_EFFECT' : 'MUTATION_BOUND_VIOLATION');
  if (observed.changedPaths.length < contract.changedPathPolicy.minimumPaths || observed.changedPaths.length > contract.changedPathPolicy.maximumPaths) reasons.push('CHANGED_PATH_BOUND_VIOLATION');
  if (contract.designArtifactPolicy === 'forbidden' && observed.designArtifacts.length > 0) reasons.push('UNNECESSARY_DESIGN_ARTIFACT');
  if (contract.requiredOutputSections.some((section) => !observed.outputSections.includes(section))) reasons.push('REQUIRED_OUTPUT_SECTION_MISSING');
  if (observed.tests.filter((item) => item.exitCode === 0).length < contract.requiredPassingTests) reasons.push('PASSING_TEST_EVIDENCE_MISSING');
  if (observed.implementationCompletedClaim !== contract.implementationCompletedClaim) reasons.push('COMPLETION_CLAIM_INVALID');
  const reasonCodes = [...new Set(reasons)].sort();
  return freeze({ status: reasonCodes.length === 0 ? 'passed' : 'failed', caseId: contract.id, behaviorPassed: reasonCodes.length === 0, qualificationEligible: true, qualificationDenominator: 'included-model-behavior', reasonCodes, observedMutationCalls: mutationCalls, observedSkillCalls: observed.skillCalls.length, observedChangedPaths: observed.changedPaths.length, writerAuthorized: false });
}
