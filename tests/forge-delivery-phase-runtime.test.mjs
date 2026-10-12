import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ForgeDeliveryPhaseError,
  beginForgeDeliveryPhase,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState,
  describeForgeDeliveryPhaseWorkflow,
  FORGE_DELIVERY_PHASE_STATE_SCHEMA,
  FORGE_READONLY_ROLE_RECOVERY_RECEIPT_SCHEMA,
  FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA,
  projectCompletedForgeDeliveryPhaseExecution,
  readForgeDeliveryPhaseState,
  resolveForgeDeliveryPhase,
  recordForgeStaleWriteRecovery,
  recordForgeReadonlyRoleRecovery,
  validateForgeDeliveryPhaseCatalog,
  validateForgeDeliveryPhaseExecutionProjection,
  validateForgeDeliveryPhaseState,
  withForgeDeliveryPhaseStateLock,
  writeForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { canonicalStringify } from '../docker/harness/forge-task-execution-contract.mjs';

const catalog = JSON.parse(await readFile(new URL(
  '../docker/harness/skills/forge-task-router/references/phase-profiles.json',
  import.meta.url,
), 'utf8'));
const sourceCommit = '6eb2881e6f6af85a5348acf3da63cef53a873b0e';
const sha = (character) => character.repeat(64);

function legacyState(state) {
  const value = structuredClone(state);
  value.schemaVersion = 'forge-delivery-phase-state/v1';
  delete value.stateDigest;
  value.stateDigest = crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
  return value;
}

function recoverStaleWrite(state, now = '2026-09-03T00:04:30.000Z') {
  return recordForgeStaleWriteRecovery({
    state,
    catalog,
    operationId: '9cbb7094-ceb7-4a83-8d8a-330411eed198',
    frozenStateFileDigest: sha('1'),
    failureEvidenceDigest: sha('2'),
    writerRecoveryTraceDigest: sha('3'),
    now,
  });
}

function freshState() {
  return createForgeDeliveryPhaseState({
    catalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    taskId: 'eval-crud-complete',
    sessionId: 'session-phased-crud',
    sourceCommit,
    now: '2026-09-03T00:00:00.000Z',
  });
}

function recoverReadonlyRole(state, input = {}) {
  return recordForgeReadonlyRoleRecovery({
    state,
    catalog,
    operationId: '7f2c4eab-7063-4786-a820-dafc7e112816',
    frozenStateFileDigest: sha('4'),
    failureEvidenceDigest: sha('5'),
    now: `2026-09-03T00:${String(state.lastExecutionGeneration).padStart(2, '0')}:30.000Z`,
    ...input,
  });
}

function phaseFor(state) {
  return catalog.workflows[0].phases[state.currentPhaseIndex];
}

function payloadFor(phase) {
  return Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, []]));
}

function beginCurrent(state, generation) {
  return beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: state.currentPhaseId,
    rpcId: `rpc-${state.currentPhaseId}-${generation}`,
    promptDigest: sha(String((generation % 9) + 1)),
    executionGeneration: generation,
    now: `2026-09-03T00:${String(generation).padStart(2, '0')}:00.000Z`,
  });
}

function artifactFor(state) {
  const phase = phaseFor(state);
  const changedPaths = phase.patchScope === 'phase'
    ? [`${phase.ownedPaths[0]}/phase-generated.txt`]
    : [];
  const patchDigest = phase.patchScope === 'none' ? null : sha('a');
  return createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: sha('b'),
    changedPaths,
    patchDigest,
    payload: payloadFor(phase),
  });
}

function hostReceiptsFor(state, artifact) {
  return phaseFor(state).hostVerificationProfiles.map((profile, index) => ({
    profile,
    status: 'passed',
    receiptDigest: String((index % 9) + 1).repeat(64),
    patchDigest: artifact.sourceFingerprint,
  }));
}

function acceptCurrent(state, generation) {
  const started = beginCurrent(state, generation);
  const artifact = artifactFor(started);
  return completeForgeDeliveryPhase({
    state: started,
    catalog,
    decision: 'accepted',
    artifact,
    hostReceipts: hostReceiptsFor(started, artifact),
    now: `2026-09-03T00:${String(generation).padStart(2, '0')}:30.000Z`,
  }).state;
}

function completedState() {
  let state = freshState();
  for (let generation = 1; generation <= catalog.workflows[0].phases.length; generation += 1) {
    state = acceptCurrent(state, generation);
  }
  return state;
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeDeliveryPhaseError);
    assert.equal(error.code, code);
    return true;
  });
}

