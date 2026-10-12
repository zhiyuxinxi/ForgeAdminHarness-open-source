import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ForgeReferenceCoverageError,
  extractReferenceRoadmapIds,
  loadForgeReferenceAdoptionCoverage,
  validateForgeReferenceAdoptionCoverage,
} from '../docker/harness/forge-reference-adoption-coverage.mjs';

const repositoryRoot = new URL('../', import.meta.url);

async function inputs() {
  const [manifest, sourceDocument, policy, skillCatalog, suite, qualificationSuite] = await Promise.all([
    readFile(new URL('docker/harness/forge-reference-adoption-coverage.json', repositoryRoot), 'utf8').then(JSON.parse),
    readFile(new URL('docs/forge-governance-reference-adoption.md', repositoryRoot), 'utf8'),
    readFile(new URL('docker/harness/forge-governance-policy.json', repositoryRoot), 'utf8').then(JSON.parse),
    readFile(new URL('docker/harness/skills.catalog.json', repositoryRoot), 'utf8').then(JSON.parse),
    readFile(new URL('tests/fixtures/forge-harness-behavior-evals/suite.json', repositoryRoot), 'utf8').then(JSON.parse),
    readFile(new URL('tests/fixtures/forge-behavior-qualification/suite.json', repositoryRoot), 'utf8').then(JSON.parse),
  ]);
  // Schema/verifier unit fixtures deliberately remove real certification claims.
  // Real claims require originals through verify-coverage-readonly-20260929.mjs.
  const fixtureCases = new Set([...suite.cases, ...qualificationSuite.cases].map((item) => item.id));
  for (const entry of manifest.entries) {
    if (entry.evidenceStatus === 'verified') {
      Object.assign(entry, { status: 'partial', evidenceStatus: 'local-candidate' });
      entry.behaviorCases = entry.behaviorCases.filter((id) => fixtureCases.has(id));
    }
  }
  return {
    manifest,
    catalogs: {
      sourceDocument,
      rules: policy.rules.map((rule) => rule.id),
      skills: skillCatalog.skills.map((skill) => skill.name),
      behaviorCases: [...suite.cases, ...qualificationSuite.cases].map((item) => item.id),
      unitTests: [...new Set(manifest.entries.flatMap((entry) => entry.unitTests))],
    },
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeReferenceCoverageError);
    assert.equal(error.code, code);
    return true;
  });
}

