import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as phaseController from '../docker/harness/forge-delivery-phase-controller.mjs';

import {
  createForgeDeliveryPhaseFormatRetryPrompt,
  createForgeDeliveryPhaseRetryPrompt,
  finalizeForgeDeliveryPhaseRun,
  forgeDeliveryPhaseRetryPromptReceiptPath,
  initializeForgeDeliveryPhaseRun,
  inspectForgeDeliveryPhaseSemanticReview,
  preflightForgeDeliveryPhaseRun,
  readPreparedForgeCrossLayerRuntimeEvidence,
  prepareForgeDatabaseContinuation,
  prepareForgeBackendFinalizedContinuation,
  prepareForgeAccessWiringContinuation,
  prepareForgeCrossLayerContinuation,
  prepareForgeFrontendRetryContinuation,
  prepareForgeFrontendRepairContinuation,
  retryForgeFrontendUserAbortedPhase,
  retryForgeFrontendReadonlyRolePhase,
  isForgeFrontendReadonlyRoleRecoveryCandidate,
  prepareForgeDeliveryBrowserPhase,
  recoverForgeDatabaseStaleWriteRun,
  rejectForgeDeliveryPhaseRun,
  validateForgeDeliveryPhaseRetryPromptReceipt,
} from '../docker/harness/forge-delivery-phase-controller.mjs';
import {
  beginForgeDeliveryPhase,
  loadForgeDeliveryPhaseCatalog,
  readForgeDeliveryPhaseState,
  writeForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { buildForgeDeliveryPhasePrompt } from '../docker/harness/forge-delivery-phase-response.mjs';
import { canonicalStringify, compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { classifyPinnedDshPromptBody, digestDirectUserTextContent, digestProductionTaskAuthorityBinding } from '../docker/harness/forge-execution-context.mjs';
import { prepareHeadlessExecutionFromEnvironment } from '../docker/harness/forge-prepare-headless-execution.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_FILE = path.join(
  ROOT,
  'docker/harness/skills/forge-task-router/references/phase-profiles.json',
);
const SOURCE_COMMIT = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const TEST_SHADOW_POLICY_FILE = path.join(
  ROOT, 'tests/fixtures/forge-harness-behavior-evals/execution-policy.test-shadow.json',
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-controller-'));
  const originalRequestFile = path.join(root, 'request.md');
  const stateFile = path.join(root, 'control', 'state.json');
  const artifactsDirectory = path.join(root, 'artifacts');
  const promptFile = path.join(root, 'current-prompt.md');
  await writeFile(originalRequestFile, '实现一个生产级员工 CRUD。\n', 'utf8');
  await initializeForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    taskId: 'eval-crud-complete',
    sessionId: 'session-test-controller',
    sourceCommit: SOURCE_COMMIT,
    originalRequestFile,
    stateFile,
    artifactsDirectory,
    promptFile,
  });
  return { root, originalRequestFile, stateFile, artifactsDirectory, promptFile };
}

function promptAuthority(prompt) {
  return JSON.parse(prompt
    .split('CURRENT PHASE AUTHORITY (machine-owned):\n')[1]
    .split('\n\nACCEPTED UPSTREAM PAYLOADS (digest-bound):')[0]);
}

async function beginCurrent(context, generation, promptDigestOverride) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const next = beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: state.currentPhaseId,
    rpcId: `rpc-${generation}`,
    promptDigest: promptDigestOverride ?? digestDirectUserTextContent([{ type: 'text', text:
      (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, ''),
    }]),
    executionGeneration: generation,
  });
  await writeForgeDeliveryPhaseState(context.stateFile, next, catalog);
  return { catalog, state: next, phase: catalog.workflows[0].phases[next.currentPhaseIndex] };
}

async function rejectedRequirementsRetryFixture({
  reasonCode = 'SEMANTIC_REQUIREMENTS_CONTRACT_INVALID',
  deferRejection = false,
  prepareFirstAttempt = false,
} = {}) {
  const context = await fixture();
  let protectedEnvironment;
  let phase;
  if (prepareFirstAttempt) {
    protectedEnvironment = await protectedRetryEnvironment(context);
    const prepared = await prepareHeadlessExecutionFromEnvironment(protectedEnvironment);
    assert.equal(prepared.generation, 1);
    const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
    phase = catalog.workflows[0].phases[0];
  } else {
    ({ phase } = await beginCurrent(context, 1));
  }
  const directory = path.join(context.root, 'requirements-attempt1');
  await mkdir(directory, { recursive: true });
  const responseFile = path.join(directory, 'model-response.md');
  const allChangedPathsFile = path.join(directory, 'all-changed-paths.json');
  const phaseChangedPathsFile = path.join(directory, 'phase-changed-paths.json');
  const phasePatchFile = path.join(directory, 'phase.patch');
  const cumulativePatchFile = path.join(directory, 'cumulative.patch');
  const preflightReceiptFile = path.join(directory, 'controller-preflight-receipt.json');
  const semanticReviewFile = path.join(directory, 'independent-semantic-review.json');
  const responseBytes = Buffer.from(
    `<forge-phase-artifact>${JSON.stringify(proposalFor(phase))}</forge-phase-artifact>\n`,
  );
  await Promise.all([
    writeFile(responseFile, responseBytes),
    writeFile(allChangedPathsFile, '[]\n'),
    writeFile(phaseChangedPathsFile, '[]\n'),
    writeFile(phasePatchFile, ''),
    writeFile(cumulativePatchFile, ''),
  ]);
  const preflight = await preflightForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    responseFile,
    allChangedPathsFile,
    phaseChangedPathsFile,
    phasePatchFile,
    cumulativePatchFile,
    receiptFile: preflightReceiptFile,
  });
  const review = {
    schemaVersion: 'forge-independent-semantic-review/v1',
    reviewer: 'independent-codex-agent',
    subject: {
      phaseId: phase.id,
      responseSha256: crypto.createHash('sha256').update(responseBytes).digest('hex'),
      candidateArtifactDigest: preflight.candidateArtifactDigest,
    },
    verdict: 'reject',
    severityCounts: { p0: 0, p1: 1, p2: 0 },
    findings: [{
      id: 'REQ-P1-01',
      severity: 'p1',
      title: 'Requirements invented an API status.',
      evidence: 'The original request leaves the transport status to domain-contract.',
      requiredAction: 'Remove the invented status and retain only the business rejection semantics.',
    }],
    coverageSummary: 'The remaining requirement scope is covered.',
    cannotClaim: ['requirements accepted'],
  };
  await writeFile(semanticReviewFile, `${JSON.stringify(review, null, 2)}\n`);
  await chmod(semanticReviewFile, 0o600);
  if (deferRejection) return {
    context, review, preflight, protectedEnvironment,
    files: { responseFile, preflightReceiptFile, semanticReviewFile },
  };
  const rejection = await rejectForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    reasonCode,
    receiptFile: path.join(directory, 'rejection-receipt.json'),
  });
  const retryReceiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(context.promptFile, rejection.attemptId);
  return {
    context,
    protectedEnvironment,
    review,
    files: { responseFile, preflightReceiptFile, semanticReviewFile, retryReceiptFile },
    args: {
      catalogFile: CATALOG_FILE,
      stateFile: context.stateFile,
      artifactsDirectory: context.artifactsDirectory,
      originalRequestFile: context.originalRequestFile,
      responseFile,
      preflightReceiptFile,
      semanticReviewFile,
      promptFile: context.promptFile,
      receiptFile: retryReceiptFile,
    },
  };
}

async function protectedRetryEnvironment(context) {
  const projectRoot = path.join(context.root, 'project');
  const taskId = 'eval-crud-complete';
  const actorUserId = '11111111-1111-4111-8111-111111111111';
  const actorId = 'fixture-operator';
  const conversationId = 'fixture-retry-conversation';
  const taskspaceRoot = path.join(projectRoot, 'taskspaces', taskId);
  await mkdir(taskspaceRoot, { recursive: true });
  await writeFile(path.join(taskspaceRoot, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 2,
    projectSlug: 'forge-retry-test',
    taskId,
    actorId,
    actorUserId,
    conversationId,
    branch: `task/${actorId}/${taskId}`,
    baseCommit: SOURCE_COMMIT,
    status: 'active',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    accessTokenHash: EMPTY_SHA256,
    harnessPort: 3080,
    accessMode: 'conversation',
    lastCandidate: null,
    lastRelease: null,
  })}\n`);
  return {
    FORGE_EVAL_PROJECT_ROOT: projectRoot,
    PROJECT_SLUG: 'forge-retry-test',
    FORGE_TASKSPACE_ID: taskId,
    FORGE_TASKSPACE_ACTOR_USER_ID: actorUserId,
    FORGE_TASKSPACE_ACTOR_ID: actorId,
    FORGE_TASKSPACE_CONVERSATION_ID: conversationId,
    FORGE_PROTECTED_HEADLESS_SESSION_ID: 'session-test-controller',
    FORGE_PROTECTED_HEADLESS_RPC_ID: 'rpc-1',
    FORGE_EVAL_SOURCE_COMMIT: SOURCE_COMMIT,
    FORGE_EVAL_CASE_FAMILY: 'crud-complete',
    FORGE_EVAL_PROMPT_FILE: context.promptFile,
    FORGE_EXECUTION_POLICY_FILE: TEST_SHADOW_POLICY_FILE,
    FORGE_EVAL_PHASE_WORKFLOW_ID: 'crud-production',
    FORGE_EVAL_PHASE_ID: 'requirements',
    FORGE_EVAL_PHASE_CATALOG_FILE: CATALOG_FILE,
    FORGE_EVAL_PHASE_STATE_FILE: context.stateFile,
  };
}

function proposalFor(phase, changedPaths = [], unresolvedDecisions = []) {
  return {
    schemaVersion: 'forge-delivery-phase-proposal/v1',
    phaseId: phase.id,
    unresolvedDecisions,
    payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [
      key,
      key === 'changedPaths' ? changedPaths : { evidence: `${phase.id}:${key}` },
    ])),
  };
}

async function formatRetryFixture({ prepareFirstAttempt = false, mutateProposal, promptDigestOverride, responseText } = {}) {
  const context = await fixture();
  let protectedEnvironment;
  let phase;
  if (prepareFirstAttempt) {
    protectedEnvironment = await protectedRetryEnvironment(context);
    const first = await prepareHeadlessExecutionFromEnvironment(protectedEnvironment);
    assert.equal(first.generation, 1);
    const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
    phase = catalog.workflows[0].phases[0];
  } else {
    ({ phase } = await beginCurrent(context, 1, promptDigestOverride));
  }
  const directory = path.join(context.root, 'format-attempt1');
  await mkdir(directory, { recursive: true });
  const proposal = proposalFor(phase);
  proposal.payload.verificationStatus = { claim: 'unverified' };
  mutateProposal?.(proposal);
  const files = {
    responseFile: path.join(directory, 'model.stdout.txt'),
    allChangedPathsFile: path.join(directory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(directory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(directory, 'phase.patch'),
    cumulativePatchFile: path.join(directory, 'cumulative.patch'),
  };
  await Promise.all([
    writeFile(files.responseFile, responseText ?? `<forge-phase-artifact>${JSON.stringify(proposal)}</forge-phase-artifact>\n`),
    writeFile(files.allChangedPathsFile, '[]\n'),
    writeFile(files.phaseChangedPathsFile, '[]\n'),
    writeFile(files.phasePatchFile, ''),
    writeFile(files.cumulativePatchFile, ''),
  ]);
  const args = {
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    ...files,
    promptFile: context.promptFile,
    rejectionReceiptFile: path.join(directory, 'controller-reject-receipt.json'),
  };
  return { context, phase, files, args, protectedEnvironment };
}

async function finalizeCurrent(context, {
  generation,
  allChangedPaths,
  phaseChangedPaths,
  phasePatch,
  cumulativePatch,
  unresolvedDecisions = [],
  humanResponse = '已形成当前阶段的业务结果，并说明了对后续工作的影响。',
}) {
  const { phase } = await beginCurrent(context, generation);
  const phaseDirectory = path.join(context.root, `phase-${generation}-${phase.id}`);
  await mkdir(phaseDirectory, { recursive: true });
  const responseFile = path.join(phaseDirectory, 'response.txt');
  const allChangedPathsFile = path.join(phaseDirectory, 'all-changed-paths.json');
  const phaseChangedPathsFile = path.join(phaseDirectory, 'phase-changed-paths.json');
  const phasePatchFile = path.join(phaseDirectory, 'phase.patch');
  const cumulativePatchFile = path.join(phaseDirectory, 'cumulative.patch');
  const hostReceiptsFile = path.join(phaseDirectory, 'host-receipts.json');
  const cumulativePatchDigest = crypto.createHash('sha256').update(cumulativePatch).digest('hex');
  const receipts = phase.hostVerificationProfiles.map((profile) => ({
    profile,
    status: 'passed',
    receiptDigest: crypto.createHash('sha256').update(`${generation}:${profile}`).digest('hex'),
    patchDigest: cumulativePatchDigest,
  }));
  await Promise.all([
    writeFile(responseFile, `${humanResponse === null ? '' : `${humanResponse}\n\n`}<forge-phase-artifact>${JSON.stringify(proposalFor(
      phase,
      phaseChangedPaths,
      unresolvedDecisions,
    ))}</forge-phase-artifact>\n`),
    writeFile(allChangedPathsFile, `${JSON.stringify(allChangedPaths)}\n`),
    writeFile(phaseChangedPathsFile, `${JSON.stringify(phaseChangedPaths)}\n`),
    writeFile(phasePatchFile, phasePatch),
    writeFile(cumulativePatchFile, cumulativePatch),
    writeFile(hostReceiptsFile, `${JSON.stringify(receipts)}\n`),
  ]);
  return finalizeForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    responseFile,
    allChangedPathsFile,
    phaseChangedPathsFile,
    phasePatchFile,
    cumulativePatchFile,
    hostReceiptsFile,
    outputDirectory: phaseDirectory,
    nextPromptFile: context.promptFile,
  });
}

async function databaseContinuationFixture() {
  const context = await fixture();
  await beginCurrent(context, 1);
  await rejectForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE, stateFile: context.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
    receiptFile: path.join(context.root, 'requirements-reject-1.json'),
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await beginCurrent(context, 3);
  await rejectForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE, stateFile: context.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
    receiptFile: path.join(context.root, 'domain-reject-3.json'),
  });
  await finalizeCurrent(context, {
    generation: 4, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  for (const generation of [5, 6]) {
    await beginCurrent(context, generation);
    await rejectForgeDeliveryPhaseRun({
      catalogFile: CATALOG_FILE,
      stateFile: context.stateFile,
      reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
      receiptFile: path.join(context.root, `database-reject-${generation}.json`),
    });
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const parent = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const sourceBytes = await readFile(context.stateFile);
  const outputDirectory = path.join(context.root, 'new-database-continuation');
  const args = {
    catalogFile: CATALOG_FILE,
    sourceStateFile: context.stateFile,
    expectedSourceStateSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    sourceArtifactsDirectory: context.artifactsDirectory,
    sourceCommit: SOURCE_COMMIT,
    originalRequestFile: context.originalRequestFile,
    outputDirectory,
  };
  return { context, catalog, parent, sourceBytes, outputDirectory, args };
}

test('database continuation prepares an isolated R/D boundary without changing the blocked parent', async () => {
  const { context, catalog, parent, sourceBytes, outputDirectory, args } = await databaseContinuationFixture();
  assert.equal(parent.status, 'blocked');
  assert.equal(parent.lastExecutionGeneration, 6);
  const receipt = await prepareForgeDatabaseContinuation(args);
  const next = await readForgeDeliveryPhaseState(path.join(outputDirectory, 'state.json'), catalog);
  assert.deepEqual(await readFile(context.stateFile), sourceBytes);
  assert.equal(next.status, 'active');
  assert.equal(next.currentPhaseId, 'database');
  assert.equal(next.currentPhaseIndex, 2);
  assert.equal(next.activeAttempt, null);
  assert.equal(next.lastExecutionGeneration, 4);
  assert.deepEqual(next.history, parent.history.slice(0, 4));
  assert.deepEqual(next.acceptedArtifacts, parent.acceptedArtifacts);
  assert.equal(receipt.parentLastExecutionGeneration, 6);
  assert.equal(receipt.nextExecutionGenerationMinimum, 7);
  assert.equal(receipt.inheritedStageCount, 2);
  assert.equal(receipt.newAcceptedStageCount, 0);
  assert.equal(receipt.modelStarted, false);
  assert.deepEqual(receipt.parentDatabaseFailureReceiptDigests,
    parent.history.slice(4).map((entry) => entry.receiptDigest));
  assert.equal(receipt.sourceStateSha256, args.expectedSourceStateSha256);
  assert.equal(receipt.sourceStateDigest, parent.stateDigest);
  assert.equal(receipt.stateDigest, next.stateDigest);
  for (const kind of ['requirements-contract', 'domain-api-contract']) {
    assert.deepEqual(await readFile(path.join(outputDirectory, 'artifacts', `${kind}.json`)),
      await readFile(path.join(context.artifactsDirectory, `${kind}.json`)));
  }
  const accepted = await Promise.all(['requirements-contract', 'domain-api-contract'].map(async (kind) =>
    JSON.parse(await readFile(path.join(outputDirectory, 'artifacts', `${kind}.json`), 'utf8'))));
  const expectedPrompt = buildForgeDeliveryPhasePrompt({
    state: next,
    catalog,
    originalRequest: (await readFile(context.originalRequestFile, 'utf8')).trimEnd(),
    upstreamArtifacts: accepted,
  });
  const promptBytes = await readFile(path.join(outputDirectory, 'current-prompt.md'));
  assert.deepEqual(promptBytes, Buffer.from(`${expectedPrompt}\n`));
  assert.equal(receipt.promptSha256, crypto.createHash('sha256').update(promptBytes).digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, 'continuation-receipt.json'), 'utf8')), receipt);
  await assert.rejects(prepareForgeDatabaseContinuation(args), { code: 'EEXIST' });
});

test('database continuation rejects changed source, wrong identity, and missing or stale accepted artifacts', async () => {
  const { context, sourceBytes, outputDirectory, args } = await databaseContinuationFixture();
  await assert.rejects(prepareForgeDatabaseContinuation({ ...args, expectedSourceStateSha256: '0'.repeat(64) }),
    { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await assert.rejects(prepareForgeDatabaseContinuation({ ...args, sourceCommit: '1'.repeat(40) }),
    { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  const domainFile = path.join(context.artifactsDirectory, 'domain-api-contract.json');
  const domainBytes = await readFile(domainFile);
  await writeFile(domainFile, Buffer.from('{}\n'));
  await assert.rejects(prepareForgeDatabaseContinuation(args));
  await writeFile(domainFile, domainBytes);
  const missing = path.join(context.root, 'missing-artifacts');
  await mkdir(missing);
  await assert.rejects(prepareForgeDatabaseContinuation({ ...args, sourceArtifactsDirectory: missing }));
  await assert.rejects(readFile(path.join(outputDirectory, 'state.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(context.stateFile), sourceBytes);
});

test('database continuation refuses invalid upstream and non-database or business-blocked terminal states', async () => {
  const { context, catalog, args } = await databaseContinuationFixture();
  const domainFile = path.join(context.artifactsDirectory, 'domain-api-contract.json');
  const domain = JSON.parse(await readFile(domainFile, 'utf8'));
  domain.upstreamArtifactDigests['requirements-contract'] = '1'.repeat(64);
  const digest = (value) => crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
  const { artifactDigest: _artifactDigest, ...artifactPayload } = domain;
  domain.artifactDigest = digest(artifactPayload);
  await writeFile(domainFile, `${JSON.stringify(domain, null, 2)}\n`);
  const state = structuredClone(await readForgeDeliveryPhaseState(context.stateFile, catalog));
  state.acceptedArtifacts['domain-api-contract'] = domain.artifactDigest;
  state.history[3].artifactDigest = domain.artifactDigest;
  const { receiptDigest: _receiptDigest, ...receiptPayload } = state.history[3];
  state.history[3].receiptDigest = digest(receiptPayload);
  const { stateDigest: _stateDigest, ...statePayload } = state;
  state.stateDigest = digest(statePayload);
  await writeForgeDeliveryPhaseState(context.stateFile, state, catalog);
  const changedArgs = { ...args,
    expectedSourceStateSha256: crypto.createHash('sha256').update(await readFile(context.stateFile)).digest('hex') };
  await assert.rejects(prepareForgeDatabaseContinuation(changedArgs), { code: 'PHASE_CONTROLLER_UPSTREAM_STALE' });

  const nonDatabase = await fixture();
  await beginCurrent(nonDatabase, 1);
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: nonDatabase.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED', receiptFile: path.join(nonDatabase.root, 'reject1.json') });
  await beginCurrent(nonDatabase, 2);
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: nonDatabase.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED', receiptFile: path.join(nonDatabase.root, 'reject2.json') });
  const wrongPhaseArgs = { ...args, sourceStateFile: nonDatabase.stateFile,
    sourceArtifactsDirectory: nonDatabase.artifactsDirectory,
    expectedSourceStateSha256: crypto.createHash('sha256').update(await readFile(nonDatabase.stateFile)).digest('hex'),
    outputDirectory: path.join(nonDatabase.root, 'invalid-continuation') };
  await assert.rejects(prepareForgeDatabaseContinuation(wrongPhaseArgs), { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  const blocked = structuredClone(await readForgeDeliveryPhaseState(context.stateFile, catalog));
  blocked.history[5].decision = 'blocked';
  blocked.history[5].reasonCode = 'BUSINESS_DECISION_REQUIRED';
  const { receiptDigest: _blockedDigest, ...blockedReceipt } = blocked.history[5];
  blocked.history[5].receiptDigest = digest(blockedReceipt);
  const { stateDigest: _blockedStateDigest, ...blockedState } = blocked;
  blocked.stateDigest = digest(blockedState);
  await writeForgeDeliveryPhaseState(context.stateFile, blocked, catalog);
  const blockedArgs = { ...args,
    expectedSourceStateSha256: crypto.createHash('sha256').update(await readFile(context.stateFile)).digest('hex') };
  await assert.rejects(prepareForgeDatabaseContinuation(blockedArgs), { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
});

async function staleWriteRecoveryFixture() {
  const context = await fixture();
  await finalizeCurrent(context, {
    generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await beginCurrent(context, 3);
  await rejectForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    reasonCode: 'SEMANTIC_REVIEW_FAILED',
    receiptFile: path.join(context.root, 'database-attempt1-rejected.json'),
  });
  const { catalog, state: active } = await beginCurrent(context, 4);
  const legacy = structuredClone(active);
  legacy.schemaVersion = 'forge-delivery-phase-state/v1';
  delete legacy.stateDigest;
  legacy.stateDigest = crypto.createHash('sha256').update(canonicalStringify(legacy)).digest('hex');
  await writeForgeDeliveryPhaseState(context.stateFile, legacy, catalog);

  const directory = path.join(context.root, 'database-stale-recovery');
  await mkdir(directory, { recursive: true });
  const files = Object.fromEntries(['evidence', 'trace', 'receipt']
    .map((name) => [name, path.join(directory, name)]));
  const responseBytes = Buffer.from('The platform prevented the database candidate from being produced.\n');
  const emptyArrayBytes = Buffer.from('[]\n');
  const stderrBytes = Buffer.from('forge phase controller: PHASE_CONTROLLER_ZERO_CHANGE: Source phase database produced no new owned change.\n');
  const ownedPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/AssetMigrationContractTest.java';
  const contentDigest = crypto.createHash('sha256').update('candidate').digest('hex');
  const trace = {
    schemaVersion: 'forge-writer-stale-create-trace/v1',
    sessionId: legacy.sessionId,
    sessionUpdatedAt: 1,
    rpcId: legacy.activeAttempt.rpcId,
    executionGeneration: legacy.activeAttempt.executionGeneration,
    path: ownedPath,
    events: [
      { seq: 10, type: 'tool/call', tool: 'write', callId: 'call-write-1', argumentsSha256: '1'.repeat(64), contentBytes: 9, contentSha256: contentDigest },
      { seq: 11, type: 'tool/result', callId: 'call-write-1', isError: true, errorName: 'FsError', errorCode: 'FS_STALE_VERSION', text: `Error: cannot write "/workspace/${ownedPath}": file no longer exists — re-read the file, then retry` },
      { seq: 20, type: 'tool/call', tool: 'read', callId: 'call-read', argumentsSha256: '2'.repeat(64) },
      { seq: 21, type: 'tool/result', callId: 'call-read', isError: true, errorName: 'FsError', errorCode: 'FS_NOT_FOUND', text: `Error: cannot read "/workspace/${ownedPath}": not found` },
      { seq: 30, type: 'tool/call', tool: 'write', callId: 'call-write-2', argumentsSha256: '3'.repeat(64), contentBytes: 9, contentSha256: contentDigest },
      { seq: 31, type: 'tool/result', callId: 'call-write-2', isError: true, text: 'Error: FORGE_PHASE_BUDGET_GUARD_V1: NO_MACHINE_OBSERVABLE_PROGRESS; ordinary mutation is closed, preserve the current immutable evidence and issue a truthful bounded closeout' },
    ],
  };
  const traceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`);
  const traceDigest = crypto.createHash('sha256').update(traceBytes).digest('hex');
  const stateFileDigest = crypto.createHash('sha256').update(await readFile(context.stateFile)).digest('hex');
  const evidence = {
    schemaVersion: 'forge-asset-ledger-database-attempt2-failure/v1',
    outcome: 'controller-preflight-rejected',
    phaseId: 'database',
    phaseAttemptId: legacy.activeAttempt.attemptId,
    executionGeneration: legacy.activeAttempt.executionGeneration,
    rpcId: legacy.activeAttempt.rpcId,
    modelTerminalKind: 'completed',
    controllerPreflight: {
      exitCode: 1,
      errorCode: 'PHASE_CONTROLLER_ZERO_CHANGE',
      stderrSha256: crypto.createHash('sha256').update(stderrBytes).digest('hex'),
      stdoutSha256: EMPTY_SHA256,
      receiptCreated: false,
      stateAdvanced: false,
    },
    independentContractFailure: {
      artifactOpenCount: 0,
      artifactCloseCount: 0,
      uniqueArtifactPresent: false,
      responseSha256: crypto.createHash('sha256').update(responseBytes).digest('hex'),
    },
    workspaceEvidence: {
      allChangedPathsSha256: crypto.createHash('sha256').update(emptyArrayBytes).digest('hex'),
      phaseChangedPathsSha256: crypto.createHash('sha256').update(emptyArrayBytes).digest('hex'),
      phasePatchSha256: EMPTY_SHA256,
      cumulativePatchSha256: EMPTY_SHA256,
      sourceCommit: SOURCE_COMMIT,
      clean: true,
    },
    forensicTurnEvidenceSha256: '4'.repeat(64),
    writerRecoveryTraceSha256: traceDigest,
    controllerStateFrozenSha256: stateFileDigest,
    hostRunnerExecuted: false,
    accepted: false,
    existingRejectInvoked: false,
    plannedTechnicalFailureClass: 'PLATFORM_WRITE_RECOVERY_FAILED',
    disposition: 'freeze-active-attempt-until-evidence-bound-technical-invalidation-is-versioned',
    cannotClaim: ['database accepted', 'database code produced', 'Host Runner verified', 'release ready'],
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await Promise.all([
    writeFile(files.trace, traceBytes),
    writeFile(files.evidence, evidenceBytes),
  ]);
  return {
    context,
    files,
    args: {
      catalogFile: CATALOG_FILE,
      stateFile: context.stateFile,
      technicalFailureEvidenceFile: files.evidence,
      expectedTechnicalFailureEvidenceSha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex'),
      writerRecoveryTraceFile: files.trace,
      expectedWriterRecoveryTraceSha256: traceDigest,
      operationId: '49e613c0-e315-4986-b034-3fe645b834d4',
      receiptFile: files.receipt,
    },
  };
}