test('versioned CRUD phase catalog splits schema from access wiring and uses real Forge owners', () => {
  const validated = validateForgeDeliveryPhaseCatalog(catalog);
  const phases = validated.workflows[0].phases;
  assert.deepEqual(phases.map((phase) => phase.id), [
    'requirements',
    'domain-contract',
    'database',
    'ui-design',
    'backend',
    'frontend',
    'access-wiring',
    'cross-layer-acceptance',
  ]);
  assert.deepEqual(phases.map((phase) => phase.requiresArtifacts), [
    [],
    ['requirements-contract'],
    ['requirements-contract', 'domain-api-contract'],
    ['requirements-contract', 'domain-api-contract'],
    [
      'requirements-contract',
      'domain-api-contract',
      'database-implementation',
      'ui-interaction-contract',
    ],
    [
      'requirements-contract',
      'domain-api-contract',
      'database-implementation',
      'ui-interaction-contract',
      'backend-implementation',
    ],
    [
      'requirements-contract',
      'domain-api-contract',
      'database-implementation',
      'ui-interaction-contract',
      'backend-implementation',
      'frontend-implementation',
    ],
    [
      'requirements-contract',
      'domain-api-contract',
      'database-implementation',
      'ui-interaction-contract',
      'backend-implementation',
      'frontend-implementation',
      'access-wiring-implementation',
    ],
  ]);
  assert.equal(phases[0].sessionMode, 'create');
  assert.ok(phases.slice(1).every((phase) => phase.sessionMode === 'resume'));
  assert.ok(phases.filter((phase) => !phase.sourceMutation).every((phase) => phase.ownedPaths.length === 0));
  assert.deepEqual(phases[2].ownedPaths, [
    'forge-server/db/migration',
    'forge-server/forge-business/forge-business-core/src/test/java',
  ]);
  assert.ok(!phases[2].ownedPaths.some((entry) => entry.includes('/src/main')));
  assert.ok(!phases[2].requiredPayloadKeys.includes('permissionSeed'));
  assert.ok(phases[2].requiredPayloadKeys.includes('dictionaryExcelSeed'));
  assert.deepEqual(phases[4].ownedPaths, [
    'forge-server/forge-business/forge-business-core/src/main',
    'forge-server/forge-business/forge-business-core/src/test',
  ]);
  assert.ok(phases[4].requiresArtifacts.includes('ui-interaction-contract'));
  assert.deepEqual(phases[5].hostVerificationProfiles, [
    'governance', 'frontend-admin-lint', 'frontend-admin-test',
    'frontend-admin-typecheck', 'frontend-admin-build',
  ]);
  assert.deepEqual(phases[5].requiresArtifacts, [
    'requirements-contract',
    'domain-api-contract',
    'database-implementation',
    'ui-interaction-contract',
    'backend-implementation',
  ]);
  assert.equal(phases[6].artifactKind, 'access-wiring-implementation');
  assert.deepEqual(phases[6].hostVerificationProfiles, ['governance', 'backend-module-test']);
  assert.ok(phases[7].requiresArtifacts.includes('access-wiring-implementation'));
  assert.ok(phases[0].requiredPayloadKeys.includes('requirementTrace'));
  assert.deepEqual(phases[4].requiredSkills, [
    'forge-task-contract',
    'forge-task-router',
    'forge-change-design',
    'forge-backend-architecture',
    'forge-security-tenancy-permission',
    'forge-testing-observability',
    'forge-evidence-truth',
  ]);
  assert.ok(phases.every((phase) => phase.requiredSkills.length < 11));
  assert.equal(
    resolveForgeDeliveryPhase({
      catalog,
      workflowId: 'crud-production',
      caseFamily: 'crud-complete',
      phaseId: 'frontend',
    }).phase.id,
    'frontend',
  );
});

test('catalog 2026.09.03.4 retains its historical frontend verification profiles', () => {
  const legacyCatalog = structuredClone(catalog);
  legacyCatalog.catalogVersion = '2026.09.03.4';
  const frontend = legacyCatalog.workflows[0].phases.find((phase) => phase.id === 'frontend');
  frontend.contractVerificationProfiles = frontend.contractVerificationProfiles.filter(
    (profile) => profile !== 'frontend-admin-typecheck',
  );
  frontend.hostVerificationProfiles = frontend.hostVerificationProfiles.filter(
    (profile) => profile !== 'frontend-admin-typecheck',
  );

  const validated = validateForgeDeliveryPhaseCatalog(legacyCatalog);
  const validatedFrontend = validated.workflows[0].phases.find((phase) => phase.id === 'frontend');
  assert.ok(!validatedFrontend.contractVerificationProfiles.includes('frontend-admin-typecheck'));
  assert.ok(!validatedFrontend.hostVerificationProfiles.includes('frontend-admin-typecheck'));

  const mislabeledLegacy = structuredClone(legacyCatalog);
  mislabeledLegacy.workflows[0].phases.find((phase) => phase.id === 'frontend')
    .hostVerificationProfiles.splice(3, 0, 'frontend-admin-typecheck');
  expectCode(
    'PHASE_CATALOG_CONTRACT_MISMATCH',
    () => validateForgeDeliveryPhaseCatalog(mislabeledLegacy),
  );
});

