import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/forge-workflow-migration-safety/valid.json' with { type: 'json' };
import {
  ForgeWorkflowMigrationError,
  applyForgeWorkflowCallback,
  createForgeWorkflowCallbackLedger,
  evaluateForgeWorkflowInflightMigration,
  parseForgeWorkflowInventoryObservation,
  sealForgeWorkflowDefinition,
  validateForgeWorkflowInventoryObservation,
} from '../docker/harness/forge-workflow-migration-safety.mjs';

const protectedInventory = { verifyProtectedWorkflowInventory: async ({ attestation }) => attestation.protected === true };
const clone = (value) => structuredClone(value);
const expectCode = (code, callback) => assert.throws(callback, (error) => {
  assert.ok(error instanceof ForgeWorkflowMigrationError);
  assert.equal(error.code, code);
  return true;
});

function observedInventory() {
  return { schemaVersion: 1, observationType: 'forge-workflow/engine-inventory-observation',
    capturedAt: '2026-10-02T03:00:00.000Z',
    definition: { processKey: 'purchase', definitionId: 'purchase:1:definition', version: 1,
      bpmnSha256: `sha256:${'a'.repeat(64)}`, nodeKeys: ['start', 'approve', 'end'] },
    instances: [{ instanceId: 'instance-1', definitionId: 'purchase:1:definition', definitionVersion: 1,
      businessKey: 'purchase:1', currentNodeKey: 'approve', state: 'active' }] };
}
const inventoryLine = value => `FORGE_WORKFLOW_INVENTORY_V1:${Buffer.from(JSON.stringify(value)).toString('base64')}`;

test('inventory observation parses one bounded engine claim without granting authority', () => {
  const result = parseForgeWorkflowInventoryObservation(`build output\r\n${inventoryLine(observedInventory())}\r\nBUILD SUCCESS\n`);
  assert.equal(result.instances[0].instanceId, 'instance-1');
  assert.deepEqual(result.definition.nodeKeys, ['approve', 'end', 'start']);
  assert.ok(Object.isFrozen(result.instances[0]));
  assert.equal(Object.hasOwn(result, 'protected'), false);
  assert.equal(parseForgeWorkflowInventoryObservation('BUILD SUCCESS'), null);
});

test('inventory observation rejects mismatched engine identity and injected authority', () => {
  for (const mutate of [
    value => { value.instances[0].definitionId = 'other'; },
    value => { value.instances[0].definitionVersion = 2; },
    value => { value.instances[0].currentNodeKey = 'missing'; },
    value => { value.instances.push(structuredClone(value.instances[0])); },
    value => { value.instances[0].state = 'completed'; },
    value => { value.protected = true; },
  ]) {
    const value = observedInventory(); mutate(value);
    assert.throws(() => validateForgeWorkflowInventoryObservation(value), ForgeWorkflowMigrationError);
  }
});

test('inventory observation rejects duplicate markers, invalid encoding and oversized payloads', () => {
  const line = inventoryLine(observedInventory());
  for (const log of [`${line}\n${line}`, 'FORGE_WORKFLOW_INVENTORY_V1:!!!',
    'FORGE_WORKFLOW_INVENTORY_V1:/w==', `FORGE_WORKFLOW_INVENTORY_V1:${'A'.repeat(350000)}`]) {
    expectCode('INVENTORY_OBSERVATION_INVALID', () => parseForgeWorkflowInventoryObservation(log));
  }
});
function evaluationInput() {
  return {
    baselineDefinition: sealForgeWorkflowDefinition(clone(fixture.baselineDefinition)),
    candidateDefinition: sealForgeWorkflowDefinition(clone(fixture.candidateDefinition)),
    instanceInventory: clone(fixture.instanceInventory),
    inventoryAttestation: clone(fixture.inventoryAttestation),
    plan: clone(fixture.plan),
  };
}

test('protected compatible migration is safe planning evidence but never deploy authority', async () => {
  const result = await evaluateForgeWorkflowInflightMigration(evaluationInput(), protectedInventory);
  assert.equal(result.status, 'migration-safe-not-deploy-authority');
  assert.equal(result.migrationSafe, true);
  assert.equal(result.deployAuthorized, false);
  assert.equal(result.requiresProtectedDeploymentAndInstanceCas, true);
  assert.match(result.planDigest, /^sha256:[0-9a-f]{64}$/u);
});
test('published definitions are immutable and candidates must advance identity and version', async () => {
  const input = evaluationInput();
  const overwrite = clone(fixture.candidateDefinition);
  overwrite.definitionId = fixture.baselineDefinition.definitionId;
  overwrite.version = fixture.baselineDefinition.version;
  input.candidateDefinition = sealForgeWorkflowDefinition(overwrite);
  assert.equal((await evaluateForgeWorkflowInflightMigration(input, protectedInventory)).reasonCode, 'PUBLISHED_DEFINITION_OVERWRITE');
});