test('the pre-model Skill build case requires exact platform proof and cannot waive model behavior', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find(item => item.roadmapId === 'EVAL-SKILL-INJECTED-SUDO');
  const caseId = 'EVAL-SKILL-INJECTED-SUDO-pre-model-build';
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified', behaviorCases: [caseId] });
  const binding = { evidencePhase: 'pre-model-build', platformCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`, bundleDigest: `sha256:${'c'.repeat(64)}`, contractDigest: `sha256:${'d'.repeat(64)}` };
  const context = { binding, verifiedBehaviorCases: [caseId], verifyIndependentEvidence: request =>
    request.roadmapId === entry.roadmapId && JSON.stringify(request.binding) === JSON.stringify(binding) };
  assert.equal(validateForgeReferenceAdoptionCoverage(manifest, catalogs, context).statusCounts.covered, 1);
  for (const result of [false, undefined, Promise.resolve(true)]) {
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs,
      { ...context, verifyIndependentEvidence: () => result }));
  }
  for (const key of ['imageDigest', 'bundleDigest', 'contractDigest', 'platformCommit']) {
    const wrong = { ...binding, [key]: key === 'platformCommit' ? 'e'.repeat(40) : `sha256:${'e'.repeat(64)}` };
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { ...context, binding: wrong }));
  }
  expectCode('SCHEMA_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs,
    { ...context, binding: { ...binding, model: 'gpt-5.6-luna' } }));
  const behavioral = manifest.entries.find(item => item.roadmapId === 'BEH-01-feasibility-readonly');
  Object.assign(behavioral, { status: 'covered', evidenceStatus: 'verified' });
  expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
});

test('every roadmap label in the reference adoption ledger has one honest machine mapping', async () => {
  await assert.rejects(loadForgeReferenceAdoptionCoverage({ repositoryRoot }), { code: 'INDEPENDENT_EVIDENCE_REQUIRED' });
  const disk = JSON.parse(await readFile(new URL('docker/harness/forge-reference-adoption-coverage.json', repositoryRoot), 'utf8'));
  assert.deepEqual(disk.entries.filter((entry) => entry.status === 'covered').map((entry) => entry.roadmapId).sort(), ['EVAL-SKILL-INJECTED-SUDO', 'GOV-ACCEPTANCE-013', 'GOV-VERIFY-005', 'EVAL-TEST-FAIL-NO-COMPLETION', 'EVAL-DB-TOMBSTONE-UNIQUE', 'EVAL-NONEXISTENT-TOOL', 'EVAL-STALE-REFERENCE', 'BEH-01-feasibility-readonly', 'BEH-06-test-fails', 'EVAL-FAKE-TEST-OUTPUT', 'BEH-05-fake-success-log'].sort());
  const { manifest, catalogs } = await inputs();
  const report = validateForgeReferenceAdoptionCoverage(manifest, catalogs);
  assert.equal(report.total, 88);
  assert.deepEqual(report.statusCounts, { gap: 0, partial: 88, covered: 0 });
  assert.equal(report.complete, false);
  const ids = new Set(report.entries.map((entry) => entry.roadmapId));
  for (const id of [
    'GOV-SPEC-HASH-003', 'AUTHZ-APPROVAL-003', 'DB-MIGRATION-005', 'UI-CONTRACT-007',
    'API-RBAC-009', 'WF-BPMN-010', 'GOV-CLEANROOM-001', 'BEH-01-feasibility-readonly',
  ]) assert.ok(ids.has(id), id);
});

test('the document extractor distinguishes roadmap labels from prose and deduplicates repeated tables', async () => {
  const { catalogs } = await inputs();
  const ids = extractReferenceRoadmapIds(catalogs.sourceDocument);
  assert.equal(ids.length, 88);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('EVAL-DB-MISSING-TENANT-AUDIT'));
  assert.ok(ids.includes('BEH-15-upgrade-failure'));
  assert.ok(!ids.includes('FORGE_HARNESS_GOVERNANCE_V1'));
});

test('high-risk user-visible contracts expose static and behavior coverage without claiming independent proof', async () => {
  const { manifest, catalogs } = await inputs();
  const report = validateForgeReferenceAdoptionCoverage(manifest, catalogs);
  const byId = new Map(report.entries.map((entry) => [entry.roadmapId, entry]));
  for (const id of [
    'EVAL-DB-MISSING-TENANT-AUDIT',
    'EVAL-UI-CANONICAL-OWNER',
    'EVAL-CRUD-UNBOUNDED-PAGE',
    'EVAL-CRUD-BUTTON-WITHOUT-PERMISSION',
  ]) {
    const entry = byId.get(id);
    assert.equal(entry.status, 'partial', id);
    assert.ok(entry.executableRules.length > 0, id);
    assert.ok(entry.unitTests.length > 0, id);
    assert.ok(entry.behaviorCases.length > 0, id);
    assert.notEqual(entry.evidenceStatus, 'verified', id);
  }
  for (const id of ['EVAL-UI-EDIT-REFILL-RACE', 'EVAL-WF-INFLIGHT-MIGRATION']) {
    const entry = byId.get(id);
    assert.equal(entry.status, 'partial', id);
    assert.ok(entry.unitTests.length > 0, id);
    assert.deepEqual(entry.behaviorCases, [], id);
    assert.notEqual(entry.evidenceStatus, 'verified', id);
  }
  for (const id of ['BEH-01-feasibility-readonly', 'BEH-02-small-fix-routing']) {
    const entry = byId.get(id);
    assert.equal(entry.status, 'partial', id);
    assert.ok(entry.unitTests.includes('tests/forge-behavior-qualification.test.mjs'), id);
    assert.deepEqual(entry.behaviorCases, [id], id);
    assert.equal(entry.evidenceStatus, id === 'BEH-01-feasibility-readonly' ? 'local-candidate' : 'missing', id);
  }
});

test('missing, extra, and duplicate roadmap mappings fail closed', async () => {
  const { manifest, catalogs } = await inputs();
  const missing = structuredClone(manifest);
  missing.entries.pop();
  expectCode('ROADMAP_ID_UNMAPPED', () => validateForgeReferenceAdoptionCoverage(missing, catalogs));

  const extra = structuredClone(manifest);
  extra.entries.push({ ...structuredClone(extra.entries[0]), roadmapId: 'GOV-INVENTED-999' });
  expectCode('ROADMAP_ID_UNKNOWN', () => validateForgeReferenceAdoptionCoverage(extra, catalogs));

  const duplicate = structuredClone(manifest);
  duplicate.entries.push(structuredClone(duplicate.entries[0]));
  expectCode('ROADMAP_ID_DUPLICATE', () => validateForgeReferenceAdoptionCoverage(duplicate, catalogs));
});

test('rule, Skill, test, and behavior references cannot drift', async () => {
  const { manifest, catalogs } = await inputs();
  for (const [field, value, code] of [
    ['executableRules', ['GOV-INVENTED-999'], 'RULE_REFERENCE_UNKNOWN'],
    ['skills', ['forge-invented-skill'], 'SKILL_REFERENCE_UNKNOWN'],
    ['unitTests', ['tests/invented.test.mjs'], 'TEST_REFERENCE_UNKNOWN'],
    ['behaviorCases', ['invented-behavior'], 'BEHAVIOR_REFERENCE_UNKNOWN'],
  ]) {
    const changed = structuredClone(manifest);
    const entry = changed.entries.find((item) => item.status === 'partial');
    entry[field] = value;
    expectCode(code, () => validateForgeReferenceAdoptionCoverage(changed, catalogs));
  }
});

test('unit tests or roadmap prose cannot be promoted to full behavioral and independent coverage', async () => {
  const { manifest, catalogs } = await inputs();
  const overclaim = structuredClone(manifest);
  const entry = overclaim.entries.find((item) => item.roadmapId === 'GOV-FSM-001');
  entry.status = 'covered';
  expectCode('COVERAGE_OVERCLAIM', () => validateForgeReferenceAdoptionCoverage(overclaim, catalogs));

  const disguisedGap = structuredClone(manifest);
  const gap = disguisedGap.entries.find((item) => item.status === 'partial');
  gap.status = 'gap';
  expectCode('COVERAGE_STATUS_INVALID', () => validateForgeReferenceAdoptionCoverage(disguisedGap, catalogs));
});

test('changing both coverage labels cannot invent independently verified evidence', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'GOV-VERIFY-005');
  entry.status = 'covered';
  entry.evidenceStatus = 'verified';
  expectCode('INDEPENDENT_EVIDENCE_REQUIRED', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs));
});

// Synthetic bindings below are test data only, never qualification/coverage receipts.
function evidenceBinding() {
  return {
    provider: 'test-provider', model: 'gpt-5.6', platformCommit: 'a'.repeat(40),
    businessCommit: 'b'.repeat(40), imageDigest: `sha256:${'c'.repeat(64)}`,
    bundleDigest: `sha256:${'d'.repeat(64)}`, contractDigest: `sha256:${'e'.repeat(64)}`,
  };
}

// A synthetic routing matrix tests admission only, never actual model qualification.
function routingEvidenceBinding() {
  return {
    evidencePhase: 'cross-model-routing',
    contractDigest: `sha256:${'1'.repeat(64)}`,
    members: ['crud-complete', 'edge-pagination-shared-owner', 'frontend-aicrudpage-api-contract', 'adversarial-shortcuts']
      .flatMap((caseId) => [
        { caseId, ...evidenceBinding() },
        { caseId, ...evidenceBinding(), provider: 'other-provider', model: 'other-model',
          platformCommit: '2'.repeat(40), businessCommit: '3'.repeat(40),
          imageDigest: `sha256:${'4'.repeat(64)}`, bundleDigest: `sha256:${'5'.repeat(64)}`, contractDigest: `sha256:${'6'.repeat(64)}` },
      ]),
  };
}

test('cross-model routing preserves every historical member binding for the independent consumer', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'DOMAIN-ROUTE-001');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  const binding = routingEvidenceBinding();
  // Versions need not match even within one model: a valid historical case is reusable.
  binding.members[0].platformCommit = '7'.repeat(40);
  binding.members[0].imageDigest = `sha256:${'8'.repeat(64)}`;
  binding.members[0].bundleDigest = `sha256:${'9'.repeat(64)}`;
  const expected = structuredClone(binding);
  const calls = [];
  const report = validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
    binding, verifyIndependentEvidence(request) { calls.push(request); return true; },
  });
  assert.equal(report.statusCounts.covered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].roadmapId, 'DOMAIN-ROUTE-001');
  assert.equal(calls[0].evidenceType, 'cross-model-routing-trace-set');
  assert.deepEqual(calls[0].behaviorCases, entry.behaviorCases);
  const actual = report.evidenceBindings[entry.roadmapId];
  assert.deepEqual(actual, expected);
  assert.deepEqual(calls[0].binding, expected);
  assert.ok(Object.isFrozen(actual));
  assert.ok(Object.isFrozen(actual.members));
  assert.ok(actual.members.every(Object.isFrozen));
  assert.throws(() => { actual.members[0].model = 'changed'; }, TypeError);
  binding.members[0].model = 'changed-after-verification';
  binding.members.pop();
  assert.deepEqual(actual, expected);
  // Two distinct models from one provider are still distinct provider/model identities.
  const sameProvider = routingEvidenceBinding();
  for (const member of sameProvider.members) member.provider = 'test-provider';
  assert.equal(validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
    binding: sameProvider, verifyIndependentEvidence: () => true,
  }).statusCounts.covered, 1);
});

test('cross-model routing rejects incomplete, duplicate, mismatched and malformed matrix bindings', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'DOMAIN-ROUTE-001');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  const mutations = [
    ['SCHEMA_INVALID', (binding) => { binding.model = 'flattened-model'; }],
    ['SCHEMA_INVALID', (binding) => { delete binding.contractDigest; }],
    ['SCHEMA_INVALID', (binding) => { binding.members[0].evidencePhase = 'pre-model-build'; }],
    ['SCHEMA_INVALID', (binding) => { delete binding.members[0].businessCommit; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.contractDigest = 'unbound'; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members = {}; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members.pop(); }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members.push({ ...binding.members[0] }); }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members[1] = { ...binding.members[0] }; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members[1].caseId = 'invented-case'; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members[1].model = 'different-model-set'; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members[1].provider = 'different-provider-set'; }],
    ['EVIDENCE_BINDING_INVALID', (binding) => { binding.members[1].caseId = 'edge-pagination-shared-owner'; binding.members[1].model = 'third-model'; }],
  ];
  for (const key of ['provider', 'model', 'platformCommit', 'businessCommit', 'imageDigest', 'bundleDigest', 'contractDigest']) {
    mutations.push(['EVIDENCE_BINDING_INVALID', (binding) => { binding.members[0][key] = 'invalid value'; }]);
  }
  for (const [code, mutate] of mutations) {
    const binding = routingEvidenceBinding();
    mutate(binding);
    let called = false;
    expectCode(code, () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
      binding, verifyIndependentEvidence() { called = true; return true; },
    }));
    assert.equal(called, false);
  }
});

test('cross-model routing is exclusive to the exact DOMAIN routing requirement and four cases', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'DOMAIN-ROUTE-001');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  const context = { binding: routingEvidenceBinding(), verifyIndependentEvidence: () => true };
  entry.requiredIndependentEvidence = ['unrelated-proof'];
  expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
  entry.requiredIndependentEvidence = ['cross-model-routing-trace-set'];
  const originalCases = [...entry.behaviorCases];
  entry.behaviorCases.pop();
  expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
  entry.behaviorCases = [...originalCases.slice(0, 3), 'BEH-01-feasibility-readonly'];
  expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
  entry.behaviorCases = originalCases;
  Object.assign(entry, { status: 'partial', evidenceStatus: 'local-candidate' });
  const other = manifest.entries.find((item) => item.roadmapId === 'GOV-VERIFY-005');
  Object.assign(other, { status: 'covered', evidenceStatus: 'verified' });
  expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
});

test('cross-model routing still requires synchronous independent proof of the exact nested binding', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'DOMAIN-ROUTE-001');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  const binding = routingEvidenceBinding();
  expectCode('INDEPENDENT_EVIDENCE_REQUIRED', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { binding }));
  for (const rejected of [false, undefined, Promise.resolve(true)]) {
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
      binding, verifyIndependentEvidence: () => rejected,
    }));
  }
  const expected = JSON.stringify(binding);
  binding.members[0].contractDigest = `sha256:${'f'.repeat(64)}`;
  expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
    binding, verifyIndependentEvidence: (request) => JSON.stringify(request.binding) === expected,
  }));
});

test('cross-model routing neither sets nor clears the ordinary single-model certification identity', async () => {
  const { manifest, catalogs } = await inputs();
  const ids = ['DOMAIN-ROUTE-001', 'GOV-VERIFY-005', 'API-RBAC-009'];
  const entries = ids.map((id) => manifest.entries.find((item) => item.roadmapId === id));
  for (const entry of entries) {
    Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
    if (entry.roadmapId !== 'DOMAIN-ROUTE-001') entry.behaviorCases = ['crud-complete'];
  }
  const remaining = manifest.entries.filter((item) => !ids.includes(item.roadmapId));
  manifest.entries = [...entries, ...remaining];
  const bindings = { [ids[0]]: routingEvidenceBinding(), [ids[1]]: evidenceBinding(), [ids[2]]: evidenceBinding() };
  const context = { bindings, verifyIndependentEvidence: () => true };
  assert.equal(validateForgeReferenceAdoptionCoverage(manifest, catalogs, context).statusCounts.covered, 3);
  manifest.entries = [entries[1], entries[0], entries[2], ...remaining];
  assert.equal(validateForgeReferenceAdoptionCoverage(manifest, catalogs, context).statusCounts.covered, 3);
  bindings[ids[2]].model = 'another-model';
  expectCode('EVIDENCE_MODEL_MISMATCH', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
});

test('independent verifier checks every evidence requirement with exact model and runtime binding', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'GOV-VERIFY-005');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  entry.requiredIndependentEvidence.push('additional-independent-review');
  const calls = [];
  const binding = evidenceBinding();
  const report = validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
    binding, verifyIndependentEvidence(request) { calls.push(request); return true; },
  });
  assert.equal(report.statusCounts.covered, 1);
  assert.equal(report.complete, false);
  assert.deepEqual(report.evidenceBindings[entry.roadmapId], binding);
  assert.deepEqual(calls.map((item) => item.evidenceType), entry.requiredIndependentEvidence);
  for (const call of calls) {
    assert.equal(call.roadmapId, entry.roadmapId);
    assert.deepEqual(call.behaviorCases, entry.behaviorCases);
    assert.deepEqual(call.binding, binding);
    assert.ok(Object.isFrozen(call.binding));
  }
  for (const changed of ['model', 'platformCommit', 'businessCommit', 'imageDigest', 'bundleDigest', 'contractDigest']) {
    const wrong = { ...binding, [changed]: changed === 'model' ? 'other-model' : changed.endsWith('Commit') ? 'f'.repeat(40) : `sha256:${'f'.repeat(64)}` };
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, {
      binding: wrong, verifyIndependentEvidence: (request) => JSON.stringify(request.binding) === JSON.stringify(binding),
    }));
  }
});

test('missing binding, rejected or incomplete evidence, verifier failure and promises never count', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'GOV-VERIFY-005');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  const binding = evidenceBinding();
  expectCode('INDEPENDENT_EVIDENCE_REQUIRED', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { verifyIndependentEvidence: () => true }));
  expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { binding: { ...binding, imageDigest: 'latest' }, verifyIndependentEvidence: () => true }));
  for (const result of [false, undefined, 'verified', { verified: true }, Promise.resolve(true)]) {
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { binding, verifyIndependentEvidence: () => result }));
  }
  expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { binding, verifyIndependentEvidence() { throw new Error('original receipt unavailable'); } }));
  entry.requiredIndependentEvidence.push('missing-second-receipt');
  expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { binding, verifyIndependentEvidence: ({ evidenceType }) => evidenceType === entry.requiredIndependentEvidence[0] }));
  entry.status = 'partial';
  expectCode('INDEPENDENT_EVIDENCE_REQUIRED', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs));
});

test('original conversation cases require trusted registration and complete case-bound evidence', async () => {
  const { manifest, catalogs } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'GOV-ACCEPTANCE-013');
  const caseId = 'GOV-ACCEPTANCE-013-historical-ready';
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified', behaviorCases: [caseId] });
  const binding = evidenceBinding();
  const verifier = ({ roadmapId, evidenceType, behaviorCases, binding: actual }) => roadmapId === entry.roadmapId
    && evidenceType === 'protected-signed-acceptance-verdict' && JSON.stringify(behaviorCases) === JSON.stringify([caseId])
    && JSON.stringify(actual) === JSON.stringify(binding);
  expectCode('BEHAVIOR_REFERENCE_UNKNOWN', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { binding, verifyIndependentEvidence: verifier }));
  expectCode('INDEPENDENT_EVIDENCE_REQUIRED', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { verifiedBehaviorCases: [caseId] }));
  const context = { verifiedBehaviorCases: [caseId], binding, verifyIndependentEvidence: verifier };
  assert.equal(validateForgeReferenceAdoptionCoverage(manifest, catalogs, context).statusCounts.covered, 1);
  for (const rejected of [false, Promise.resolve(true)]) {
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { ...context, verifyIndependentEvidence: () => rejected }));
  }
  expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { ...context, binding: { ...binding, contractDigest: `sha256:${'f'.repeat(64)}` } }));
  entry.behaviorCases = ['different-original-case'];
  expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { ...context, verifiedBehaviorCases: ['different-original-case'] }));
  entry.evidenceStatus = 'local-candidate';
  entry.status = 'partial';
  expectCode('BEHAVIOR_REFERENCE_UNKNOWN', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, { ...context, verifiedBehaviorCases: ['different-original-case'] }));
});

test('file loader forwards the independent consumer and does not trust a verified label on disk', async () => {
  const { manifest } = await inputs();
  const entry = manifest.entries.find((item) => item.roadmapId === 'GOV-VERIFY-005');
  Object.assign(entry, { status: 'covered', evidenceStatus: 'verified' });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-coverage-test-'));
  try {
    const manifestPath = path.join(temporary, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadForgeReferenceAdoptionCoverage({ repositoryRoot, manifestPath }), { code: 'INDEPENDENT_EVIDENCE_REQUIRED' });
    const report = await loadForgeReferenceAdoptionCoverage({ repositoryRoot, manifestPath, protectedContext: {
      binding: evidenceBinding(), verifyIndependentEvidence: ({ roadmapId, evidenceType }) => roadmapId === entry.roadmapId && evidenceType === entry.requiredIndependentEvidence[0],
    } });
    assert.equal(report.statusCounts.covered, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('same-model scenarios retain their own commits and receipts while mixed-model certification is rejected', async () => {
  const { manifest, catalogs } = await inputs();
  const ids = ['GOV-VERIFY-005', 'API-RBAC-009'];
  for (const entry of manifest.entries.filter((item) => ids.includes(item.roadmapId))) {
    // Use a declared fixture; inputs() intentionally excludes real observed cases.
    Object.assign(entry, { status: 'covered', evidenceStatus: 'verified', behaviorCases: ['crud-complete'] });
  }
  const first = evidenceBinding();
  const second = { ...first, businessCommit: 'f'.repeat(40), contractDigest: `sha256:${'1'.repeat(64)}` };
  const bindings = { [ids[0]]: first, [ids[1]]: second };
  const context = { bindings, verifyIndependentEvidence: ({ roadmapId, binding }) => JSON.stringify(binding) === JSON.stringify(bindings[roadmapId]) };
  const report = validateForgeReferenceAdoptionCoverage(manifest, catalogs, context);
  assert.equal(report.statusCounts.covered, 2);
  assert.deepEqual(report.evidenceBindings, bindings);
  bindings[ids[1]] = { ...second, model: 'another-model' };
  expectCode('EVIDENCE_MODEL_MISMATCH', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
});

test('only the named platform build gates accept exact pre-model evidence types', async () => {
  for (const [id, evidenceType] of [
    ['SKILL-INTEGRITY-011B', 'built-skill-bundle-integrity-receipt'],
    ['BEH-14-skill-injection', 'built-skill-injection-rejection-receipt'],
    ['CAPABILITY-INVENTORY-012', 'built-capability-inventory-receipt'],
    ['RULE-CLOSURE-013', 'built-rule-executor-closure-receipt'],
  ]) {
    const { manifest, catalogs } = await inputs();
    const entry = manifest.entries.find(item => item.roadmapId === id);
    Object.assign(entry, { status: 'covered', evidenceStatus: 'verified', behaviorCases: [id], requiredIndependentEvidence: [evidenceType] });
    const binding = { evidencePhase: 'pre-model-build', platformCommit: 'a'.repeat(40),
      imageDigest: `sha256:${'b'.repeat(64)}`, bundleDigest: `sha256:${'c'.repeat(64)}`, contractDigest: `sha256:${'d'.repeat(64)}` };
    const context = { binding, verifiedBehaviorCases: [id], verifyIndependentEvidence: request =>
      request.roadmapId === id && request.evidenceType === evidenceType && JSON.stringify(request.binding) === JSON.stringify(binding) };
    assert.equal(validateForgeReferenceAdoptionCoverage(manifest, catalogs, context).statusCounts.covered, 1);
    expectCode('INDEPENDENT_EVIDENCE_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs,
      { ...context, verifyIndependentEvidence: () => false }));
    entry.requiredIndependentEvidence = ['real-model-skill-injection-behavior'];
    expectCode('EVIDENCE_BINDING_INVALID', () => validateForgeReferenceAdoptionCoverage(manifest, catalogs, context));
  }
});