test('catalog 2026.09.03.5 requires frontend typecheck without relaxing other phase contracts', () => {
  for (const profileField of ['contractVerificationProfiles', 'hostVerificationProfiles']) {
    const missingTypecheck = structuredClone(catalog);
    missingTypecheck.catalogVersion = '2026.09.03.5';
    const frontend = missingTypecheck.workflows[0].phases.find((phase) => phase.id === 'frontend');
    frontend[profileField] = frontend[profileField].filter(
      (profile) => profile !== 'frontend-admin-typecheck',
    );
    expectCode(
      'PHASE_CATALOG_CONTRACT_MISMATCH',
      () => validateForgeDeliveryPhaseCatalog(missingTypecheck),
    );
  }

  const weakenedBackend = structuredClone(catalog);
  const backend = weakenedBackend.workflows[0].phases.find((phase) => phase.id === 'backend');
  backend.contractVerificationProfiles = backend.contractVerificationProfiles.filter(
    (profile) => profile !== 'backend-module-test',
  );
  expectCode(
    'PHASE_CATALOG_CONTRACT_MISMATCH',
    () => validateForgeDeliveryPhaseCatalog(weakenedBackend),
  );
});

test('catalog 2026.09.03.5 state cannot continue under the revised 2026.09.03.7 contract graph', () => {
  const revisedCatalog = structuredClone(catalog);
  revisedCatalog.catalogVersion = '2026.09.03.7';
  revisedCatalog.workflows[0].phases.find((phase) => phase.id === 'frontend').ownedPaths = [
    'forge-admin-ui/src/api',
    'forge-admin-ui/src/views',
  ];
  const oldCatalog = structuredClone(revisedCatalog);
  oldCatalog.catalogVersion = '2026.09.03.5';
  const phases = oldCatalog.workflows[0].phases;
  phases[4].requiresArtifacts = phases[4].requiresArtifacts.filter(
    (kind) => kind !== 'ui-interaction-contract',
  );
  phases[5].requiresArtifacts = phases[5].requiresArtifacts.filter(
    (kind) => kind !== 'database-implementation',
  );
  const oldState = createForgeDeliveryPhaseState({
    catalog: oldCatalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    taskId: 'eval-crud-complete',
    sessionId: 'session-old-catalog',
    sourceCommit,
    now: '2026-09-03T00:00:00.000Z',
  });

  assert.doesNotThrow(() => validateForgeDeliveryPhaseState(oldState, oldCatalog));
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(oldState, revisedCatalog));
});

test('catalog 2026.09.03.22 preserves frontend typecheck ownership and requires bound cross-layer runtime evidence', () => {
  assert.equal(catalog.catalogVersion, '2026.09.03.22');
  assert.ok(catalog.workflows[0].phases[7].requiredPayloadKeys.includes('runtimeEvidenceDigest'));
  let state = freshState();
  for (let generation = 1; generation <= 5; generation += 1) {
    state = acceptCurrent(state, generation);
  }
  state = beginCurrent(state, 6);
  const phase = phaseFor(state);
  assert.equal(phase.id, 'frontend');
  assert.deepEqual(phase.ownedPaths, [
    'forge-admin-ui/src/api',
    'forge-admin-ui/src/views',
    'forge-admin-ui/package.json',
    'forge-admin-ui/pnpm-lock.yaml',
    'forge-admin-ui/jsconfig.json',
  ]);
  const createArtifact = (changedPath) => createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: sha('1'),
    changedPaths: [changedPath],
    patchDigest: sha('2'),
    payload: payloadFor(phase),
  });
  for (const allowedPath of [
    'forge-admin-ui/package.json',
    'forge-admin-ui/pnpm-lock.yaml',
    'forge-admin-ui/jsconfig.json',
    'forge-admin-ui/src/api/supplier.js',
    'forge-admin-ui/src/views/supplier/index.vue',
  ]) {
    assert.deepEqual(createArtifact(allowedPath).changedPaths, [allowedPath]);
  }
  for (const deniedPath of [
    'forge-admin-ui/vite.config.js',
    'forge-admin-ui/tsconfig.json',
    'forge-admin-ui/package.json.bak',
    'forge-admin-ui/pnpm-lock.yaml.backup',
    'forge-admin-ui/jsconfig.json.disabled',
    'forge-admin-ui/src/components/Other.vue',
  ]) {
    expectCode('PHASE_PATH_DENIED', () => createArtifact(deniedPath));
  }
});