test('backend Host-finalized continuation prepares its protected frontend seed from bound BE02 evidence', async () => {
  const context = await fixture();
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const databasePath = 'forge-server/db/migration/V20260903__employee.sql';
  const databaseTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeMigrationContractTest.java';
  const backendPath = 'forge-server/forge-business/forge-business-core/src/main/java/com/forge/EmployeeController.java';
  await finalizeCurrent(context, { generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '' });
  await finalizeCurrent(context, { generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '' });
  await finalizeCurrent(context, { generation: 7, allChangedPaths: [databasePath, databaseTestPath].sort(),
    phaseChangedPaths: [databasePath, databaseTestPath].sort(), phasePatch: 'database patch\n', cumulativePatch: 'database patch\n' });
  await finalizeCurrent(context, { generation: 8, allChangedPaths: [databasePath, databaseTestPath].sort(),
    phaseChangedPaths: [], phasePatch: '', cumulativePatch: 'database patch\n' });
  await beginCurrent(context, 9);
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED', receiptFile: path.join(context.root, 'backend-reject.json') });
  const { phase } = await beginCurrent(context, 10);
  assert.equal(phase.id, 'backend');
  const sourceCaseDirectory = path.join(context.root, 'crud-complete');
  const sourceControl = path.join(sourceCaseDirectory, 'phase-control');
  const sourceEvidence = path.join(sourceCaseDirectory, 'phases/05-backend/attempts/02');
  const outputDirectory = path.join(context.root, 'continued-case');
  const bindingsFile = path.join(context.root, 'backend-bindings.json');
  const write = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600 }); };
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation', 'ui-interaction-contract'];
  const profiles = ['governance', 'backend-module-compile', 'backend-module-test'];
  const artifactSha256 = {};
  for (const kind of kinds) {
    const bytes = await readFile(path.join(context.artifactsDirectory, `${kind}.json`));
    artifactSha256[kind] = digest(bytes);
    await write(path.join(sourceControl, 'artifacts', `${kind}.json`), bytes);
  }
  const originalState = await readFile(context.stateFile);
  await write(path.join(sourceControl, 'state.json'), originalState);
  const patch = Buffer.from('database patch\nbackend patch\n');
  const response = Buffer.from(`已完成后端业务设计。\n\n<forge-phase-artifact>${JSON.stringify(proposalFor(phase, [backendPath]))}</forge-phase-artifact>\n`);
  const evidence = {
    'model.stdout.txt': response,
    'all-changed-paths.json': Buffer.from(`${JSON.stringify([backendPath, databasePath, databaseTestPath].sort())}\n`),
    'phase-changed-paths.json': Buffer.from(`${JSON.stringify([backendPath])}\n`),
    'phase.patch': Buffer.from('backend patch\n'),
    'cumulative.patch': patch,
  };
  for (const [name, bytes] of Object.entries(evidence)) await write(path.join(sourceEvidence, name), bytes);
  const preflight = await preflightForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: path.join(sourceControl, 'state.json'), artifactsDirectory: path.join(sourceControl, 'artifacts'),
    responseFile: path.join(sourceEvidence, 'model.stdout.txt'),
    allChangedPathsFile: path.join(sourceEvidence, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(sourceEvidence, 'phase-changed-paths.json'),
    phasePatchFile: path.join(sourceEvidence, 'phase.patch'),
    cumulativePatchFile: path.join(sourceEvidence, 'cumulative.patch'),
    receiptFile: path.join(sourceEvidence, 'controller-preflight-receipt.json') });
  const review = { schemaVersion: 'forge-independent-semantic-review/v1', reviewer: 'independent-fixture-reviewer',
    subject: { phaseId: 'backend', responseSha256: digest(response), candidateArtifactDigest: preflight.candidateArtifactDigest },
    verdict: 'PASS', severityCounts: { p0: 0, p1: 0, p2: 0 }, findings: [],
    coverageSummary: 'Backend fixture accepted after current preflight.', cannotClaim: [] };
  await write(path.join(sourceEvidence, 'independent-semantic-review.json'), Buffer.from(`${JSON.stringify(review)}\n`));
  await write(path.join(sourceEvidence, 'host-runner/manifest.json'), Buffer.from(`${JSON.stringify({
    caseId: 'crud-complete', phaseId: 'backend', sourceHead: SOURCE_COMMIT,
    completePatchSha256: digest(patch), runnerExitCode: 0,
    requestedProfiles: profiles, completedProfiles: profiles,
    receiptStatuses: Object.fromEntries(profiles.map((profile) => [profile, 'passed'])),
  })}\n`));
  for (const profile of profiles) await write(path.join(sourceEvidence, `host-runner/${profile}/host-profile.receipt.json`),
    Buffer.from(`${JSON.stringify({ receipt: { status: 'passed', source: { head: SOURCE_COMMIT,
      workspaceFingerprint: 'a'.repeat(64) }, request: { profile },
    policy: { profileCatalogVersion: (await loadForgeDeliveryPhaseCatalog(CATALOG_FILE)).catalog.catalogVersion } } })}\n`));
  const hostReceipts = await Promise.all(profiles.map(async (profile) => ({ profile, status: 'passed',
    receiptDigest: digest(await readFile(path.join(sourceEvidence,
      `host-runner/${profile}/host-profile.receipt.json`))), patchDigest: digest(patch) })));
  await write(path.join(sourceEvidence, 'phase-host-receipts.json'), Buffer.from(`${JSON.stringify(hostReceipts)}\n`));
  const evidenceSha256 = {};
  for (const relative of [...Object.keys(evidence), 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'phase-host-receipts.json', 'host-runner/manifest.json',
    ...profiles.map((profile) => `host-runner/${profile}/host-profile.receipt.json`)]) {
    evidenceSha256[relative] = digest(await readFile(path.join(sourceEvidence, relative)));
  }
  const bindings = { schemaVersion: 'forge-delivery-backend-finalize-bindings/v1',
    sourceStateSha256: digest(originalState), originalRequestSha256: digest(await readFile(context.originalRequestFile)),
    artifactSha256, evidenceSha256 };
  const bindingsBytes = Buffer.from(`${JSON.stringify(bindings)}\n`);
  await write(bindingsFile, bindingsBytes);
  const args = { catalogFile: CATALOG_FILE, sourceCaseDirectory, bindingsFile,
    expectedBindingsSha256: digest(bindingsBytes), sourceCommit: SOURCE_COMMIT,
    originalRequestFile: context.originalRequestFile, outputDirectory };
  const result = await prepareForgeBackendFinalizedContinuation(args);
  assert.equal(result.backendArtifactDigest, preflight.candidateArtifactDigest);
  assert.equal(result.nextExecutionGenerationMinimum, 11);
  assert.deepEqual(await readFile(path.join(sourceControl, 'state.json')), originalState);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const next = await readForgeDeliveryPhaseState(path.join(outputDirectory, 'phase-control/state.json'), catalog);
  assert.equal(next.currentPhaseId, 'frontend');
  assert.equal(next.currentPhaseIndex, 5);
  assert.equal(Object.keys(next.acceptedArtifacts).length, 5);
  assert.equal(next.acceptedArtifacts['backend-implementation'], preflight.candidateArtifactDigest);
  if (process.platform === 'linux') {
    const environment = await protectedRetryEnvironment(context);
    const prepared = await prepareHeadlessExecutionFromEnvironment({
      ...environment,
      FORGE_PROTECTED_HEADLESS_RPC_ID: 'frontend-rpc-11',
      FORGE_EVAL_PHASE_ID: 'frontend',
      FORGE_EVAL_PHASE_STATE_FILE: path.join(outputDirectory, 'phase-control/state.json'),
      FORGE_EVAL_PROMPT_FILE: path.join(outputDirectory, 'phase-control/current-prompt.md'),
      FORGE_EVAL_BACKEND_CONTINUATION_RECEIPT_FILE: path.join(outputDirectory,
        'phase-control/backend-continuation-receipt.json'),
    });
    assert.equal(prepared.phaseId, 'frontend');
    assert.equal(prepared.generation, 11);
    assert.equal(prepared.actionCeiling, 'workspace-write');
    assert.deepEqual(prepared.ownedPaths, [...catalog.workflows[0].phases[5].ownedPaths].sort());
    assert.equal(prepared.phaseAttemptId !== null, true);
  }
  await assert.rejects(prepareForgeBackendFinalizedContinuation({ ...args, expectedBindingsSha256: '0'.repeat(64) }),
    { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await write(path.join(sourceEvidence, 'cumulative.patch'), 'changed patch\n');
  await assert.rejects(prepareForgeBackendFinalizedContinuation({ ...args, outputDirectory: path.join(context.root, 'wrong') }),
    { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
});

test('accepted frontend continuation copies six accepted contracts and its Controller prompt without finalizing again', async () => {
  const context = await fixture();
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const write = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600 }); };
  const dbPath = 'forge-server/db/migration/V20260903__employee.sql';
  const dbTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeMigrationContractTest.java';
  const bePath = 'forge-server/forge-business/forge-business-core/src/main/java/com/forge/EmployeeController.java';
  const fePath = 'forge-admin-ui/src/views/Employee.vue';
  const dbPaths = [dbPath, dbTestPath].sort();
  const bePaths = [...dbPaths, bePath].sort();
  const fePaths = [...bePaths, fePath].sort();
  for (let index = 0; index < 5; index += 1) {
    await beginCurrent(context, index * 2 + 1);
    await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
      reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
      receiptFile: path.join(context.root, `rejected-${index}.json`) });
    const changed = index === 2 ? dbPaths : index === 4 ? [bePath] : [];
    const all = index >= 4 ? bePaths : index >= 2 ? dbPaths : [];
    const cumulative = index >= 4 ? 'database patch\nbackend patch\n' : index >= 2 ? 'database patch\n' : '';
    await finalizeCurrent(context, { generation: index * 2 + 2,
      allChangedPaths: all, phaseChangedPaths: changed,
      phasePatch: index === 2 ? 'database patch\n' : index === 4 ? 'backend patch\n' : '',
      cumulativePatch: cumulative });
  }
  const { phase } = await beginCurrent(context, 11);
  assert.equal(phase.id, 'frontend');
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
    receiptFile: path.join(context.root, 'frontend-rejected.json') });
  await beginCurrent(context, 12);
  const sourceCaseDirectory = path.join(context.root, 'crud-complete');
  const sourceControl = path.join(sourceCaseDirectory, 'phase-control');
  const sourceEvidence = path.join(sourceCaseDirectory, 'candidate-lint-fixed');
  const outputDirectory = path.join(context.root, 'continued-case');
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation'];
  const profiles = ['governance', 'frontend-admin-lint', 'frontend-admin-test',
    'frontend-admin-typecheck', 'frontend-admin-build'];
  for (const kind of kinds.slice(0, 5)) {
    await write(path.join(sourceControl, 'artifacts', `${kind}.json`),
      await readFile(path.join(context.artifactsDirectory, `${kind}.json`)));
  }
  await write(path.join(sourceControl, 'state.json'), await readFile(context.stateFile));
  const patch = Buffer.from('database patch\nbackend patch\nfrontend patch\n');
  const response = Buffer.from(`前端页面已实现，供业务人员核对。\n\n<forge-phase-artifact>${JSON.stringify(proposalFor(phase, [fePath]))}</forge-phase-artifact>\n`);
  const evidence = {
    'model.stdout.txt': response,
    'all-changed-paths.json': Buffer.from(`${JSON.stringify(fePaths)}\n`),
    'phase-changed-paths.json': Buffer.from(`${JSON.stringify([fePath])}\n`),
    'phase.patch': Buffer.from('frontend patch\n'),
    'cumulative.patch': patch,
  };
  for (const [name, bytes] of Object.entries(evidence)) await write(path.join(sourceEvidence, name), bytes);
  const preflight = await preflightForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: path.join(sourceControl, 'state.json'), artifactsDirectory: path.join(sourceControl, 'artifacts'),
    responseFile: path.join(sourceEvidence, 'model.stdout.txt'),
    allChangedPathsFile: path.join(sourceEvidence, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(sourceEvidence, 'phase-changed-paths.json'),
    phasePatchFile: path.join(sourceEvidence, 'phase.patch'),
    cumulativePatchFile: path.join(sourceEvidence, 'cumulative.patch'),
    receiptFile: path.join(sourceEvidence, 'controller-preflight-receipt.json') });
  const review = { schemaVersion: 'forge-independent-semantic-review/v1', reviewer: 'independent-fixture-reviewer',
    subject: { phaseId: 'frontend', responseSha256: digest(response), candidateArtifactDigest: preflight.candidateArtifactDigest },
    verdict: 'PASS', severityCounts: { p0: 0, p1: 0, p2: 0 }, findings: [],
    coverageSummary: 'Frontend fixture accepted after current preflight.', cannotClaim: [] };
  await write(path.join(sourceEvidence, 'independent-semantic-review.json'), `${JSON.stringify(review)}\n`);
  const hostReceipts = [];
  for (const profile of profiles) {
    const original = Buffer.from(`${JSON.stringify({ receipt: { status: 'passed',
      source: { head: SOURCE_COMMIT, workspaceFingerprint: 'a'.repeat(64) }, request: { profile },
      policy: { profileCatalogVersion: (await loadForgeDeliveryPhaseCatalog(CATALOG_FILE)).catalog.catalogVersion } } })}\n`);
    await write(path.join(sourceEvidence, `host-runner/${profile}/host-profile.receipt.json`), original);
    hostReceipts.push({ profile, status: 'passed', receiptDigest: digest(original), patchDigest: digest(patch) });
  }
  await write(path.join(sourceEvidence, 'phase-host-receipts.json'), `${JSON.stringify(hostReceipts)}\n`);
  const finalized = await finalizeForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: path.join(sourceControl, 'state.json'), artifactsDirectory: path.join(sourceControl, 'artifacts'),
    originalRequestFile: context.originalRequestFile,
    responseFile: path.join(sourceEvidence, 'model.stdout.txt'),
    allChangedPathsFile: path.join(sourceEvidence, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(sourceEvidence, 'phase-changed-paths.json'),
    phasePatchFile: path.join(sourceEvidence, 'phase.patch'),
    cumulativePatchFile: path.join(sourceEvidence, 'cumulative.patch'),
    hostReceiptsFile: path.join(sourceEvidence, 'phase-host-receipts.json'),
    outputDirectory: path.join(sourceEvidence, 'controller'),
    nextPromptFile: path.join(sourceControl, 'current-prompt.md') });
  await write(path.join(sourceEvidence, 'controller-cli-receipt.json'), `${JSON.stringify(finalized)}\n`);
  const stateBytes = await readFile(path.join(sourceControl, 'state.json'));
  const artifactSha256 = {};
  for (const kind of kinds) artifactSha256[kind] = digest(await readFile(path.join(sourceControl, 'artifacts', `${kind}.json`)));
  const evidenceNames = [...Object.keys(evidence), 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'phase-host-receipts.json', 'controller-cli-receipt.json',
    ...profiles.map((profile) => `host-runner/${profile}/host-profile.receipt.json`)];
  const evidenceSha256 = {};
  for (const name of evidenceNames) evidenceSha256[name] = digest(await readFile(path.join(sourceEvidence, name)));
  const bindings = { schemaVersion: 'forge-delivery-access-wiring-continuation-bindings/v1',
    sourceStateSha256: digest(stateBytes), originalRequestSha256: digest(await readFile(context.originalRequestFile)),
    artifactSha256, evidenceSha256,
    currentPromptSha256: digest(await readFile(path.join(sourceControl, 'current-prompt.md'))) };
  const bindingsFile = path.join(context.root, 'access-wiring-bindings.json');
  const bindingsBytes = Buffer.from(`${JSON.stringify(bindings)}\n`);
  await write(bindingsFile, bindingsBytes);
  const args = { catalogFile: CATALOG_FILE, sourceCaseDirectory, bindingsFile,
    expectedBindingsSha256: digest(bindingsBytes), sourceCommit: SOURCE_COMMIT,
    originalRequestFile: context.originalRequestFile, outputDirectory };
  const continuation = await prepareForgeAccessWiringContinuation(args);
  assert.equal(continuation.schemaVersion, 'forge-delivery-access-wiring-continuation/v1');
  assert.equal(continuation.inheritedStageCount, 6);
  assert.equal(continuation.nextExecutionGenerationMinimum, 13);
  assert.equal(continuation.cumulativePatchSha256, digest(patch));
  assert.deepEqual(await readFile(path.join(sourceControl, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(outputDirectory, 'phase-control/state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(outputDirectory, 'phase-control/current-prompt.md')),
    await readFile(path.join(sourceControl, 'current-prompt.md')));
  await assert.rejects(prepareForgeAccessWiringContinuation({ ...args, expectedBindingsSha256: '0'.repeat(64),
    outputDirectory: path.join(context.root, 'wrong-digest') }), { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await write(path.join(sourceEvidence, 'phase-host-receipts.json'), '[]\n');
  await assert.rejects(prepareForgeAccessWiringContinuation({ ...args,
    outputDirectory: path.join(context.root, 'wrong-host') }), { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
});

test('accepted access wiring continuation copies seven contracts and proves the generation 15 boundary', async () => {
  const context = await fixture();
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const put = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600 }); };
  const owned = new Map([
    [2, ['forge-server/db/migration/V20260913__supplier.sql',
      'forge-server/forge-business/forge-business-core/src/test/java/SupplierMigrationContractTest.java']],
    [4, 'forge-server/forge-business/forge-business-core/src/main/java/Supplier.java'],
    [5, 'forge-admin-ui/src/views/Supplier.vue'],
  ]);
  const accumulated = [];
  let cumulative = '';
  for (let index = 0; index < 6; index += 1) {
    await beginCurrent(context, index * 2 + 1);
    await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
      reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
      receiptFile: path.join(context.root, `rejected-${index}.json`) });
    const changed = owned.has(index) ? [owned.get(index)].flat() : [];
    accumulated.push(...changed);
    const phasePatch = changed.length ? `phase ${index} patch\n` : '';
    cumulative += phasePatch;
    await finalizeCurrent(context, { generation: index * 2 + 2,
      allChangedPaths: [...accumulated].sort(), phaseChangedPaths: changed,
      phasePatch, cumulativePatch: cumulative });
  }
  await beginCurrent(context, 13);
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED', receiptFile: path.join(context.root, 'aw-rejected.json') });
  const { phase } = await beginCurrent(context, 14);
  assert.equal(phase.id, 'access-wiring');
  const sourceCaseDirectory = path.join(context.root, 'crud-complete');
  const control = path.join(sourceCaseDirectory, 'phase-control');
  const evidenceDirectory = path.join(sourceCaseDirectory, 'phases/07-access-wiring/attempts/02');
  const outputDirectory = path.join(context.root, 'cross-layer-case');
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation', 'access-wiring-implementation'];
  for (const kind of kinds.slice(0, 6)) await put(path.join(control, 'artifacts', `${kind}.json`),
    await readFile(path.join(context.artifactsDirectory, `${kind}.json`)));
  await put(path.join(control, 'state.json'), await readFile(context.stateFile));
  const awPath = 'forge-server/db/migration/V20260913__access_wiring.sql';
  const awTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/AccessWiringMigrationContractTest.java';
  const awPaths = [awPath, awTestPath].sort();
  const phasePatch = Buffer.from('access wiring patch\n');
  const patch = Buffer.from(`${cumulative}access wiring patch\n`);
  const response = Buffer.from(`访问控制已准备完毕。\n\n<forge-phase-artifact>${JSON.stringify(proposalFor(phase, awPaths))}</forge-phase-artifact>\n`);
  const evidence = { 'model.stdout.txt': response, 'all-changed-paths.json': Buffer.from(`${JSON.stringify([...accumulated, ...awPaths].sort())}\n`),
    'phase-changed-paths.json': Buffer.from(`${JSON.stringify(awPaths)}\n`),
    'phase.patch': phasePatch, 'cumulative.patch': patch };
  for (const [name, bytes] of Object.entries(evidence)) await put(path.join(evidenceDirectory, name), bytes);
  const preflight = await preflightForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: path.join(control, 'state.json'), artifactsDirectory: path.join(control, 'artifacts'),
    responseFile: path.join(evidenceDirectory, 'model.stdout.txt'),
    allChangedPathsFile: path.join(evidenceDirectory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(evidenceDirectory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(evidenceDirectory, 'phase.patch'),
    cumulativePatchFile: path.join(evidenceDirectory, 'cumulative.patch'),
    receiptFile: path.join(evidenceDirectory, 'controller-preflight-receipt.json') });
  await put(path.join(evidenceDirectory, 'independent-semantic-review.json'), `${JSON.stringify({
    schemaVersion: 'forge-independent-semantic-review/v1', reviewer: 'independent-fixture-reviewer',
    subject: { phaseId: 'access-wiring', responseSha256: digest(response),
      candidateArtifactDigest: preflight.candidateArtifactDigest }, verdict: 'PASS',
    severityCounts: { p0: 0, p1: 0, p2: 0 }, findings: [], coverageSummary: 'Current access wiring accepted.',
    cannotClaim: [],
  })}\n`);
  const profiles = ['governance', 'backend-module-test'];
  const hostReceipts = [];
  for (const profile of profiles) {
    const bytes = Buffer.from(`${JSON.stringify({ receipt: { status: 'passed',
      source: { head: SOURCE_COMMIT, workspaceFingerprint: 'a'.repeat(64) }, request: { profile },
      policy: { profileCatalogVersion: (await loadForgeDeliveryPhaseCatalog(CATALOG_FILE)).catalog.catalogVersion } } })}\n`);
    await put(path.join(evidenceDirectory, `host-runner/${profile}/host-profile.receipt.json`), bytes);
    hostReceipts.push({ profile, status: 'passed', receiptDigest: digest(bytes), patchDigest: digest(patch) });
  }
  await put(path.join(evidenceDirectory, 'phase-host-receipts.json'), `${JSON.stringify(hostReceipts)}\n`);
  const finalized = await finalizeForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: path.join(control, 'state.json'), artifactsDirectory: path.join(control, 'artifacts'),
    originalRequestFile: context.originalRequestFile,
    responseFile: path.join(evidenceDirectory, 'model.stdout.txt'),
    allChangedPathsFile: path.join(evidenceDirectory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(evidenceDirectory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(evidenceDirectory, 'phase.patch'),
    cumulativePatchFile: path.join(evidenceDirectory, 'cumulative.patch'),
    hostReceiptsFile: path.join(evidenceDirectory, 'phase-host-receipts.json'),
    outputDirectory: path.join(evidenceDirectory, 'controller'),
    nextPromptFile: path.join(control, 'current-prompt.md') });
  await put(path.join(evidenceDirectory, 'controller-cli-receipt.json'), `${JSON.stringify(finalized)}\n`);
  const stateBytes = await readFile(path.join(control, 'state.json'));
  const evidenceNames = [...Object.keys(evidence), 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'phase-host-receipts.json', 'controller-cli-receipt.json',
    ...profiles.map((profile) => `host-runner/${profile}/host-profile.receipt.json`)];
  const bindings = { schemaVersion: 'forge-delivery-cross-layer-continuation-bindings/v1',
    sourceStateSha256: digest(stateBytes), originalRequestSha256: digest(await readFile(context.originalRequestFile)),
    artifactSha256: Object.fromEntries(await Promise.all(kinds.map(async (kind) =>
      [kind, digest(await readFile(path.join(control, 'artifacts', `${kind}.json`)))]))),
    evidenceSha256: Object.fromEntries(await Promise.all(evidenceNames.map(async (name) =>
      [name, digest(await readFile(path.join(evidenceDirectory, name)))]))),
    currentPromptSha256: digest(await readFile(path.join(control, 'current-prompt.md'))) };
  const bindingsFile = path.join(context.root, 'cross-layer-bindings.json');
  const bindingsBytes = Buffer.from(`${JSON.stringify(bindings)}\n`);
  await put(bindingsFile, bindingsBytes);
  const args = { catalogFile: CATALOG_FILE, sourceCaseDirectory, bindingsFile,
    expectedBindingsSha256: digest(bindingsBytes), sourceCommit: SOURCE_COMMIT,
    originalRequestFile: context.originalRequestFile, outputDirectory };
  const result = await prepareForgeCrossLayerContinuation(args);
  assert.equal(result.inheritedStageCount, 7);
  assert.equal(result.nextExecutionGenerationMinimum, 15);
  assert.equal(result.cumulativePatchSha256, digest(patch));
  assert.deepEqual(await readFile(path.join(outputDirectory, 'phase-control/state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  await assert.rejects(prepareForgeCrossLayerContinuation({ ...args, expectedBindingsSha256: '0'.repeat(64),
    outputDirectory: path.join(context.root, 'wrong-hash') }), { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await put(path.join(evidenceDirectory, 'phase-host-receipts.json'), '[]\n');
  await assert.rejects(prepareForgeCrossLayerContinuation({ ...args,
    outputDirectory: path.join(context.root, 'wrong-host') }), { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
});

async function frontendRepairFixture(attempts = 2) {
  const context = await fixture();
  for (const [rejected, accepted] of [[1, 2], [3, 4]]) {
    await beginCurrent(context, rejected);
    await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
      reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
      receiptFile: path.join(context.root, `upstream-rejected-${rejected}.json`) });
    await finalizeCurrent(context, { generation: accepted, allChangedPaths: [], phaseChangedPaths: [],
      phasePatch: '', cumulativePatch: '' });
  }
  const databasePaths = ['forge-server/db/migration/V20260903__employee.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeMigrationContractTest.java'].sort();
  const backendPath = 'forge-server/forge-business/forge-business-core/src/main/java/com/forge/EmployeeController.java';
  await finalizeCurrent(context, { generation: 6, allChangedPaths: databasePaths,
    phaseChangedPaths: databasePaths, phasePatch: 'database patch\n', cumulativePatch: 'database patch\n' });
  await finalizeCurrent(context, { generation: 7, allChangedPaths: databasePaths,
    phaseChangedPaths: [], phasePatch: '', cumulativePatch: 'database patch\n' });
  await finalizeCurrent(context, { generation: 9, allChangedPaths: [...databasePaths, backendPath].sort(),
    phaseChangedPaths: [backendPath], phasePatch: 'backend patch\n', cumulativePatch: 'database patch\nbackend patch\n' });
  const rejectionFiles = [];
  for (const generation of [10, 11].slice(0, attempts)) {
    await beginCurrent(context, generation);
    const receiptFile = path.join(context.root, `frontend-rejected-${generation}.json`);
    await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: context.stateFile,
      reasonCode: 'PHASE_RESPONSE_INVALID', receiptFile });
    rejectionFiles.push(receiptFile);
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const sourceBytes = await readFile(context.stateFile);
  const parent = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const args = { catalogFile: CATALOG_FILE, sourceStateFile: context.stateFile,
    expectedSourceStateSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    sourceArtifactsDirectory: context.artifactsDirectory, sourceCommit: SOURCE_COMMIT,
    originalRequestFile: context.originalRequestFile, outputDirectory: path.join(context.root, 'frontend-repair'),
    repairRequestText: '继续修改，处理上一轮阶段检查指出的问题。' };
  return { context, catalog, parent, sourceBytes, args, rejectionFiles };
}

test('linked frontend readonly-role recovery preserves the last quality attempt and binds real denial evidence', async () => {
  const { context, catalog, sourceBytes, args } = await frontendRepairFixture();
  args.repairRequestText = '继续修改。只读角色在此不出现任何可提交的编辑入口。';
  await prepareForgeFrontendRepairContinuation(args);
  const child = { ...context, stateFile: path.join(args.outputDirectory, 'state.json'),
    promptFile: path.join(args.outputDirectory, 'current-prompt.md'),
    originalRequestFile: path.join(args.outputDirectory, 'original-request.md'),
    artifactsDirectory: path.join(args.outputDirectory, 'artifacts') };
  await beginCurrent(child, 12);
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: child.stateFile,
    reasonCode: 'BROWSER_USER_ABORTED', receiptFile: path.join(context.root, 'user-aborted-12.json') });
  const { state } = await beginCurrent(child, 13);
  const oldPrompt = await readFile(child.promptFile);
  const requestBytes = await readFile(child.originalRequestFile);
  const content = [{ type: 'text', text: oldPrompt.toString('utf8').trimEnd() }];
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
    rpcId: state.activeAttempt.rpcId, method: 'session.prompt',
    payload: { sessionId: state.sessionId, mode: 'queue', content } })), 'session.prompt');
  const contract = compileForgeTaskExecutionContract({ prompt: '实现前端页面。', actionCeiling: 'workspace-write',
    ownedPaths: ['forge-admin-ui/src/views/business/employee.vue'], taskProfiles: ['frontend-admin'] });
  const execution = {
    schemaVersion: 1, issuer: 'forge-conversation-gateway', audience: 'forge-phase-budget-guard',
    executionId: crypto.randomUUID(), claimId: crypto.randomUUID(), generation: 13,
    projectSlug: 'readonly-role-project', taskId: state.taskId, actorUserId: crypto.randomUUID(), actorUsername: 'owner',
    conversationId: crypto.randomUUID(), dshSessionId: state.sessionId,
    route: classified.route, classification: classified.classification, rpcId: classified.rpcId,
    mode: classified.mode, bodyDigest: classified.bodyDigest, textDigest: classified.textDigest, bodyBytes: classified.bodyBytes,
    promptDigest: classified.textDigest, policyVersion: 'forge-conversation-execution/v1',
    authorityClass: 'production-task-writer', testOnly: false, sourceCommit: SOURCE_COMMIT,
    workspaceFingerprint: 'a'.repeat(64), caseFamily: state.caseFamily, productionAuthorityId: crypto.randomUUID(),
    controllerGrantDigest: 'b'.repeat(64), workflowId: state.workflowId, phaseId: 'frontend', phaseIndex: 5,
    phaseCatalogVersion: state.catalogVersion, phaseCatalogDigest: state.catalogDigest,
    contractId: contract.contractId, contractDigest: contract.contractId, actionCeiling: contract.actionCeiling,
    ownedPaths: contract.ownedPaths, requiredProfiles: contract.requiredVerificationProfiles, contract,
    requestId: 'request:readonly:13', issuedAt: '2026-09-17T00:00:00.000Z', expiresAt: '2026-09-17T00:10:00.000Z',
  };
  execution.productionAuthorityDigest = digestProductionTaskAuthorityBinding(execution);
  const identityKeys = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId', 'phaseId',
    'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  const identity = Object.fromEntries(identityKeys.map((key) => [key, execution[key]]));
  const baseline = { schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', ...identity,
    observedSeq: 1, sessionCwd: '/workspace' };
  const begin = { schemaVersion: 'forge-delivery-browser-phase-begin/v1', workflowId: state.workflowId,
    phaseId: 'frontend', phaseIndex: 5, attempt: state.activeAttempt };
  const tool = { callId: 'write-13', callSeq: 3, tool: 'Write', resultSeq: 4, status: 'error' };
  const sessionProof = { schemaVersion: 'forge-delivery-phase-browser-session-proof/v1', ...identity,
    baselineObservedSeq: 1, requestSeq: 2, assistantMessageSeq: 5, terminalSeq: 6, terminalReason: 'completed',
    toolCallCount: 1, toolResultCount: 1, toolResults: [tool], terminalEventDigest: 'c'.repeat(64),
    modelResponseSha256: 'd'.repeat(64), sessionCwd: '/workspace',
    historyPages: 1, historyEventCount: 6, hostReceiptsDerived: false };
  const proof = { schemaVersion: 'forge-delivery-frontend-readonly-denial-proof/v1', ...identity,
    baselineObservedSeq: 1, requestSeq: 2, terminalSeq: 6, terminalReason: 'completed',
    terminalEventDigest: sessionProof.terminalEventDigest, modelResponseSha256: sessionProof.modelResponseSha256,
    sessionProofDigest: crypto.createHash('sha256').update(JSON.stringify(sessionProof)).digest('hex'),
    sessionCwd: '/workspace', sessionRunning: false, toolCallCount: 1, toolResultCount: 1,
    denials: [{ ...tool, denialCode: 'GLOBAL_READ_ONLY_CONSTRAINT', resultTextSha256: 'e'.repeat(64) }], hostReceiptsDerived: false };
  const attemptDirectory = path.join(args.outputDirectory, 'browser-attempts', execution.executionId);
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const proofFile = path.join(attemptDirectory, '前端阶段-只读误拒证明.json');
  for (const [name, value] of [['execution.json', execution], ['session-baseline.json', baseline], ['begin.json', begin],
    ['会话终态证明.json', sessionProof], ['前端阶段-只读误拒证明.json', { ...proof, rpcId: 'wrong-rpc' }]]) {
    await writeFile(path.join(attemptDirectory, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
  const before = await readFile(child.stateFile);
  const retryArgs = { ...child, catalogFile: CATALOG_FILE, attemptDirectory, repairRequestText: '继续修改。完成原前端问题并如实验证。' };
  await assert.rejects(retryForgeFrontendReadonlyRolePhase(retryArgs), { code: 'PHASE_READONLY_ROLE_EVIDENCE_INVALID' });
  assert.deepEqual(await readFile(child.stateFile), before);
  assert.equal(isForgeFrontendReadonlyRoleRecoveryCandidate({ execution, promptText: content[0].text }), true);
  assert.equal(isForgeFrontendReadonlyRoleRecoveryCandidate({ execution: { ...execution, actionCeiling: 'read-only' },
    promptText: content[0].text }), false);
  const readonlyPrompt = `${content[0].text}\n本次仅做只读分析，不得修改任何文件。`;
  assert.equal(isForgeFrontendReadonlyRoleRecoveryCandidate({ execution: { ...execution,
    textDigest: digestDirectUserTextContent([{ type: 'text', text: readonlyPrompt }]) }, promptText: readonlyPrompt }), false);
  await writeFile(proofFile, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
  const retryReceiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(child.promptFile, state.activeAttempt.attemptId);
  await mkdir(retryReceiptFile);
  await assert.rejects(retryForgeFrontendReadonlyRolePhase(retryArgs));
  assert.deepEqual(await readFile(child.stateFile), before, 'partial output cannot publish recovery');
  assert.deepEqual(await readFile(child.promptFile), oldPrompt);
  const recoveryBefore = await readFile(path.join(attemptDirectory, '前端阶段-平台误拒恢复凭据.json'));
  await rm(retryReceiptFile, { recursive: true });
  const result = await retryForgeFrontendReadonlyRolePhase(retryArgs);
  assert.equal(result.status, 'retry-ready');
  assert.equal(result.receipt.remainingAttempts, 1);
  assert.deepEqual(await readFile(path.join(attemptDirectory, '前端阶段-平台误拒恢复凭据.json')), recoveryBefore);
  assert.deepEqual(await retryForgeFrontendReadonlyRolePhase(retryArgs), result);
  const recovered = await readForgeDeliveryPhaseState(child.stateFile, catalog);
  assert.equal(recovered.history.at(-1).incidentCode, 'READONLY_ROLE_PROMPT_MISCLASSIFIED');
  assert.equal(recovered.history.filter((entry) => entry.phaseId === 'frontend').length, 2);
  assert.deepEqual(recovered.acceptedArtifacts, state.acceptedArtifacts);
  assert.deepEqual(await readFile(context.stateFile), sourceBytes);
  assert.deepEqual(await readFile(child.originalRequestFile), requestBytes);
  assert.equal(JSON.parse(await readFile(path.join(attemptDirectory, '会话终态证明.json'))).terminalEventDigest, sessionProof.terminalEventDigest);
  const prepareArgs = { ...child, catalogFile: CATALOG_FILE, sourceCommit: SOURCE_COMMIT,
    taskId: state.taskId, sessionId: state.sessionId, rpcId: 'rpc-14' };
  const prepared = await prepareForgeDeliveryBrowserPhase(prepareArgs);
  assert.ok(prepared.promptText.includes(retryArgs.repairRequestText));
  await beginCurrent(child, 14);
  const active = await prepareForgeDeliveryBrowserPhase(prepareArgs);
  assert.equal(active.promptText, prepared.promptText);
  await assert.rejects(retryForgeFrontendReadonlyRolePhase(retryArgs), { code: 'PHASE_READONLY_ROLE_EVIDENCE_INVALID' });
  await writeFile(proofFile, `${JSON.stringify({ ...proof, denials: [] })}\n`, { mode: 0o600 });
  await assert.rejects(prepareForgeDeliveryBrowserPhase(prepareArgs), { code: 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID' });
});

test('linked frontend user-abort retry binds retained proof and feedback without rewriting its original request', async () => {
  const { context, catalog, sourceBytes, args } = await frontendRepairFixture();
  await prepareForgeFrontendRepairContinuation(args);
  const child = { ...context, stateFile: path.join(args.outputDirectory, 'state.json'),
    promptFile: path.join(args.outputDirectory, 'current-prompt.md'),
    originalRequestFile: path.join(args.outputDirectory, 'original-request.md'),
    artifactsDirectory: path.join(args.outputDirectory, 'artifacts') };
  const { state } = await beginCurrent(child, 12);
  const oldPrompt = await readFile(child.promptFile);
  const requestBytes = await readFile(child.originalRequestFile);
  const content = [{ type: 'text', text: oldPrompt.toString('utf8').trimEnd() }];
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
    rpcId: state.activeAttempt.rpcId, method: 'session.prompt',
    payload: { sessionId: state.sessionId, mode: 'queue', content } })), 'session.prompt');
  const contract = compileForgeTaskExecutionContract({ prompt: '实现前端页面。', actionCeiling: 'workspace-write',
    ownedPaths: ['forge-admin-ui/src/views/business/employee.vue'], taskProfiles: ['frontend-admin'] });
  const execution = {
    schemaVersion: 1, issuer: 'forge-conversation-gateway', audience: 'forge-phase-budget-guard',
    executionId: crypto.randomUUID(), claimId: crypto.randomUUID(), generation: 12,
    projectSlug: 'abort-retry-project', taskId: state.taskId, actorUserId: crypto.randomUUID(), actorUsername: 'owner',
    conversationId: crypto.randomUUID(), dshSessionId: state.sessionId,
    route: classified.route, classification: classified.classification, rpcId: classified.rpcId,
    mode: classified.mode, bodyDigest: classified.bodyDigest, textDigest: classified.textDigest, bodyBytes: classified.bodyBytes,
    promptDigest: classified.textDigest, policyVersion: 'forge-conversation-execution/v1',
    authorityClass: 'production-task-writer', testOnly: false, sourceCommit: SOURCE_COMMIT,
    workspaceFingerprint: 'a'.repeat(64), caseFamily: state.caseFamily, productionAuthorityId: crypto.randomUUID(),
    controllerGrantDigest: 'b'.repeat(64), workflowId: state.workflowId, phaseId: 'frontend', phaseIndex: 5,
    phaseCatalogVersion: state.catalogVersion, phaseCatalogDigest: state.catalogDigest,
    contractId: contract.contractId, contractDigest: contract.contractId, actionCeiling: contract.actionCeiling,
    ownedPaths: contract.ownedPaths, requiredProfiles: contract.requiredVerificationProfiles, contract,
    requestId: 'request:abort:12', issuedAt: '2026-09-17T00:00:00.000Z', expiresAt: '2026-09-17T00:10:00.000Z',
  };
  execution.productionAuthorityDigest = digestProductionTaskAuthorityBinding(execution);
  const identityKeys = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId', 'phaseId',
    'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  const identity = Object.fromEntries(identityKeys.map((key) => [key, execution[key]]));
  const baseline = { schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', ...identity,
    observedSeq: 1, sessionCwd: '/workspace' };
  const begin = { schemaVersion: 'forge-delivery-browser-phase-begin/v1', workflowId: state.workflowId,
    phaseId: 'frontend', phaseIndex: 5, attempt: state.activeAttempt };
  const proof = { schemaVersion: 'forge-delivery-phase-browser-interruption-proof/v1', ...identity,
    baselineObservedSeq: 1, requestSeq: 2, terminalSeq: 3, terminalReason: 'user-aborted',
    toolCallCount: 0, toolResultCount: 0, toolResults: [], terminalEventDigest: 'c'.repeat(64),
    sessionCwd: '/workspace', sessionRunning: false, historyPages: 1, historyEventCount: 3, hostReceiptsDerived: false };
  const attemptDirectory = path.join(args.outputDirectory, 'browser-attempts', execution.executionId);
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const proofFile = path.join(attemptDirectory, '会话中止证明.json');
  for (const [name, value] of [['execution.json', execution], ['session-baseline.json', baseline],
    ['begin.json', begin], ['会话中止证明.json', { ...proof, rpcId: 'rpc-wrong' }]]) {
    await writeFile(path.join(attemptDirectory, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
  const stateBefore = await readFile(child.stateFile);
  const retryArgs = { ...child, catalogFile: CATALOG_FILE, attemptDirectory,
    repairRequestText: '继续修改。读取 /project-inputs/incoming/原始资料.txt，沿用已确认范围。' };
  await assert.rejects(retryForgeFrontendUserAbortedPhase(retryArgs), { code: 'PHASE_CAPTURE_IDENTITY_CONFLICT' });
  assert.deepEqual(await readFile(child.stateFile), stateBefore);
  await assert.rejects(readFile(path.join(attemptDirectory, '前端阶段-用户中止拒绝凭据.json')), { code: 'ENOENT' });
  await writeFile(proofFile, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
  const retryReceiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(child.promptFile, state.activeAttempt.attemptId);
  await mkdir(retryReceiptFile);
  await assert.rejects(retryForgeFrontendUserAbortedPhase(retryArgs));
  assert.deepEqual(await readFile(child.stateFile), stateBefore, 'partial output must not publish rejection state');
  assert.deepEqual(await readFile(child.promptFile), oldPrompt);
  const rejectionBeforeResume = await readFile(path.join(attemptDirectory, '前端阶段-用户中止拒绝凭据.json'));
  await rm(retryReceiptFile, { recursive: true });
  const result = await retryForgeFrontendUserAbortedPhase(retryArgs);
  assert.equal(result.status, 'retry-ready');
  assert.equal(result.receipt.remainingAttempts, 1);
  assert.deepEqual(await readFile(path.join(attemptDirectory, '前端阶段-用户中止拒绝凭据.json')), rejectionBeforeResume);
  const retried = await readForgeDeliveryPhaseState(child.stateFile, catalog);
  assert.equal(retried.history.at(-1).reasonCode, 'BROWSER_USER_ABORTED');
  assert.deepEqual(await readFile(child.originalRequestFile), requestBytes);
  assert.deepEqual(await readFile(context.stateFile), sourceBytes);
  assert.deepEqual(await readFile(path.join(attemptDirectory, '前端阶段-中止前提示原文.md')), oldPrompt);
  assert.deepEqual(await retryForgeFrontendUserAbortedPhase(retryArgs), result);
  const prepareArgs = { ...child, catalogFile: CATALOG_FILE, sourceCommit: SOURCE_COMMIT,
    taskId: state.taskId, sessionId: state.sessionId, rpcId: 'rpc-13' };
  const prepared = await prepareForgeDeliveryBrowserPhase(prepareArgs);
  assert.ok(prepared.promptText.includes(retryArgs.repairRequestText));
  const feedbackFile = path.join(attemptDirectory, '前端阶段-重试补充说明.txt');
  await writeFile(feedbackFile, '伪造补充内容');
  await assert.rejects(prepareForgeDeliveryBrowserPhase(prepareArgs), { code: 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID' });
});

test('frontend repair continuation preserves exhausted parent and five accepted inputs across partial and active replay', async () => {
  const { context, catalog, parent, sourceBytes, args, rejectionFiles } = await frontendRepairFixture();
  const originalRequest = await readFile(context.originalRequestFile);
  const failures = await Promise.all(rejectionFiles.map((file) => readFile(file)));
  const artifacts = new Map(await Promise.all(Object.keys(parent.acceptedArtifacts).map(async (kind) =>
    [kind, await readFile(path.join(context.artifactsDirectory, `${kind}.json`))])));
  // A matching file left by an interrupted creation is reused, never overwritten.
  await mkdir(path.join(args.outputDirectory, 'artifacts'), { recursive: true });
  await writeFile(path.join(args.outputDirectory, 'artifacts/requirements-contract.json'), artifacts.get('requirements-contract'));
  const receipt = await prepareForgeFrontendRepairContinuation(args);
  const child = { ...context, stateFile: path.join(args.outputDirectory, 'state.json'),
    promptFile: path.join(args.outputDirectory, 'current-prompt.md'),
    originalRequestFile: path.join(args.outputDirectory, 'original-request.md'),
    artifactsDirectory: path.join(args.outputDirectory, 'artifacts') };
  const next = await readForgeDeliveryPhaseState(child.stateFile, catalog);
  assert.equal(parent.status, 'blocked');
  assert.equal(next.status, 'active');
  assert.equal(next.currentPhaseId, 'frontend');
  assert.equal(next.activeAttempt, null);
  assert.equal(next.lastExecutionGeneration, 9);
  assert.deepEqual(next.history, parent.history.filter((entry) => entry.phaseIndex < 5));
  assert.deepEqual(next.acceptedArtifacts, parent.acceptedArtifacts);
  assert.equal(receipt.schemaVersion, 'forge-delivery-frontend-repair-continuation/v1');
  assert.equal(receipt.parentLastExecutionGeneration, 11);
  assert.equal(receipt.nextExecutionGenerationMinimum, 12);
  assert.equal(receipt.inheritedStageCount, 5);
  assert.equal(receipt.newAcceptedStageCount, 0);
  assert.equal(receipt.modelStarted, false);
  assert.equal(receipt.sourceStateSha256, args.expectedSourceStateSha256);
  assert.equal(receipt.sourceCommit, parent.sourceCommit);
  assert.equal(receipt.catalogDigest, parent.catalogDigest);
  assert.deepEqual(receipt.parentFrontendFailureReceiptDigests,
    parent.history.filter((entry) => entry.phaseId === 'frontend').map((entry) => entry.receiptDigest));
  assert.deepEqual(receipt.inheritedArtifactDigests, parent.acceptedArtifacts);
  assert.equal(await readFile(path.join(args.outputDirectory, '前端阶段-修复请求原文.txt'), 'utf8'), args.repairRequestText);
  const combined = `${originalRequest.toString('utf8').trimEnd()}\n\n${args.repairRequestText}`;
  assert.equal(await readFile(child.originalRequestFile, 'utf8'), `${combined}\n`);
  const phase = catalog.workflows.find((entry) => entry.id === parent.workflowId).phases[5];
  assert.equal(await readFile(child.promptFile, 'utf8'), `${buildForgeDeliveryPhasePrompt({ state: next, catalog,
    originalRequest: combined, upstreamArtifacts: phase.requiresArtifacts.map((kind) => JSON.parse(artifacts.get(kind))),
  })}\n`);
  const receiptFile = path.join(args.outputDirectory, '前端阶段-关联修复凭据.json');
  const receiptBytes = await readFile(receiptFile);
  assert.deepEqual(JSON.parse(receiptBytes), receipt);
  assert.deepEqual(await prepareForgeFrontendRepairContinuation(args), receipt);
  await beginCurrent(child, receipt.nextExecutionGenerationMinimum);
  const activeChildBytes = await readFile(child.stateFile);
  assert.deepEqual(await prepareForgeFrontendRepairContinuation(args), receipt);
  assert.deepEqual(await readFile(child.stateFile), activeChildBytes);
  assert.deepEqual(await readFile(receiptFile), receiptBytes);
  await assert.rejects(prepareForgeFrontendRepairContinuation({ ...args, repairRequestText: '另一条反馈' }));
  assert.deepEqual(await readFile(child.stateFile), activeChildBytes);
  assert.deepEqual(await readFile(context.stateFile), sourceBytes);
  assert.deepEqual(await readFile(context.originalRequestFile), originalRequest);
  for (const [kind, bytes] of artifacts) {
    assert.deepEqual(await readFile(path.join(context.artifactsDirectory, `${kind}.json`)), bytes);
    assert.deepEqual(await readFile(path.join(child.artifactsDirectory, `${kind}.json`)), bytes);
  }
  for (const [index, file] of rejectionFiles.entries()) assert.deepEqual(await readFile(file), failures[index]);
});

test('frontend repair continuation refuses unexhausted and changed source before creating a child', async () => {
  const unexhausted = await frontendRepairFixture(1);
  await assert.rejects(prepareForgeFrontendRepairContinuation(unexhausted.args),
    { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  await assert.rejects(readdir(unexhausted.args.outputDirectory), { code: 'ENOENT' });
  const exhausted = await frontendRepairFixture();
  await assert.rejects(prepareForgeFrontendRepairContinuation({ ...exhausted.args, sourceCommit: '1'.repeat(40) }),
    { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  await writeFile(exhausted.context.stateFile, Buffer.concat([exhausted.sourceBytes, Buffer.from('\n')]));
  await assert.rejects(prepareForgeFrontendRepairContinuation(exhausted.args),
    { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await assert.rejects(readdir(exhausted.args.outputDirectory), { code: 'ENOENT' });
});

test('frontend repair continuation rejects rehashed upstream chain phase and source substitutions', async () => {
  const { context, catalog, parent, args } = await frontendRepairFixture();
  const digest = (value) => crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
  for (const [kind, mutate] of [
    ['domain-api-contract', (value) => { value.upstreamArtifactDigests['requirements-contract'] = '1'.repeat(64); }],
    ['backend-implementation', (value) => { value.phaseId = 'frontend'; }],
    ['ui-interaction-contract', (value) => { value.sourceFingerprint = '1'.repeat(64); }],
  ]) {
    const file = path.join(context.artifactsDirectory, `${kind}.json`);
    const original = await readFile(file);
    const artifact = JSON.parse(original);
    mutate(artifact);
    const { artifactDigest: _artifactDigest, ...payload } = artifact;
    artifact.artifactDigest = digest(payload);
    await writeFile(file, `${JSON.stringify(artifact)}\n`);
    const modified = structuredClone(parent);
    modified.acceptedArtifacts[kind] = artifact.artifactDigest;
    const accepted = modified.history.find((entry) => entry.artifactDigest === parent.acceptedArtifacts[kind]);
    accepted.artifactDigest = artifact.artifactDigest;
    const { receiptDigest: _receiptDigest, ...acceptedPayload } = accepted;
    accepted.receiptDigest = digest(acceptedPayload);
    const { stateDigest: _stateDigest, ...statePayload } = modified;
    modified.stateDigest = digest(statePayload);
    await writeForgeDeliveryPhaseState(context.stateFile, modified, catalog);
    const expectedSourceStateSha256 = crypto.createHash('sha256').update(await readFile(context.stateFile)).digest('hex');
    await assert.rejects(prepareForgeFrontendRepairContinuation({ ...args, expectedSourceStateSha256 }),
      { code: 'PHASE_CONTROLLER_UPSTREAM_STALE' });
    await assert.rejects(readdir(args.outputDirectory), { code: 'ENOENT' });
    await writeFile(file, original);
  }
});

test('frontend retry continuation binds FE01 rejection and seeds only protected FE02', async () => {
  const context = await fixture();
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const databasePath = 'forge-server/db/migration/V20260903__employee.sql';
  const databaseTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeMigrationContractTest.java';
  const backendPath = 'forge-server/forge-business/forge-business-core/src/main/java/com/forge/EmployeeController.java';
  const frontendPath = 'forge-admin-ui/src/views/Employee.vue';
  const databasePaths = [databasePath, databaseTestPath].sort();
  await finalizeCurrent(context, { generation: 1, allChangedPaths: [], phaseChangedPaths: [],
    phasePatch: '', cumulativePatch: '' });
  await finalizeCurrent(context, { generation: 2, allChangedPaths: [], phaseChangedPaths: [],
    phasePatch: '', cumulativePatch: '' });
  await finalizeCurrent(context, { generation: 3, allChangedPaths: databasePaths,
    phaseChangedPaths: databasePaths, phasePatch: 'database patch\n', cumulativePatch: 'database patch\n' });
  await finalizeCurrent(context, { generation: 4, allChangedPaths: databasePaths,
    phaseChangedPaths: [], phasePatch: '', cumulativePatch: 'database patch\n' });
  await finalizeCurrent(context, { generation: 5, allChangedPaths: [...databasePaths, backendPath].sort(),
    phaseChangedPaths: [backendPath], phasePatch: 'backend patch\n',
    cumulativePatch: 'database patch\nbackend patch\n' });
  const { phase } = await beginCurrent(context, 6);
  assert.equal(phase.id, 'frontend');
  const sourceCaseDirectory = path.join(context.root, 'source-case');
  const sourceControl = path.join(sourceCaseDirectory, 'phase-control');
  const sourceAttempt = path.join(sourceCaseDirectory, 'phases/06-frontend/attempts/01');
  const outputDirectory = path.join(context.root, 'continued-case');
  const bindingsFile = path.join(context.root, 'frontend-bindings.json');
  const write = async (file, bytes) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { mode: 0o600 });
  };
  const sourceState = await readFile(context.stateFile);
  const sourcePrompt = await readFile(context.promptFile);
  await write(path.join(sourceControl, 'state.json'), sourceState);
  await write(path.join(sourceControl, 'current-prompt.md'), sourcePrompt);
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation'];
  const artifactSha256 = {};
  for (const kind of kinds) {
    const bytes = await readFile(path.join(context.artifactsDirectory, `${kind}.json`));
    artifactSha256[kind] = digest(bytes);
    await write(path.join(sourceControl, 'artifacts', `${kind}.json`), bytes);
  }
  const response = Buffer.from(`已形成前端页面方案。\n\n<forge-phase-artifact>${JSON.stringify(
    proposalFor(phase, [frontendPath], []),
  )}</forge-phase-artifact>\n`);
  const phasePatch = Buffer.from('frontend patch\n');
  const cumulativePatch = Buffer.from('database patch\nbackend patch\nfrontend patch\n');
  const paths = [...databasePaths, backendPath, frontendPath].sort();
  const evidence = {
    'model.stdout.txt': response,
    'before-snapshot.json': Buffer.from('{}\n'),
    'all-changed-paths.json': Buffer.from(`${JSON.stringify(paths)}\n`),
    'phase-changed-paths.json': Buffer.from(`${JSON.stringify([frontendPath])}\n`),
    'phase.patch': phasePatch,
    'cumulative.patch': cumulativePatch,
  };
  for (const [name, bytes] of Object.entries(evidence)) await write(path.join(sourceAttempt, name), bytes);
  const preflight = await preflightForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: path.join(sourceControl, 'state.json'),
    artifactsDirectory: path.join(sourceControl, 'artifacts'),
    responseFile: path.join(sourceAttempt, 'model.stdout.txt'),
    allChangedPathsFile: path.join(sourceAttempt, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(sourceAttempt, 'phase-changed-paths.json'),
    phasePatchFile: path.join(sourceAttempt, 'phase.patch'),
    cumulativePatchFile: path.join(sourceAttempt, 'cumulative.patch'),
    receiptFile: path.join(sourceAttempt, 'controller-preflight-receipt.json') });
  const review = { schemaVersion: 'forge-independent-semantic-review/v1', reviewer: 'independent-fixture-reviewer',
    subject: { phaseId: 'frontend', responseSha256: digest(response),
      candidateArtifactDigest: preflight.candidateArtifactDigest },
    verdict: 'reject', severityCounts: { p0: 0, p1: 1, p2: 0 },
    findings: [{ id: 'FE-P1-01', severity: 'p1', title: 'Missing required page behavior',
      evidence: 'The first page response omits a required interaction state.',
      requiredAction: 'Preserve the valid UI design and add the missing state in FE02.' }],
    coverageSummary: 'All other frontend duties are covered.', cannotClaim: ['frontend accepted'] };
  await write(path.join(sourceAttempt, 'independent-semantic-review.json'),
    Buffer.from(`${JSON.stringify(review)}\n`));
  const evidenceSha256 = {};
  for (const relative of [...Object.keys(evidence), 'controller-preflight-receipt.json',
    'independent-semantic-review.json']) {
    evidenceSha256[relative] = digest(await readFile(path.join(sourceAttempt, relative)));
  }
  const bindings = { schemaVersion: 'forge-delivery-frontend-retry-bindings/v1',
    sourceStateSha256: digest(sourceState), originalRequestSha256: digest(await readFile(context.originalRequestFile)),
    artifactSha256, evidenceSha256, currentPromptSha256: digest(sourcePrompt) };
  const bindingsBytes = Buffer.from(`${JSON.stringify(bindings)}\n`);
  await write(bindingsFile, bindingsBytes);
  const args = { catalogFile: CATALOG_FILE, sourceCaseDirectory, bindingsFile,
    expectedBindingsSha256: digest(bindingsBytes), sourceCommit: SOURCE_COMMIT,
    originalRequestFile: context.originalRequestFile, outputDirectory };
  const result = await prepareForgeFrontendRetryContinuation(args);
  assert.equal(result.schemaVersion, 'forge-delivery-frontend-retry-continuation/v1');
  assert.equal(result.nextExecutionGenerationMinimum, 7);
  assert.equal(result.remainingAttempts, 1);
  assert.equal(result.parentStateUnchanged, true);
  assert.deepEqual(await readFile(path.join(sourceControl, 'state.json')), sourceState);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const nextStateFile = path.join(outputDirectory, 'phase-control/state.json');
  const nextPromptFile = path.join(outputDirectory, 'phase-control/current-prompt.md');
  const next = await readForgeDeliveryPhaseState(nextStateFile, catalog);
  assert.equal(next.currentPhaseId, 'frontend');
  assert.equal(next.activeAttempt, null);
  assert.equal(next.history.at(-1).decision, 'rejected');
  assert.equal(Object.keys(next.acceptedArtifacts).length, 5);
  const nextPrompt = await readFile(nextPromptFile, 'utf8');
  assert.match(nextPrompt, /Missing required page behavior/u);
  assert.match(nextPrompt, /Preserve the valid UI design and add the missing state in FE02/u);
  const retryReceiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(nextPromptFile, result.rejectedAttemptId);
  assert.equal(result.retryPromptReceiptSha256, digest(await readFile(retryReceiptFile)));
  assert.deepEqual(await readFile(path.join(outputDirectory, 'phases/06-frontend/attempts/01/before-snapshot.json')),
    evidence['before-snapshot.json']);
  await assert.rejects(prepareForgeFrontendRetryContinuation({ ...args,
    expectedBindingsSha256: '0'.repeat(64), outputDirectory: path.join(context.root, 'wrong-digest') }),
  { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await assert.rejects(prepareForgeFrontendRetryContinuation({ ...args,
    sourceCommit: '0'.repeat(40), outputDirectory: path.join(context.root, 'wrong-source') }),
  { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  await write(path.join(sourceControl, 'current-prompt.md'), 'stale frontend prompt\n');
  await assert.rejects(prepareForgeFrontendRetryContinuation({ ...args,
    outputDirectory: path.join(context.root, 'stale-prompt') }),
  { code: 'PHASE_CONTROLLER_SOURCE_STATE_MISMATCH' });
  await write(path.join(sourceControl, 'current-prompt.md'), sourcePrompt);
  if (process.platform === 'linux') {
    const environment = await protectedRetryEnvironment(context);
    const prepared = await prepareHeadlessExecutionFromEnvironment({ ...environment,
      FORGE_PROTECTED_HEADLESS_RPC_ID: 'frontend-rpc-7',
      FORGE_EVAL_PHASE_ID: 'frontend', FORGE_EVAL_PHASE_STATE_FILE: nextStateFile,
      FORGE_EVAL_PROMPT_FILE: nextPromptFile });
    assert.equal(prepared.generation, 7);
    assert.equal(prepared.phaseId, 'frontend');
  } else {
    const retryPrompt = (await readFile(nextPromptFile, 'utf8')).replace(/(?:\r?\n)+$/u, '');
    const begun = beginForgeDeliveryPhase({ state: next, catalog, phaseId: 'frontend', rpcId: 'frontend-rpc-7',
      promptDigest: digestDirectUserTextContent([{ type: 'text', text: retryPrompt }]), executionGeneration: 7 });
    await writeForgeDeliveryPhaseState(nextStateFile, begun, catalog);
  }
  await rejectForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile: nextStateFile,
    reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
    receiptFile: path.join(outputDirectory, 'fe02-rejection.json') });
  await assert.rejects(createForgeDeliveryPhaseRetryPrompt({ catalogFile: CATALOG_FILE,
    stateFile: nextStateFile, artifactsDirectory: path.join(outputDirectory, 'phase-control/artifacts'),
    originalRequestFile: context.originalRequestFile,
    responseFile: path.join(outputDirectory, 'phases/06-frontend/attempts/01/model.stdout.txt'),
    preflightReceiptFile: path.join(outputDirectory, 'phases/06-frontend/attempts/01/controller-preflight-receipt.json'),
    semanticReviewFile: path.join(outputDirectory, 'phases/06-frontend/attempts/01/independent-semantic-review.json'),
    promptFile: nextPromptFile,
    receiptFile: forgeDeliveryPhaseRetryPromptReceiptPath(nextPromptFile, result.rejectedAttemptId),
  }), { code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED' });
});

test('controller persists source-bound authority in initial and automatically generated next prompts', async () => {
  const context = await fixture();
  const initialState = JSON.parse(await readFile(context.stateFile, 'utf8'));
  const initialAuthority = promptAuthority(
    (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, ''),
  );
  assert.equal(initialAuthority.phaseId, 'requirements');
  assert.equal(initialAuthority.sourceCommit, SOURCE_COMMIT);
  assert.equal(initialAuthority.catalogVersion, initialState.catalogVersion);
  assert.equal(initialAuthority.catalogDigest, initialState.catalogDigest);

  await finalizeCurrent(context, {
    generation: 1,
    allChangedPaths: [],
    phaseChangedPaths: [],
    phasePatch: '',
    cumulativePatch: '',
  });
  const nextState = JSON.parse(await readFile(context.stateFile, 'utf8'));
  const nextAuthority = promptAuthority(
    (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, ''),
  );
  assert.equal(nextAuthority.phaseId, 'domain-contract');
  assert.equal(nextAuthority.sourceCommit, SOURCE_COMMIT);
  assert.equal(nextAuthority.catalogVersion, nextState.catalogVersion);
  assert.equal(nextAuthority.catalogDigest, nextState.catalogDigest);
  assert.equal(
    nextAuthority.upstreamArtifactDigests['requirements-contract'],
    nextState.acceptedArtifacts['requirements-contract'],
  );
});

test('controller records an operator rejection and leaves the same phase idle for a bounded retry', async () => {
  const context = await fixture();
  await beginCurrent(context, 1);
  const receiptFile = path.join(context.root, 'requirements-rejected.json');
  const receipt = await rejectForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    reasonCode: 'HOST_VERIFICATION_FAILED',
    receiptFile,
  });
  assert.equal(receipt.decision, 'rejected');
  assert.equal(receipt.reasonCode, 'HOST_VERIFICATION_FAILED');
  assert.equal(receipt.phaseId, 'requirements');
  assert.deepEqual(JSON.parse(await readFile(receiptFile, 'utf8')), receipt);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.status, 'active');
  assert.equal(state.currentPhaseId, 'requirements');
  assert.equal(state.activeAttempt, null);
  assert.equal(state.history.at(-1).receiptDigest, receipt.receiptDigest);
});

test('independent review binds both verdicts to the active attempt, response bytes and preflight candidate', async () => {
  const { context, review, preflight, files } = await rejectedRequirementsRetryFixture({ deferRejection: true });
  const args = {
    catalogFile: CATALOG_FILE, stateFile: context.stateFile,
    responseFile: files.responseFile, preflightReceiptFile: files.preflightReceiptFile,
    semanticReviewFile: files.semanticReviewFile,
  };
  const rejected = await inspectForgeDeliveryPhaseSemanticReview(args);
  assert.equal(rejected.verdict, 'reject');
  assert.equal(rejected.candidateArtifactDigest, preflight.candidateArtifactDigest);
  const state = await readForgeDeliveryPhaseState(context.stateFile, (await loadForgeDeliveryPhaseCatalog(CATALOG_FILE)).catalog);
  assert.equal(state.currentPhaseIndex, 0);
  assert.equal(state.activeAttempt.attemptId, preflight.phaseAttemptId);

  const pass = { ...review, verdict: 'PASS', findings: [], cannotClaim: [],
    severityCounts: { p0: 0, p1: 0, p2: 0 } };
  await writeFile(files.semanticReviewFile, `${JSON.stringify(pass)}\n`);
  assert.equal((await inspectForgeDeliveryPhaseSemanticReview(args)).verdict, 'PASS');
  await writeFile(files.semanticReviewFile, `${JSON.stringify({ ...pass, subject: { ...pass.subject,
    candidateArtifactDigest: EMPTY_SHA256 } })}\n`);
  await assert.rejects(inspectForgeDeliveryPhaseSemanticReview(args), { code: 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID' });
  await writeFile(files.semanticReviewFile, `${JSON.stringify(pass)}\n`);
  const originalResponse = await readFile(files.responseFile, 'utf8');
  await writeFile(files.responseFile, `${originalResponse}changed`);
  await assert.rejects(inspectForgeDeliveryPhaseSemanticReview(args), { code: 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID' });
  await writeFile(files.responseFile, originalResponse);
  await writeFile(files.semanticReviewFile, `${JSON.stringify(pass)}\n`);
  await chmod(files.semanticReviewFile, 0o666);
  if (process.platform !== 'win32') {
    await assert.rejects(inspectForgeDeliveryPhaseSemanticReview(args), { code: 'PHASE_CONTROLLER_PATH_INVALID' });
  }
  if (process.platform !== 'win32') {
    const linked = path.join(path.dirname(files.semanticReviewFile), 'linked-review.json');
    await symlink(files.semanticReviewFile, linked);
    await assert.rejects(inspectForgeDeliveryPhaseSemanticReview({ ...args, semanticReviewFile: linked }),
      { code: 'PHASE_CONTROLLER_PATH_INVALID' });
  }
});

test('controller derives a same-phase retry prompt only from the latest bound semantic rejection', async () => {
  const { context, review, files, args } = await rejectedRequirementsRetryFixture();
  const receipt = await createForgeDeliveryPhaseRetryPrompt(args);
  const prompt = (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, '');
  const persistedReceipt = JSON.parse(await readFile(files.retryReceiptFile, 'utf8'));
  assert.deepEqual(persistedReceipt, receipt);
  assert.equal(receipt.phaseId, 'requirements');
  assert.equal(receipt.reasonCode, 'SEMANTIC_REQUIREMENTS_CONTRACT_INVALID');
  assert.equal(receipt.retryPromptDigest, crypto.createHash('sha256').update(prompt).digest('hex'));
  assert.equal(receipt.semanticReviewSha256, crypto.createHash('sha256')
    .update(await readFile(files.semanticReviewFile)).digest('hex'));
  assert.equal(receipt.remainingAttempts, 1);
  assert.equal(receipt.stateAdvanced, false);
  assert.match(prompt, /REJECTED ATTEMPT FEEDBACK \(machine-owned, evidence-bound\)/u);
  assert.match(prompt, new RegExp(review.findings[0].id, 'u'));
  assert.match(prompt, new RegExp(review.findings[0].requiredAction, 'u'));
  assert.match(prompt, new RegExp(review.cannotClaim[0], 'u'));
  assert.match(prompt, new RegExp(`"sourceCommit": "${SOURCE_COMMIT}"`, 'u'));
  assert.ok(prompt.includes('Correct every finding within the current phase authority, preserve compliant content, and return the complete phase response: a concise business-facing explanation followed by exactly one complete replacement artifact.'));

  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const idleState = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.deepEqual(validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt,
    state: idleState,
    catalog,
    promptDigest: receipt.retryPromptDigest,
  }), receipt);
  await assert.rejects(async () => validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt: { ...receipt, retryPromptDigest: '0'.repeat(64) },
    state: idleState,
    catalog,
    promptDigest: receipt.retryPromptDigest,
  }), (error) => error.code === 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID');

  const { state } = await beginCurrent(context, 2);
  assert.equal(state.activeAttempt.sessionMode, 'resume');
  assert.equal(state.activeAttempt.promptDigest, digestDirectUserTextContent([{ type: 'text', text:
    (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, ''),
  }]));
});

test('protected prepare consumes the Controller retry receipt and rejects changed prompt text before generation 2', {
  skip: process.platform !== 'linux' && 'protected prepare requires POSIX absolute paths and Linux execution locks',
}, async () => {
  const { context, args, protectedEnvironment } = await rejectedRequirementsRetryFixture({
    prepareFirstAttempt: true,
  });
  const retryReceipt = await createForgeDeliveryPhaseRetryPrompt(args);
  const promptBytes = await readFile(context.promptFile);
  const executionStateFile = path.join(
    protectedEnvironment.FORGE_EVAL_PROJECT_ROOT,
    'taskspaces', '.broker', 'executions', 'eval-crud-complete.json',
  );
  const phaseStateBefore = await readFile(context.stateFile);
  const executionStateBefore = await readFile(executionStateFile);
  const retryEnvironment = { ...protectedEnvironment, FORGE_PROTECTED_HEADLESS_RPC_ID: 'rpc-2' };

  await writeFile(context.promptFile, Buffer.concat([promptBytes, Buffer.from('Changed prompt text\n')]));
  await assert.rejects(prepareHeadlessExecutionFromEnvironment(retryEnvironment), {
    code: 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID',
  });
  assert.deepEqual(await readFile(context.stateFile), phaseStateBefore);
  assert.deepEqual(await readFile(executionStateFile), executionStateBefore);

  await writeFile(context.promptFile, promptBytes);
  const prepared = await prepareHeadlessExecutionFromEnvironment(retryEnvironment);
  assert.equal(prepared.generation, 2);
  assert.equal(prepared.sessionMode, 'resume');
  assert.equal(prepared.phaseId, 'requirements');
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.lastExecutionGeneration, 2);
  assert.equal(state.activeAttempt.attemptId, prepared.phaseAttemptId);
  assert.equal(state.activeAttempt.executionGeneration, 2);
  assert.equal(state.history.at(-1).decision, 'rejected');
  assert.equal(retryReceipt.stateAdvanced, false);
});

test('extra payload key consumes one phase attempt without a fabricated candidate or preflight receipt', async () => {
  const { context, phase, files, args } = await formatRetryFixture();
  const preflightReceiptFile = path.join(context.root, 'preflight-receipt.json');
  await assert.rejects(preflightForgeDeliveryPhaseRun({
    ...args, receiptFile: preflightReceiptFile,
  }), (error) => error.code === 'PHASE_RESPONSE_INVALID'
    && error.payloadShapeIssue?.kind === 'unexpected-payload-keys'
    && JSON.stringify(error.payloadShapeIssue.unexpectedKeys) === '["verificationStatus"]');
  await assert.rejects(readFile(preflightReceiptFile), { code: 'ENOENT' });
  const receipt = await createForgeDeliveryPhaseFormatRetryPrompt(args);
  assert.equal(receipt.schemaVersion, 'forge-delivery-phase-format-retry-prompt/v1');
  assert.equal(receipt.reasonCode, 'FORMAT_UNEXPECTED_PAYLOAD_KEYS');
  assert.equal(receipt.responseSha256, crypto.createHash('sha256').update(await readFile(files.responseFile)).digest('hex'));
  assert.deepEqual(receipt.unexpectedKeys, ['verificationStatus']);
  assert.deepEqual(receipt.requiredPayloadKeys, phase.requiredPayloadKeys);
  assert.equal(receipt.remainingAttempts, 1);
  assert.equal(receipt.stateAdvanced, false);
  assert.ok(!Object.hasOwn(receipt, 'candidateArtifactDigest'));
  assert.ok(!Object.hasOwn(receipt, 'preflightReceiptSha256'));
  assert.ok(!Object.hasOwn(receipt, 'semanticReviewSha256'));
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.currentPhaseId, 'requirements');
  assert.equal(state.activeAttempt, null);
  assert.deepEqual(state.acceptedArtifacts, {});
  assert.equal(state.history.at(-1).decision, 'rejected');
  assert.equal(state.history.at(-1).artifactDigest, null);
  assert.deepEqual(state.history.at(-1).hostReceiptDigests, []);
  const prompt = (await readFile(context.promptFile, 'utf8')).trimEnd();
  assert.ok(prompt.includes('Return the complete phase response: a concise business-facing explanation followed by exactly one complete replacement artifact. Its payload must contain exactly requiredPayloadKeys and no extra keys.'));
  assert.match(prompt, /payload must contain exactly requiredPayloadKeys and no extra keys/u);
  assert.equal(receipt.retryPromptDigest, crypto.createHash('sha256').update(prompt).digest('hex'));
  const receiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(context.promptFile, receipt.rejectedAttemptId);
  assert.deepEqual(JSON.parse(await readFile(receiptFile, 'utf8')), receipt);
  assert.deepEqual(validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt, state, catalog, promptDigest: receipt.retryPromptDigest,
  }), receipt);
  for (const forged of [
    { ...receipt, sourceCommit: '0'.repeat(40) },
    { ...receipt, stateDigest: '0'.repeat(64) },
  ]) {
    await assert.rejects(async () => validateForgeDeliveryPhaseRetryPromptReceipt({
      receipt: forged, state, catalog, promptDigest: receipt.retryPromptDigest,
    }), { code: 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID' });
  }
  await assert.rejects(async () => validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt: { ...receipt, candidateArtifactDigest: '0'.repeat(64) },
    state, catalog, promptDigest: receipt.retryPromptDigest,
  }), { code: 'PHASE_CONTROLLER_INPUT_INVALID' });
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  });
  await beginCurrent(context, 2);
  const secondAttemptState = await readFile(context.stateFile);
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  });
  assert.deepEqual(await readFile(context.stateFile), secondAttemptState);
});

test('read-only invalid JSON gets a bound format retry and corrected proposal needs full preflight', async () => {
  const responseText = '<forge-phase-artifact>{"phaseId":"domain-contract","unresolvedDecisions":["approve"],</forge-phase-artifact>\n';
  const { context, phase, files, args } = await formatRetryFixture({ responseText });
  const firstPreflightFile = path.join(context.root, 'syntax-attempt1-preflight.json');
  await assert.rejects(preflightForgeDeliveryPhaseRun({ ...args, receiptFile: firstPreflightFile }), (error) => {
    assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
    assert.deepEqual(error.payloadShapeIssue, { kind: 'invalid-proposal-json' });
    assert.equal(error.phaseProposal, undefined);
    return true;
  });
  await assert.rejects(readFile(firstPreflightFile), { code: 'ENOENT' });
  const previousPrompt = (await readFile(context.promptFile, 'utf8')).trimEnd();
  const firstState = await readForgeDeliveryPhaseState(context.stateFile, (await loadForgeDeliveryPhaseCatalog(CATALOG_FILE)).catalog);
  const receipt = await createForgeDeliveryPhaseFormatRetryPrompt(args);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(receipt.schemaVersion, 'forge-delivery-phase-format-retry-prompt/v1');
  assert.equal(receipt.reasonCode, 'FORMAT_INVALID_PROPOSAL_JSON');
  assert.deepEqual(receipt.unexpectedKeys, []);
  assert.deepEqual(receipt.requiredPayloadKeys, phase.requiredPayloadKeys);
  assert.equal(receipt.rejectedAttemptId, firstState.activeAttempt.attemptId);
  assert.equal(receipt.rejectedExecutionGeneration, 1);
  assert.equal(receipt.remainingAttempts, phase.maxAttempts - 1);
  assert.equal(receipt.sourceCommit, state.sourceCommit);
  assert.equal(receipt.catalogVersion, state.catalogVersion);
  assert.equal(receipt.catalogDigest, state.catalogDigest);
  assert.equal(receipt.stateDigest, state.stateDigest);
  assert.equal(receipt.previousPromptDigest, crypto.createHash('sha256').update(previousPrompt).digest('hex'));
  assert.equal(receipt.originalRequestSha256, crypto.createHash('sha256').update(await readFile(context.originalRequestFile)).digest('hex'));
  assert.equal(receipt.responseSha256, crypto.createHash('sha256').update(await readFile(files.responseFile)).digest('hex'));
  assert.deepEqual(receipt.upstreamArtifactDigests, {});
  assert.equal(receipt.stateAdvanced, false);
  assert.ok(!Object.hasOwn(receipt, 'candidateArtifactDigest'));
  assert.ok(!Object.hasOwn(receipt, 'preflightReceiptSha256'));
  const prompt = (await readFile(context.promptFile, 'utf8')).trimEnd();
  assert.equal(receipt.retryPromptDigest, crypto.createHash('sha256').update(prompt).digest('hex'));
  assert.match(prompt, /Regenerate the current phase contract from the original request/u);
  assert.match(prompt, /exactly one complete replacement artifact/u);
  assert.doesNotMatch(prompt, /"unresolvedDecisions": \["approve"\]/u);
  assert.deepEqual(JSON.parse(await readFile(
    forgeDeliveryPhaseRetryPromptReceiptPath(context.promptFile, receipt.rejectedAttemptId), 'utf8',
  )), receipt);
  assert.deepEqual(validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt, state, catalog, promptDigest: receipt.retryPromptDigest,
  }), receipt);
  for (const forged of [
    { ...receipt, reasonCode: 'FORMAT_UNEXPECTED_PAYLOAD_KEYS' },
    { ...receipt, unexpectedKeys: ['forged'] },
  ]) {
    await assert.rejects(async () => validateForgeDeliveryPhaseRetryPromptReceipt({
      receipt: forged, state, catalog, promptDigest: receipt.retryPromptDigest,
    }), { code: 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID' });
  }
  assert.equal(state.activeAttempt, null);
  assert.deepEqual(state.acceptedArtifacts, {});
  assert.equal(state.history.at(-1).reasonCode, receipt.reasonCode);
  assert.equal(state.history.at(-1).artifactDigest, null);
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  });
  await beginCurrent(context, 2);
  const secondAttemptState = await readFile(context.stateFile);
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  });
  assert.deepEqual(await readFile(context.stateFile), secondAttemptState);
  await writeFile(files.responseFile, `<forge-phase-artifact>${JSON.stringify(proposalFor(phase))}</forge-phase-artifact>\n`);
  const preflight = await preflightForgeDeliveryPhaseRun({
    ...args, receiptFile: path.join(context.root, 'syntax-attempt2-preflight.json'),
  });
  assert.equal(preflight.phaseId, phase.id);
  assert.equal(preflight.stateAdvanced, false);
  const afterPreflight = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(afterPreflight.activeAttempt.executionGeneration, 2);
  assert.deepEqual(afterPreflight.acceptedArtifacts, {});
  assert.equal(afterPreflight.history.at(-1).decision, 'rejected');
});

