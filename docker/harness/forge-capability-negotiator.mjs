import {
  EXECUTION_BLOCKING_STAGES,
  EXECUTION_PROOF_LEVELS,
  canonicalExecutionCapabilityDigest,
  validateExecutionCapabilityRegistry,
} from './forge-execution-capability-registry.mjs';

export const CAPABILITY_NEGOTIATION_OUTCOMES = Object.freeze([
  'READY', 'READ_ONLY_DEGRADED', 'BOUNDED_BLOCKED',
]);
export const CAPABILITY_OFFER_STATUSES = Object.freeze(['available', 'partial', 'planned', 'unknown']);

const DEMAND_KEYS = ['capabilityId', 'minimumProofLevel'];
const OFFER_KEYS = ['capabilityId', 'evidenceDigests', 'proofLevel', 'reasonCode', 'status'];
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{2,127}$/u;

export class ForgeCapabilityNegotiationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeCapabilityNegotiationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeCapabilityNegotiationError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, location) {
  if (!plainObject(value)) fail('CAPABILITY_NEGOTIATION_SCHEMA_INVALID', `${location} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('CAPABILITY_NEGOTIATION_UNSUPPORTED_FIELD', `${location} has missing or unsupported fields.`);
  }
}

function registryReport(registry) {
  if (!registry?.registryDigest && !registry?.dagOrder) return validateExecutionCapabilityRegistry(registry);
  const { registryDigest, dagOrder: _dagOrder, ...raw } = registry;
  const checked = validateExecutionCapabilityRegistry(raw);
  if (checked.registryDigest !== registryDigest) {
    fail('CAPABILITY_REGISTRY_DIGEST_MISMATCH', 'Registry report digest does not match its canonical content.');
  }
  return checked;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeDemands(registry, demands) {
  if (!Array.isArray(demands) || demands.length === 0) fail('CAPABILITY_DEMAND_EMPTY', 'At least one capability demand is required.');
  const byId = new Map(registry.capabilities.map((item) => [item.capabilityId, item]));
  const explicit = new Map();
  for (const [index, demand] of demands.entries()) {
    exactKeys(demand, DEMAND_KEYS, `demands[${index}]`);
    const capability = byId.get(demand.capabilityId);
    if (!capability) fail('CAPABILITY_DEMAND_UNKNOWN', `Demand references unknown capability ${demand.capabilityId}.`);
    if (!EXECUTION_PROOF_LEVELS.includes(demand.minimumProofLevel)) {
      fail('CAPABILITY_DEMAND_PROOF_INVALID', `Demand ${demand.capabilityId} has invalid proof level.`);
    }
    const minimum = Math.max(
      EXECUTION_PROOF_LEVELS.indexOf(capability.minimumProofLevel),
      EXECUTION_PROOF_LEVELS.indexOf(demand.minimumProofLevel),
    );
    const previous = explicit.get(demand.capabilityId);
    if (previous !== undefined) fail(
      previous === minimum ? 'CAPABILITY_DEMAND_DUPLICATE' : 'CAPABILITY_DEMAND_CONFLICT',
      `Demand ${demand.capabilityId} is duplicated${previous === minimum ? '' : ' with conflicting proof levels'}.`,
    );
    explicit.set(demand.capabilityId, minimum);
  }

  const required = new Map();
  function include(capabilityId, inheritedMinimum = 0, demandedBy = capabilityId) {
    const capability = byId.get(capabilityId);
    const minimumIndex = Math.max(
      EXECUTION_PROOF_LEVELS.indexOf(capability.minimumProofLevel),
      inheritedMinimum,
      explicit.get(capabilityId) ?? 0,
    );
    const current = required.get(capabilityId);
    if (!current || minimumIndex > current.minimumIndex) {
      required.set(capabilityId, { capability, minimumIndex, demandedBy: new Set(current?.demandedBy ?? []) });
    }
    required.get(capabilityId).demandedBy.add(demandedBy);
    for (const dependencyId of capability.dependsOn) include(dependencyId, 0, capabilityId);
  }
  for (const [capabilityId, minimumIndex] of explicit) include(capabilityId, minimumIndex, capabilityId);
  return [...required.values()]
    .sort((left, right) => left.capability.capabilityId.localeCompare(right.capability.capabilityId))
    .map(({ capability, minimumIndex, demandedBy }) => ({
      capabilityId: capability.capabilityId,
      minimumProofLevel: EXECUTION_PROOF_LEVELS[minimumIndex],
      blockingStage: capability.blockingStage,
      dependsOn: [...capability.dependsOn],
      demandedBy: [...demandedBy].sort(),
    }));
}

function normalizeOffers(registry, offers) {
  if (!Array.isArray(offers)) fail('CAPABILITY_OFFER_INVALID', 'offers must be an array.');
  const known = new Set(registry.capabilities.map((item) => item.capabilityId));
  const byId = new Map();
  for (const [index, offer] of offers.entries()) {
    exactKeys(offer, OFFER_KEYS, `offers[${index}]`);
    if (!known.has(offer.capabilityId)) fail('CAPABILITY_OFFER_UNKNOWN', `Offer references unknown capability ${offer.capabilityId}.`);
    if (byId.has(offer.capabilityId)) fail('CAPABILITY_OFFER_DUPLICATE', `Duplicate offer for ${offer.capabilityId}.`);
    if (!CAPABILITY_OFFER_STATUSES.includes(offer.status)) fail('CAPABILITY_OFFER_STATUS_INVALID', `Offer ${offer.capabilityId} has invalid status.`);
    if (offer.proofLevel !== null && !EXECUTION_PROOF_LEVELS.includes(offer.proofLevel)) {
      fail('CAPABILITY_OFFER_PROOF_INVALID', `Offer ${offer.capabilityId} has invalid proofLevel.`);
    }
    if (!Array.isArray(offer.evidenceDigests) || offer.evidenceDigests.some((digest) => !SHA256.test(digest))
      || new Set(offer.evidenceDigests).size !== offer.evidenceDigests.length) {
      fail('CAPABILITY_OFFER_EVIDENCE_INVALID', `Offer ${offer.capabilityId} has invalid evidence digests.`);
    }
    const evidenceDigests = [...offer.evidenceDigests].sort();
    if (offer.status === 'available') {
      if (offer.proofLevel === null || evidenceDigests.length === 0 || offer.reasonCode !== null) {
        fail('CAPABILITY_OFFER_FALSE_AVAILABLE', `Available offer ${offer.capabilityId} requires proof and cannot carry a gap reason.`);
      }
    } else if (typeof offer.reasonCode !== 'string' || !SAFE_REASON.test(offer.reasonCode)) {
      fail('CAPABILITY_OFFER_GAP_REQUIRED', `${offer.status} offer ${offer.capabilityId} requires a typed reasonCode.`);
    }
    byId.set(offer.capabilityId, { ...offer, evidenceDigests });
  }
  return byId;
}

export function createCapabilityDemand(registry, profileId, proofOverrides = {}) {
  const checked = registryReport(registry);
  const profile = checked.demandProfiles.find((item) => item.profileId === profileId);
  if (!profile) fail('CAPABILITY_DEMAND_PROFILE_UNKNOWN', `Unknown demand profile ${profileId}.`);
  if (!plainObject(proofOverrides)) fail('CAPABILITY_DEMAND_OVERRIDE_INVALID', 'proofOverrides must be a plain object.');
  for (const capabilityId of Object.keys(proofOverrides)) {
    if (!profile.capabilityIds.includes(capabilityId)) {
      fail('CAPABILITY_DEMAND_OVERRIDE_UNKNOWN', `Proof override ${capabilityId} is outside profile ${profileId}.`);
    }
    if (!EXECUTION_PROOF_LEVELS.includes(proofOverrides[capabilityId])) {
      fail('CAPABILITY_DEMAND_PROOF_INVALID', `Proof override ${capabilityId} is invalid.`);
    }
  }
  return freeze(profile.capabilityIds.map((capabilityId) => ({
    capabilityId,
    minimumProofLevel: proofOverrides[capabilityId]
      ?? checked.capabilities.find((item) => item.capabilityId === capabilityId).minimumProofLevel,
  })));
}

function gapFor(requirement, offer, dependencyGaps) {
  if (!offer) return { reasonCode: 'OFFER_MISSING', offeredStatus: 'unknown', offeredProofLevel: null };
  if (offer.status !== 'available') {
    return { reasonCode: offer.reasonCode, offeredStatus: offer.status, offeredProofLevel: offer.proofLevel };
  }
  if (EXECUTION_PROOF_LEVELS.indexOf(offer.proofLevel) < EXECUTION_PROOF_LEVELS.indexOf(requirement.minimumProofLevel)) {
    return { reasonCode: 'PROOF_LEVEL_INSUFFICIENT', offeredStatus: 'partial', offeredProofLevel: offer.proofLevel };
  }
  const dependencyGap = requirement.dependsOn.find((dependencyId) => dependencyGaps.has(dependencyId));
  if (dependencyGap) {
    return { reasonCode: 'DEPENDENCY_UNAVAILABLE', offeredStatus: 'partial', offeredProofLevel: offer.proofLevel };
  }
  return null;
}

export function negotiateExecutionCapabilities({ registry, demands, offers }) {
  const checked = registryReport(registry);
  const normalizedDemands = normalizeDemands(checked, demands);
  const offerById = normalizeOffers(checked, offers);
  const requestedDemands = [...demands]
    .map((item) => ({ capabilityId: item.capabilityId, minimumProofLevel: item.minimumProofLevel }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const normalizedOffers = [...offerById.values()].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const requirementsById = new Map(normalizedDemands.map((item) => [item.capabilityId, item]));
  const gapById = new Map();
  const resultsById = new Map();
  for (const capabilityId of checked.dagOrder) {
    const requirement = requirementsById.get(capabilityId);
    if (!requirement) continue;
    const offer = offerById.get(capabilityId);
    const gap = gapFor(requirement, offer, gapById);
    if (gap) gapById.set(capabilityId, gap);
    resultsById.set(capabilityId, {
      ...requirement,
      satisfied: gap === null,
      offeredStatus: gap ? gap.offeredStatus : offer.status,
      offeredProofLevel: gap ? gap.offeredProofLevel : offer.proofLevel,
      evidenceDigests: offer?.evidenceDigests ?? [],
      reasonCode: gap?.reasonCode ?? null,
    });
  }
  const capabilityResults = [...resultsById.values()].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const blockingGaps = capabilityResults.filter((item) => !item.satisfied);
  let outcome = 'READY';
  if (blockingGaps.some((item) => item.blockingStage === 'DISCOVER')) outcome = 'BOUNDED_BLOCKED';
  else if (blockingGaps.length > 0) outcome = 'READ_ONLY_DEGRADED';

  const firstBlockingStage = blockingGaps.length === 0 ? null : EXECUTION_BLOCKING_STAGES.find(
    (stage) => blockingGaps.some((item) => item.blockingStage === stage),
  );
  const cannotClaim = outcome === 'READY' ? [] : outcome === 'READ_ONLY_DEGRADED'
    ? ['implemented', 'verified', 'accepted', 'complete', 'released']
    : ['analyzed', 'implemented', 'verified', 'accepted', 'complete', 'released'];
  const result = {
    schemaVersion: 1,
    negotiationType: 'forge-execution/capability-negotiation',
    registryDigest: checked.registryDigest,
    requestedDemands,
    offers: normalizedOffers,
    demandDigest: canonicalExecutionCapabilityDigest(requestedDemands),
    offerDigest: canonicalExecutionCapabilityDigest(normalizedOffers),
    outcome,
    maximumTerminalOutcome: outcome === 'READY' ? 'COMPLETE' : 'BOUNDED_BLOCKED',
    firstBlockingStage,
    cannotClaim,
    capabilityResults,
    blockingGaps,
  };
  return freeze({ ...result, negotiationDigest: canonicalExecutionCapabilityDigest(result) });
}
