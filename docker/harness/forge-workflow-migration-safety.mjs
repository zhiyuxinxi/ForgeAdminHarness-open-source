import { createHash } from 'node:crypto';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUIRED_CALLBACK_FIELDS = ['eventId', 'instanceId', 'transition'];

export class ForgeWorkflowMigrationError extends Error {
  constructor(code, message) { super(message); this.name = 'ForgeWorkflowMigrationError'; this.code = code; }
}
function fail(code, message) { throw new ForgeWorkflowMigrationError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`); }
function safe(value, label, pattern = SAFE) { if (typeof value !== 'string' || !pattern.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`); return value; }
function timestamp(value, label) { const parsed = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('SCHEMA_INVALID', `${label} must be an ISO timestamp.`); return parsed; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!plain(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); }
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function freeze(value) { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function unique(value, label) { if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !SAFE.test(item)) || new Set(value).size !== value.length) fail('SCHEMA_INVALID', `${label} is invalid.`); return [...value].sort(); }

const INVENTORY_MARKER = 'FORGE_WORKFLOW_INVENTORY_V1:';
const MAX_INVENTORY_BYTES = 256 * 1024;

// This is a claim read from an integration run, not an attestation. Only the
// protected runner/issuer may bind it to reviewed source and signed evidence.
export function validateForgeWorkflowInventoryObservation(value) {
  exact(value, ['schemaVersion', 'observationType', 'capturedAt', 'definition', 'instances'], 'engine inventory observation');
  if (value.schemaVersion !== 1 || value.observationType !== 'forge-workflow/engine-inventory-observation') fail('INVENTORY_OBSERVATION_INVALID', 'Engine inventory observation type is unsupported.');
  timestamp(value.capturedAt, 'inventory capturedAt');
  const definition = value.definition;
  exact(definition, ['processKey', 'definitionId', 'version', 'bpmnSha256', 'nodeKeys'], 'observed engine definition');
  if (!Number.isSafeInteger(definition.version) || definition.version < 1
      || !Array.isArray(definition.nodeKeys) || definition.nodeKeys.length > 5000) fail('INVENTORY_OBSERVATION_INVALID', 'Observed definition version or node count is invalid.');
  const normalizedDefinition = {
    processKey: safe(definition.processKey, 'observed processKey'),
    definitionId: safe(definition.definitionId, 'observed definitionId'),
    version: definition.version,
    bpmnSha256: safe(definition.bpmnSha256, 'observed bpmnSha256', SHA256),
    nodeKeys: unique(definition.nodeKeys, 'observed nodeKeys'),
  };
  if (!Array.isArray(value.instances) || value.instances.length > 1000) fail('INVENTORY_OBSERVATION_INVALID', 'Observed instance count is invalid.');
  const observedInstances = value.instances.map(item => {
    exact(item, ['instanceId', 'definitionId', 'definitionVersion', 'businessKey', 'currentNodeKey', 'state'], 'observed engine instance');
    if (item.definitionId !== normalizedDefinition.definitionId
        || item.definitionVersion !== normalizedDefinition.version
        || !normalizedDefinition.nodeKeys.includes(item.currentNodeKey)
        || !['active', 'suspended'].includes(item.state)) fail('INVENTORY_OBSERVATION_INVALID', 'Observed instance is not bound to the observed running definition.');
    return { instanceId: safe(item.instanceId, 'observed instanceId'), definitionId: item.definitionId,
      definitionVersion: item.definitionVersion, businessKey: safe(item.businessKey, 'observed businessKey'),
      currentNodeKey: item.currentNodeKey, state: item.state };
  }).sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  if (new Set(observedInstances.map(item => item.instanceId)).size !== observedInstances.length) fail('INVENTORY_OBSERVATION_INVALID', 'Observed instance IDs are duplicated.');
  return freeze({ schemaVersion: 1, observationType: value.observationType, capturedAt: value.capturedAt,
    definition: normalizedDefinition, instances: observedInstances });
}

