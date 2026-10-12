#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(DIRECTORY, 'forge-reference-adoption-coverage.json');
const SAFE_ID = /^(?:EVAL|BEH|GOV|DOMAIN|AUTHZ|DB|API|UI|CRUD|WF|QUERY|SKILL|CAPABILITY|RULE)-[A-Za-z0-9-]+$/u;
const SAFE_RULE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const EVIDENCE_BINDING_KEYS = new Set([
  'provider', 'model', 'platformCommit', 'businessCommit', 'imageDigest', 'bundleDigest', 'contractDigest',
]);
const PRE_MODEL_BINDING_KEYS = new Set([
  'evidencePhase', 'platformCommit', 'imageDigest', 'bundleDigest', 'contractDigest',
]);
const CROSS_MODEL_BINDING_KEYS = new Set(['evidencePhase', 'contractDigest', 'members']);
const CROSS_MODEL_MEMBER_KEYS = new Set(['caseId', ...EVIDENCE_BINDING_KEYS]);
const CROSS_MODEL_ROUTING_CASES = new Set([
  'crud-complete', 'edge-pagination-shared-owner', 'frontend-aicrudpage-api-contract', 'adversarial-shortcuts',
]);
const PRE_MODEL_EVIDENCE = new Map([
  ['EVAL-SKILL-INJECTED-SUDO', 'built-skill-injection-rejection-receipt'],
  ['SKILL-INTEGRITY-011B', 'built-skill-bundle-integrity-receipt'],
  ['BEH-14-skill-injection', 'built-skill-injection-rejection-receipt'],
  ['CAPABILITY-INVENTORY-012', 'built-capability-inventory-receipt'],
  ['RULE-CLOSURE-013', 'built-rule-executor-closure-receipt'],
]);
const ENTRY_KEYS = new Set([
  'roadmapId', 'kind', 'status', 'skills', 'executableRules', 'unitTests', 'behaviorCases',
  'requiredIndependentEvidence', 'evidenceStatus',
]);

export class ForgeReferenceCoverageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeReferenceCoverageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeReferenceCoverageError(code, message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SCHEMA_INVALID', `${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`);
}

function uniqueStrings(value, pattern, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !pattern.test(item))) {
    fail('SCHEMA_INVALID', `${label} must contain only valid strings.`);
  }
  if (new Set(value).size !== value.length) fail('SCHEMA_INVALID', `${label} contains duplicates.`);
  return value;
}

