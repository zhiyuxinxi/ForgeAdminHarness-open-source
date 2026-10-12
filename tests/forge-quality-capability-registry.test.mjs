import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';
import {
  ForgeQualityCapabilityRegistryError,
  loadCurrentForgeQualityCapabilityRegistry,
  validateForgeQualityCapabilityRegistry,
} from '../docker/harness/forge-quality-capability-registry.mjs';

const root = new URL('../docker/harness/', import.meta.url);

async function currentInputs() {
  const [registry, governancePolicy, skillCatalog] = await Promise.all([
    readFile(new URL('forge-quality-capability-registry.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('forge-governance-policy.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('skills.catalog.json', root), 'utf8').then(JSON.parse),
  ]);
  return {
    registry,
    catalogs: {
      governancePolicy,
      skillCatalog,
      verificationProfiles: [...VERIFY_PROFILE_NAMES],
    },
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeQualityCapabilityRegistryError);
    assert.equal(error.code, code);
    return true;
  });
}

test('current registry validates against the live policy, Skill catalog, and typed profile catalog', async () => {
  const report = await loadCurrentForgeQualityCapabilityRegistry();
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.coverage.requirements, 9);
  assert.equal(report.coverage.acceptanceCriteria, 9);
  assert.equal(report.coverage.excludedCriteria, 1);
  assert.equal(report.coverageEdges.length, 8);
  assert.equal(report.structuredGaps.length, 39);
  assert.equal(report.coverage.total, 42);
  assert.deepEqual(report.coverage.statusCounts, { enforced: 3, partial: 37, planned: 2 });
  assert.deepEqual(report.coverage.proofLevelCounts, {
    static: 3,
    semantic: 11,
    runtime: 19,
    independent: 9,
  });
  assert.equal(report.coverage.complete, false);
  assert.equal(report.blockingGaps.length, 39);
  assert.ok(Object.isFrozen(report));
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('registry covers every requested database/backend quality area and frontend quality area', async () => {
  const report = await loadCurrentForgeQualityCapabilityRegistry();
  const ids = new Set(report.capabilities.map((capability) => capability.capabilityId));
  for (const expected of [
    'database.audit-columns',
    'database.soft-delete',
    'database.tenant-isolation',
    'database.index-design',
    'database.migration',
    'backend.entity-dto',
    'backend.layering',
    'backend.utility-ownership',
    'backend.pagination',
    'backend.permission',
    'backend.idempotency',
    'backend.transaction',
    'backend.error-contract',
    'observability.logging',
    'quality.testing',
    'frontend.canonical-components',
    'frontend.api',
    'frontend.permission',
    'frontend.long-id',
    'frontend.dictionary',
    'frontend.forms',
    'frontend.table',
    'frontend.tokens',
    'frontend.responsive',
    'frontend.accessibility',
    'frontend.states',
    'frontend.danger-actions',
    'frontend.upload',
    'frontend.browser-visual',
    'security.authorization',
    'workflow.state-machine',
    'ops.controlled-verification',
    'ops.controlled-release',
    'database.table-baseline',
    'backend.crud-http-contract',
    'frontend.menu-view-binding',
    'frontend.shared-component-ownership',
    'governance.project-task-context',
    'delivery.requirement-acceptance-orchestration',
    'delivery.phase-work-package',
  ]) assert.ok(ids.has(expected), expected);
  assert.equal(report.coverage.domains.frontend.total, 16);
  assert.ok(report.coverage.domains.database.total >= 5);
  assert.ok(report.coverage.domains.backend.total >= 8);
  assert.ok(report.coverage.domains.security.total >= 1);
  assert.ok(report.coverage.domains.workflow.total >= 1);
  assert.ok(report.coverage.domains.ops.total >= 1);
  assert.equal(report.coverage.domains.delivery.total, 2);
});

test('every capability exposes exact references, proof level, status, and an honest gap shape', async () => {
  const report = await loadCurrentForgeQualityCapabilityRegistry();
  for (const capability of report.capabilities) {
    assert.ok(capability.requiredSkills.length > 0, capability.capabilityId);
    assert.equal(new Set(capability.requiredSkills).size, capability.requiredSkills.length);
    assert.equal(new Set(capability.ruleIds).size, capability.ruleIds.length);
    assert.equal(new Set(capability.verificationProfiles).size, capability.verificationProfiles.length);
    if (capability.status === 'enforced') {
      assert.ok(capability.ruleIds.length > 0, capability.capabilityId);
      assert.ok(capability.verificationProfiles.length > 0, capability.capabilityId);
      assert.equal(capability.gap, null, capability.capabilityId);
    } else {
      assert.equal(typeof capability.gap, 'string', capability.capabilityId);
      assert.ok(capability.gap.length > 0, capability.capabilityId);
    }
  }
});

test('frontend capabilities bind the fixed lint and typecheck profiles without treating either as semantic proof', async () => {
  const report = await loadCurrentForgeQualityCapabilityRegistry();
  const canonical = report.capabilities.find((item) => item.capabilityId === 'frontend.canonical-components');
  const api = report.capabilities.find((item) => item.capabilityId === 'frontend.api');
  assert.ok(VERIFY_PROFILE_NAMES.includes('frontend-admin-lint'));
  assert.ok(VERIFY_PROFILE_NAMES.includes('frontend-admin-typecheck'));
  assert.ok(canonical.verificationProfiles.includes('frontend-admin-lint'));
  assert.ok(canonical.verificationProfiles.includes('frontend-admin-typecheck'));
  assert.ok(api.verificationProfiles.includes('frontend-admin-lint'));
  assert.ok(api.verificationProfiles.includes('frontend-admin-test'));
  assert.ok(api.verificationProfiles.includes('frontend-admin-typecheck'));
  const longId = report.capabilities.find((item) => item.capabilityId === 'frontend.long-id');
  assert.ok(longId.verificationProfiles.includes('frontend-admin-typecheck'));
});

test('rule reference drift fails closed', async () => {
  const { registry, catalogs } = await currentInputs();
  const drifted = structuredClone(registry);
  drifted.capabilities[0].ruleIds = ['DB-SCHEMA-REMOVED'];
  expectCode('QUALITY_RULE_REFERENCE_MISSING', () => validateForgeQualityCapabilityRegistry(drifted, catalogs));
});

test('Skill reference drift fails closed', async () => {
  const { registry, catalogs } = await currentInputs();
  const drifted = structuredClone(registry);
  drifted.capabilities[0].requiredSkills = ['forge-missing-domain-skill'];
  expectCode('QUALITY_SKILL_REFERENCE_MISSING', () => validateForgeQualityCapabilityRegistry(drifted, catalogs));
});

test('verification profile reference drift fails closed', async () => {
  const { registry, catalogs } = await currentInputs();
  const drifted = structuredClone(registry);
  drifted.capabilities[0].verificationProfiles = ['database-migration-runtime-removed'];
  expectCode('QUALITY_PROFILE_REFERENCE_MISSING', () => validateForgeQualityCapabilityRegistry(drifted, catalogs));
});

test('catalog entries cannot exist without a consuming capability', async () => {
  const { registry, catalogs } = await currentInputs();
  const orphanRule = structuredClone(registry);
  orphanRule.capabilities.find((item) => item.capabilityId === 'database.table-baseline').ruleIds = [];
  expectCode('QUALITY_RULE_ORPHANED', () => validateForgeQualityCapabilityRegistry(orphanRule, catalogs));

  const orphanSkill = structuredClone(registry);
  orphanSkill.capabilities.find((item) => item.capabilityId === 'governance.project-task-context').requiredSkills = [
    'forge-taskspace-collaboration', 'forge-task-contract', 'forge-task-router',
  ];
  expectCode('QUALITY_SKILL_ORPHANED', () => validateForgeQualityCapabilityRegistry(orphanSkill, catalogs));

  const orphanProfile = structuredClone(registry);
  orphanProfile.capabilities.find((item) => item.capabilityId === 'backend.crud-http-contract').verificationProfiles = [
    'governance', 'backend-module-test',
  ];
  expectCode('QUALITY_PROFILE_ORPHANED', () => validateForgeQualityCapabilityRegistry(orphanProfile, catalogs));
});

test('an enforced claim without both a rule and a verification profile is rejected', async () => {
  const { registry, catalogs } = await currentInputs();
  const falseClaim = structuredClone(registry);
  const capability = falseClaim.capabilities.find((item) => item.capabilityId === 'frontend.browser-visual');
  capability.status = 'enforced';
  capability.gap = null;
  capability.ruleIds = [];
  capability.verificationProfiles = [];
  expectCode('QUALITY_FALSE_ENFORCED', () => validateForgeQualityCapabilityRegistry(falseClaim, catalogs));
});

test('an enforced claim cannot hide a declared gap', async () => {
  const { registry, catalogs } = await currentInputs();
  const falseClaim = structuredClone(registry);
  const capability = falseClaim.capabilities.find((item) => item.capabilityId === 'frontend.browser-visual');
  capability.status = 'enforced';
  expectCode('QUALITY_FALSE_ENFORCED', () => validateForgeQualityCapabilityRegistry(falseClaim, catalogs));
});

test('runtime proof cannot rely only on governance or changed-safe static profiles', async () => {
  const { registry, catalogs } = await currentInputs();
  for (const profiles of [['governance'], ['changed-safe'], ['governance', 'changed-safe']]) {
    const falseRuntime = structuredClone(registry);
    const capability = falseRuntime.capabilities.find((item) => item.capabilityId === 'backend.transaction');
    capability.verificationProfiles = profiles;
    expectCode('QUALITY_RUNTIME_PROFILE_MISSING', () => validateForgeQualityCapabilityRegistry(falseRuntime, catalogs));
  }
});

test('partial and planned capabilities must state a concrete gap', async () => {
  const { registry, catalogs } = await currentInputs();
  const missingGap = structuredClone(registry);
  const capability = missingGap.capabilities.find((item) => item.capabilityId === 'database.migration');
  capability.gap = null;
  expectCode('QUALITY_GAP_REQUIRED', () => validateForgeQualityCapabilityRegistry(missingGap, catalogs));
});

test('current gaps remain visible instead of reporting full quality coverage', async () => {
  const report = await loadCurrentForgeQualityCapabilityRegistry();
  const gaps = new Map(report.blockingGaps.map((item) => [item.capabilityId, item]));
  assert.match(gaps.get('database.migration').gap, /empty-schema.*previous-version MySQL/iu);
  assert.equal(gaps.get('frontend.browser-visual').status, 'planned');
  assert.match(gaps.get('frontend.browser-visual').gap, /browser visual-regression/iu);
  assert.match(gaps.get('workflow.state-machine').gap, /real-Flowable/iu);
  assert.match(gaps.get('ops.controlled-release').gap, /do not prove Broker promotion/iu);
  for (const capability of report.capabilities.filter((item) => item.status === 'enforced')) {
    assert.ok(!gaps.has(capability.capabilityId), capability.capabilityId);
  }
});

test('duplicate capability identifiers and unsupported fields fail closed', async () => {
  const { registry, catalogs } = await currentInputs();
  const duplicate = structuredClone(registry);
  duplicate.capabilities.push(structuredClone(duplicate.capabilities[0]));
  expectCode('QUALITY_CAPABILITY_DUPLICATE', () => validateForgeQualityCapabilityRegistry(duplicate, catalogs));

  const unsupported = structuredClone(registry);
  unsupported.capabilities[0].fullyCovered = true;
  expectCode('QUALITY_REGISTRY_UNSUPPORTED_FIELD', () => validateForgeQualityCapabilityRegistry(unsupported, catalogs));
});

test('every non-excluded acceptance criterion has one graph edge and every capability has one consumer', async () => {
  const report = await loadCurrentForgeQualityCapabilityRegistry();
  const criteria = report.requirements.flatMap((requirement) => requirement.acceptanceCriteria);
  const edgeByCriterion = new Map(report.coverageEdges.map((edge) => [edge.criterionId, edge]));
  const consumed = report.coverageEdges.flatMap((edge) => edge.capabilityIds);
  for (const criterion of criteria.filter((item) => !item.excluded)) {
    const edge = edgeByCriterion.get(criterion.criterionId);
    assert.ok(edge, criterion.criterionId);
    assert.ok(edge.capabilityIds.length > 0, criterion.criterionId);
    assert.ok(edge.evidenceContractIds.length > 0, criterion.criterionId);
  }
  assert.equal(consumed.length, report.capabilities.length);
  assert.equal(new Set(consumed).size, report.capabilities.length);
});

test('criterion and capability orphans fail closed', async () => {
  const { registry, catalogs } = await currentInputs();
  const uncoveredCriterion = structuredClone(registry);
  uncoveredCriterion.requirements[0].acceptanceCriteria.push({
    criterionId: 'AC-DATABASE-UNROUTED',
    statement: 'A new criterion must be covered or explicitly excluded.',
    excluded: false,
  });
  expectCode('QUALITY_CRITERION_UNCOVERED', () => validateForgeQualityCapabilityRegistry(uncoveredCriterion, catalogs));

  const orphanCapability = structuredClone(registry);
  orphanCapability.coverageEdges.find((edge) => edge.criterionId === 'AC-BACKEND').capabilityIds =
    orphanCapability.coverageEdges.find((edge) => edge.criterionId === 'AC-BACKEND').capabilityIds
      .filter((id) => id !== 'backend.transaction');
  expectCode('QUALITY_CAPABILITY_ORPHANED', () => validateForgeQualityCapabilityRegistry(orphanCapability, catalogs));
});

test('coverage evidence must match each capability proof level', async () => {
  const { registry, catalogs } = await currentInputs();
  const missingRuntime = structuredClone(registry);
  const edge = missingRuntime.coverageEdges.find((item) => item.criterionId === 'AC-WORKFLOW');
  edge.evidenceContractIds = ['evidence-semantic-review'];
  expectCode('QUALITY_CAPABILITY_EVIDENCE_MISMATCH', () => validateForgeQualityCapabilityRegistry(missingRuntime, catalogs));
});

test('routing profile references and routed Skill closure fail closed on drift', async () => {
  const { registry, catalogs } = await currentInputs();
  const missingCatalogProfile = structuredClone(registry);
  missingCatalogProfile.routingProfiles[0].verificationProfiles = ['removed-profile'];
  expectCode('QUALITY_ROUTING_PROFILE_REFERENCE_MISSING', () =>
    validateForgeQualityCapabilityRegistry(missingCatalogProfile, catalogs));

  const missingSkill = structuredClone(registry);
  const route = missingSkill.routingProfiles.find((item) => item.routingProfileId === 'route-frontend');
  route.requiredSkills = route.requiredSkills.filter((skill) => skill !== 'forge-evidence-truth');
  expectCode('QUALITY_ROUTING_SKILL_INCOMPLETE', () => validateForgeQualityCapabilityRegistry(missingSkill, catalogs));
});

test('every partial or planned capability has one exact structured gap', async () => {
  const { registry, catalogs } = await currentInputs();
  const missing = structuredClone(registry);
  missing.structuredGaps = missing.structuredGaps.filter((gap) => gap.capabilityId !== 'backend.transaction');
  expectCode('QUALITY_STRUCTURED_GAP_MISSING', () => validateForgeQualityCapabilityRegistry(missing, catalogs));

  const mismatched = structuredClone(registry);
  mismatched.structuredGaps.find((gap) => gap.capabilityId === 'frontend.responsive').status = 'partial';
  expectCode('QUALITY_GAP_STATUS_MISMATCH', () => validateForgeQualityCapabilityRegistry(mismatched, catalogs));
});

test('changing a gap to enforced cannot fake completion without available matching evidence', async () => {
  const { registry, catalogs } = await currentInputs();
  const fake = structuredClone(registry);
  const capability = fake.capabilities.find((item) => item.capabilityId === 'backend.transaction');
  capability.status = 'enforced';
  capability.gap = null;
  fake.structuredGaps = fake.structuredGaps.filter((gap) => gap.capabilityId !== capability.capabilityId);
  expectCode('QUALITY_FALSE_ENFORCED', () => validateForgeQualityCapabilityRegistry(fake, catalogs));
});

test('excluded criteria require one explicit authority boundary and cannot also be covered', async () => {
  const { registry, catalogs } = await currentInputs();
  const missingExclusion = structuredClone(registry);
  missingExclusion.explicitExclusions = [];
  expectCode('QUALITY_EXCLUSION_MISSING', () => validateForgeQualityCapabilityRegistry(missingExclusion, catalogs));

  const coveredExclusion = structuredClone(registry);
  coveredExclusion.coverageEdges.push({
    criterionId: 'AC-NO-SERVER-DEPLOYMENT',
    capabilityIds: ['ops.controlled-release'],
    evidenceContractIds: ['evidence-independent-acceptance'],
    routingProfileId: 'route-operations',
  });
  expectCode('QUALITY_EXCLUDED_CRITERION_HAS_EDGE', () => validateForgeQualityCapabilityRegistry(coveredExclusion, catalogs));
});

test('unused graph contracts fail closed instead of becoming decorative metadata', async () => {
  const { registry, catalogs } = await currentInputs();
  const orphanEvidence = structuredClone(registry);
  orphanEvidence.evidenceContracts.push({
    evidenceContractId: 'evidence-unused-review',
    proofLevel: 'semantic',
    availability: 'planned',
    receiptType: 'unused-review-receipt',
    verificationProfiles: ['governance'],
  });
  expectCode('QUALITY_EVIDENCE_CONTRACT_ORPHANED', () => validateForgeQualityCapabilityRegistry(orphanEvidence, catalogs));
});