export function parseForgeWorkflowInventoryObservation(logText) {
  if (typeof logText !== 'string') fail('INVENTORY_OBSERVATION_INVALID', 'Execution log must be text.');
  const rows = logText.split(/\r?\n/u).filter(row => row.startsWith(INVENTORY_MARKER));
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail('INVENTORY_OBSERVATION_INVALID', 'Execution must emit exactly one inventory observation.');
  const encoded = rows[0].slice(INVENTORY_MARKER.length);
  if (encoded.length > Math.ceil(MAX_INVENTORY_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) fail('INVENTORY_OBSERVATION_INVALID', 'Inventory observation encoding is invalid.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_INVENTORY_BYTES || bytes.toString('base64') !== encoded) fail('INVENTORY_OBSERVATION_INVALID', 'Inventory observation encoding is not canonical.');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateForgeWorkflowInventoryObservation(JSON.parse(text));
  } catch (error) {
    if (error instanceof ForgeWorkflowMigrationError) throw error;
    fail('INVENTORY_OBSERVATION_INVALID', 'Inventory observation is not valid UTF-8 JSON.');
  }
}

export function sealForgeWorkflowDefinition(input) {
  exact(input, ['schemaVersion', 'definitionType', 'processKey', 'definitionId', 'version', 'status', 'bpmnSha256', 'bindingSha256', 'nodeKeys'], 'workflow definition');
  if (input.schemaVersion !== 1 || input.definitionType !== 'forge-workflow/definition' || !Number.isSafeInteger(input.version) || input.version < 1 || !['draft', 'published'].includes(input.status)) fail('SCHEMA_INVALID', 'workflow definition header is invalid.');
  const normalized = { schemaVersion: 1, definitionType: input.definitionType, processKey: safe(input.processKey, 'processKey'), definitionId: safe(input.definitionId, 'definitionId'), version: input.version, status: input.status, bpmnSha256: safe(input.bpmnSha256, 'bpmnSha256', SHA256), bindingSha256: safe(input.bindingSha256, 'bindingSha256', SHA256), nodeKeys: unique(input.nodeKeys, 'nodeKeys') };
  return freeze({ ...normalized, definitionDigest: digest(normalized) });
}
function definition(value) { exact(value, ['schemaVersion', 'definitionType', 'processKey', 'definitionId', 'version', 'status', 'bpmnSha256', 'bindingSha256', 'nodeKeys', 'definitionDigest'], 'sealed workflow definition'); const { definitionDigest, ...input } = value; const sealed = sealForgeWorkflowDefinition(input); if (sealed.definitionDigest !== definitionDigest) fail('DEFINITION_INTEGRITY_INVALID', 'workflow definition digest is invalid.'); return sealed; }

function instances(value, baseline) {
  if (!Array.isArray(value)) fail('SCHEMA_INVALID', 'instances must be an array.');
  const normalized = value.map((item) => { exact(item, ['instanceId', 'definitionId', 'definitionVersion', 'currentNodeKey', 'state'], 'workflow instance'); if (!Number.isSafeInteger(item.definitionVersion) || item.definitionVersion < 1 || !['active', 'suspended', 'completed'].includes(item.state)) fail('SCHEMA_INVALID', 'workflow instance is invalid.'); if (item.definitionId !== baseline.definitionId || item.definitionVersion !== baseline.version || !baseline.nodeKeys.includes(item.currentNodeKey)) fail('INSTANCE_BINDING_INVALID', `Instance is not bound to the baseline definition: ${String(item.instanceId)}`); return { instanceId: safe(item.instanceId, 'instanceId'), definitionId: item.definitionId, definitionVersion: item.definitionVersion, currentNodeKey: item.currentNodeKey, state: item.state }; }).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  if (new Set(normalized.map((item) => item.instanceId)).size !== normalized.length) fail('SCHEMA_INVALID', 'workflow instances contain duplicates.');
  return normalized;
}
function callbackPolicy(value) {
  exact(value, ['idempotencyKeyFields', 'duplicateOutcome', 'retentionSeconds', 'storeOwner', 'transactionOwner'], 'callback policy');
  const fields = unique(value.idempotencyKeyFields, 'idempotencyKeyFields');
  if (JSON.stringify(fields) !== JSON.stringify(REQUIRED_CALLBACK_FIELDS) || value.duplicateOutcome !== 'no-op-success' || !Number.isSafeInteger(value.retentionSeconds) || value.retentionSeconds < 86400) fail('CALLBACK_POLICY_INVALID', 'callback idempotency policy is incomplete.');
  return { idempotencyKeyFields: fields, duplicateOutcome: value.duplicateOutcome, retentionSeconds: value.retentionSeconds, storeOwner: safe(value.storeOwner, 'storeOwner'), transactionOwner: safe(value.transactionOwner, 'transactionOwner') };
}
function migrationPlan(value) {
  exact(value, ['schemaVersion', 'planType', 'planId', 'strategy', 'sourceDefinitionId', 'targetDefinitionId', 'retainSourceDefinition', 'newInstanceAdmission', 'mappings', 'callbackPolicy', 'rollbackStrategy'], 'workflow migration plan');
  if (value.schemaVersion !== 1 || value.planType !== 'forge-workflow/inflight-migration-plan' || !['keep-on-version', 'migrate-compatible', 'drain-before-cutover'].includes(value.strategy) || typeof value.retainSourceDefinition !== 'boolean' || !['open', 'closed'].includes(value.newInstanceAdmission)) fail('SCHEMA_INVALID', 'workflow migration plan header is invalid.');
  if (!Array.isArray(value.mappings)) fail('SCHEMA_INVALID', 'workflow migration mappings are invalid.');
  const mappings = value.mappings.map((item) => { exact(item, ['instanceId', 'fromNodeKey', 'toNodeKey'], 'workflow migration mapping'); return { instanceId: safe(item.instanceId, 'mapping.instanceId'), fromNodeKey: safe(item.fromNodeKey, 'mapping.fromNodeKey'), toNodeKey: safe(item.toNodeKey, 'mapping.toNodeKey') }; }).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  if (new Set(mappings.map((item) => item.instanceId)).size !== mappings.length) fail('SCHEMA_INVALID', 'workflow migration mappings contain duplicates.');
  return { schemaVersion: 1, planType: value.planType, planId: safe(value.planId, 'planId', UUID), strategy: value.strategy, sourceDefinitionId: safe(value.sourceDefinitionId, 'sourceDefinitionId'), targetDefinitionId: safe(value.targetDefinitionId, 'targetDefinitionId'), retainSourceDefinition: value.retainSourceDefinition, newInstanceAdmission: value.newInstanceAdmission, mappings, callbackPolicy: callbackPolicy(value.callbackPolicy), rollbackStrategy: safe(value.rollbackStrategy, 'rollbackStrategy') };
}
function blocked(reasonCode) { return freeze({ status: 'blocked', reasonCode, migrationSafe: false, deployAuthorized: false }); }

export async function evaluateForgeWorkflowInflightMigration(input, protectedContext = {}) {
  exact(input, ['baselineDefinition', 'candidateDefinition', 'instanceInventory', 'inventoryAttestation', 'plan'], 'workflow migration evaluation');
  const baseline = definition(input.baselineDefinition); const candidate = definition(input.candidateDefinition); const plan = migrationPlan(input.plan); const inventory = instances(input.instanceInventory, baseline);
  if (baseline.status !== 'published') return blocked('BASELINE_NOT_PUBLISHED');
  if (candidate.processKey !== baseline.processKey || candidate.status !== 'draft') return blocked('CANDIDATE_BINDING_INVALID');
  if (candidate.definitionId === baseline.definitionId || candidate.version <= baseline.version) return blocked('PUBLISHED_DEFINITION_OVERWRITE');
  if (candidate.definitionDigest === baseline.definitionDigest || candidate.bpmnSha256 === baseline.bpmnSha256 && candidate.bindingSha256 === baseline.bindingSha256) return blocked('CANDIDATE_HAS_NO_VERSIONED_CHANGE');
  if (plan.sourceDefinitionId !== baseline.definitionId || plan.targetDefinitionId !== candidate.definitionId) return blocked('PLAN_DEFINITION_STALE');
  if (typeof protectedContext.verifyProtectedWorkflowInventory !== 'function') return blocked('PROTECTED_INSTANCE_INVENTORY_REQUIRED');
  let verified = false;
  try { verified = await protectedContext.verifyProtectedWorkflowInventory({ baselineDefinition: baseline, instances: inventory, attestation: input.inventoryAttestation }); } catch { return blocked('PROTECTED_INSTANCE_INVENTORY_FAILED'); }
  if (verified !== true) return blocked('PROTECTED_INSTANCE_INVENTORY_FAILED');
  const inflight = inventory.filter((item) => item.state !== 'completed');
  if (plan.strategy === 'keep-on-version') {
    if (!plan.retainSourceDefinition || plan.mappings.length !== 0) return blocked('KEEP_VERSION_PLAN_INVALID');
  } else if (plan.strategy === 'drain-before-cutover') {
    if (!plan.retainSourceDefinition || plan.newInstanceAdmission !== 'closed' || plan.mappings.length !== 0) return blocked('DRAIN_PLAN_INVALID');
  } else {
    if (!plan.retainSourceDefinition) return blocked('MIGRATION_PLAN_INVALID');
    if (plan.mappings.length !== inflight.length) return blocked('INFLIGHT_INSTANCE_UNMAPPED');
    const byId = new Map(inflight.map((item) => [item.instanceId, item]));
    for (const mapping of plan.mappings) {
      const instance = byId.get(mapping.instanceId);
      if (!instance || instance.currentNodeKey !== mapping.fromNodeKey || !candidate.nodeKeys.includes(mapping.toNodeKey)) return blocked('INSTANCE_MAPPING_INCOMPATIBLE');
    }
  }
  return freeze({ status: 'migration-safe-not-deploy-authority', reasonCode: 'INFLIGHT_MIGRATION_PLAN_VALID', migrationSafe: true, deployAuthorized: false, requiresProtectedDeploymentAndInstanceCas: true, baselineDefinitionDigest: baseline.definitionDigest, candidateDefinitionDigest: candidate.definitionDigest, inventoryDigest: digest(inventory), planDigest: digest(plan), callbackPolicyDigest: digest(plan.callbackPolicy) });
}

export function createForgeWorkflowCallbackLedger(input) {
  exact(input, ['schemaVersion', 'ledgerType', 'projectSlug', 'processKey', 'callbackPolicy'], 'callback ledger input');
  const normalized = { schemaVersion: 1, ledgerType: input.ledgerType, projectSlug: safe(input.projectSlug, 'projectSlug'), processKey: safe(input.processKey, 'processKey'), callbackPolicy: callbackPolicy(input.callbackPolicy), revision: 0, entries: [] };
  if (input.schemaVersion !== 1 || input.ledgerType !== 'forge-workflow/callback-ledger') fail('SCHEMA_INVALID', 'callback ledger header is invalid.');
  return freeze({ ...normalized, ledgerDigest: digest(normalized) });
}
function ledger(value) {
  exact(value, ['schemaVersion', 'ledgerType', 'projectSlug', 'processKey', 'callbackPolicy', 'revision', 'entries', 'ledgerDigest'], 'callback ledger');
  if (value.schemaVersion !== 1 || value.ledgerType !== 'forge-workflow/callback-ledger' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries)) fail('SCHEMA_INVALID', 'callback ledger is invalid.');
  safe(value.projectSlug, 'projectSlug'); safe(value.processKey, 'processKey'); callbackPolicy(value.callbackPolicy);
  const normalizedEntries = value.entries.map((entry) => {
    exact(entry, ['idempotencyKey', 'eventId', 'instanceId', 'transition', 'payloadSha256', 'receivedAt'], 'callback ledger entry');
    const keyFacts = { eventId: safe(entry.eventId, 'entry.eventId'), instanceId: safe(entry.instanceId, 'entry.instanceId'), transition: safe(entry.transition, 'entry.transition') };
    if (safe(entry.idempotencyKey, 'entry.idempotencyKey', SHA256) !== digest(keyFacts)) fail('LEDGER_ENTRY_INTEGRITY_INVALID', 'callback ledger entry idempotency key is invalid.');
    safe(entry.payloadSha256, 'entry.payloadSha256', SHA256); timestamp(entry.receivedAt, 'entry.receivedAt');
    return entry;
  });
  if (new Set(normalizedEntries.map((entry) => entry.idempotencyKey)).size !== normalizedEntries.length) fail('LEDGER_ENTRY_INTEGRITY_INVALID', 'callback ledger contains duplicate idempotency keys.');
  const unsigned = { ...value }; delete unsigned.ledgerDigest;
  if (digest(unsigned) !== value.ledgerDigest) fail('LEDGER_INTEGRITY_INVALID', 'callback ledger digest is invalid.');
  return value;
}
export function applyForgeWorkflowCallback(ledgerInput, input) {
  const current = ledger(ledgerInput); exact(input, ['expectedRevision', 'instanceId', 'eventId', 'transition', 'payloadSha256', 'receivedAt'], 'callback event'); if (input.expectedRevision !== current.revision) fail('LEDGER_CAS_CONFLICT', 'callback ledger revision is stale.'); timestamp(input.receivedAt, 'receivedAt');
  const keyFacts = { eventId: safe(input.eventId, 'eventId'), instanceId: safe(input.instanceId, 'instanceId'), transition: safe(input.transition, 'transition') }; const idempotencyKey = digest(keyFacts); const payloadSha256 = safe(input.payloadSha256, 'payloadSha256', SHA256); const existing = current.entries.find((item) => item.idempotencyKey === idempotencyKey);
  if (existing) { if (existing.payloadSha256 !== payloadSha256) fail('CALLBACK_IDEMPOTENCY_COLLISION', 'Callback idempotency key was reused with a different payload.'); return freeze({ outcome: 'duplicate-no-op-success', ledger: current, cas: null, sideEffectAuthorized: false }); }
  const entry = { idempotencyKey, ...keyFacts, payloadSha256, receivedAt: input.receivedAt }; const unsigned = { ...current, revision: current.revision + 1, entries: [...current.entries, entry].sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey)) }; delete unsigned.ledgerDigest; const next = freeze({ ...unsigned, ledgerDigest: digest(unsigned) }); return freeze({ outcome: 'first-seen-not-side-effect-authority', ledger: next, cas: { expectedRevision: current.revision, expectedDigest: current.ledgerDigest, nextRevision: next.revision, nextDigest: next.ledgerDigest }, sideEffectAuthorized: false });
}