test('catalog 2026.09.03.7 state cannot start a phase under the current frontend contract', () => {
  const oldCatalog = structuredClone(catalog);
  oldCatalog.catalogVersion = '2026.09.03.7';
  oldCatalog.workflows[0].phases.find((phase) => phase.id === 'frontend').ownedPaths = [
    'forge-admin-ui/src/api',
    'forge-admin-ui/src/views',
  ];
  const oldState = createForgeDeliveryPhaseState({
    catalog: oldCatalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    taskId: 'eval-crud-complete',
    sessionId: 'session-catalog-7',
    sourceCommit,
    now: '2026-09-03T00:00:00.000Z',
  });
  assert.doesNotThrow(() => validateForgeDeliveryPhaseState(oldState, oldCatalog));
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(oldState, catalog));
  expectCode('PHASE_STATE_INVALID', () => beginForgeDeliveryPhase({
    state: oldState,
    catalog,
    phaseId: 'requirements',
    rpcId: 'rpc-old-catalog-rejected',
    promptDigest: sha('3'),
    executionGeneration: 1,
  }));
});

for (const previousVersion of ['2026.09.03.8', '2026.09.03.9', '2026.09.03.10', '2026.09.03.11', '2026.09.03.12', '2026.09.03.13', '2026.09.03.14', '2026.09.03.15', '2026.09.03.16', '2026.09.03.17', '2026.09.03.18', '2026.09.03.19', '2026.09.03.20']) {
  test(`catalog ${previousVersion} cannot resume under the new human-response contract`, () => {
    const previousCatalog = structuredClone(catalog);
    previousCatalog.catalogVersion = previousVersion;
    const previousState = createForgeDeliveryPhaseState({
      catalog: previousCatalog,
      workflowId: 'crud-production',
      caseFamily: 'crud-complete',
      taskId: 'eval-previous-human-response-contract',
      sessionId: `session-catalog-${previousVersion}`,
      sourceCommit,
      now: '2026-09-03T00:00:00.000Z',
    });
    assert.doesNotThrow(() => validateForgeDeliveryPhaseState(previousState, previousCatalog));
    expectCode('PHASE_STATE_INVALID', () => beginForgeDeliveryPhase({
      state: previousState,
      catalog,
      phaseId: 'requirements',
      rpcId: 'rpc-old-human-response-contract-rejected',
      promptDigest: sha('3'),
      executionGeneration: 1,
    }));
    assert.equal(freshState().currentPhaseId, 'requirements');
    assert.equal(freshState().history.length, 0);
  });
}

test('one TaskSpace session advances by new generation and resumes after requirements', () => {
  let state = freshState();
  state = beginCurrent(state, 1);
  assert.equal(state.activeAttempt.sessionMode, 'create');
  const firstArtifact = artifactFor(state);
  state = completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'accepted',
    artifact: firstArtifact,
    hostReceipts: [],
    now: '2026-09-03T00:01:30.000Z',
  }).state;
  assert.equal(state.currentPhaseId, 'domain-contract');
  state = beginCurrent(state, 2);
  assert.equal(state.sessionId, 'session-phased-crud');
  assert.equal(state.activeAttempt.sessionMode, 'resume');
  assert.equal(state.lastExecutionGeneration, 2);
  expectCode('PHASE_ORDER_VIOLATION', () => beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: 'database',
    rpcId: 'rpc-skip',
    promptDigest: sha('c'),
    executionGeneration: 3,
  }));
});

test('a new phased workflow creates its session even when the TaskSpace execution generation is already advanced', () => {
  const state = beginCurrent(freshState(), 7);
  assert.equal(state.activeAttempt.executionGeneration, 7);
  assert.equal(state.activeAttempt.sessionMode, 'create');
  assert.doesNotThrow(() => validateForgeDeliveryPhaseState(state, catalog));
});

test('generation replay and concurrent attempts fail closed', () => {
  const started = beginCurrent(freshState(), 1);
  expectCode('PHASE_ORDER_VIOLATION', () => beginCurrent(started, 2));
  const artifact = artifactFor(started);
  const state = completeForgeDeliveryPhase({
    state: started,
    catalog,
    decision: 'accepted',
    artifact,
    hostReceipts: [],
  }).state;
  expectCode('PHASE_GENERATION_REPLAY', () => beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: 'domain-contract',
    rpcId: 'rpc-replay',
    promptDigest: sha('d'),
    executionGeneration: 1,
  }));
});