export function extractReferenceRoadmapIds(source) {
  if (typeof source !== 'string' || source.length === 0) fail('SOURCE_INVALID', 'Reference adoption source is empty.');
  const ids = [];
  for (const match of source.matchAll(/`((?:EVAL|BEH|GOV|DOMAIN|AUTHZ|DB|API|UI|CRUD|WF|QUERY|SKILL|CAPABILITY|RULE)-[A-Za-z0-9-]+)`/gu)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  if (ids.length === 0) fail('SOURCE_INVALID', 'Reference adoption source contains no roadmap identifiers.');
  return Object.freeze(ids);
}

function expectedKind(id) {
  if (id.startsWith('EVAL-')) return 'evaluation';
  if (id.startsWith('BEH-')) return 'behavior';
  return 'gate';
}

function validateEvidenceIdentity(binding, preModel = false) {
  if ((preModel ? typeof binding.platformCommit !== 'string' || !COMMIT.test(binding.platformCommit) : typeof binding.provider !== 'string' || !SAFE_NAME.test(binding.provider)
      || typeof binding.model !== 'string' || !SAFE_NAME.test(binding.model)
      || ![binding.platformCommit, binding.businessCommit].every((value) => typeof value === 'string' && COMMIT.test(value)))
      || ![binding.imageDigest, binding.bundleDigest, binding.contractDigest].every((value) => typeof value === 'string' && DIGEST.test(value))) {
    fail('EVIDENCE_BINDING_INVALID', 'Independent evidence must bind actual execution identity, commits, image, bundle and contract.');
  }
}

function crossModelRoutingBinding(entry, binding) {
  exactKeys(binding, CROSS_MODEL_BINDING_KEYS, 'cross-model routing evidence binding');
  if (entry.roadmapId !== 'DOMAIN-ROUTE-001'
      || JSON.stringify(entry.requiredIndependentEvidence) !== JSON.stringify(['cross-model-routing-trace-set'])
      || entry.behaviorCases.length !== CROSS_MODEL_ROUTING_CASES.size
      || entry.behaviorCases.some((caseId) => !CROSS_MODEL_ROUTING_CASES.has(caseId))) {
    fail('EVIDENCE_BINDING_INVALID', 'Cross-model routing evidence is limited to DOMAIN-ROUTE-001 and its four routing cases.');
  }
  if (typeof binding.contractDigest !== 'string' || !DIGEST.test(binding.contractDigest)
      || !Array.isArray(binding.members) || binding.members.length !== 8) {
    fail('EVIDENCE_BINDING_INVALID', 'Cross-model routing evidence requires a contract digest and eight case/model members.');
  }
  const modelsByCase = new Map([...CROSS_MODEL_ROUTING_CASES].map((caseId) => [caseId, new Set()]));
  for (const member of binding.members) {
    exactKeys(member, CROSS_MODEL_MEMBER_KEYS, 'cross-model routing evidence member');
    validateEvidenceIdentity(member);
    const models = modelsByCase.get(member.caseId);
    const model = JSON.stringify([member.provider, member.model]);
    if (!models || models.has(model)) {
      fail('EVIDENCE_BINDING_INVALID', 'Cross-model routing evidence has an unknown case or duplicate case/model member.');
    }
    models.add(model);
  }
  const expectedModels = modelsByCase.values().next().value;
  for (const models of modelsByCase.values()) {
    if (models.size !== 2 || [...models].some((model) => !expectedModels.has(model))) {
      fail('EVIDENCE_BINDING_INVALID', 'Each routing case must bind the same two distinct provider/model identities.');
    }
  }
  return Object.freeze({ ...binding, members: Object.freeze(binding.members.map((member) => Object.freeze({ ...member }))) });
}

// protectedContext belongs to the independent evidence consumer, never the manifest/model.
// Its verifier must check original evidence (including issuer/role, integrity, outcome and
// applicability) against this exact binding. A status label or a receipt hash alone is not proof.
// Verification is synchronous here; consumers must finish any I/O/signature checks beforehand.
function verifyIndependentEvidence(entry, protectedContext) {
  const binding = protectedContext.bindings?.[entry.roadmapId] ?? protectedContext.binding;
  if (typeof protectedContext.verifyIndependentEvidence !== 'function' || !binding) {
    fail('INDEPENDENT_EVIDENCE_REQUIRED', `${entry.roadmapId} requires an independent evidence verifier and explicit target binding.`);
  }
  // PRO-11/12/13 require actual Skill, inventory and executor build evidence.
  // Do not invent a provider/model or business commit for these platform build checks.
  const preModel = binding.evidencePhase === 'pre-model-build';
  const crossModel = binding.evidencePhase === 'cross-model-routing';
  let verifiedBinding;
  if (crossModel) {
    verifiedBinding = crossModelRoutingBinding(entry, binding);
  } else {
    exactKeys(binding, preModel ? PRE_MODEL_BINDING_KEYS : EVIDENCE_BINDING_KEYS, 'independent evidence binding');
    if (preModel && (!PRE_MODEL_EVIDENCE.has(entry.roadmapId)
        || JSON.stringify(entry.requiredIndependentEvidence) !== JSON.stringify([PRE_MODEL_EVIDENCE.get(entry.roadmapId)]))) {
      fail('EVIDENCE_BINDING_INVALID', 'Pre-model build evidence cannot replace this roadmap item\'s actual model behavior.');
    }
    validateEvidenceIdentity(binding, preModel);
    verifiedBinding = Object.freeze({ ...binding });
  }
  for (const evidenceType of entry.requiredIndependentEvidence) {
    let verified = false;
    try {
      verified = protectedContext.verifyIndependentEvidence(Object.freeze({
        roadmapId: entry.roadmapId,
        evidenceType,
        behaviorCases: Object.freeze([...entry.behaviorCases]),
        binding: verifiedBinding,
      }));
    } catch {
      fail('INDEPENDENT_EVIDENCE_INVALID', `${entry.roadmapId}: independent verification failed for ${evidenceType}.`);
    }
    if (verified !== true) {
      fail('INDEPENDENT_EVIDENCE_INVALID', `${entry.roadmapId}: ${evidenceType} was not independently verified under the target binding.`);
    }
  }
  return verifiedBinding;
}

export function validateForgeReferenceAdoptionCoverage(manifest, catalogs, protectedContext = {}) {
  exactKeys(manifest, new Set(['schemaVersion', 'sourceDocument', 'entries']), 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.sourceDocument !== 'docs/forge-governance-reference-adoption.md'
      || !Array.isArray(manifest.entries)) fail('SCHEMA_INVALID', 'Reference adoption coverage manifest header is invalid.');
  const sourceIds = extractReferenceRoadmapIds(catalogs?.sourceDocument);
  const sourceSet = new Set(sourceIds);
  const ruleSet = new Set(catalogs?.rules ?? []);
  const skillSet = new Set(catalogs?.skills ?? []);
  const behaviorSet = new Set(catalogs?.behaviorCases ?? []);
  // A real conversation need not be replayed as a fixture. Only the trusted
  // evidence consumer may register its observed case, after verifying the
  // original contract/behavior. This never substitutes for per-entry proof.
  const observedBehaviorSet = new Set(uniqueStrings(protectedContext.verifiedBehaviorCases ?? [], SAFE_NAME, 'verifiedBehaviorCases'));
  const testSet = new Set(catalogs?.unitTests ?? []);
  const seen = new Set();
  const statusCounts = { gap: 0, partial: 0, covered: 0 };
  const evidenceBindings = {};
  let verifiedModel;

  for (const entry of manifest.entries) {
    exactKeys(entry, ENTRY_KEYS, 'coverage entry');
    if (typeof entry.roadmapId !== 'string' || !SAFE_ID.test(entry.roadmapId)) fail('SCHEMA_INVALID', 'roadmapId is invalid.');
    if (seen.has(entry.roadmapId)) fail('ROADMAP_ID_DUPLICATE', `Duplicate roadmap id: ${entry.roadmapId}`);
    seen.add(entry.roadmapId);
    if (!sourceSet.has(entry.roadmapId)) fail('ROADMAP_ID_UNKNOWN', `Manifest contains an unknown roadmap id: ${entry.roadmapId}`);
    if (entry.kind !== expectedKind(entry.roadmapId)) fail('SCHEMA_INVALID', `Roadmap kind is invalid: ${entry.roadmapId}`);
    if (!['gap', 'partial', 'covered'].includes(entry.status)) fail('SCHEMA_INVALID', `Coverage status is invalid: ${entry.roadmapId}`);
    uniqueStrings(entry.skills, SAFE_NAME, `${entry.roadmapId}.skills`);
    uniqueStrings(entry.executableRules, SAFE_RULE, `${entry.roadmapId}.executableRules`);
    uniqueStrings(entry.unitTests, SAFE_PATH, `${entry.roadmapId}.unitTests`);
    uniqueStrings(entry.behaviorCases, SAFE_NAME, `${entry.roadmapId}.behaviorCases`);
    uniqueStrings(entry.requiredIndependentEvidence, SAFE_NAME, `${entry.roadmapId}.requiredIndependentEvidence`);
    if (entry.requiredIndependentEvidence.length === 0 || !['missing', 'local-candidate', 'verified'].includes(entry.evidenceStatus)) {
      fail('SCHEMA_INVALID', `${entry.roadmapId} must state its independent evidence requirement and status.`);
    }
    for (const skill of entry.skills) if (!skillSet.has(skill)) fail('SKILL_REFERENCE_UNKNOWN', `${entry.roadmapId} references unknown Skill: ${skill}`);
    for (const rule of entry.executableRules) if (!ruleSet.has(rule)) fail('RULE_REFERENCE_UNKNOWN', `${entry.roadmapId} references unknown executable rule: ${rule}`);
    for (const test of entry.unitTests) if (!testSet.has(test)) fail('TEST_REFERENCE_UNKNOWN', `${entry.roadmapId} references unknown unit test: ${test}`);
    for (const behavior of entry.behaviorCases) {
      if (!behaviorSet.has(behavior) && !(entry.evidenceStatus === 'verified' && observedBehaviorSet.has(behavior))) {
        fail('BEHAVIOR_REFERENCE_UNKNOWN', `${entry.roadmapId} references unknown behavior case: ${behavior}`);
      }
    }

    const executable = entry.executableRules.length > 0 || entry.unitTests.length > 0;
    if (entry.status === 'gap' && (executable || entry.behaviorCases.length > 0 || entry.evidenceStatus !== 'missing')) {
      fail('COVERAGE_STATUS_INVALID', `${entry.roadmapId} is labeled gap but claims executable or observed coverage.`);
    }
    if (entry.status === 'partial' && !executable && entry.behaviorCases.length === 0 && entry.evidenceStatus === 'missing') {
      fail('COVERAGE_STATUS_INVALID', `${entry.roadmapId} is labeled partial without any machine mapping.`);
    }
    if (entry.status === 'covered' && (!executable || entry.behaviorCases.length === 0
        || entry.evidenceStatus !== 'verified')) {
      fail('COVERAGE_OVERCLAIM', `${entry.roadmapId} cannot be covered without executable, behavior, and verified independent evidence.`);
    }
    if (entry.evidenceStatus === 'verified') {
      const binding = verifyIndependentEvidence(entry, protectedContext);
      if (binding.evidencePhase !== 'pre-model-build' && binding.evidencePhase !== 'cross-model-routing') {
        const model = JSON.stringify([binding.provider, binding.model]);
        if (verifiedModel && verifiedModel !== model) {
          fail('EVIDENCE_MODEL_MISMATCH', 'Coverage from different providers/models cannot form one model certification.');
        }
        verifiedModel = model;
      }
      evidenceBindings[entry.roadmapId] = binding;
    }
    statusCounts[entry.status] += 1;
  }

  const missing = sourceIds.filter((id) => !seen.has(id));
  if (missing.length > 0) fail('ROADMAP_ID_UNMAPPED', `Roadmap ids are missing from the manifest: ${missing.join(', ')}`);
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    sourceDocument: manifest.sourceDocument,
    total: manifest.entries.length,
    statusCounts: Object.freeze(statusCounts),
    complete: statusCounts.gap === 0 && statusCounts.partial === 0,
    evidenceBindings: Object.freeze(evidenceBindings),
    entries: Object.freeze(manifest.entries.map((entry) => Object.freeze(structuredClone(entry)))),
  });
}

