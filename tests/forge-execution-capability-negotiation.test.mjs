import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ForgeExecutionCapabilityRegistryError,
  canonicalExecutionCapabilityDigest,
  loadCurrentExecutionCapabilityRegistry,
  validateExecutionCapabilityRegistry,
} from '../docker/harness/forge-execution-capability-registry.mjs';
import {
  ForgeCapabilityNegotiationError,
  createCapabilityDemand,
  negotiateExecutionCapabilities,
} from '../docker/harness/forge-capability-negotiator.mjs';
import {
  createExecutionPack,
  verifyExecutionPack,
} from '../docker/harness/forge-execution-pack.mjs';

const DIGEST = (character) => `sha256:${character.repeat(64)}`;

async function rawRegistry() {
  return JSON.parse(await readFile(
    new URL('../docker/harness/forge-execution-capability-registry.json', import.meta.url),
    'utf8',
  ));
}

function availableOffers(registry) {
  return registry.capabilities.map((capability, index) => ({
    capabilityId: capability.capabilityId,
    status: 'available',
    proofLevel: capability.minimumProofLevel,
    evidenceDigests: [DIGEST((index % 10).toString())],
    reasonCode: null,
  }));
}

function replaceOffer(offers, capabilityId, replacement) {
  return offers.map((offer) => offer.capabilityId === capabilityId ? { ...offer, ...replacement } : offer);
}

function expectRegistryCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeExecutionCapabilityRegistryError);
    assert.equal(error.code, code);
    return true;
  });
}

function expectNegotiationCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeCapabilityNegotiationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('current execution capability registry is a canonical acyclic Demand graph', async () => {
  const report = await loadCurrentExecutionCapabilityRegistry();
  assert.equal(report.schemaVersion, 1);
  assert.match(report.registryDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(report.dagOrder.length, report.capabilities.length);
  assert.equal(new Set(report.dagOrder).size, report.capabilities.length);
  assert.ok(Object.isFrozen(report));
  assert.deepEqual(
    report.capabilities.find((item) => item.capabilityId === 'verification.red-executor')?.dependsOn,
    ['verification.batch-admission', 'workspace.write'],
  );
  assert.ok(
    report.demandProfiles.find((item) => item.profileId === 'workspace-change')
      ?.capabilityIds.includes('verification.red-executor'),
  );

  const raw = await rawRegistry();
  const reordered = structuredClone(raw);
  reordered.capabilities.reverse();
  reordered.demandProfiles.reverse();
  assert.equal(
    validateExecutionCapabilityRegistry(reordered).registryDigest,
    report.registryDigest,
    'registry digest must not depend on set-like input ordering',
  );
});

test('packaged registry loader resolves the immutable JSON from /usr/local/share layout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-capability-package-'));
  try {
    const local = path.join(root, 'usr', 'local');
    await mkdir(path.join(local, 'lib'), { recursive: true });
    await mkdir(path.join(local, 'share'), { recursive: true });
    await copyFile(
      new URL('../docker/harness/forge-execution-capability-registry.mjs', import.meta.url),
      path.join(local, 'lib', 'forge-execution-capability-registry.mjs'),
    );
    await copyFile(
      new URL('../docker/harness/forge-execution-capability-registry.json', import.meta.url),
      path.join(local, 'share', 'forge-execution-capability-registry.json'),
    );
    const packaged = await import(`${new URL(`file:///${path.join(local, 'lib', 'forge-execution-capability-registry.mjs').replaceAll('\\', '/')}`).href}?package-layout-test=1`);
    const report = await packaged.loadCurrentExecutionCapabilityRegistry();
    assert.equal(report.registryDigest, (await loadCurrentExecutionCapabilityRegistry()).registryDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registry rejects unknown dependencies, DAG cycles, stage inversion, and unknown fields', async () => {
  const raw = await rawRegistry();
  const unknown = structuredClone(raw);
  unknown.capabilities.find((item) => item.capabilityId === 'workspace.read').dependsOn = ['missing.capability'];
  expectRegistryCode('EXECUTION_CAPABILITY_DEPENDENCY_UNKNOWN', () => validateExecutionCapabilityRegistry(unknown));

  const cycle = structuredClone(raw);
  cycle.capabilities.find((item) => item.capabilityId === 'contract.task-intent').dependsOn = ['workspace.read'];
  expectRegistryCode('EXECUTION_CAPABILITY_DAG_CYCLE', () => validateExecutionCapabilityRegistry(cycle));

  const inversion = structuredClone(raw);
  inversion.capabilities.find((item) => item.capabilityId === 'workspace.read').dependsOn = ['workspace.write'];
  expectRegistryCode('EXECUTION_CAPABILITY_STAGE_INVERSION', () => validateExecutionCapabilityRegistry(inversion));

  const unsupported = structuredClone(raw);
  unsupported.capabilities[0].assumeAvailable = true;
  expectRegistryCode('EXECUTION_CAPABILITY_UNSUPPORTED_FIELD', () => validateExecutionCapabilityRegistry(unsupported));
});

test('complete proven Offers satisfy a workspace-change Demand and permit COMPLETE as the maximum outcome', async () => {
  const registry = await loadCurrentExecutionCapabilityRegistry();
  const demands = createCapabilityDemand(registry, 'workspace-change');
  const result = negotiateExecutionCapabilities({
    registry,
    demands,
    offers: availableOffers(registry),
  });

  assert.equal(result.outcome, 'READY');
  assert.equal(result.maximumTerminalOutcome, 'COMPLETE');
  assert.equal(result.firstBlockingStage, null);
  assert.deepEqual(result.cannotClaim, []);
  assert.deepEqual(result.blockingGaps, []);
  assert.match(result.negotiationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(result.capabilityResults.every((item) => item.satisfied));
});

test('missing or unknown DISCOVER Offer fails closed as BOUNDED_BLOCKED', async () => {
  const registry = await loadCurrentExecutionCapabilityRegistry();
  const demands = createCapabilityDemand(registry, 'read-only-analysis');
  const offers = availableOffers(registry).filter((offer) => offer.capabilityId !== 'workspace.read');
  const missing = negotiateExecutionCapabilities({ registry, demands, offers });

  assert.equal(missing.outcome, 'BOUNDED_BLOCKED');
  assert.equal(missing.firstBlockingStage, 'DISCOVER');
  assert.equal(missing.maximumTerminalOutcome, 'BOUNDED_BLOCKED');
  assert.ok(missing.cannotClaim.includes('analyzed'));
  assert.equal(missing.blockingGaps.find((item) => item.capabilityId === 'workspace.read').reasonCode, 'OFFER_MISSING');

  const unknown = negotiateExecutionCapabilities({
    registry,
    demands,
    offers: replaceOffer(availableOffers(registry), 'workspace.read', {
      status: 'unknown', proofLevel: null, evidenceDigests: [], reasonCode: 'PROBE_NOT_RUN',
    }),
  });
  assert.equal(unknown.outcome, 'BOUNDED_BLOCKED');
  assert.equal(unknown.blockingGaps.find((item) => item.capabilityId === 'workspace.read').offeredStatus, 'unknown');
});

test('partial and planned post-discovery Offers preserve read-only analysis but prohibit implementation claims', async () => {
  const registry = await loadCurrentExecutionCapabilityRegistry();
  const demands = createCapabilityDemand(registry, 'workspace-change');
  for (const [capabilityId, status, reasonCode] of [
    ['workspace.write', 'partial', 'WRITER_RESERVATION_UNPROVEN'],
    ['verification.red-executor', 'planned', 'RED_EXECUTOR_NOT_PROVEN'],
    ['verification.controlled-executor', 'planned', 'RUNNER_NOT_DEPLOYED'],
  ]) {
    const offers = replaceOffer(availableOffers(registry), capabilityId, {
      status, proofLevel: status === 'partial' ? 'static' : null, evidenceDigests: [], reasonCode,
    });
    const result = negotiateExecutionCapabilities({ registry, demands, offers });
    assert.equal(result.outcome, 'READ_ONLY_DEGRADED');
    assert.equal(result.maximumTerminalOutcome, 'BOUNDED_BLOCKED');
    assert.ok(!result.cannotClaim.includes('analyzed'));
    assert.ok(result.cannotClaim.includes('implemented'));
    assert.ok(result.cannotClaim.includes('complete'));
    assert.equal(result.blockingGaps.find((item) => item.capabilityId === capabilityId).offeredStatus, status);
  }
});

test('proof shortfall and dependency failure are explicit even when a dependent falsely claims availability', async () => {
  const registry = await loadCurrentExecutionCapabilityRegistry();
  const demands = createCapabilityDemand(registry, 'workspace-change');
  let offers = replaceOffer(availableOffers(registry), 'acceptance.independent-verdict', {
    proofLevel: 'runtime',
  });
  let result = negotiateExecutionCapabilities({ registry, demands, offers });
  assert.equal(result.outcome, 'READ_ONLY_DEGRADED');
  assert.equal(
    result.blockingGaps.find((item) => item.capabilityId === 'acceptance.independent-verdict').reasonCode,
    'PROOF_LEVEL_INSUFFICIENT',
  );

  offers = replaceOffer(availableOffers(registry), 'verification.batch-admission', {
    status: 'unknown', proofLevel: null, evidenceDigests: [], reasonCode: 'ADMISSION_NOT_ISSUED',
  });
  result = negotiateExecutionCapabilities({ registry, demands, offers });
  assert.equal(
    result.blockingGaps.find((item) => item.capabilityId === 'verification.controlled-executor').reasonCode,
    'DEPENDENCY_UNAVAILABLE',
  );
  assert.equal(
    result.blockingGaps.find((item) => item.capabilityId === 'acceptance.independent-verdict').reasonCode,
    'DEPENDENCY_UNAVAILABLE',
  );
});

test('Offer schema refuses optimistic available claims without typed proof evidence', async () => {
  const registry = await loadCurrentExecutionCapabilityRegistry();
  const demands = createCapabilityDemand(registry, 'read-only-analysis');
  const falseAvailable = replaceOffer(availableOffers(registry), 'workspace.read', {
    proofLevel: null, evidenceDigests: [],
  });
  expectNegotiationCode('CAPABILITY_OFFER_FALSE_AVAILABLE', () => negotiateExecutionCapabilities({
    registry, demands, offers: falseAvailable,
  }));

  const inventedField = availableOffers(registry);
  inventedField[0].confidence = 0.99;
  expectNegotiationCode('CAPABILITY_NEGOTIATION_UNSUPPORTED_FIELD', () => negotiateExecutionCapabilities({
    registry, demands, offers: inventedField,
  }));
});

test('execution pack binds task, contract, source, registry, Demand, Offers, and negotiation digest', async () => {
  const registry = await loadCurrentExecutionCapabilityRegistry();
  const pack = createExecutionPack({
    registry,
    demandProfileId: 'workspace-change',
    offers: availableOffers(registry),
    taskId: 'task-001',
    contractId: DIGEST('a'),
    sourceFingerprint: DIGEST('b'),
  });
  assert.equal(pack.negotiation.outcome, 'READY');
  assert.equal(verifyExecutionPack(pack, registry), true);
  assert.equal(pack.packDigest, canonicalExecutionCapabilityDigest({
    schemaVersion: pack.schemaVersion,
    executionPackType: pack.executionPackType,
    taskId: pack.taskId,
    contractId: pack.contractId,
    sourceFingerprint: pack.sourceFingerprint,
    registryDigest: pack.registryDigest,
    demandProfileId: pack.demandProfileId,
    negotiation: pack.negotiation,
  }));

  const tamperedSource = structuredClone(pack);
  tamperedSource.sourceFingerprint = DIGEST('c');
  assert.equal(verifyExecutionPack(tamperedSource, registry), false);

  const tamperedOutcome = structuredClone(pack);
  tamperedOutcome.negotiation.outcome = 'READ_ONLY_DEGRADED';
  assert.equal(verifyExecutionPack(tamperedOutcome, registry), false);

  const recalculatedForgery = structuredClone(pack);
  recalculatedForgery.negotiation.outcome = 'READ_ONLY_DEGRADED';
  const { negotiationDigest: _oldNegotiationDigest, ...forgedNegotiationPayload } = recalculatedForgery.negotiation;
  recalculatedForgery.negotiation.negotiationDigest = canonicalExecutionCapabilityDigest(forgedNegotiationPayload);
  const { packDigest: _oldPackDigest, ...forgedPackPayload } = recalculatedForgery;
  recalculatedForgery.packDigest = canonicalExecutionCapabilityDigest(forgedPackPayload);
  assert.equal(
    verifyExecutionPack(recalculatedForgery, registry),
    false,
    'recomputing hashes cannot turn a semantically inconsistent result into a valid pack',
  );

  const stricterPack = createExecutionPack({
    registry,
    demandProfileId: 'read-only-analysis',
    proofOverrides: { 'workspace.read': 'independent' },
    offers: replaceOffer(availableOffers(registry), 'workspace.read', { proofLevel: 'independent' }),
    taskId: 'task-002',
    contractId: DIGEST('d'),
    sourceFingerprint: DIGEST('e'),
  });
  assert.equal(verifyExecutionPack(stricterPack, registry), true);
});