test('phase state transitions hold one exclusive operator lock', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-phase-lock-'));
  const stateFile = path.join(directory, 'state.json');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const acquired = new Promise((resolve) => { entered = resolve; });
  const first = withForgeDeliveryPhaseStateLock(stateFile, async () => {
    entered();
    await gate;
  });
  await acquired;
  await assert.rejects(
    withForgeDeliveryPhaseStateLock(stateFile, async () => undefined),
    (error) => error instanceof ForgeDeliveryPhaseError && error.code === 'PHASE_STATE_BUSY',
  );
  release();
  await first;
  await assert.doesNotReject(withForgeDeliveryPhaseStateLock(stateFile, async () => undefined));
  await rm(directory, { recursive: true, force: true });
});

test('atomic phase state replacement preserves the existing file owner, group, and mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-phase-owner-'));
  const stateFile = path.join(directory, 'state.json');
  try {
    await writeForgeDeliveryPhaseState(stateFile, freshState(), catalog);
    await chmod(stateFile, 0o640);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      await chown(stateFile, 65534, 65534);
    }
    const before = await lstat(stateFile);
    await writeForgeDeliveryPhaseState(stateFile, freshState(), catalog);
    const after = await lstat(stateFile);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o7777, before.mode & 0o7777);
    assert.equal(after.nlink, 1);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.doesNotThrow(() => validateForgeDeliveryPhaseState(persisted, catalog));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('phase state reads and replacements reject a multiply linked authority file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-phase-hardlink-'));
  const stateFile = path.join(directory, 'state.json');
  const aliasFile = path.join(directory, 'state.alias.json');
  try {
    await writeForgeDeliveryPhaseState(stateFile, freshState(), catalog);
    await link(stateFile, aliasFile);
    await assert.rejects(
      writeForgeDeliveryPhaseState(stateFile, freshState(), catalog),
      (error) => error instanceof ForgeDeliveryPhaseError && error.code === 'PHASE_STATE_PATH_INVALID',
    );
    await assert.rejects(
      readForgeDeliveryPhaseState(stateFile, catalog),
      (error) => error instanceof ForgeDeliveryPhaseError && error.code === 'PHASE_STATE_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requirements and design phases cannot claim production source mutations', () => {
  const state = beginCurrent(freshState(), 1);
  expectCode('PHASE_MUTATION_DENIED', () => createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: 'requirements',
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: sha('e'),
    changedPaths: ['forge-server/db/migration/V1__bad.sql'],
    patchDigest: sha('f'),
    payload: payloadFor(phaseFor(state)),
  }));
});

test('implementation phase rejects cross-owner paths and failed host receipts', () => {
  let state = freshState();
  state = acceptCurrent(state, 1);
  state = acceptCurrent(state, 2);
  state = beginCurrent(state, 3);
  const phase = phaseFor(state);
  assert.doesNotThrow(() => createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: sha('1'),
    changedPaths: [
      'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/supplieradmission/migration/SupplierAdmissionProfileMigrationContractTest.java',
    ],
    patchDigest: sha('2'),
    payload: payloadFor(phase),
  }));
  expectCode('PHASE_PATH_DENIED', () => createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: sha('1'),
    changedPaths: ['forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/supplieradmission/SupplierAdmissionService.java'],
    patchDigest: sha('2'),
    payload: payloadFor(phase),
  }));
  const artifact = artifactFor(state);
  expectCode('PHASE_HOST_VERIFICATION_FAILED', () => completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'accepted',
    artifact,
    hostReceipts: [
      {
        profile: 'governance',
        status: 'failed',
        receiptDigest: sha('3'),
        patchDigest: artifact.sourceFingerprint,
      },
      {
        profile: 'backend-module-test',
        status: 'passed',
        receiptDigest: sha('4'),
        patchDigest: artifact.sourceFingerprint,
      },
    ],
  }));
});

test('later implementation accepts Host verification of the cumulative source and rejects phase-only verification', () => {
  let state = freshState();
  state = acceptCurrent(state, 1);
  state = acceptCurrent(state, 2);
  state = acceptCurrent(state, 3);
  state = acceptCurrent(state, 4);
  state = beginCurrent(state, 5);
  const artifact = artifactFor(state);
  assert.notEqual(artifact.patchDigest, artifact.sourceFingerprint);
  const verifiedSourceReceipts = hostReceiptsFor(state, artifact);
  assert.ok(verifiedSourceReceipts.length > 0);

  const accepted = completeForgeDeliveryPhase({
    state, catalog, decision: 'accepted', artifact, hostReceipts: verifiedSourceReceipts,
  });
  assert.equal(accepted.state.currentPhaseId, 'frontend');

  expectCode('PHASE_HOST_VERIFICATION_FAILED', () => completeForgeDeliveryPhase({
    state, catalog, decision: 'accepted', artifact,
    hostReceipts: verifiedSourceReceipts.map((receipt) => ({
      ...receipt, patchDigest: artifact.patchDigest,
    })),
  }));
});