test('format retry refuses missing required keys, wrong identity, and changed read-only paths without mutating state', async () => {
  for (const mutateProposal of [
    (proposal) => { delete proposal.payload.actors; },
    (proposal) => { proposal.phaseId = 'domain-contract'; },
  ]) {
    const { context, args } = await formatRetryFixture({ mutateProposal });
    const stateBefore = await readFile(context.stateFile);
    await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args));
    assert.deepEqual(await readFile(context.stateFile), stateBefore);
    await assert.rejects(readFile(args.rejectionReceiptFile), { code: 'ENOENT' });
  }
  const { context, args, files } = await formatRetryFixture();
  await writeFile(files.allChangedPathsFile, '["forge-server/db/migration/extra.sql"]\n');
  await writeFile(files.phaseChangedPathsFile, '["forge-server/db/migration/extra.sql"]\n');
  const stateBefore = await readFile(context.stateFile);
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_MUTATION_DENIED',
  });
  assert.deepEqual(await readFile(context.stateFile), stateBefore);
});

test('format retry rejects an active attempt whose prompt digest differs from the actual direct-user content digest', async () => {
  const { context, args } = await formatRetryFixture({ promptDigestOverride: '0'.repeat(64) });
  const stateBefore = await readFile(context.stateFile);
  const promptBefore = await readFile(context.promptFile);
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID',
  });
  assert.deepEqual(await readFile(context.stateFile), stateBefore);
  assert.deepEqual(await readFile(context.promptFile), promptBefore);
  await assert.rejects(readFile(args.rejectionReceiptFile), { code: 'ENOENT' });
});

