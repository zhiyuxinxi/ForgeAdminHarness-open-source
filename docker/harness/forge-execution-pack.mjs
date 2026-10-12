import {
  EXECUTION_PROOF_LEVELS,
  canonicalExecutionCapabilityDigest,
  canonicalExecutionCapabilityJson,
  validateExecutionCapabilityRegistry,
} from './forge-execution-capability-registry.mjs';
import {
  createCapabilityDemand,
  negotiateExecutionCapabilities,
} from './forge-capability-negotiator.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PACK_KEYS = [
  'contractId', 'demandProfileId', 'executionPackType', 'negotiation', 'packDigest',
  'registryDigest', 'schemaVersion', 'sourceFingerprint', 'taskId',
];

export class ForgeExecutionPackError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeExecutionPackError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeExecutionPackError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function packPayload(pack) {
  const { packDigest: _packDigest, ...payload } = pack;
  return payload;
}

function registryReport(registry) {
  if (!registry?.registryDigest && !registry?.dagOrder) return validateExecutionCapabilityRegistry(registry);
  const { registryDigest, dagOrder: _dagOrder, ...raw } = registry;
  const checked = validateExecutionCapabilityRegistry(raw);
  if (checked.registryDigest !== registryDigest) fail('EXECUTION_PACK_REGISTRY_MISMATCH', 'Registry digest does not match its canonical content.');
  return checked;
}

export function createExecutionPack({
  registry,
  demandProfileId,
  proofOverrides = {},
  offers,
  taskId,
  contractId,
  sourceFingerprint,
}) {
  const checked = registryReport(registry);
  if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) fail('EXECUTION_PACK_ID_INVALID', 'taskId is invalid.');
  if (typeof contractId !== 'string' || !SHA256.test(contractId)) fail('EXECUTION_PACK_DIGEST_INVALID', 'contractId must be a sha256 digest.');
  if (typeof sourceFingerprint !== 'string' || !SHA256.test(sourceFingerprint)) {
    fail('EXECUTION_PACK_DIGEST_INVALID', 'sourceFingerprint must be a sha256 digest.');
  }
  const demands = createCapabilityDemand(checked, demandProfileId, proofOverrides);
  const negotiation = negotiateExecutionCapabilities({ registry: checked, demands, offers });
  const payload = {
    schemaVersion: 1,
    executionPackType: 'forge-execution/capability-pack',
    taskId,
    contractId,
    sourceFingerprint,
    registryDigest: checked.registryDigest,
    demandProfileId,
    negotiation,
  };
  return deepFreeze({ ...payload, packDigest: canonicalExecutionCapabilityDigest(payload) });
}

export function verifyExecutionPack(pack, registry) {
  try {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return false;
    const actual = Object.keys(pack).sort();
    const expected = [...PACK_KEYS].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return false;
    const checked = registryReport(registry);
    if (pack.schemaVersion !== 1 || pack.executionPackType !== 'forge-execution/capability-pack') return false;
    if (pack.registryDigest !== checked.registryDigest || !SHA256.test(pack.packDigest ?? '')) return false;
    if (typeof pack.taskId !== 'string' || !SAFE_ID.test(pack.taskId)
      || !SHA256.test(pack.contractId ?? '') || !SHA256.test(pack.sourceFingerprint ?? '')) return false;
    const expectedDemands = createCapabilityDemand(checked, pack.demandProfileId);
    const requestedDemands = pack.negotiation?.requestedDemands;
    if (!Array.isArray(requestedDemands) || requestedDemands.length !== expectedDemands.length) return false;
    const requestedById = new Map(requestedDemands.map((item) => [item.capabilityId, item]));
    if (requestedById.size !== requestedDemands.length || expectedDemands.some((expected) => {
      const requested = requestedById.get(expected.capabilityId);
      return !requested || EXECUTION_PROOF_LEVELS.indexOf(requested.minimumProofLevel)
        < EXECUTION_PROOF_LEVELS.indexOf(expected.minimumProofLevel);
    })) return false;
    if (canonicalExecutionCapabilityDigest(packPayload(pack)) !== pack.packDigest) return false;
    const negotiation = pack.negotiation;
    if (!negotiation || negotiation.registryDigest !== checked.registryDigest) return false;
    const { negotiationDigest, ...negotiationPayload } = negotiation;
    if (!SHA256.test(negotiationDigest ?? '')
      || canonicalExecutionCapabilityDigest(negotiationPayload) !== negotiationDigest) return false;
    const replayed = negotiateExecutionCapabilities({
      registry: checked,
      demands: negotiation.requestedDemands,
      offers: negotiation.offers,
    });
    if (canonicalExecutionCapabilityJson(replayed) !== canonicalExecutionCapabilityJson(negotiation)) return false;
    return canonicalExecutionCapabilityJson(pack) === canonicalExecutionCapabilityJson(JSON.parse(JSON.stringify(pack)));
  } catch {
    return false;
  }
}