test('unresolved business decisions block phase acceptance', () => {
  const state = beginCurrent(freshState(), 1);
  const phase = phaseFor(state);
  const artifact = createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: sha('4'),
    unresolvedDecisions: ['供应商资质是否允许跨租户共享？'],
    payload: payloadFor(phase),
  });
  expectCode('PHASE_BUSINESS_DECISION_REQUIRED', () => completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'accepted',
    artifact,
    hostReceipts: [],
  }));
});

test('rejected phase stays current and exhausts its bounded repair budget', () => {
  let state = beginCurrent(freshState(), 1);
  state = completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'rejected',
    reasonCode: 'ARTIFACT_SCHEMA_FAILED',
    now: '2026-09-03T00:01:30.000Z',
  }).state;
  assert.equal(state.status, 'active');
  assert.equal(state.currentPhaseId, 'requirements');
  state = beginCurrent(state, 2);
  state = completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'rejected',
    reasonCode: 'SEMANTIC_REVIEW_FAILED',
    now: '2026-09-03T00:02:30.000Z',
  }).state;
  assert.equal(state.status, 'blocked');
  expectCode('PHASE_ORDER_VIOLATION', () => beginCurrent(state, 3));
});

test('the database stale-write incident consumes execution cost but preserves one quality retry', () => {
  let state = freshState();
  state = acceptCurrent(state, 1);
  state = acceptCurrent(state, 2);
  state = beginCurrent(state, 3);
  state = completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'rejected',
    reasonCode: 'SEMANTIC_REVIEW_FAILED',
    now: '2026-09-03T00:03:30.000Z',
  }).state;
  state = beginCurrent(state, 4);
  const recovered = recoverStaleWrite(state);
  state = recovered.state;
  assert.equal(state.schemaVersion, FORGE_DELIVERY_PHASE_STATE_SCHEMA);
  assert.equal(state.status, 'active');
  assert.equal(state.currentPhaseId, 'database');
  assert.equal(state.activeAttempt, null);
  assert.equal(recovered.receipt.schemaVersion, FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA);
  assert.equal(recovered.receipt.budgetDisposition, 'quality-attempt-not-consumed');
  assert.equal(recovered.receipt.executionCostConsumed, true);

  state = beginCurrent(state, 5);
  expectCode('PHASE_STALE_WRITE_RECOVERY_DENIED', () => recoverStaleWrite(
    state,
    '2026-09-03T00:05:30.000Z',
  ));
  const databaseArtifact = artifactFor(state);
  state = completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'accepted',
    artifact: databaseArtifact,
    hostReceipts: hostReceiptsFor(state, databaseArtifact),
    now: '2026-09-03T00:05:30.000Z',
  }).state;
  for (let generation = 6; generation <= 10; generation += 1) {
    state = acceptCurrent(state, generation);
  }
  assert.equal(state.status, 'completed');
  assert.equal(state.history.length, 10);
  assert.equal(state.history.filter((entry) => entry.decision === 'accepted').length, 8);
  assert.doesNotThrow(() => projectCompletedForgeDeliveryPhaseExecution({
    catalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    state,
  }));
});

test('legacy v1 state is read-only compatible and converts atomically on stale-write recovery', () => {
  let state = freshState();
  state = acceptCurrent(state, 1);
  state = acceptCurrent(state, 2);
  state = legacyState(beginCurrent(state, 3));
  assert.doesNotThrow(() => validateForgeDeliveryPhaseState(state, catalog));
  const recovered = recoverStaleWrite(state, '2026-09-03T00:03:30.000Z').state;
  assert.equal(recovered.schemaVersion, 'forge-delivery-phase-state/v2');
  const invalidLegacyUnion = legacyState(recovered);
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(invalidLegacyUnion, catalog));
  const tampered = structuredClone(recovered);
  tampered.history.at(-1).writerRecoveryTraceDigest = sha('9');
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(tampered, catalog));
});