test('protected live-instance evidence is mandatory and mapping is exact', async () => {
  const missingVerifier = await evaluateForgeWorkflowInflightMigration(evaluationInput());
  assert.equal(missingVerifier.reasonCode, 'PROTECTED_INSTANCE_INVENTORY_REQUIRED');
  const unmapped = evaluationInput(); unmapped.plan.mappings = [];
  assert.equal((await evaluateForgeWorkflowInflightMigration(unmapped, protectedInventory)).reasonCode, 'INFLIGHT_INSTANCE_UNMAPPED');
  const incompatible = evaluationInput(); incompatible.plan.mappings[0].toNodeKey = 'deletedNode';
  assert.equal((await evaluateForgeWorkflowInflightMigration(incompatible, protectedInventory)).reasonCode, 'INSTANCE_MAPPING_INCOMPATIBLE');
});

test('keep-version and drain strategies retain the published source definition', async () => {
  const keep = evaluationInput(); keep.plan.strategy = 'keep-on-version'; keep.plan.mappings = [];
  assert.equal((await evaluateForgeWorkflowInflightMigration(keep, protectedInventory)).migrationSafe, true);
  keep.plan.retainSourceDefinition = false;
  assert.equal((await evaluateForgeWorkflowInflightMigration(keep, protectedInventory)).reasonCode, 'KEEP_VERSION_PLAN_INVALID');

  const drain = evaluationInput(); drain.plan.strategy = 'drain-before-cutover'; drain.plan.mappings = []; drain.plan.newInstanceAdmission = 'closed';
  assert.equal((await evaluateForgeWorkflowInflightMigration(drain, protectedInventory)).migrationSafe, true);
  drain.plan.newInstanceAdmission = 'open';
  assert.equal((await evaluateForgeWorkflowInflightMigration(drain, protectedInventory)).reasonCode, 'DRAIN_PLAN_INVALID');
});

test('callback idempotency ledger distinguishes first, duplicate, and collision outcomes', () => {
  const ledger = createForgeWorkflowCallbackLedger(clone(fixture.ledger));
  const first = applyForgeWorkflowCallback(ledger, clone(fixture.callback));
  assert.equal(first.outcome, 'first-seen-not-side-effect-authority');
  assert.equal(first.sideEffectAuthorized, false);
  assert.equal(first.cas.nextRevision, 1);

  const duplicate = applyForgeWorkflowCallback(first.ledger, { ...clone(fixture.callback), expectedRevision: 1 });
  assert.equal(duplicate.outcome, 'duplicate-no-op-success');
  assert.equal(duplicate.cas, null);
  const collision = { ...clone(fixture.callback), expectedRevision: 1, payloadSha256: `sha256:${'f'.repeat(64)}` };
  expectCode('CALLBACK_IDEMPOTENCY_COLLISION', () => applyForgeWorkflowCallback(first.ledger, collision));
});

test('callback ledger rejects stale CAS and independently malformed entries', () => {
  const ledger = createForgeWorkflowCallbackLedger(clone(fixture.ledger));
  const first = applyForgeWorkflowCallback(ledger, clone(fixture.callback));
  expectCode('LEDGER_CAS_CONFLICT', () => applyForgeWorkflowCallback(first.ledger, clone(fixture.callback)));
  const tampered = clone(first.ledger);
  tampered.entries[0].idempotencyKey = `sha256:${'0'.repeat(64)}`;
  expectCode('LEDGER_ENTRY_INTEGRITY_INVALID', () => applyForgeWorkflowCallback(tampered, { ...clone(fixture.callback), expectedRevision: 1 }));
});

test('callback policy must bind the complete idempotency key and retention contract', () => {
  const ledger = clone(fixture.ledger);
  ledger.callbackPolicy.idempotencyKeyFields = ['eventId', 'instanceId'];
  expectCode('CALLBACK_POLICY_INVALID', () => createForgeWorkflowCallbackLedger(ledger));
});