async function databaseFormatRetryFixture(mutateProposal, responseText) {
  const context = await fixture();
  await finalizeCurrent(context, {
    generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  const { phase } = await beginCurrent(context, 3);
  const directory = path.join(context.root, 'database-format-attempt1');
  await mkdir(directory);
  const changedPaths = [
    'forge-server/db/migration/V1.0.134__add_supplier_archive.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/migration/SupplierArchiveMigrationContractTest.java',
  ];
  const proposal = proposalFor(phase, changedPaths);
  proposal.payload.verificationStatus = { claim: 'unverified' };
  mutateProposal?.(proposal);
  const files = {
    responseFile: path.join(directory, 'model.stdout.txt'),
    allChangedPathsFile: path.join(directory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(directory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(directory, 'phase.patch'),
    cumulativePatchFile: path.join(directory, 'cumulative.patch'),
  };
  await Promise.all([
    writeFile(files.responseFile, responseText ?? `<forge-phase-artifact>${JSON.stringify(proposal)}</forge-phase-artifact>\n`),
    writeFile(files.allChangedPathsFile, `${JSON.stringify(changedPaths)}\n`),
    writeFile(files.phaseChangedPathsFile, `${JSON.stringify(changedPaths)}\n`),
    writeFile(files.phasePatchFile, 'database patch\n'),
    writeFile(files.cumulativePatchFile, 'database patch\n'),
  ]);
  const args = {
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    ...files,
    promptFile: context.promptFile,
    rejectionReceiptFile: path.join(directory, 'controller-reject-receipt.json'),
  };
  return { context, directory, changedPaths, proposal, files, args };
}

test('database format retry retains accepted upstream and bounded owned migration edits', async () => {
  const { context, directory, changedPaths, proposal, files, args } = await databaseFormatRetryFixture();
  const receipt = await createForgeDeliveryPhaseFormatRetryPrompt(args);
  assert.equal(receipt.phaseId, 'database');
  assert.equal(receipt.phasePatchSha256, crypto.createHash('sha256').update('database patch\n').digest('hex'));
  assert.equal(receipt.cumulativePatchSha256, receipt.phasePatchSha256);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.currentPhaseId, 'database');
  assert.equal(Object.keys(state.acceptedArtifacts).length, 2);
  assert.deepEqual(receipt.upstreamArtifactDigests, {
    'requirements-contract': state.acceptedArtifacts['requirements-contract'],
    'domain-api-contract': state.acceptedArtifacts['domain-api-contract'],
  });
  assert.deepEqual(validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt, state, catalog, promptDigest: receipt.retryPromptDigest,
  }), receipt);
  const prompt = await readFile(context.promptFile, 'utf8');
  assert.match(prompt, /CURRENT PHASE AUTHORITY/u);
  assert.match(prompt, /REJECTED FORMAT FEEDBACK/u);
  const resumed = await beginCurrent(context, 4);
  assert.equal(resumed.state.activeAttempt.executionGeneration, 4);
  delete proposal.payload.verificationStatus;
  await writeFile(files.responseFile, `<forge-phase-artifact>${JSON.stringify(proposal)}</forge-phase-artifact>\n`);
  const preflight = await preflightForgeDeliveryPhaseRun({
    ...args, receiptFile: path.join(directory, 'attempt2-preflight.json'),
  });
  assert.equal(preflight.phaseId, 'database');
  assert.deepEqual(preflight.changedPaths, [...changedPaths].sort());
  assert.equal(preflight.stateAdvanced, false);
  const afterPreflight = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(afterPreflight.currentPhaseId, 'database');
  assert.equal(afterPreflight.activeAttempt.executionGeneration, 4);
  assert.equal(Object.keys(afterPreflight.acceptedArtifacts).length, 2);
  assert.equal(afterPreflight.history.at(-1).decision, 'rejected');
});

test('database invalid JSON retains observed owned patch and upstream, then checks corrected changedPaths', async () => {
  const responseText = '<forge-phase-artifact>{"phaseId":"backend","payload":{"changedPaths":["forged.sql"]},</forge-phase-artifact>\n';
  const { context, directory, changedPaths, files, args } = await databaseFormatRetryFixture(undefined, responseText);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const before = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const firstPreflightFile = path.join(directory, 'syntax-attempt1-preflight.json');
  await assert.rejects(preflightForgeDeliveryPhaseRun({ ...args, receiptFile: firstPreflightFile }), (error) => {
    assert.equal(error.code, 'PHASE_RESPONSE_INVALID');
    assert.deepEqual(error.payloadShapeIssue, { kind: 'invalid-proposal-json' });
    assert.equal(error.phaseProposal, undefined);
    return true;
  });
  await assert.rejects(readFile(firstPreflightFile), { code: 'ENOENT' });
  const receipt = await createForgeDeliveryPhaseFormatRetryPrompt(args);
  const rejected = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(receipt.reasonCode, 'FORMAT_INVALID_PROPOSAL_JSON');
  assert.deepEqual(receipt.unexpectedKeys, []);
  assert.equal(receipt.rejectedAttemptId, before.activeAttempt.attemptId);
  assert.equal(receipt.remainingAttempts, catalog.workflows[0].phases[2].maxAttempts - 1);
  assert.equal(receipt.allChangedPathsSha256, crypto.createHash('sha256').update(await readFile(files.allChangedPathsFile)).digest('hex'));
  assert.equal(receipt.phaseChangedPathsSha256, crypto.createHash('sha256').update(await readFile(files.phaseChangedPathsFile)).digest('hex'));
  assert.equal(receipt.phasePatchSha256, crypto.createHash('sha256').update(await readFile(files.phasePatchFile)).digest('hex'));
  assert.equal(receipt.cumulativePatchSha256, crypto.createHash('sha256').update(await readFile(files.cumulativePatchFile)).digest('hex'));
  assert.deepEqual(receipt.upstreamArtifactDigests, {
    'requirements-contract': before.acceptedArtifacts['requirements-contract'],
    'domain-api-contract': before.acceptedArtifacts['domain-api-contract'],
  });
  assert.deepEqual(rejected.acceptedArtifacts, before.acceptedArtifacts);
  assert.equal(rejected.currentPhaseId, 'database');
  assert.equal(rejected.activeAttempt, null);
  assert.equal(rejected.history.at(-1).artifactDigest, null);
  assert.deepEqual(validateForgeDeliveryPhaseRetryPromptReceipt({
    receipt, state: rejected, catalog, promptDigest: receipt.retryPromptDigest,
  }), receipt);
  const prompt = await readFile(context.promptFile, 'utf8');
  assert.match(prompt, /accepted upstream artifacts above/u);
  assert.match(prompt, /Preserve valid business content and current phase source edits/u);
  assert.doesNotMatch(prompt, /forged\.sql/u);
  await beginCurrent(context, 4);
  const corrected = proposalFor(catalog.workflows[0].phases[2], changedPaths);
  corrected.payload.changedPaths = [changedPaths[0]];
  await writeFile(files.responseFile, `<forge-phase-artifact>${JSON.stringify(corrected)}</forge-phase-artifact>\n`);
  const correctedPreflightFile = path.join(directory, 'syntax-attempt2-preflight.json');
  const secondAttemptState = await readFile(context.stateFile);
  await assert.rejects(preflightForgeDeliveryPhaseRun({
    ...args, receiptFile: correctedPreflightFile,
  }), { code: 'PHASE_RESPONSE_INVALID' });
  await assert.rejects(readFile(correctedPreflightFile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(context.stateFile), secondAttemptState);
  corrected.payload.changedPaths = changedPaths;
  await writeFile(files.responseFile, `<forge-phase-artifact>${JSON.stringify(corrected)}</forge-phase-artifact>\n`);
  const preflight = await preflightForgeDeliveryPhaseRun({
    ...args, receiptFile: correctedPreflightFile,
  });
  assert.deepEqual(preflight.changedPaths, [...changedPaths].sort());
  assert.equal(preflight.stateAdvanced, false);
  const afterPreflight = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.deepEqual(afterPreflight.acceptedArtifacts, before.acceptedArtifacts);
  assert.equal(afterPreflight.activeAttempt.executionGeneration, 4);
  assert.equal(afterPreflight.history.at(-1).decision, 'rejected');
});

test('database format retry refuses wrong declared paths', async () => {
  const { context, args } = await databaseFormatRetryFixture((proposal) => { proposal.payload.changedPaths = []; });
  const stateBefore = await readFile(context.stateFile);
  const promptBefore = await readFile(context.promptFile);
  await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt(args), {
    code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  });
  assert.deepEqual(await readFile(context.stateFile), stateBefore);
  assert.deepEqual(await readFile(context.promptFile), promptBefore);
  await assert.rejects(readFile(args.rejectionReceiptFile), { code: 'ENOENT' });
});

test('format retry rejects invalid user feedback before changing the original attempt or prompt', async () => {
  const { context, args } = await formatRetryFixture();
  const stateBefore = await readFile(context.stateFile);
  const promptBefore = await readFile(context.promptFile);
  for (const repairRequestText of [null, '', ' \t', 'untrusted\0text', 'x'.repeat(1024 * 1024)]) {
    await assert.rejects(createForgeDeliveryPhaseFormatRetryPrompt({ ...args, repairRequestText }), {
      code: 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
    });
    assert.deepEqual(await readFile(context.stateFile), stateBefore);
    assert.deepEqual(await readFile(context.promptFile), promptBefore);
    await assert.rejects(readFile(args.rejectionReceiptFile), { code: 'ENOENT' });
  }
});

test('protected prepare accepts only the exact format retry prompt for generation 2', {
  skip: process.platform !== 'linux' && 'protected prepare requires POSIX absolute paths and Linux execution locks',
}, async () => {
  for (const [reasonCode, responseText] of [
    ['FORMAT_UNEXPECTED_PAYLOAD_KEYS', undefined],
    ['FORMAT_INVALID_PROPOSAL_JSON', '<forge-phase-artifact>{"phaseId":"requirements",</forge-phase-artifact>\n'],
  ]) {
    const { context, args, protectedEnvironment } = await formatRetryFixture({
      prepareFirstAttempt: true, responseText,
    });
    const receipt = await createForgeDeliveryPhaseFormatRetryPrompt(args);
    assert.equal(receipt.reasonCode, reasonCode);
    const promptBytes = await readFile(context.promptFile);
    const executionStateFile = path.join(
      protectedEnvironment.FORGE_EVAL_PROJECT_ROOT, 'taskspaces', '.broker', 'executions', 'eval-crud-complete.json',
    );
    const phaseBefore = await readFile(context.stateFile);
    const executionBefore = await readFile(executionStateFile);
    const retryEnvironment = { ...protectedEnvironment, FORGE_PROTECTED_HEADLESS_RPC_ID: 'rpc-2' };
    await writeFile(context.promptFile, Buffer.concat([promptBytes, Buffer.from('Changed prompt text\n')]));
    await assert.rejects(prepareHeadlessExecutionFromEnvironment(retryEnvironment), {
      code: 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID',
    });
    assert.deepEqual(await readFile(context.stateFile), phaseBefore);
    assert.deepEqual(await readFile(executionStateFile), executionBefore);
    await writeFile(context.promptFile, promptBytes);
    const prepared = await prepareHeadlessExecutionFromEnvironment(retryEnvironment);
    assert.equal(prepared.generation, 2);
    assert.equal(prepared.sessionMode, 'resume');
    assert.equal(prepared.phaseId, 'requirements');
    const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
    const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
    assert.equal(state.activeAttempt.executionGeneration, 2);
    assert.equal(state.history.at(-1).reasonCode, reasonCode);
  }
});

test('controller refuses unbound semantic review evidence and exhausted retries without replacing the prompt', async () => {
  const mismatched = await rejectedRequirementsRetryFixture();
  await assert.rejects(inspectForgeDeliveryPhaseSemanticReview({
    catalogFile: CATALOG_FILE, stateFile: mismatched.context.stateFile,
    responseFile: mismatched.files.responseFile,
    preflightReceiptFile: mismatched.files.preflightReceiptFile,
    semanticReviewFile: mismatched.files.semanticReviewFile,
  }), { code: 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID' });
  const originalPrompt = await readFile(mismatched.context.promptFile);
  const review = JSON.parse(await readFile(mismatched.files.semanticReviewFile, 'utf8'));
  review.subject.responseSha256 = '0'.repeat(64);
  await writeFile(mismatched.files.semanticReviewFile, `${JSON.stringify(review, null, 2)}\n`);
  await assert.rejects(
    createForgeDeliveryPhaseRetryPrompt(mismatched.args),
    (error) => error.code === 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID',
  );
  assert.deepEqual(await readFile(mismatched.context.promptFile), originalPrompt);
  await assert.rejects(readFile(mismatched.files.retryReceiptFile), (error) => error.code === 'ENOENT');

  const forgedCandidate = await rejectedRequirementsRetryFixture();
  const preflight = JSON.parse(await readFile(forgedCandidate.files.preflightReceiptFile, 'utf8'));
  const forgedReview = JSON.parse(await readFile(forgedCandidate.files.semanticReviewFile, 'utf8'));
  preflight.candidateArtifactDigest = 'f'.repeat(64);
  forgedReview.subject.candidateArtifactDigest = preflight.candidateArtifactDigest;
  await Promise.all([
    writeFile(forgedCandidate.files.preflightReceiptFile, `${JSON.stringify(preflight, null, 2)}\n`),
    writeFile(forgedCandidate.files.semanticReviewFile, `${JSON.stringify(forgedReview, null, 2)}\n`),
  ]);
  await assert.rejects(
    createForgeDeliveryPhaseRetryPrompt(forgedCandidate.args),
    (error) => error.code === 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID',
  );

  const changedRequest = await rejectedRequirementsRetryFixture();
  await writeFile(changedRequest.context.originalRequestFile, '实现另一项未经初始化绑定的需求。\n');
  await assert.rejects(
    createForgeDeliveryPhaseRetryPrompt(changedRequest.args),
    (error) => error.code === 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID',
  );

  const hostRejected = await rejectedRequirementsRetryFixture({ reasonCode: 'HOST_VERIFICATION_FAILED' });
  await assert.rejects(
    createForgeDeliveryPhaseRetryPrompt(hostRejected.args),
    (error) => error.code === 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  );

  const exhausted = await rejectedRequirementsRetryFixture();
  await beginCurrent(exhausted.context, 2);
  await rejectForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: exhausted.context.stateFile,
    reasonCode: 'SEMANTIC_REQUIREMENTS_CONTRACT_INVALID',
    receiptFile: path.join(exhausted.context.root, 'requirements-attempt2-rejected.json'),
  });
  await assert.rejects(
    createForgeDeliveryPhaseRetryPrompt(exhausted.args),
    (error) => error.code === 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED',
  );
});

test('controller recovers only the pinned active database stale-write incident and replays idempotently', async () => {
  const { context, files, args } = await staleWriteRecoveryFixture();
  const receipt = await recoverForgeDatabaseStaleWriteRun(args);
  assert.equal(receipt.incidentCode, 'STALE_WRITE_PROGRESS_GUARD_DEADLOCK');
  assert.equal(receipt.budgetDisposition, 'quality-attempt-not-consumed');
  assert.equal(receipt.hostRunnerExecuted, false);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  let state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.schemaVersion, 'forge-delivery-phase-state/v2');
  assert.equal(state.status, 'active');
  assert.equal(state.currentPhaseId, 'database');
  assert.equal(state.activeAttempt, null);
  assert.equal(state.history.at(-1).receiptDigest, receipt.receiptDigest);
  assert.deepEqual(await recoverForgeDatabaseStaleWriteRun(args), receipt);
  assert.deepEqual(JSON.parse(await readFile(files.receipt, 'utf8')), receipt);

  state = beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: 'database',
    rpcId: 'rpc-after-stale-recovery',
    promptDigest: '9'.repeat(64),
    executionGeneration: 5,
  });
  assert.equal(state.activeAttempt.sessionMode, 'resume');
});