test('frontend readonly-role recovery preserves one quality retry and the original execution ceiling', () => {
  let state = freshState();
  for (let generation = 1; generation <= 5; generation += 1) state = acceptCurrent(state, generation);
  const upstream = JSON.stringify(state.acceptedArtifacts);
  state = completeForgeDeliveryPhase({
    state: beginCurrent(state, 6), catalog, decision: 'rejected', reasonCode: 'BROWSER_USER_ABORTED',
    now: '2026-09-03T00:06:30.000Z',
  }).state;
  state = beginCurrent(state, 7);
  const before = JSON.stringify(state);
  const { state: recovered, receipt } = recoverReadonlyRole(state);
  assert.equal(JSON.stringify(state), before, 'the supplied active state and its historical receipts stay unchanged');
  assert.equal(JSON.stringify(recovered.acceptedArtifacts), upstream);
  assert.equal(recovered.status, 'active');
  assert.equal(recovered.currentPhaseId, 'frontend');
  assert.equal(recovered.activeAttempt, null);
  assert.equal(recovered.lastExecutionGeneration, 7);
  assert.equal(recovered.revision, state.revision + 1);
  assert.equal(receipt.schemaVersion, FORGE_READONLY_ROLE_RECOVERY_RECEIPT_SCHEMA);
  assert.equal(receipt.incidentCode, 'READONLY_ROLE_PROMPT_MISCLASSIFIED');
  assert.equal(receipt.budgetDisposition, 'quality-attempt-not-consumed');
  assert.equal(receipt.executionCostConsumed, true);
  for (const key of ['taskId', 'sessionId', 'sourceCommit', 'catalogDigest']) {
    assert.equal(receipt[key], state[key]);
  }
  for (const key of ['attemptId', 'executionGeneration', 'rpcId', 'promptDigest']) {
    assert.equal(receipt[key], state.activeAttempt[key]);
  }
  assert.equal(receipt.frozenStateFileDigest, sha('4'));
  assert.equal(receipt.failureEvidenceDigest, sha('5'));
  assert.equal('decision' in receipt, false, 'a platform failure is not a business acceptance or rejection');
  assert.equal('artifactStatus' in receipt, false, 'the recovery does not claim the captured candidate is absent');
  assert.equal('writerRecoveryTraceDigest' in receipt, false, 'frontend recovery does not impersonate the database incident');
  const retried = beginCurrent(recovered, 8);
  expectCode('PHASE_READONLY_ROLE_RECOVERY_DENIED', () => recoverReadonlyRole(retried));
  const exhausted = completeForgeDeliveryPhase({
    state: retried, catalog, decision: 'rejected', reasonCode: 'SEMANTIC_REVIEW_FAILED',
    now: '2026-09-03T00:08:30.000Z',
  }).state;
  const frontendHistory = exhausted.history.filter((entry) => entry.phaseId === 'frontend');
  assert.equal(exhausted.status, 'blocked');
  assert.equal(frontendHistory.length, phaseFor(exhausted).maxAttempts + 1);
  assert.equal(frontendHistory.filter((entry) => entry.decision === 'rejected').length, phaseFor(exhausted).maxAttempts);
  expectCode('PHASE_ORDER_VIOLATION', () => beginCurrent(exhausted, 9));
  expectCode('PHASE_READONLY_ROLE_RECOVERY_DENIED', () => recoverReadonlyRole(exhausted));
  assert.equal(acceptCurrent(recovered, 8).currentPhaseId, 'access-wiring', 'a real accepted retry still advances normally');
});

test('frontend readonly-role recovery requires an active matching phase and digest-bound technical history', () => {
  let state = freshState();
  expectCode('PHASE_READONLY_ROLE_RECOVERY_DENIED', () => recoverReadonlyRole(beginCurrent(state, 1)));
  for (let generation = 1; generation <= 5; generation += 1) state = acceptCurrent(state, generation);
  expectCode('PHASE_READONLY_ROLE_RECOVERY_DENIED', () => recoverReadonlyRole(state));
  state = beginCurrent(state, 6);
  expectCode('PHASE_READONLY_ROLE_RECOVERY_DENIED', () => recoverReadonlyRole(state, { now: '2026-09-03T00:05:59.000Z' }));
  expectCode('PHASE_INPUT_INVALID', () => recoverReadonlyRole(state, { failureEvidenceDigest: 'missing' }));
  expectCode('PHASE_INPUT_INVALID', () => recoverReadonlyRole(state, { frozenStateFileDigest: 'missing' }));
  const recovered = recoverReadonlyRole(state).state;
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(legacyState(recovered), catalog));
  const resign = (value, key) => {
    delete value[key];
    value[key] = crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
  };
  for (const change of [
    { taskId: 'other-task' }, { sessionId: 'other-session' }, { sourceCommit: 'a'.repeat(40) },
    { catalogDigest: sha('a') }, { phaseIndex: 4 }, { phaseId: 'backend' },
    { budgetDisposition: 'quality-attempt-consumed' }, { executionCostConsumed: false },
    { failureEvidenceDigest: 'missing' }, { executionGeneration: 5 },
  ]) {
    const changed = structuredClone(recovered);
    Object.assign(changed.history.at(-1), change);
    resign(changed.history.at(-1), 'receiptDigest');
    resign(changed, 'stateDigest');
    expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(changed, catalog));
  }
  const duplicate = structuredClone(recovered);
  const second = { ...duplicate.history.at(-1), executionGeneration: 7, failedAt: '2026-09-03T00:07:30.000Z' };
  resign(second, 'receiptDigest');
  duplicate.history.push(second);
  duplicate.lastExecutionGeneration = 7;
  duplicate.updatedAt = second.failedAt;
  resign(duplicate, 'stateDigest');
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(duplicate, catalog));
});

