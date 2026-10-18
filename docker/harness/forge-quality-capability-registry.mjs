import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERIFY_PROFILE_NAMES } from './verify-policy.mjs';

export const QUALITY_PROOF_LEVELS = Object.freeze(['static', 'semantic', 'runtime', 'independent']);
export const QUALITY_CAPABILITY_STATUSES = Object.freeze(['enforced', 'partial', 'planned']);
export const QUALITY_EVIDENCE_AVAILABILITY = Object.freeze(['available', 'planned']);
export const STATIC_ONLY_VERIFICATION_PROFILES = Object.freeze(['governance', 'changed-safe']);

const MODULE_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const PACKAGED_SHARE_DIRECTORY = path.basename(MODULE_DIRECTORY) === 'lib'
  && path.basename(path.dirname(MODULE_DIRECTORY)) === 'local'
  ? path.resolve(MODULE_DIRECTORY, '..', 'share')
  : MODULE_DIRECTORY;
const DEFAULT_REGISTRY_PATH = path.join(PACKAGED_SHARE_DIRECTORY, 'forge-quality-capability-registry.json');
const DEFAULT_POLICY_PATH = path.join(PACKAGED_SHARE_DIRECTORY, 'forge-governance-policy.json');
const DEFAULT_SKILL_CATALOG_PATH = path.join(PACKAGED_SHARE_DIRECTORY,
  PACKAGED_SHARE_DIRECTORY === MODULE_DIRECTORY ? 'skills.catalog.json' : 'dsh-skills.catalog.json');

const REGISTRY_KEYS = Object.freeze([
  'schemaVersion', 'registryVersion', 'requirements', 'routingProfiles', 'evidenceContracts', 'coverageEdges',
  'capabilities', 'structuredGaps', 'explicitExclusions',
]);
const CAPABILITY_KEYS = Object.freeze([
  'capabilityId', 'domain', 'summary', 'requiredSkills', 'ruleIds', 'verificationProfiles', 'proofLevel', 'status', 'gap',
]);
const REQUIREMENT_KEYS = Object.freeze(['requirementId', 'summary', 'acceptanceCriteria']);
const CRITERION_KEYS = Object.freeze(['criterionId', 'statement', 'excluded']);
const ROUTING_PROFILE_KEYS = Object.freeze(['routingProfileId', 'requiredSkills', 'verificationProfiles']);
const EVIDENCE_CONTRACT_KEYS = Object.freeze([
  'evidenceContractId', 'proofLevel', 'availability', 'receiptType', 'verificationProfiles',
]);
const COVERAGE_EDGE_KEYS = Object.freeze(['criterionId', 'capabilityIds', 'evidenceContractIds', 'routingProfileId']);
const STRUCTURED_GAP_KEYS = Object.freeze(['gapId', 'capabilityId', 'status', 'targetEvidenceContractId']);
const EXCLUSION_KEYS = Object.freeze(['exclusionId', 'criterionId', 'reason', 'authority']);

const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const GRAPH_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const REQUIREMENT_ID_PATTERN = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const CRITERION_ID_PATTERN = /^AC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const DOMAIN_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const VERSION_PATTERN = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,127}$/u;
const RULE_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,127}$/u;

export class ForgeQualityCapabilityRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeQualityCapabilityRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeQualityCapabilityRegistryError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail('QUALITY_REGISTRY_INVALID_TYPE', `${label} must be a plain object.`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('QUALITY_REGISTRY_UNSUPPORTED_FIELD', `${label} contains unsupported field ${key}.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) fail('QUALITY_REGISTRY_REQUIRED_FIELD', `${label} is missing required field ${key}.`);
  }
}

function requiredString(value, pattern, label, maximum = 1000) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    fail('QUALITY_REGISTRY_FIELD_INVALID', `${label} is invalid.`);
  }
  return value;
}

function uniqueReferences(value, pattern, maximum, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail('QUALITY_REGISTRY_FIELD_INVALID', `${label} must be a bounded array.`);
  }
  const result = value.map((entry) => requiredString(entry, pattern, label, 128));
  if (new Set(result).size !== result.length) fail('QUALITY_REGISTRY_DUPLICATE_REFERENCE', `${label} contains duplicates.`);
  return result;
}

function uniqueId(id, seen, duplicateCode, label) {
  if (seen.has(id)) fail(duplicateCode, `Duplicate ${label} ${id}.`);
  seen.add(id);
}

function normalizeCatalogs(catalogs) {
  if (!isPlainObject(catalogs)) fail('QUALITY_CATALOG_INVALID', 'catalogs must be a plain object.');
  const { governancePolicy, skillCatalog, verificationProfiles } = catalogs;
  if (!isPlainObject(governancePolicy) || !Array.isArray(governancePolicy.rules)) {
    fail('QUALITY_POLICY_INVALID', 'governancePolicy.rules must be an array.');
  }
  if (!isPlainObject(skillCatalog) || !Array.isArray(skillCatalog.skills)) {
    fail('QUALITY_SKILL_CATALOG_INVALID', 'skillCatalog.skills must be an array.');
  }
  if (!Array.isArray(verificationProfiles) || verificationProfiles.length < 1) {
    fail('QUALITY_PROFILE_CATALOG_INVALID', 'verificationProfiles must be a non-empty array.');
  }
  const ruleIds = governancePolicy.rules.map((rule) => rule?.id);
  const skillNames = skillCatalog.skills.map((skill) => skill?.name);
  for (const [label, values, pattern] of [
    ['governance rule catalog', ruleIds, RULE_ID_PATTERN],
    ['Skill catalog', skillNames, IDENTIFIER_PATTERN],
    ['verification profile catalog', verificationProfiles, IDENTIFIER_PATTERN],
  ]) {
    if (values.some((value) => typeof value !== 'string' || !pattern.test(value))) {
      fail('QUALITY_CATALOG_INVALID', `${label} contains an invalid identifier.`);
    }
    if (new Set(values).size !== values.length) fail('QUALITY_CATALOG_INVALID', `${label} contains duplicate identifiers.`);
  }
  return {
    ruleIds: new Set(ruleIds),
    skillNames: new Set(skillNames),
    verificationProfiles: new Set(verificationProfiles),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateCapability(value, catalogs, seenIds) {
  const keys = Object.hasOwn(value ?? {}, 'supportingSkills') ? [...CAPABILITY_KEYS, 'supportingSkills'] : CAPABILITY_KEYS;
  exactKeys(value, keys, 'quality capability');
  const capabilityId = requiredString(value.capabilityId, CAPABILITY_ID_PATTERN, 'capabilityId', 128);
  uniqueId(capabilityId, seenIds, 'QUALITY_CAPABILITY_DUPLICATE', 'capabilityId');
  requiredString(value.domain, DOMAIN_PATTERN, `${capabilityId}.domain`, 32);
  requiredString(value.summary, /^.{1,500}$/u, `${capabilityId}.summary`, 500);
  const requiredSkills = uniqueReferences(value.requiredSkills, IDENTIFIER_PATTERN, 16, `${capabilityId}.requiredSkills`, 1);
  // Available tools support a capability without becoming mandatory routing steps.
  const supportingSkills = uniqueReferences(Object.hasOwn(value, 'supportingSkills') ? value.supportingSkills : [],
    IDENTIFIER_PATTERN, 16, `${capabilityId}.supportingSkills`);
  const ruleIds = uniqueReferences(value.ruleIds, RULE_ID_PATTERN, 32, `${capabilityId}.ruleIds`);
  const verificationProfiles = uniqueReferences(
    value.verificationProfiles, IDENTIFIER_PATTERN, 16, `${capabilityId}.verificationProfiles`, 0,
  );
  for (const skill of [...requiredSkills, ...supportingSkills]) {
    if (!catalogs.skillNames.has(skill)) fail('QUALITY_SKILL_REFERENCE_MISSING', `${capabilityId} references missing Skill ${skill}.`);
  }
  for (const ruleId of ruleIds) {
    if (!catalogs.ruleIds.has(ruleId)) fail('QUALITY_RULE_REFERENCE_MISSING', `${capabilityId} references missing rule ${ruleId}.`);
  }
  for (const profile of verificationProfiles) {
    if (!catalogs.verificationProfiles.has(profile)) {
      fail('QUALITY_PROFILE_REFERENCE_MISSING', `${capabilityId} references missing verification profile ${profile}.`);
    }
  }
  if (!QUALITY_PROOF_LEVELS.includes(value.proofLevel)) fail('QUALITY_PROOF_LEVEL_INVALID', `${capabilityId} has an invalid proofLevel.`);
  if (!QUALITY_CAPABILITY_STATUSES.includes(value.status)) fail('QUALITY_STATUS_INVALID', `${capabilityId} has an invalid status.`);
  if (value.gap !== null && (typeof value.gap !== 'string' || value.gap.length < 1 || value.gap.length > 1000)) {
    fail('QUALITY_GAP_INVALID', `${capabilityId}.gap must be null or a bounded non-empty string.`);
  }
  if (value.status === 'enforced') {
    if (ruleIds.length < 1 || verificationProfiles.length < 1) {
      fail('QUALITY_FALSE_ENFORCED', `${capabilityId} cannot be enforced without both a rule and verification profile.`);
    }
    if (value.gap !== null) fail('QUALITY_FALSE_ENFORCED', `${capabilityId} cannot be enforced while declaring a gap.`);
  } else if (value.gap === null) {
    fail('QUALITY_GAP_REQUIRED', `${capabilityId} must state the gap for ${value.status} coverage.`);
  }
  if (value.proofLevel === 'runtime'
      && !verificationProfiles.some((profile) => !STATIC_ONLY_VERIFICATION_PROFILES.includes(profile))) {
    fail('QUALITY_RUNTIME_PROFILE_MISSING', `${capabilityId} runtime proof cannot rely only on static profiles.`);
  }
  return {
    capabilityId, domain: value.domain, summary: value.summary, requiredSkills, ruleIds, verificationProfiles,
    ...(supportingSkills.length ? { supportingSkills } : {}),
    proofLevel: value.proofLevel, status: value.status, gap: value.gap,
  };
}

function requireReverseCatalogCoverage(capabilities, catalogs) {
  const used = {
    ruleIds: new Set(capabilities.flatMap((capability) => capability.ruleIds)),
    skillNames: new Set(capabilities.flatMap((capability) => [...capability.requiredSkills, ...(capability.supportingSkills ?? [])])),
    verificationProfiles: new Set(capabilities.flatMap((capability) => capability.verificationProfiles)),
  };
  for (const [catalogKey, code, label] of [
    ['ruleIds', 'QUALITY_RULE_ORPHANED', 'governance rule'],
    ['skillNames', 'QUALITY_SKILL_ORPHANED', 'Skill'],
    ['verificationProfiles', 'QUALITY_PROFILE_ORPHANED', 'verification profile'],
  ]) {
    const executionProtocolProfiles = new Set(['backend-red-test', 'frontend-red-test']);
    const orphaned = [...catalogs[catalogKey]]
      .filter((identifier) => catalogKey !== 'verificationProfiles' || !executionProtocolProfiles.has(identifier))
      .filter((identifier) => !used[catalogKey].has(identifier)).sort();
    if (orphaned.length > 0) fail(code, `Every ${label} must be consumed by at least one capability; orphaned: ${orphaned.join(', ')}.`);
  }
}

function validateRequirements(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) {
    fail('QUALITY_REQUIREMENTS_INVALID', 'requirements must be a non-empty bounded array.');
  }
  const requirementIds = new Set();
  const criterionIds = new Set();
  const criteria = new Map();
  const requirements = values.map((requirement) => {
    exactKeys(requirement, REQUIREMENT_KEYS, 'requirement');
    const requirementId = requiredString(requirement.requirementId, REQUIREMENT_ID_PATTERN, 'requirementId', 128);
    uniqueId(requirementId, requirementIds, 'QUALITY_REQUIREMENT_DUPLICATE', 'requirementId');
    requiredString(requirement.summary, /^.{1,500}$/u, `${requirementId}.summary`, 500);
    if (!Array.isArray(requirement.acceptanceCriteria) || requirement.acceptanceCriteria.length < 1
        || requirement.acceptanceCriteria.length > 64) {
      fail('QUALITY_CRITERIA_INVALID', `${requirementId}.acceptanceCriteria must be a non-empty bounded array.`);
    }
    const acceptanceCriteria = requirement.acceptanceCriteria.map((criterion) => {
      exactKeys(criterion, CRITERION_KEYS, 'acceptance criterion');
      const criterionId = requiredString(criterion.criterionId, CRITERION_ID_PATTERN, 'criterionId', 128);
      uniqueId(criterionId, criterionIds, 'QUALITY_CRITERION_DUPLICATE', 'criterionId');
      requiredString(criterion.statement, /^.{1,500}$/u, `${criterionId}.statement`, 500);
      if (typeof criterion.excluded !== 'boolean') fail('QUALITY_CRITERION_INVALID', `${criterionId}.excluded must be boolean.`);
      const normalized = { criterionId, statement: criterion.statement, excluded: criterion.excluded, requirementId };
      criteria.set(criterionId, normalized);
      return { criterionId, statement: criterion.statement, excluded: criterion.excluded };
    });
    return { requirementId, summary: requirement.summary, acceptanceCriteria };
  });
  return { requirements, criteria };
}

function validateRoutingProfiles(values, catalogs) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) {
    fail('QUALITY_ROUTING_PROFILES_INVALID', 'routingProfiles must be a non-empty bounded array.');
  }
  const profileIds = new Set();
  const profiles = new Map();
  const normalized = values.map((profile) => {
    exactKeys(profile, ROUTING_PROFILE_KEYS, 'routing profile');
    const routingProfileId = requiredString(profile.routingProfileId, GRAPH_ID_PATTERN, 'routingProfileId', 128);
    uniqueId(routingProfileId, profileIds, 'QUALITY_ROUTING_PROFILE_DUPLICATE', 'routingProfileId');
    const requiredSkills = uniqueReferences(profile.requiredSkills, IDENTIFIER_PATTERN, 32,
      `${routingProfileId}.requiredSkills`, 1);
    const verificationProfiles = uniqueReferences(profile.verificationProfiles, IDENTIFIER_PATTERN, 32,
      `${routingProfileId}.verificationProfiles`, 1);
    for (const skill of requiredSkills) {
      if (!catalogs.skillNames.has(skill)) fail('QUALITY_ROUTING_SKILL_REFERENCE_MISSING', `${routingProfileId} references missing Skill ${skill}.`);
    }
    for (const verificationProfile of verificationProfiles) {
      if (!catalogs.verificationProfiles.has(verificationProfile)) {
        fail('QUALITY_ROUTING_PROFILE_REFERENCE_MISSING', `${routingProfileId} references missing verification profile ${verificationProfile}.`);
      }
    }
    const result = { routingProfileId, requiredSkills, verificationProfiles };
    profiles.set(routingProfileId, result);
    return result;
  });
  return { routingProfiles: normalized, routingProfileMap: profiles };
}

function validateEvidenceContracts(values, catalogs) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) {
    fail('QUALITY_EVIDENCE_CONTRACTS_INVALID', 'evidenceContracts must be a non-empty bounded array.');
  }
  const contractIds = new Set();
  const contracts = new Map();
  const normalized = values.map((contract) => {
    exactKeys(contract, EVIDENCE_CONTRACT_KEYS, 'evidence contract');
    const evidenceContractId = requiredString(contract.evidenceContractId, GRAPH_ID_PATTERN, 'evidenceContractId', 128);
    uniqueId(evidenceContractId, contractIds, 'QUALITY_EVIDENCE_CONTRACT_DUPLICATE', 'evidenceContractId');
    if (!QUALITY_PROOF_LEVELS.includes(contract.proofLevel)) {
      fail('QUALITY_EVIDENCE_PROOF_LEVEL_INVALID', `${evidenceContractId} has an invalid proofLevel.`);
    }
    if (!QUALITY_EVIDENCE_AVAILABILITY.includes(contract.availability)) {
      fail('QUALITY_EVIDENCE_AVAILABILITY_INVALID', `${evidenceContractId} has invalid availability.`);
    }
    requiredString(contract.receiptType, IDENTIFIER_PATTERN, `${evidenceContractId}.receiptType`, 128);
    const verificationProfiles = uniqueReferences(contract.verificationProfiles, IDENTIFIER_PATTERN, 32,
      `${evidenceContractId}.verificationProfiles`, 1);
    for (const verificationProfile of verificationProfiles) {
      if (!catalogs.verificationProfiles.has(verificationProfile)) {
        fail('QUALITY_EVIDENCE_PROFILE_REFERENCE_MISSING', `${evidenceContractId} references missing verification profile ${verificationProfile}.`);
      }
    }
    if (contract.proofLevel === 'runtime'
        && !verificationProfiles.some((profile) => !STATIC_ONLY_VERIFICATION_PROFILES.includes(profile))) {
      fail('QUALITY_EVIDENCE_RUNTIME_PROFILE_MISSING', `${evidenceContractId} runtime evidence cannot use only static profiles.`);
    }
    const result = {
      evidenceContractId, proofLevel: contract.proofLevel, availability: contract.availability,
      receiptType: contract.receiptType, verificationProfiles,
    };
    contracts.set(evidenceContractId, result);
    return result;
  });
  return { evidenceContracts: normalized, evidenceContractMap: contracts };
}

function validateCoverageEdges(values, context) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 256) {
    fail('QUALITY_COVERAGE_EDGES_INVALID', 'coverageEdges must be a non-empty bounded array.');
  }
  const edgeCriteria = new Set();
  const consumedCapabilities = new Set();
  const usedRoutingProfiles = new Set();
  const usedEvidenceContracts = new Set();
  const capabilityEdge = new Map();
  const edges = values.map((edge) => {
    exactKeys(edge, COVERAGE_EDGE_KEYS, 'coverage edge');
    const criterionId = requiredString(edge.criterionId, CRITERION_ID_PATTERN, 'coverageEdge.criterionId', 128);
    const criterion = context.criteria.get(criterionId);
    if (!criterion) fail('QUALITY_EDGE_CRITERION_MISSING', `Coverage edge references missing criterion ${criterionId}.`);
    if (criterion.excluded) fail('QUALITY_EXCLUDED_CRITERION_HAS_EDGE', `Excluded criterion ${criterionId} cannot have a coverage edge.`);
    uniqueId(criterionId, edgeCriteria, 'QUALITY_CRITERION_EDGE_DUPLICATE', 'coverage criterion');
    const capabilityIds = uniqueReferences(edge.capabilityIds, CAPABILITY_ID_PATTERN, 128,
      `${criterionId}.capabilityIds`, 1);
    const evidenceContractIds = uniqueReferences(edge.evidenceContractIds, GRAPH_ID_PATTERN, 32,
      `${criterionId}.evidenceContractIds`, 1);
    const routingProfileId = requiredString(edge.routingProfileId, GRAPH_ID_PATTERN,
      `${criterionId}.routingProfileId`, 128);
    const routingProfile = context.routingProfiles.get(routingProfileId);
    if (!routingProfile) fail('QUALITY_EDGE_ROUTING_PROFILE_MISSING', `${criterionId} references missing routing profile ${routingProfileId}.`);
    usedRoutingProfiles.add(routingProfileId);
    const evidence = evidenceContractIds.map((id) => {
      const contract = context.evidenceContracts.get(id);
      if (!contract) fail('QUALITY_EDGE_EVIDENCE_MISSING', `${criterionId} references missing evidence contract ${id}.`);
      usedEvidenceContracts.add(id);
      return contract;
    });
    for (const capabilityId of capabilityIds) {
      const capability = context.capabilities.get(capabilityId);
      if (!capability) fail('QUALITY_EDGE_CAPABILITY_MISSING', `${criterionId} references missing capability ${capabilityId}.`);
      if (consumedCapabilities.has(capabilityId)) {
        fail('QUALITY_CAPABILITY_EDGE_DUPLICATE', `Capability ${capabilityId} is consumed by more than one criterion.`);
      }
      consumedCapabilities.add(capabilityId);
      capabilityEdge.set(capabilityId, { criterionId, evidenceContractIds, routingProfileId });
      if (!evidence.some((contract) => contract.proofLevel === capability.proofLevel)) {
        fail('QUALITY_CAPABILITY_EVIDENCE_MISMATCH', `${capabilityId} lacks a ${capability.proofLevel} evidence contract.`);
      }
      for (const skill of capability.requiredSkills) {
        if (!routingProfile.requiredSkills.includes(skill)) {
          fail('QUALITY_ROUTING_SKILL_INCOMPLETE', `${routingProfileId} does not route required Skill ${skill} for ${capabilityId}.`);
        }
      }
      for (const profile of capability.verificationProfiles) {
        if (!routingProfile.verificationProfiles.includes(profile)) {
          fail('QUALITY_ROUTING_PROFILE_INCOMPLETE', `${routingProfileId} does not route verification profile ${profile} for ${capabilityId}.`);
        }
      }
      if (capability.status === 'enforced'
          && !evidence.some((contract) => contract.proofLevel === capability.proofLevel && contract.availability === 'available')) {
        fail('QUALITY_FALSE_ENFORCED', `${capabilityId} cannot be enforced without available ${capability.proofLevel} evidence.`);
      }
    }
    return { criterionId, capabilityIds, evidenceContractIds, routingProfileId };
  });
  const uncoveredCriteria = [...context.criteria.values()]
    .filter((criterion) => !criterion.excluded && !edgeCriteria.has(criterion.criterionId))
    .map((criterion) => criterion.criterionId).sort();
  if (uncoveredCriteria.length > 0) {
    fail('QUALITY_CRITERION_UNCOVERED', `Non-excluded criteria lack coverage edges: ${uncoveredCriteria.join(', ')}.`);
  }
  const orphanCapabilities = [...context.capabilities.keys()].filter((id) => !consumedCapabilities.has(id)).sort();
  if (orphanCapabilities.length > 0) {
    fail('QUALITY_CAPABILITY_ORPHANED', `Capabilities lack acceptance-criterion consumers: ${orphanCapabilities.join(', ')}.`);
  }
  const orphanRouting = [...context.routingProfiles.keys()].filter((id) => !usedRoutingProfiles.has(id)).sort();
  if (orphanRouting.length > 0) fail('QUALITY_ROUTING_PROFILE_ORPHANED', `Routing profiles are unused: ${orphanRouting.join(', ')}.`);
  const orphanEvidence = [...context.evidenceContracts.keys()].filter((id) => !usedEvidenceContracts.has(id)).sort();
  if (orphanEvidence.length > 0) fail('QUALITY_EVIDENCE_CONTRACT_ORPHANED', `Evidence contracts are unused: ${orphanEvidence.join(', ')}.`);
  return { coverageEdges: edges, capabilityEdge };
}

function validateStructuredGaps(values, context) {
  if (!Array.isArray(values) || values.length > 256) {
    fail('QUALITY_STRUCTURED_GAPS_INVALID', 'structuredGaps must be a bounded array.');
  }
  const gapIds = new Set();
  const gapCapabilities = new Set();
  const gaps = values.map((gap) => {
    exactKeys(gap, STRUCTURED_GAP_KEYS, 'structured gap');
    const gapId = requiredString(gap.gapId, GRAPH_ID_PATTERN, 'gapId', 128);
    uniqueId(gapId, gapIds, 'QUALITY_STRUCTURED_GAP_DUPLICATE', 'gapId');
    const capabilityId = requiredString(gap.capabilityId, CAPABILITY_ID_PATTERN, `${gapId}.capabilityId`, 128);
    uniqueId(capabilityId, gapCapabilities, 'QUALITY_CAPABILITY_GAP_DUPLICATE', 'gap capability');
    const capability = context.capabilities.get(capabilityId);
    if (!capability) fail('QUALITY_GAP_CAPABILITY_MISSING', `${gapId} references missing capability ${capabilityId}.`);
    if (capability.status === 'enforced') fail('QUALITY_ENFORCED_CAPABILITY_HAS_GAP', `${capabilityId} cannot have a structured gap.`);
    if (gap.status !== capability.status || !['partial', 'planned'].includes(gap.status)) {
      fail('QUALITY_GAP_STATUS_MISMATCH', `${gapId} status must exactly match ${capabilityId}.`);
    }
    const evidence = context.evidenceContracts.get(gap.targetEvidenceContractId);
    if (!evidence) fail('QUALITY_GAP_EVIDENCE_MISSING', `${gapId} references missing target evidence contract.`);
    if (evidence.proofLevel !== capability.proofLevel || evidence.availability !== 'planned') {
      fail('QUALITY_GAP_EVIDENCE_MISMATCH', `${gapId} must target planned ${capability.proofLevel} evidence.`);
    }
    const edge = context.capabilityEdge.get(capabilityId);
    if (!edge?.evidenceContractIds.includes(gap.targetEvidenceContractId)) {
      fail('QUALITY_GAP_EDGE_MISMATCH', `${gapId} target evidence is not declared on its criterion edge.`);
    }
    return {
      gapId, capabilityId, status: gap.status, targetEvidenceContractId: gap.targetEvidenceContractId,
      description: capability.gap,
    };
  });
  const missing = [...context.capabilities.values()]
    .filter((capability) => capability.status !== 'enforced' && !gapCapabilities.has(capability.capabilityId))
    .map((capability) => capability.capabilityId).sort();
  if (missing.length > 0) fail('QUALITY_STRUCTURED_GAP_MISSING', `Non-enforced capabilities lack structured gaps: ${missing.join(', ')}.`);
  return gaps;
}

function validateExplicitExclusions(values, criteria, edgeCriteria) {
  if (!Array.isArray(values) || values.length > 128) fail('QUALITY_EXCLUSIONS_INVALID', 'explicitExclusions must be a bounded array.');
  const exclusionIds = new Set();
  const excludedCriteria = new Set();
  const exclusions = values.map((exclusion) => {
    exactKeys(exclusion, EXCLUSION_KEYS, 'explicit exclusion');
    const exclusionId = requiredString(exclusion.exclusionId, GRAPH_ID_PATTERN, 'exclusionId', 128);
    uniqueId(exclusionId, exclusionIds, 'QUALITY_EXCLUSION_DUPLICATE', 'exclusionId');
    const criterionId = requiredString(exclusion.criterionId, CRITERION_ID_PATTERN, `${exclusionId}.criterionId`, 128);
    uniqueId(criterionId, excludedCriteria, 'QUALITY_EXCLUSION_CRITERION_DUPLICATE', 'excluded criterion');
    const criterion = criteria.get(criterionId);
    if (!criterion) fail('QUALITY_EXCLUSION_CRITERION_MISSING', `${exclusionId} references missing criterion ${criterionId}.`);
    if (!criterion.excluded) fail('QUALITY_EXCLUSION_NOT_DECLARED', `${criterionId} is not declared excluded.`);
    if (edgeCriteria.has(criterionId)) fail('QUALITY_EXCLUDED_CRITERION_HAS_EDGE', `${criterionId} cannot be both covered and excluded.`);
    requiredString(exclusion.reason, /^.{1,1000}$/u, `${exclusionId}.reason`, 1000);
    requiredString(exclusion.authority, GRAPH_ID_PATTERN, `${exclusionId}.authority`, 128);
    return { exclusionId, criterionId, reason: exclusion.reason, authority: exclusion.authority };
  });
  const missing = [...criteria.values()]
    .filter((criterion) => criterion.excluded && !excludedCriteria.has(criterion.criterionId))
    .map((criterion) => criterion.criterionId).sort();
  if (missing.length > 0) fail('QUALITY_EXCLUSION_MISSING', `Excluded criteria lack explicit exclusions: ${missing.join(', ')}.`);
  return exclusions;
}

function coverageOf(capabilities, requirements, criteria, structuredGaps, explicitExclusions) {
  const statusCounts = Object.fromEntries(QUALITY_CAPABILITY_STATUSES.map((status) => [status, 0]));
  const proofLevelCounts = Object.fromEntries(QUALITY_PROOF_LEVELS.map((level) => [level, 0]));
  const domains = {};
  for (const capability of capabilities) {
    statusCounts[capability.status] += 1;
    proofLevelCounts[capability.proofLevel] += 1;
    domains[capability.domain] ??= { total: 0, enforced: 0, partial: 0, planned: 0 };
    domains[capability.domain].total += 1;
    domains[capability.domain][capability.status] += 1;
  }
  const gapByCapability = new Map(structuredGaps.map((gap) => [gap.capabilityId, gap]));
  const blockingGaps = capabilities.filter((capability) => capability.status !== 'enforced').map((capability) => ({
    capabilityId: capability.capabilityId,
    domain: capability.domain,
    proofLevel: capability.proofLevel,
    status: capability.status,
    gap: capability.gap,
    gapId: gapByCapability.get(capability.capabilityId).gapId,
    targetEvidenceContractId: gapByCapability.get(capability.capabilityId).targetEvidenceContractId,
  }));
  return {
    coverage: {
      total: capabilities.length,
      requirements: requirements.length,
      acceptanceCriteria: criteria.size,
      excludedCriteria: explicitExclusions.length,
      statusCounts,
      proofLevelCounts,
      domains,
      complete: blockingGaps.length === 0,
    },
    blockingGaps,
  };
}

export function validateForgeQualityCapabilityRegistry(value, catalogs) {
  exactKeys(value, REGISTRY_KEYS, 'quality capability registry');
  if (value.schemaVersion !== 2) fail('QUALITY_REGISTRY_SCHEMA_UNSUPPORTED', 'Unsupported quality registry schema.');
  requiredString(value.registryVersion, VERSION_PATTERN, 'registryVersion', 32);
  if (!Array.isArray(value.capabilities) || value.capabilities.length < 1 || value.capabilities.length > 256) {
    fail('QUALITY_REGISTRY_FIELD_INVALID', 'capabilities must be a non-empty bounded array.');
  }
  const normalizedCatalogs = normalizeCatalogs(catalogs);
  const seenCapabilityIds = new Set();
  const capabilities = value.capabilities.map((capability) => validateCapability(capability, normalizedCatalogs, seenCapabilityIds));
  requireReverseCatalogCoverage(capabilities, normalizedCatalogs);
  const capabilityMap = new Map(capabilities.map((capability) => [capability.capabilityId, capability]));
  const { requirements, criteria } = validateRequirements(value.requirements);
  const { routingProfiles, routingProfileMap } = validateRoutingProfiles(value.routingProfiles, normalizedCatalogs);
  const { evidenceContracts, evidenceContractMap } = validateEvidenceContracts(value.evidenceContracts, normalizedCatalogs);
  const { coverageEdges, capabilityEdge } = validateCoverageEdges(value.coverageEdges, {
    criteria, capabilities: capabilityMap, routingProfiles: routingProfileMap, evidenceContracts: evidenceContractMap,
  });
  const structuredGaps = validateStructuredGaps(value.structuredGaps, {
    capabilities: capabilityMap, evidenceContracts: evidenceContractMap, capabilityEdge,
  });
  const edgeCriteria = new Set(coverageEdges.map((edge) => edge.criterionId));
  const explicitExclusions = validateExplicitExclusions(value.explicitExclusions, criteria, edgeCriteria);
  const report = coverageOf(capabilities, requirements, criteria, structuredGaps, explicitExclusions);
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    registryVersion: value.registryVersion,
    requirements,
    routingProfiles,
    evidenceContracts,
    coverageEdges,
    capabilities,
    structuredGaps,
    explicitExclusions,
    ...report,
  });
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail('QUALITY_REGISTRY_READ_FAILED', `${label} could not be read as JSON: ${error.message}`);
  }
}

export async function loadCurrentForgeQualityCapabilityRegistry(options = {}) {
  if (!isPlainObject(options)) fail('QUALITY_REGISTRY_INVALID_TYPE', 'options must be a plain object.');
  const allowed = new Set(['registryPath', 'policyPath', 'skillCatalogPath', 'verificationProfiles']);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail('QUALITY_REGISTRY_UNSUPPORTED_FIELD', `options contains unsupported field ${key}.`);
  }
  const registry = await readJson(options.registryPath ?? DEFAULT_REGISTRY_PATH, 'quality registry');
  const governancePolicy = await readJson(options.policyPath ?? DEFAULT_POLICY_PATH, 'governance policy');
  const skillCatalog = await readJson(options.skillCatalogPath ?? DEFAULT_SKILL_CATALOG_PATH, 'Skill catalog');
  return validateForgeQualityCapabilityRegistry(registry, {
    governancePolicy,
    skillCatalog,
    verificationProfiles: options.verificationProfiles ?? VERIFY_PROFILE_NAMES,
  });
}