test('controller refuses stale-write recovery when fixed evidence or zero-change boundaries drift', async () => {
  const first = await staleWriteRecoveryFixture();
  const changedWorkspaceEvidence = JSON.parse(await readFile(first.files.evidence, 'utf8'));
  changedWorkspaceEvidence.workspaceEvidence.clean = false;
  const changedWorkspaceBytes = Buffer.from(`${JSON.stringify(changedWorkspaceEvidence, null, 2)}\n`);
  await writeFile(first.files.evidence, changedWorkspaceBytes);
  first.args.expectedTechnicalFailureEvidenceSha256 = crypto.createHash('sha256')
    .update(changedWorkspaceBytes).digest('hex');
  await assert.rejects(
    recoverForgeDatabaseStaleWriteRun(first.args),
    (error) => error.code === 'PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID',
  );

  const second = await staleWriteRecoveryFixture();
  const trace = JSON.parse(await readFile(second.files.trace, 'utf8'));
  trace.events[3].errorCode = 'FS_PERMISSION_DENIED';
  const traceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(second.files.trace, traceBytes);
  second.args.expectedWriterRecoveryTraceSha256 = crypto.createHash('sha256').update(traceBytes).digest('hex');
  const traceEvidence = JSON.parse(await readFile(second.files.evidence, 'utf8'));
  traceEvidence.writerRecoveryTraceSha256 = second.args.expectedWriterRecoveryTraceSha256;
  const traceEvidenceBytes = Buffer.from(`${JSON.stringify(traceEvidence, null, 2)}\n`);
  await writeFile(second.files.evidence, traceEvidenceBytes);
  second.args.expectedTechnicalFailureEvidenceSha256 = crypto.createHash('sha256')
    .update(traceEvidenceBytes).digest('hex');
  await assert.rejects(
    recoverForgeDatabaseStaleWriteRun(second.args),
    (error) => error.code === 'PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID',
  );

  const third = await staleWriteRecoveryFixture();
  const hostEvidence = JSON.parse(await readFile(third.files.evidence, 'utf8'));
  hostEvidence.hostRunnerExecuted = true;
  const hostEvidenceBytes = Buffer.from(`${JSON.stringify(hostEvidence, null, 2)}\n`);
  await writeFile(third.files.evidence, hostEvidenceBytes);
  third.args.expectedTechnicalFailureEvidenceSha256 = crypto.createHash('sha256')
    .update(hostEvidenceBytes).digest('hex');
  await assert.rejects(
    recoverForgeDatabaseStaleWriteRun(third.args),
    (error) => error.code === 'PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID',
  );
});