test('readonly-role and historical database recovery remain independent per phase', () => {
  let state = acceptCurrent(acceptCurrent(freshState(), 1), 2);
  state = recoverStaleWrite(beginCurrent(state, 3), '2026-09-03T00:03:30.000Z').state;
  const databaseReceipt = JSON.stringify(state.history.at(-1));
  for (let generation = 4; generation <= 6; generation += 1) state = acceptCurrent(state, generation);
  state = recoverReadonlyRole(beginCurrent(state, 7)).state;
  for (let generation = 8; generation <= 10; generation += 1) state = acceptCurrent(state, generation);
  assert.equal(state.status, 'completed');
  assert.equal(state.history.length, 10);
  assert.equal(state.history.filter((entry) => entry.decision === 'accepted').length, 8);
  assert.equal(JSON.stringify(state.history.find((entry) => entry.schemaVersion === FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA)), databaseReceipt);
  assert.doesNotThrow(() => projectCompletedForgeDeliveryPhaseExecution({
    catalog, workflowId: 'crud-production', caseFamily: 'crud-complete', state,
  }));
});

test('all accepted artifacts form a digest-bound chain and complete only after final acceptance', () => {
  const state = completedState();
  assert.equal(state.status, 'completed');
  assert.equal(state.history.length, 8);
  assert.equal(Object.keys(state.acceptedArtifacts).length, 8);
  assert.doesNotThrow(() => validateForgeDeliveryPhaseState(state, catalog));
  const tampered = JSON.parse(JSON.stringify(state));
  tampered.acceptedArtifacts['requirements-contract'] = sha('0');
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseState(tampered, catalog));
});

test('workflow description derives cardinality and session continuity from any valid catalog', () => {
  const production = describeForgeDeliveryPhaseWorkflow({
    catalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
  });
  assert.equal(production.phaseCount, 8);
  assert.equal(production.sessionContinuity, 'create-once-resume-7');
  assert.deepEqual(production.orderedPhases, catalog.workflows[0].phases.map((phase) => phase.id));

  const twoPhaseCatalog = structuredClone(catalog);
  twoPhaseCatalog.catalogVersion = '2026.09.05.1';
  twoPhaseCatalog.workflows[0].phases = twoPhaseCatalog.workflows[0].phases.slice(0, 2);
  const compact = describeForgeDeliveryPhaseWorkflow({
    catalog: twoPhaseCatalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
  });
  assert.equal(compact.phaseCount, 2);
  assert.equal(compact.sessionContinuity, 'create-once-resume-1');
  assert.deepEqual(compact.orderedPhases, ['requirements', 'domain-contract']);
});

test('completed phase execution projection is catalog-derived and rejects divergent evidence', () => {
  const state = completedState();
  const projection = projectCompletedForgeDeliveryPhaseExecution({
    catalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    state,
  });
  assert.equal(projection.sessionContinuity, 'create-once-resume-7');
  assert.equal(projection.orderedPhases.length, 8);
  assert.equal(Object.keys(projection.acceptedArtifactDigests).length, 8);
  assert.deepEqual(validateForgeDeliveryPhaseExecutionProjection({
    catalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    state,
    phaseExecution: projection,
  }), projection);

  const mutations = [
    (value) => { value.orderedPhases.pop(); },
    (value) => { [value.orderedPhases[0], value.orderedPhases[1]] = [value.orderedPhases[1], value.orderedPhases[0]]; },
    (value) => { value.orderedPhases[value.orderedPhases.length - 1] = 'wrong-final-phase'; },
    (value) => { value.catalogDigest = sha('f'); },
    (value) => {
      delete value.acceptedArtifactDigests['requirements-contract'];
      value.acceptedArtifactDigests['wrong-artifact-kind'] = sha('e');
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(projection);
    mutate(changed);
    expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseExecutionProjection({
      catalog,
      workflowId: 'crud-production',
      caseFamily: 'crud-complete',
      state,
      phaseExecution: changed,
    }));
  }
});

test('non-phased cases fail closed when phased execution is declared', () => {
  expectCode('PHASE_STATE_INVALID', () => validateForgeDeliveryPhaseExecutionProjection({
    catalog,
    workflowId: null,
    caseFamily: 'edge-pagination-shared-owner',
    state: null,
    phaseExecution: { enabled: true },
  }));
  assert.equal(validateForgeDeliveryPhaseExecutionProjection({
    catalog,
    workflowId: null,
    caseFamily: 'edge-pagination-shared-owner',
    state: null,
    phaseExecution: null,
  }), null);
});