export async function loadForgeReferenceAdoptionCoverage(options = {}) {
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST;
  const repositoryRoot = options.repositoryRoot instanceof URL
    ? fileURLToPath(options.repositoryRoot)
    : options.repositoryRoot ?? path.resolve(DIRECTORY, '..', '..');
  const [manifest, sourceDocument, policy, skillCatalog, suite, qualificationSuite] = await Promise.all([
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'docs', 'forge-governance-reference-adoption.md'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docker', 'harness', 'forge-governance-policy.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'docker', 'harness', 'skills.catalog.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'tests', 'fixtures', 'forge-harness-behavior-evals', 'suite.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'tests', 'fixtures', 'forge-behavior-qualification', 'suite.json'), 'utf8').then(JSON.parse),
  ]);
  const unitTests = [...new Set(manifest.entries.flatMap((entry) => entry.unitTests))];
  await Promise.all(unitTests.map(async (relative) => {
    try { await access(path.join(repositoryRoot, relative)); } catch { fail('TEST_REFERENCE_UNKNOWN', `Unit test does not exist: ${relative}`); }
  }));
  return validateForgeReferenceAdoptionCoverage(manifest, {
    sourceDocument,
    rules: policy.rules.map((rule) => rule.id),
    skills: skillCatalog.skills.map((skill) => skill.name),
    behaviorCases: [...suite.cases, ...qualificationSuite.cases].map((item) => item.id),
    unitTests,
  }, options.protectedContext);
}