test('runtime access repair preserves the accepted migration child and its imported failed observation', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
  const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value, { mode: 0o600 }); };
  const paths = [[], [], ['forge-server/db/migration/V20261001__fixture.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/FixtureMigrationContractTest.java'], [],
  ['forge-server/forge-business/forge-business-core/src/main/java/Fixture.java'],
  ['forge-admin-ui/src/views/Fixture.vue'], ['forge-server/db/migration/V20261002__access.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/FixtureAccessMigrationContractTest.java']];
  const allPaths = []; let cumulative = '';
  for (let index = 0; index < 7; index += 1) {
    allPaths.push(...paths[index]);
    const patch = paths[index].length ? `phase ${index}\n` : ''; cumulative += patch;
    await finalizeCurrent(context, { generation: index + 1, allChangedPaths: [...allPaths].sort(),
      phaseChangedPaths: paths[index], phasePatch: patch, cumulativePatch: cumulative });
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const rootDirectory = path.dirname(context.stateFile);
  const rootState = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const rootBytes = await readFile(context.stateFile);
  await put(path.join(rootDirectory, 'original-request.md'), await readFile(context.originalRequestFile));
  for (const kind of Object.keys(rootState.acceptedArtifacts)) await put(path.join(rootDirectory, 'artifacts', `${kind}.json`),
    await readFile(path.join(context.artifactsDirectory, `${kind}.json`)));
  await put(path.join(rootDirectory, 'phase-6-workspace-before.json'), bytes({ schemaVersion: 1, fixture: 'original access baseline' }));
  const access = JSON.parse(await readFile(path.join(context.artifactsDirectory, 'access-wiring-implementation.json')));
  const actorUserId = '11111111-1111-4111-8111-111111111111';
  const candidateCommit = '7'.repeat(40); const candidateTree = 'c'.repeat(40); const fingerprint = '3'.repeat(64);
  const failure = { schemaVersion: 'forge-cross-layer-preparation-failure/v1', taskId: rootState.taskId,
    sessionId: rootState.sessionId, actorUserId, actorUsername: 'fixture-operator', conversationId: 'fixture-conversation',
    executionId: crypto.randomUUID(), executionGeneration: 8, rpcId: 'rpc-migration-failure', parentStateDigest: rootState.stateDigest,
    baseSourceCommit: SOURCE_COMMIT, workspaceFingerprint: fingerprint, acceptedArtifactDigests: rootState.acceptedArtifacts,
    jobId: crypto.randomUUID(), candidateCommit, candidateTree, acceptedPatchSha256: access.sourceFingerprint,
    status: 'failed', failedStage: 'test-database-migration', runnerEvidenceSha256: 'd'.repeat(64), sourceBindingSha256: 'e'.repeat(64),
    errorCode: 'MIGRATION_EXECUTION_FAILED', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  const failureFile = path.join(rootDirectory, 'runtime-preparations', crypto.randomUUID(), 'migration-failure.json');
  await put(failureFile, bytes(failure));
  const oldDirectory = path.join(rootDirectory, 'access-wiring-repair');
  await phaseController.prepareForgeAccessWiringRepairContinuation({ catalogFile: CATALOG_FILE,
    sourceStateFile: context.stateFile, expectedSourceStateSha256: digest(rootBytes), sourceArtifactsDirectory: context.artifactsDirectory,
    sourceCommit: SOURCE_COMMIT, originalRequestFile: context.originalRequestFile, outputDirectory: oldDirectory,
    repairRequestText: '修复当前权限迁移失败。', failureEvidenceFile: failureFile, expectedFailureEvidenceSha256: digest(bytes(failure)) });
  const old = { root: context.root, stateFile: path.join(oldDirectory, 'state.json'), artifactsDirectory: path.join(oldDirectory, 'artifacts'),
    originalRequestFile: path.join(oldDirectory, 'original-request.md'), promptFile: path.join(oldDirectory, 'current-prompt.md') };
  cumulative += 'accepted migration repair\n';
  await finalizeCurrent(old, { generation: 9, allChangedPaths: [...allPaths].sort(), phaseChangedPaths: paths[6],
    phasePatch: 'accepted migration repair\n', cumulativePatch: cumulative });
  const runtimePrompt = '当前候选运行检查结果，保留已完成的权限迁移。';
  await put(old.promptFile, Buffer.from(`${runtimePrompt}\n`));
  const { state } = await beginCurrent(old, 36, digestDirectUserTextContent([{ type: 'text', text: runtimePrompt }]));
  const originalStateBytes = await readFile(old.stateFile);
  const preparationBinding = { stateDigest: state.stateDigest, acceptedArtifactDigests: state.acceptedArtifacts,
    baseSourceCommit: SOURCE_COMMIT, workspaceFingerprint: fingerprint };
  const contract = compileForgeTaskExecutionContract({ prompt: '继续当前跨层运行检查', actionCeiling: 'read-only',
    ownedPaths: [], taskProfiles: ['read-only-review'] });
  const preparationExecution = { schemaVersion: 1, issuer: 'forge-conversation-gateway', audience: 'forge-phase-budget-guard',
    executionId: '1dca4a1f-2a21-49af-9b1e-35cad1a9a65b', claimId: crypto.randomUUID(), projectSlug: 'forge-fixture',
    taskId: state.taskId, actorUserId, actorUsername: 'fixture-operator', conversationId: 'fixture-conversation', generation: 40,
    route: 'session.prompt', classification: 'claimable-text', rpcId: 'rpc-runtime-40', dshSessionId: state.sessionId, mode: 'queue',
    bodyDigest: '1'.repeat(64), textDigest: '2'.repeat(64), bodyBytes: 48, promptDigest: '2'.repeat(64), policyVersion: 'fixture-v1',
    authorityClass: 'production-read-only', testOnly: false, sourceCommit: SOURCE_COMMIT, workspaceFingerprint: null,
    caseFamily: 'crud-complete', productionAuthorityId: null, productionAuthorityDigest: null, controllerGrantDigest: null,
    workflowId: state.workflowId, phaseId: 'cross-layer-acceptance', phaseIndex: 7,
    phaseCatalogVersion: state.catalogVersion, phaseCatalogDigest: state.catalogDigest, contractId: contract.contractId,
    contractDigest: contract.contractId, actionCeiling: 'read-only', ownedPaths: [], requiredProfiles: [], contract,
    requestId: 'request:runtime-40', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    crossLayerPreparation: true, preparationBinding };
  const preparationTerminal = { ...Object.fromEntries(['executionId', 'generation', 'dshSessionId', 'rpcId', 'textDigest']
    .map(key => [key, preparationExecution[key]])), terminalReason: 'completed', sessionRunning: false,
    turn: 40, requestSeq: 338128, terminalSeq: 340082, terminalEventDigest: '4'.repeat(64) };
  const observationId = '31ab7ebb-4c7d-4225-9a48-c01d5887db74';
  const previousObservationId = '9187d2b0-347a-47d7-8fff-5372b8a66e92';
  const patchSha = JSON.parse(await readFile(path.join(old.artifactsDirectory, 'access-wiring-implementation.json'))).sourceFingerprint;
  const common = { sourceCommit: candidateCommit, taskId: state.taskId, executionId: preparationExecution.executionId,
    stateDigest: state.stateDigest, baseSourceCommit: SOURCE_COMMIT, workspaceFingerprint: fingerprint,
    acceptedPatchSha256: patchSha, candidateTree, observationId, observedAt: new Date().toISOString() };
  const bundle = { manifestSha256: '0'.repeat(64), subject: { workflowId: state.workflowId, taskId: state.taskId,
    baseSourceCommit: SOURCE_COMMIT, stateDigest: state.stateDigest, catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest, cumulativePatchSha256: patchSha }, runtimeSource: { commit: candidateCommit, tree: candidateTree },
    evidence: { deployment: { ...common, status: 'success', startup: { migrationValidated: true, applicationStarted: true } },
      api: { ...common, status: 'passed', roleAuthorizationVerified: false },
      database: { ...common, status: 'failed', checks: [{ id: 'fire-role', status: 'failed', rowCount: 0, resultSha256: EMPTY_SHA256 },
        { id: 'applicant-role', status: 'failed', rowCount: 0, resultSha256: EMPTY_SHA256 }] },
      browser: { ...common, status: 'not-executed', reason: 'owner-excluded' } }, sourceLineage: {} };
  const receipt = { schemaVersion: 'forge-cross-layer-runtime-input-receipt/v1', sourceStateDigest: state.stateDigest,
    sessionId: state.sessionId, lastExecutionGeneration: 36, acceptedArtifacts: state.acceptedArtifacts,
    manifestSha256: bundle.manifestSha256, bundleSha256: digest(bytes(bundle)), promptDigest: state.activeAttempt.promptDigest,
    promptSha256: digest(await readFile(old.promptFile)), modelStarted: false, acceptedStageCountChanged: false, preparationBinding };
  const archiveDirectory = path.join(oldDirectory, 'runtime-rechecks', digest(Buffer.from('rpc-old-reprobe')));
  const archived = { 'state.json': originalStateBytes, 'runtime-evidence.json': bytes({ old: true }),
    'runtime-input-receipt.json': bytes({ old: true }), 'current-prompt.md': await readFile(old.promptFile) };
  for (const [name, value] of Object.entries(archived)) await put(path.join(archiveDirectory, name), value);
  const reprobe = { schemaVersion: 'forge-cross-layer-runtime-reprobe/v1', status: 'imported', rpcId: 'rpc-old-reprobe',
    requestSha256: '5'.repeat(64), taskId: state.taskId, sessionId: state.sessionId, stateDigest: state.stateDigest,
    attemptId: state.activeAttempt.attemptId, baseSourceCommit: SOURCE_COMMIT, workspaceFingerprint: fingerprint,
    acceptedArtifactDigests: state.acceptedArtifacts, candidateCommit, candidateTree, acceptedPatchSha256: patchSha,
    previousManifestSha256: '6'.repeat(64), previousObservationId, previousStateDigest: state.stateDigest,
    previousExecutionId: crypto.randomUUID(), previousExecutionGeneration: 36, archiveDirectory,
    archivedSha256: Object.fromEntries(Object.entries(archived).map(([name, value]) => [name, digest(value)])),
    replacementManifestSha256: bundle.manifestSha256, replacementObservationId: observationId,
    replacementSha256: { 'runtime-evidence.json': digest(bytes(bundle)), 'runtime-input-receipt.json': digest(bytes(receipt)) } };
  const writeObservation = async value => {
    const input = { ...receipt, bundleSha256: digest(bytes(value)) };
    const link = { ...reprobe, replacementSha256: { 'runtime-evidence.json': digest(bytes(value)), 'runtime-input-receipt.json': digest(bytes(input)) } };
    await put(path.join(oldDirectory, 'runtime-evidence.json'), bytes(value));
    await put(path.join(oldDirectory, 'runtime-input-receipt.json'), bytes(input));
    await put(path.join(oldDirectory, 'runtime-reprobe.json'), bytes(link));
  };
  await writeObservation(bundle);
  const outputDirectory = path.join(oldDirectory, 'runtime-access-repair');
  const args = { catalogFile: CATALOG_FILE, sourceStateFile: old.stateFile, expectedSourceStateSha256: digest(originalStateBytes),
    sourceArtifactsDirectory: old.artifactsDirectory, sourceCommit: SOURCE_COMMIT, originalRequestFile: old.originalRequestFile,
    outputDirectory, repairRequestText: '请现在继续修复当前候选的权限接线缺口。', preparationExecution, preparationTerminal };
  for (const change of [value => { value.runtimeSource.commit = '9'.repeat(40); },
    value => { value.evidence.database.observationId = previousObservationId; },
    value => { value.evidence.database.status = 'passed'; value.evidence.database.checks.forEach(item => { item.status = 'passed'; item.rowCount = 1; }); }]) {
    const changed = structuredClone(bundle); change(changed); await writeObservation(changed);
    await assert.rejects(phaseController.prepareForgeAccessWiringRuntimeRepairContinuation(args),
      error => error.code === 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID');
    assert.deepEqual(await readFile(old.stateFile), originalStateBytes);
  }
  await writeObservation(bundle);
  await assert.rejects(phaseController.prepareForgeAccessWiringRuntimeRepairContinuation({ ...args,
    preparationTerminal: { ...preparationTerminal, terminalReason: 'error' } }),
  error => error.code === 'PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID');
  const saved = Object.fromEntries(await Promise.all(['state.json', 'runtime-evidence.json', 'runtime-input-receipt.json', 'runtime-reprobe.json']
    .map(async name => [name, await readFile(path.join(oldDirectory, name))])));
  const created = await phaseController.prepareForgeAccessWiringRuntimeRepairContinuation(args);
  assert.equal(created.nextExecutionGenerationMinimum, 41); assert.equal(created.observationId, observationId);
  assert.equal(created.inheritedStageCount, 6); assert.equal(created.newAcceptedStageCount, 0);
  const readArgs = { catalogFile: CATALOG_FILE, sourceStateFile: context.stateFile,
    sourceArtifactsDirectory: context.artifactsDirectory, sourceCommit: SOURCE_COMMIT, taskId: state.taskId, sessionId: state.sessionId };
  const resolved = await phaseController.readForgeAccessWiringRepairContinuation(readArgs);
  assert.equal(resolved.phaseDirectory, outputDirectory); assert.deepEqual(resolved.continuation, created);
  assert.deepEqual(await phaseController.prepareForgeAccessWiringRuntimeRepairContinuation(args), created);
  const child = { root: context.root, stateFile: path.join(outputDirectory, 'state.json'), artifactsDirectory: path.join(outputDirectory, 'artifacts'),
    originalRequestFile: path.join(outputDirectory, 'original-request.md'), promptFile: path.join(outputDirectory, 'current-prompt.md') };
  const phase = await prepareForgeDeliveryBrowserPhase({ ...child, catalogFile: CATALOG_FILE, sourceCommit: SOURCE_COMMIT,
    taskId: state.taskId, sessionId: state.sessionId, rpcId: 'rpc-repair-41' });
  assert.equal(phase.phaseId, 'access-wiring'); assert.equal(phase.phaseIndex, 6);
  cumulative += 'runtime permission repair\n';
  const accepted = await finalizeCurrent(child, { generation: 41, allChangedPaths: [...allPaths].sort(), phaseChangedPaths: paths[6],
    phasePatch: 'runtime permission repair\n', cumulativePatch: cumulative });
  assert.equal(accepted.nextPhaseId, 'cross-layer-acceptance');
  assert.equal((await phaseController.readForgeAccessWiringRepairContinuation(readArgs)).phaseDirectory, outputDirectory);
  const final = await readForgeDeliveryPhaseState(child.stateFile, catalog);
  assert.equal(final.currentPhaseIndex, 7); assert.equal(Object.keys(final.acceptedArtifacts).length, 7);
  assert.equal(final.activeAttempt, null); assert.equal(final.lastExecutionGeneration, 41);
  assert.deepEqual(await readFile(context.stateFile), rootBytes);
  for (const [name, value] of Object.entries(saved)) assert.deepEqual(await readFile(path.join(oldDirectory, name)), value);
});

test('controller preserves seven accepted phases and waits for runtime evidence before cross-layer execution', async () => {
  const context = await fixture();
  const databasePath = 'forge-server/db/migration/V20260903__employee.sql';
  const databaseTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeMigrationContractTest.java';
  const backendPath = 'forge-server/forge-business/forge-business-core/src/main/java/com/forge/EmployeeController.java';
  const frontendPath = 'forge-admin-ui/src/views/system/employee/index.vue';
  const accessPath = 'forge-server/db/migration/V20260904__employee_access.sql';
  const accessTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeAccessMigrationContractTest.java';
  let allChangedPaths = [];
  let cumulativePatch = '';

  let result = await finalizeCurrent(context, {
    generation: 1, allChangedPaths, phaseChangedPaths: [], phasePatch: '', cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'domain-contract');
  result = await finalizeCurrent(context, {
    generation: 2, allChangedPaths, phaseChangedPaths: [], phasePatch: '', cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'database');

  allChangedPaths = [databasePath, databaseTestPath].sort();
  cumulativePatch = 'database patch\n';
  result = await finalizeCurrent(context, {
    generation: 3,
    allChangedPaths,
    phaseChangedPaths: [databasePath, databaseTestPath],
    phasePatch: 'database patch\n',
    cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'ui-design');
  result = await finalizeCurrent(context, {
    generation: 4, allChangedPaths, phaseChangedPaths: [], phasePatch: '', cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'backend');

  allChangedPaths = [...allChangedPaths, backendPath].sort();
  cumulativePatch += 'backend patch\n';
  result = await finalizeCurrent(context, {
    generation: 5,
    allChangedPaths,
    phaseChangedPaths: [backendPath],
    phasePatch: 'backend patch\n',
    cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'frontend');

  allChangedPaths = [...allChangedPaths, frontendPath].sort();
  cumulativePatch += 'frontend patch\n';
  result = await finalizeCurrent(context, {
    generation: 6,
    allChangedPaths,
    phaseChangedPaths: [frontendPath],
    phasePatch: 'frontend patch\n',
    cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'access-wiring');

  allChangedPaths = [...allChangedPaths, accessPath, accessTestPath].sort();
  cumulativePatch += 'access wiring patch\n';
  result = await finalizeCurrent(context, {
    generation: 7,
    allChangedPaths,
    phaseChangedPaths: [accessPath, accessTestPath],
    phasePatch: 'access wiring patch\n',
    cumulativePatch,
  });
  assert.equal(result.nextPhaseId, 'cross-layer-acceptance');
  assert.equal(result.workflowStatus, 'active');
  assert.equal(result.nextPromptDigest, null);
  assert.equal(result.nextPromptPendingReason, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED');

  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.status, 'active');
  assert.equal(state.history.length, 7);
  assert.equal(state.history[0].executionGeneration, 1);
  assert.equal(state.history[6].executionGeneration, 7);
  assert.equal(Object.keys(state.acceptedArtifacts).length, 7);
  assert.equal(state.activeAttempt, null);
  const beforeMissingEvidence = await readFile(context.stateFile);
  await assert.rejects(readPreparedForgeCrossLayerRuntimeEvidence({
    stateFile: context.stateFile, state, promptText: await readFile(context.promptFile, 'utf8'),
  }), { code: 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED' });
  assert.deepEqual(await readFile(context.stateFile), beforeMissingEvidence);
  const phaseIds = catalog.workflows[0].phases.slice(0, 7).map((phase) => phase.id);
  for (let index = 0; index < phaseIds.length; index += 1) {
    const workPackageDirectory = path.join(
      context.root,
      `phase-${index + 1}-${phaseIds[index]}`,
      'work-package',
    );
    assert.deepEqual((await readdir(workPackageDirectory)).sort(), [
      '00-input.md',
      '01-result.md',
      '02-process.md',
      '03-verification.md',
      '04-handoff.md',
      '05-memory-candidate.md',
      'manifest.json',
    ]);
    const manifest = JSON.parse(await readFile(path.join(workPackageDirectory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.phaseId, phaseIds[index]);
    assert.equal(manifest.decision, 'accepted');
    assert.equal(manifest.memoryStatus, 'candidate-only');
  }
});

test('controller rejects source mutation in a read-only requirements phase', async () => {
  const context = await fixture();
  await assert.rejects(
    finalizeCurrent(context, {
      generation: 1,
      allChangedPaths: ['forge-server/db/migration/illegal.sql'],
      phaseChangedPaths: ['forge-server/db/migration/illegal.sql'],
      phasePatch: '',
      cumulativePatch: 'illegal',
    }),
    (error) => error.code === 'PHASE_CONTROLLER_MUTATION_DENIED',
  );
});

test('controller finalize rejects a changed attempt without writing artifacts or advancing state', async (t) => {
  const context = await fixture();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const { phase, state } = await beginCurrent(context, 1);
  const inputsDirectory = path.join(context.root, 'finalize-inputs');
  await mkdir(inputsDirectory);
  const files = {
    responseFile: path.join(inputsDirectory, 'response.txt'),
    allChangedPathsFile: path.join(inputsDirectory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(inputsDirectory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(inputsDirectory, 'phase.patch'),
    cumulativePatchFile: path.join(inputsDirectory, 'cumulative.patch'),
    hostReceiptsFile: path.join(inputsDirectory, 'host-receipts.json'),
  };
  await Promise.all([
    writeFile(files.responseFile, `已明确当前需求与后续交付边界。\n\n<forge-phase-artifact>${JSON.stringify(proposalFor(phase))}</forge-phase-artifact>\n`),
    writeFile(files.allChangedPathsFile, '[]\n'),
    writeFile(files.phaseChangedPathsFile, '[]\n'),
    writeFile(files.phasePatchFile, ''),
    writeFile(files.cumulativePatchFile, ''),
    writeFile(files.hostReceiptsFile, `${JSON.stringify(phase.hostVerificationProfiles.map((profile) => ({
      profile, status: 'passed', receiptDigest: EMPTY_SHA256, patchDigest: EMPTY_SHA256,
    })))}\n`),
  ]);
  const args = {
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    ...files,
    outputDirectory: path.join(context.root, 'finalize-output'),
    nextPromptFile: context.promptFile,
  };
  const stateBefore = await readFile(context.stateFile);
  const promptBefore = await readFile(context.promptFile);
  const entriesBefore = (await readdir(context.root, { recursive: true })).sort();
  await assert.rejects(finalizeForgeDeliveryPhaseRun({
    ...args, expectedAttemptId: crypto.randomUUID(),
  }), { code: 'PHASE_CONTROLLER_ATTEMPT_CHANGED' });
  assert.deepEqual(await readFile(context.stateFile), stateBefore);
  assert.deepEqual(await readFile(context.promptFile), promptBefore);
  assert.deepEqual((await readdir(context.root, { recursive: true })).sort(), entriesBefore);
  await assert.rejects(readdir(args.outputDirectory), { code: 'ENOENT' });
  const result = await finalizeForgeDeliveryPhaseRun({ ...args, expectedAttemptId: state.activeAttempt.attemptId });
  assert.equal(result.acceptedPhaseId, 'requirements');
  assert.equal(result.nextPhaseId, 'domain-contract');
});

test('controller preflight validates the observed phase patch without advancing state', async () => {
  const context = await fixture();
  await finalizeCurrent(context, {
    generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  const { phase } = await beginCurrent(context, 3);
  const phaseDirectory = path.join(context.root, 'database-preflight');
  await mkdir(phaseDirectory, { recursive: true });
  const changedPaths = [
    'forge-server/db/migration/V20260903__employee.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/employee/migration/EmployeeMigrationContractTest.java',
  ];
  const files = {
    responseFile: path.join(phaseDirectory, 'response.txt'),
    allChangedPathsFile: path.join(phaseDirectory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(phaseDirectory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(phaseDirectory, 'phase.patch'),
    cumulativePatchFile: path.join(phaseDirectory, 'cumulative.patch'),
    receiptFile: path.join(phaseDirectory, 'preflight-receipt.json'),
  };
  await Promise.all([
    writeFile(files.responseFile, `<forge-phase-artifact>${JSON.stringify(proposalFor(phase, changedPaths))}</forge-phase-artifact>\n`),
    writeFile(files.allChangedPathsFile, `${JSON.stringify(changedPaths)}\n`),
    writeFile(files.phaseChangedPathsFile, `${JSON.stringify(changedPaths)}\n`),
    writeFile(files.phasePatchFile, 'database patch\n'),
    writeFile(files.cumulativePatchFile, 'database patch\n'),
  ]);
  const stateBeforePreflight = await readFile(context.stateFile, 'utf8');
  await assert.rejects(preflightForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    ...files,
    expectedAttemptId: crypto.randomUUID(),
  }), { code: 'PHASE_CONTROLLER_ATTEMPT_CHANGED' });
  await assert.rejects(readFile(files.receiptFile), { code: 'ENOENT' });
  assert.equal(await readFile(context.stateFile, 'utf8'), stateBeforePreflight);
  const receipt = await preflightForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    ...files,
    expectedAttemptId: JSON.parse(stateBeforePreflight).activeAttempt.attemptId,
  });
  assert.equal(receipt.phaseId, 'database');
  assert.equal(receipt.safeForOperatorHostVerification, true);
  assert.equal(receipt.stateAdvanced, false);
  assert.deepEqual(receipt.changedPaths, [...changedPaths].sort());
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.currentPhaseId, 'database');
  assert.equal(state.history.length, 2);
});

test('controller preflight rejects a cross-owner path before Host Runner execution', async () => {
  const context = await fixture();
  await finalizeCurrent(context, {
    generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  const { phase } = await beginCurrent(context, 3);
  const phaseDirectory = path.join(context.root, 'database-cross-owner-preflight');
  await mkdir(phaseDirectory, { recursive: true });
  const changedPath = 'forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/employee/EmployeeService.java';
  const files = {
    responseFile: path.join(phaseDirectory, 'response.txt'),
    allChangedPathsFile: path.join(phaseDirectory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(phaseDirectory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(phaseDirectory, 'phase.patch'),
    cumulativePatchFile: path.join(phaseDirectory, 'cumulative.patch'),
    receiptFile: path.join(phaseDirectory, 'preflight-receipt.json'),
  };
  await Promise.all([
    writeFile(files.responseFile, `<forge-phase-artifact>${JSON.stringify(proposalFor(phase, [changedPath]))}</forge-phase-artifact>\n`),
    writeFile(files.allChangedPathsFile, `${JSON.stringify([changedPath])}\n`),
    writeFile(files.phaseChangedPathsFile, `${JSON.stringify([changedPath])}\n`),
    writeFile(files.phasePatchFile, 'dependency mutation\n'),
    writeFile(files.cumulativePatchFile, 'dependency mutation\n'),
  ]);
  await assert.rejects(
    preflightForgeDeliveryPhaseRun({
      catalogFile: CATALOG_FILE,
      stateFile: context.stateFile,
      artifactsDirectory: context.artifactsDirectory,
      ...files,
    }),
    (error) => error.code === 'PHASE_PATH_DENIED',
  );
  await assert.rejects(readFile(files.receiptFile), (error) => error.code === 'ENOENT');
});

test('controller blocks rather than inventing an unresolved business decision', async () => {
  const context = await fixture();
  await assert.rejects(
    finalizeCurrent(context, {
      generation: 1,
      allChangedPaths: [],
      phaseChangedPaths: [],
      phasePatch: '',
      cumulativePatch: '',
      unresolvedDecisions: ['员工编号是否允许跨租户重复需要 owner 决策'],
    }),
    (error) => error.code === 'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED',
  );
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.status, 'blocked');
  assert.equal(state.history[0].reasonCode, 'BUSINESS_DECISION_REQUIRED');
  const manifest = JSON.parse(await readFile(path.join(
    context.root,
    'phase-1-requirements',
    'work-package',
    'manifest.json',
  ), 'utf8'));
  assert.equal(manifest.decision, 'blocked');
  assert.equal(manifest.canonicalArtifactDigest, null);
  const result = await readFile(path.join(
    context.root,
    'phase-1-requirements',
    'work-package',
    '01-result.md',
  ), 'utf8');
  assert.match(result, /已形成当前阶段的业务结果/u);
  assert.match(result, /本阶段暂未通过，需要先完成业务决定/u);
  assert.match(result, /员工编号是否允许跨租户重复需要 owner 决策/u);
  assert.doesNotMatch(result.split('<details>')[0], /Decision: `accepted`/u);
});

test('controller carries the accepted model business response into the result without losing machine payload', async () => {
  const context = await fixture();
  const businessResponse = '员工档案需求已经明确到角色、业务流程和权限边界。下一步将据此统一领域对象与接口含义。';
  await finalizeCurrent(context, {
    generation: 1,
    allChangedPaths: [],
    phaseChangedPaths: [],
    phasePatch: '',
    cumulativePatch: '',
    humanResponse: businessResponse,
  });
  const result = await readFile(path.join(
    context.root,
    'phase-1-requirements',
    'work-package',
    '01-result.md',
  ), 'utf8');
  assert.match(result, new RegExp(businessResponse, 'u'));
  assert.match(result, /本阶段结果已经确认，可以继续后续工作/u);
  assert.match(result, /下一步进入领域与接口约定/u);
  assert.match(result, /"actors"/u);
  assert.match(result, /Controller receipt/u);
});

test('controller detects a later phase rewriting an earlier owner', async () => {
  const context = await fixture();
  const databasePath = 'forge-server/db/migration/V20260903__employee.sql';
  const databaseTestPath = 'forge-server/forge-business/forge-business-core/src/test/java/com/forge/EmployeeMigrationContractTest.java';
  const databasePaths = [databasePath, databaseTestPath].sort();
  await finalizeCurrent(context, {
    generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 3,
    allChangedPaths: databasePaths,
    phaseChangedPaths: databasePaths,
    phasePatch: 'database patch\n',
    cumulativePatch: 'database patch\n',
  });
  await finalizeCurrent(context, {
    generation: 4,
    allChangedPaths: databasePaths,
    phaseChangedPaths: [],
    phasePatch: '',
    cumulativePatch: 'database patch\n',
  });
  await assert.rejects(
    finalizeCurrent(context, {
      generation: 5,
      allChangedPaths: databasePaths,
      phaseChangedPaths: [databasePath],
      phasePatch: 'tampered database patch\n',
      cumulativePatch: 'tampered database patch\n',
    }),
    (error) => error.code === 'PHASE_CONTROLLER_ACCEPTED_PATH_REWRITE',
  );
});

test('database and access wiring phases require a migration plus a business-core migration contract test', async () => {
  const context = await fixture();
  await finalizeCurrent(context, {
    generation: 1, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await finalizeCurrent(context, {
    generation: 2, allChangedPaths: [], phaseChangedPaths: [], phasePatch: '', cumulativePatch: '',
  });
  await assert.rejects(
    finalizeCurrent(context, {
      generation: 3,
      allChangedPaths: ['forge-server/db/migration/V20260903__employee.sql'],
      phaseChangedPaths: ['forge-server/db/migration/V20260903__employee.sql'],
      phasePatch: 'database patch\n',
      cumulativePatch: 'database patch\n',
    }),
    (error) => error.code === 'PHASE_CONTROLLER_REQUIRED_FILE_MISSING',
  );
});

test('empty cumulative fingerprint remains a real SHA-256 identity', async () => {
  assert.equal(EMPTY_SHA256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
