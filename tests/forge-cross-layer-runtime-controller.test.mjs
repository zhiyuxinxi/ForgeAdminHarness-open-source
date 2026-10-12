import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  beginForgeDeliveryBrowserPhase,
  finalizeForgeDeliveryPhaseRun,
  inspectForgeCrossLayerHostVerificationReuse,
  preflightForgeDeliveryPhaseRun,
  prepareForgeDeliveryBrowserPhase,
  prepareForgeCrossLayerRuntimePrompt,
  readPreparedForgeCrossLayerRuntimeEvidence,
} from '../docker/harness/forge-delivery-phase-controller.mjs';
import {
  beginForgeDeliveryPhase,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState,
  loadForgeDeliveryPhaseCatalog,
  readForgeDeliveryPhaseState,
  validateForgeDeliveryPhaseState,
  writeForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import {
  classifyPinnedDshPromptBody,
  digestDirectUserTextContent,
  prepareProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { canonicalStringify } from '../docker/harness/forge-task-execution-contract.mjs';
import * as controller from '../docker/harness/forge-delivery-phase-controller.mjs';

const executeFile = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_FILE = path.join(
  ROOT,
  'docker/harness/skills/forge-task-router/references/phase-profiles.json',
);
const POLICY_FILE = path.join(ROOT, 'docker/harness/forge-execution-policy.json');
const PROJECT_SLUG = 'runtime-controller-project';
const ACTOR_USER_ID = '123e4567-e89b-42d3-a456-426614174000';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function git(repository, args) {
  const result = await executeFile('git', ['-C', repository, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  return result.stdout.trim();
}

async function privateWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function acceptedSevenPhaseBoundary(catalog, sourceCommit, cumulativePatchSha256) {
  const workflow = catalog.workflows.find((entry) => entry.id === 'crud-production');
  let state = createForgeDeliveryPhaseState({
    catalog,
    workflowId: workflow.id,
    caseFamily: 'crud-complete',
    taskId: 'runtime-controller-fixture',
    sessionId: 'session:runtime-controller-fixture',
    sourceCommit,
    now: '2026-09-13T01:00:00.000Z',
  });
  const artifacts = [];
  for (const phase of workflow.phases.slice(0, 7)) {
    state = beginForgeDeliveryPhase({
      state,
      catalog,
      phaseId: phase.id,
      rpcId: `rpc:accepted:${phase.index}`,
      promptDigest: digest(`prompt:${phase.index}`),
      executionGeneration: phase.index + 1,
      now: `2026-09-13T01:00:${String(phase.index * 2 + 1).padStart(2, '0')}.000Z`,
    });
    const changedPaths = phase.sourceMutation
      ? [`${phase.ownedPaths[0]}/fixture-${phase.index}.txt`] : [];
    const payload = Object.fromEntries(phase.requiredPayloadKeys.map((key) => [
      key,
      key === 'changedPaths' ? changedPaths : { evidence: `${phase.id}:${key}` },
    ]));
    const artifact = createForgeDeliveryPhaseArtifact({
      state,
      catalog,
      phaseId: phase.id,
      attemptId: state.activeAttempt.attemptId,
      sourceFingerprint: cumulativePatchSha256,
      changedPaths,
      patchDigest: phase.patchScope === 'none' ? null : cumulativePatchSha256,
      payload,
    });
    const hostReceipts = phase.hostVerificationProfiles.map((profile) => ({
      profile,
      status: 'passed',
      receiptDigest: digest(`receipt:${phase.index}:${profile}`),
      patchDigest: cumulativePatchSha256,
    }));
    ({ state } = completeForgeDeliveryPhase({
      state,
      catalog,
      decision: 'accepted',
      artifact,
      hostReceipts,
      now: `2026-09-13T01:00:${String(phase.index * 2 + 2).padStart(2, '0')}.000Z`,
    }));
    artifacts.push(artifact);
  }
  return { state, artifacts };
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-controller-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'repository');
  const evidenceDirectory = path.join(temporary, 'evidence');
  const stateFile = path.join(temporary, 'control', 'state.json');
  const artifactsDirectory = path.join(temporary, 'artifacts');
  const originalRequestFile = path.join(temporary, 'request.md');
  const promptFile = path.join(temporary, 'current-prompt.md');
  await mkdir(repository, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  await git(repository, ['init', '--quiet']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repository, 'app.txt'), 'base\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['commit', '--quiet', '-m', 'base']);
  const baseCommit = await git(repository, ['rev-parse', 'HEAD']);
  await writeFile(path.join(repository, 'app.txt'), 'base\naccepted\n');
  const acceptedPatch = Buffer.from(`${await git(repository, ['diff', '--binary'])}\n`, 'utf8');
  await privateWrite(path.join(evidenceDirectory, 'accepted.patch'), acceptedPatch);
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['commit', '--quiet', '-m', 'accepted candidate']);
  const runtimeCommit = await git(repository, ['rev-parse', 'HEAD']);
  const runtimeTree = await git(repository, ['rev-parse', 'HEAD^{tree}']);
  const cumulativePatchSha256 = digest(acceptedPatch);

  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const accepted = await acceptedSevenPhaseBoundary(catalog, baseCommit, cumulativePatchSha256);
  await writeForgeDeliveryPhaseState(stateFile, accepted.state, catalog);
  await mkdir(artifactsDirectory, { recursive: true });
  for (const artifact of accepted.artifacts) {
    await writeFile(path.join(artifactsDirectory, `${artifact.artifactKind}.json`), `${JSON.stringify(artifact)}\n`);
  }
  await writeFile(originalRequestFile, '验证已经部署的完整业务功能。\n');
  await writeFile(promptFile, 'Runtime evidence has not been prepared.\n');

  const deployment = {
    schemaVersion: 1,
    sourceCommit: runtimeCommit,
    releaseState: { commit: runtimeCommit, status: 'success' },
    provenance: { candidateCommit: runtimeCommit },
    checks: [{ id: 'container-health', passed: true }],
  };
  const api = { schemaVersion: 1, sourceCommit: runtimeCommit, checks: 31, failures: [] };
  await privateWrite(path.join(evidenceDirectory, 'deployment.json'), `${JSON.stringify(deployment)}\n`);
  await privateWrite(path.join(evidenceDirectory, 'api.json'), `${JSON.stringify(api)}\n`);
  const deploymentEvidenceSha256 = digest(await readFile(path.join(evidenceDirectory, 'deployment.json')));
  const apiEvidenceSha256 = digest(await readFile(path.join(evidenceDirectory, 'api.json')));
  const browser = {
    schemaVersion: 1, sourceCommit: runtimeCommit, checks: 14, failures: [], unknown: [],
    deploymentEvidenceSha256, apiEvidenceSha256,
  };
  const database = {
    schemaVersion: 1, sourceCommit: runtimeCommit, checks: 8, failures: [], apiEvidenceSha256,
  };
  await privateWrite(path.join(evidenceDirectory, 'browser.json'), `${JSON.stringify(browser)}\n`);
  await privateWrite(path.join(evidenceDirectory, 'database.json'), `${JSON.stringify(database)}\n`);
  const fileRef = async (name) => ({
    path: name,
    sha256: digest(await readFile(path.join(evidenceDirectory, name))),
  });
  const manifest = {
    schemaVersion: 'forge-cross-layer-runtime-evidence/v1',
    subject: {
      workflowId: accepted.state.workflowId,
      taskId: accepted.state.taskId,
      catalogVersion: accepted.state.catalogVersion,
      catalogDigest: accepted.state.catalogDigest,
      stateDigest: accepted.state.stateDigest,
      baseSourceCommit: baseCommit,
      cumulativePatchSha256,
    },
    runtimeSource: { commit: runtimeCommit, tree: runtimeTree },
    acceptedPatch: await fileRef('accepted.patch'),
    repairs: [],
    evidence: Object.fromEntries(await Promise.all(
      ['deployment', 'api', 'browser', 'database'].map(async (kind) => [kind, await fileRef(`${kind}.json`)]),
    )),
  };
  await privateWrite(path.join(evidenceDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  const expectedManifestSha256 = digest(await readFile(path.join(evidenceDirectory, 'manifest.json')));
  return {
    temporary, repository, evidenceDirectory, stateFile, artifactsDirectory,
    originalRequestFile, promptFile, catalog, accepted, manifest, expectedManifestSha256,
    cumulativePatchSha256, acceptedPatch, runtimeCommit,
  };
}

async function prepare(context) {
  return prepareForgeCrossLayerRuntimePrompt({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    runtimeEvidenceDirectory: context.evidenceDirectory,
    expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository,
    promptFile: context.promptFile,
  });
}

function browserArgs(context, rpcId, sourceCommit = context.runtimeCommit) {
  return {
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    promptFile: context.promptFile,
    sourceCommit,
    taskId: context.accepted.state.taskId,
    sessionId: context.accepted.state.sessionId,
    rpcId,
  };
}

function browserRequest(context, promptText, rpcId, requestId = `request:${rpcId}`) {
  const body = Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'session.prompt',
    payload: {
      sessionId: context.accepted.state.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    },
  }));
  return {
    ...classifyPinnedDshPromptBody(body, 'session.prompt'),
    requestId,
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'alice',
    conversationId: 'conversation:runtime-controller',
  };
}

function browserMetadata(context) {
  return {
    schemaVersion: 2,
    projectSlug: PROJECT_SLUG,
    taskId: context.accepted.state.taskId,
    actorId: 'alice',
    actorUserId: ACTOR_USER_ID,
    conversationId: 'conversation:runtime-controller',
    accessMode: 'conversation',
    status: 'active',
  };
}

async function browserExecution(context, prepared) {
  const projectRoot = path.join(context.temporary, 'execution');
  for (let generation = 1; generation <= 7; generation += 1) {
    await prepareProtectedExecutionContext({
      projectRoot,
      projectSlug: PROJECT_SLUG,
      taskMetadata: browserMetadata(context),
      request: browserRequest(context, `prior phase ${generation}`, `rpc:prior:${generation}`),
      policyPath: POLICY_FILE,
      now: Date.now(),
    });
  }
  return prepareProtectedExecutionContext({
    projectRoot,
    projectSlug: PROJECT_SLUG,
    taskMetadata: browserMetadata(context),
    request: browserRequest(context, prepared.promptText, prepared.rpcId),
    policyPath: POLICY_FILE,
    trustedPhase: {
      sourceCommit: prepared.executionSourceCommit,
      caseFamily: prepared.caseFamily,
      phaseAuthority: prepared.phaseAuthority,
    },
    now: Date.now(),
  });
}

function proposal(phase, manifestSha256) {
  return {
    schemaVersion: 'forge-delivery-phase-proposal/v1',
    phaseId: phase.id,
    unresolvedDecisions: [],
    payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [
      key,
      key === 'runtimeEvidenceDigest' ? manifestSha256 : { evidence: `cross-layer:${key}` },
    ])),
  };
}

async function beginAndWriteAttempt(context, runtimeEvidenceDigest = context.expectedManifestSha256) {
  const prompt = (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, '');
  const idle = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  const state = beginForgeDeliveryPhase({
    state: idle,
    catalog: context.catalog,
    phaseId: 'cross-layer-acceptance',
    rpcId: 'rpc:cross-layer:8',
    promptDigest: digestDirectUserTextContent([{ type: 'text', text: prompt }]),
    executionGeneration: 8,
    now: '2026-09-13T01:00:20.000Z',
  });
  await writeForgeDeliveryPhaseState(context.stateFile, state, context.catalog);
  const phase = context.catalog.workflows.find((entry) => entry.id === state.workflowId).phases[7];
  const directory = path.join(context.temporary, 'phase-8-cross-layer');
  await mkdir(directory, { recursive: true });
  const priorPaths = context.accepted.artifacts.flatMap((artifact) => artifact.changedPaths).sort();
  const files = {
    responseFile: path.join(directory, 'response.md'),
    allChangedPathsFile: path.join(directory, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(directory, 'phase-changed-paths.json'),
    phasePatchFile: path.join(directory, 'phase.patch'),
    cumulativePatchFile: path.join(directory, 'cumulative.patch'),
    hostReceiptsFile: path.join(directory, 'host-receipts.json'),
    receiptFile: path.join(directory, 'preflight-receipt.json'),
  };
  const hostReceipts = phase.hostVerificationProfiles.map((profile) => ({
    profile,
    status: 'passed',
    receiptDigest: digest(`a8:${profile}`),
    patchDigest: context.cumulativePatchSha256,
  }));
  await Promise.all([
    writeFile(files.responseFile, `运行证据已逐项核对。\n\n<forge-phase-artifact>${JSON.stringify(
      proposal(phase, runtimeEvidenceDigest),
    )}</forge-phase-artifact>\n`),
    writeFile(files.allChangedPathsFile, `${JSON.stringify(priorPaths)}\n`),
    writeFile(files.phaseChangedPathsFile, '[]\n'),
    writeFile(files.phasePatchFile, ''),
    writeFile(files.cumulativePatchFile, context.acceptedPatch),
    writeFile(files.hostReceiptsFile, `${JSON.stringify(hostReceipts)}\n`),
  ]);
  return { directory, files, state };
}

test('same preparation execution appends failed runtime observations without changing its formal attempt', async (t) => {
  const context = await fixture(t);
  const { prepareForgeCrossLayerCandidate } = await import('../docker/harness/forge-cross-layer-preparation.mjs');
  const projectRoot = path.join(context.temporary, 'execution');
  const phaseDirectory = path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases', context.accepted.state.taskId, 'phase-control');
  const oldArtifacts = context.artifactsDirectory;
  context.stateFile = path.join(phaseDirectory, 'state.json');
  context.artifactsDirectory = path.join(phaseDirectory, 'artifacts');
  context.originalRequestFile = path.join(phaseDirectory, 'original-request.md');
  context.promptFile = path.join(phaseDirectory, 'current-prompt.md');
  await writeForgeDeliveryPhaseState(context.stateFile, context.accepted.state, context.catalog);
  for (const artifact of context.accepted.artifacts) await privateWrite(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`), await readFile(path.join(oldArtifacts, `${artifact.artifactKind}.json`)));
  await privateWrite(context.originalRequestFile, '验证已经部署的完整业务功能。\n');
  await privateWrite(context.promptFile, '尚未准备运行证据。\n');
  await git(context.repository, ['commit', '--amend', '--quiet', '-m', `Accepted cross-layer candidate ${context.cumulativePatchSha256}`]);
  context.runtimeCommit = await git(context.repository, ['rev-parse', 'HEAD']);
  context.manifest.runtimeSource.commit = context.runtimeCommit;
  const retainedRoot = path.join(phaseDirectory, 'runtime-preparations', crypto.randomUUID());
  await mkdir(retainedRoot, { recursive: true, mode: 0o700 });
  await git(context.repository, ['clone', '--bare', '--quiet', context.repository, path.join(retainedRoot, 'source.git')]);
  await privateWrite(path.join(retainedRoot, 'evidence', 'accepted.patch'), context.acceptedPatch);
  await git(context.repository, ['reset', '--mixed', '--quiet', context.accepted.state.sourceCommit]);
  const oldObservation = '11111111-1111-4111-8111-111111111111';
  const fingerprint = 'a'.repeat(64);
  const initialBinding = { stateDigest: context.accepted.state.stateDigest,
    acceptedArtifactDigests: context.accepted.state.acceptedArtifacts,
    baseSourceCommit: context.accepted.state.sourceCommit, workspaceFingerprint: fingerprint };
  const observation = async (state, observationId, apiStatus, roleAuthorizationVerified = false) => {
    const common = { sourceCommit: context.runtimeCommit, taskId: state.taskId,
      stateDigest: state.stateDigest, baseSourceCommit: state.sourceCommit,
      workspaceFingerprint: fingerprint, acceptedPatchSha256: context.cumulativePatchSha256,
      candidateTree: context.manifest.runtimeSource.tree, observationId };
    for (const kind of ['deployment', 'api', 'database', 'browser']) {
      const document = { ...common, status: kind === 'deployment' ? 'success' : kind === 'api' ? apiStatus : kind === 'browser' ? 'not-executed' : apiStatus === 'blocked' ? 'blocked' : 'passed',
        ...(kind === 'deployment' ? { startup: { migrationValidated: true, applicationStarted: true } } : {}),
        ...(kind === 'browser' ? { reason: 'owner-excluded' } : {}),
        ...(apiStatus === 'blocked' && ['api', 'database'].includes(kind)
          ? { checks: Array.from({ length: kind === 'api' ? 9 : 3 }, (_, index) => ({ id: `${kind}-${index}`, status: 'not-executed' })) } : {}),
        ...(kind === 'api' ? { roleAuthorizationVerified } : {}) };
      const file = path.join(context.evidenceDirectory, `${kind}.json`);
      await privateWrite(file, `${JSON.stringify(document)}\n`);
      context.manifest.evidence[kind].sha256 = digest(await readFile(file));
    }
    context.manifest.subject.stateDigest = state.stateDigest;
    await privateWrite(path.join(context.evidenceDirectory, 'manifest.json'), `${JSON.stringify(context.manifest)}\n`);
    context.expectedManifestSha256 = digest(await readFile(path.join(context.evidenceDirectory, 'manifest.json')));
  };
  await observation(context.accepted.state, oldObservation, 'blocked');
  await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: initialBinding });
  const args = browserArgs(context, 'rpc:runtime-review', context.accepted.state.sourceCommit);
  const prepared = await prepareForgeDeliveryBrowserPhase(args);
  await browserExecution(context, prepared);
  const execution = JSON.parse(await readFile(path.join(context.temporary, 'execution', 'taskspaces', '.broker',
    'executions', `${context.accepted.state.taskId}.json`), 'utf8')).current;
  const begin = await beginForgeDeliveryBrowserPhase({ ...args, prepared, execution });
  const attemptDirectory = path.join(path.dirname(context.stateFile), 'browser-attempts', execution.executionId);
  const baseline = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', observedSeq: 100, sessionCwd: '/workspace' };
  const modelResponse = '运行观察失败，保留原候选及原失败，不声明阶段通过。';
  const proof = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-proof/v1',
    terminalReason: 'completed', hostReceiptsDerived: false, baselineObservedSeq: 100,
    requestSeq: 101, assistantMessageSeq: 102, terminalSeq: 103, sessionCwd: '/workspace',
    terminalEventDigest: 'b'.repeat(64), modelResponseSha256: digest(modelResponse) };
  for (const [name, value] of Object.entries({ 'execution.json': execution, 'session-baseline.json': baseline,
    'begin.json': begin, '阶段终态采集.json': { modelResponse, sessionProof: proof } })) {
    await privateWrite(path.join(attemptDirectory, name), `${JSON.stringify(value)}\n`);
  }
  const original = Object.fromEntries(await Promise.all(['runtime-evidence.json', 'runtime-input-receipt.json'].map(async name =>
    [name, await readFile(path.join(path.dirname(context.stateFile), name))])));
  const stateBefore = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  const artifactBytes = await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`))));
  const promptText = `当前跨层验收尚未通过，请继续核对这次候选的匿名认证响应，并补充必要的受控运行检查。

保留原作业 b9de518c-e458-408b-904b-1dd170047b18、候选 7a40893fb5ece587cc84fdc598b8dece991eee82、已成功迁移和原 HTTP 401 期望失败证据。请先读取当前实际接口和认证异常处理合同，判断 HTTP 200 的正文究竟是拒绝提示还是业务数据；只能按真实合同提出有正文断言的检查，不能只改 HTTP 期望让它变绿。

只复用本候选及现有测试库补充探测，不重建、不重复迁移，不改业务源码或测试，不删除或改写旧私有回执，不新建其他业务，不进行浏览器或现场外部联调。若现有受控入口不能读取必要响应证据、不能对当前候选执行补充探测，或不能保留失败再导入新观察，请在原对话明确具体阻塞和最小解除条件；不要用结束答复或伪造通过代替。
`;
  const resumeArgs = { ...args, rpcId: 'rpc:runtime-reprobe', workspaceFingerprint: fingerprint, promptText, attemptDirectory };
  for (const status of ['passed', 'unknown']) {
    const rejectedBundle = JSON.parse(original['runtime-evidence.json']);
    for (const kind of ['api', 'database']) rejectedBundle.evidence[kind].checks[0].status = status;
    const bytes = Buffer.from(`${JSON.stringify(rejectedBundle)}\n`);
    const receipt = { ...JSON.parse(original['runtime-input-receipt.json']), bundleSha256: digest(bytes) };
    await privateWrite(path.join(phaseDirectory, 'runtime-evidence.json'), bytes);
    await privateWrite(path.join(phaseDirectory, 'runtime-input-receipt.json'), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe(resumeArgs), { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  }
  for (const [name, bytes] of Object.entries(original)) await privateWrite(path.join(phaseDirectory, name), bytes);
  const resumed = await controller.prepareForgeCrossLayerRuntimeReprobe(resumeArgs);
  await prepareProtectedExecutionContext({ projectRoot, projectSlug: PROJECT_SLUG, taskMetadata: browserMetadata(context),
    request: browserRequest(context, resumed.promptText, resumed.rpcId), policyPath: POLICY_FILE,
    trustedPhase: { sourceCommit: resumed.executionSourceCommit, caseFamily: resumed.caseFamily,
      phaseAuthority: resumed.phaseAuthority, crossLayerPreparation: true, preparationBinding: resumed.preparationBinding }, now: Date.now() });
  const preparation = JSON.parse(await readFile(path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${stateBefore.taskId}.json`), 'utf8')).current;
  const task = { metadata: browserMetadata(context), workspace: context.repository };
  const jobId = crypto.randomUUID();
  let runnerCalls = 0, replayObservation = false;
  const observations = [];
  const runnerDocuments = [];
  let current = preparation;
  const source = { head: stateBefore.sourceCommit, workspaceFingerprint: fingerprint };
  const runArgs = { projectRoot, task, context: preparation, catalogFile: CATALOG_FILE,
    inspectSource: async () => source, readContext: async () => current,
    publishCandidate: async () => assert.fail('the accepted candidate must not be rebuilt or published'),
    readReleaseStatus: async () => ({ active: false, activeJobId: null,
      lastJob: { status: 'prepared', jobId, commit: context.runtimeCommit, services: ['forge-admin', 'forge-ui'],
        provenance: { source: 'taskspace', taskId: preparation.taskId, actorId: task.metadata.actorId,
          conversationId: preparation.conversationId, candidateCommit: context.runtimeCommit } },
      testDatabaseRecovery: { status: 'healthy', lastAttempt: { jobId, commit: context.runtimeCommit, status: 'success' } } }),
    releaseClient: async request => {
      runnerCalls++;
      assert.equal(request.preparedJobId, jobId);
      assert.equal(request.provenance.candidateCommit, context.runtimeCommit);
      assert.equal(request.runtimePreparation.executionId, preparation.executionId);
      assert.equal(request.runtimePreparation.stateDigest, stateBefore.stateDigest);
      assert.equal(request.runtimePreparation.recheck.previousObservationId, observations.at(-1) ?? oldObservation);
      const observationId = replayObservation ? observations[0] : crypto.randomUUID();
      const root = path.join(projectRoot, 'ops', 'release-candidates', jobId, 'runtime-evidence', observationId);
      const { probePlan, recheck: _recheck, ...binding } = request.runtimePreparation;
      const evidence = {};
      for (const kind of ['deployment', 'api', 'database', 'browser']) {
        const document = { sourceCommit: context.runtimeCommit, ...binding, observationId,
          probePlanSha256: digest(Buffer.from(JSON.stringify(probePlan))),
          status: kind === 'deployment' ? 'success' : kind === 'browser' ? 'not-executed' : kind === 'api' ? 'blocked' : 'failed',
          ...(kind === 'deployment' ? { startup: { migrationValidated: true, applicationStarted: true } } : {}),
          ...(kind === 'browser' ? { reason: 'owner-excluded' } : {}) };
        const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
        evidence[kind] = { path: path.join(root, `${kind}.json`), sha256: digest(bytes), bytesBase64: bytes.toString('base64') };
        runnerDocuments.push(bytes);
      }
      if (!replayObservation) observations.push(observationId);
      return { status: 'prepared', jobId, commit: context.runtimeCommit,
        runtimeEvidence: { status: 'failed', observationId, root, evidence } };
    } };
  const request = { action: 'prepare', expectedHead: source.head, expectedFingerprint: fingerprint,
    probePlan: { schemaVersion: 1, api: [], database: [], browser: { status: 'not-executed', reason: 'owner-excluded' } } };
  const first = await prepareForgeCrossLayerCandidate({ ...runArgs, request });
  assert.equal(first.status, 'runtime-evidence-prepared');
  const firstBytes = Object.fromEntries(await Promise.all(['runtime-evidence.json', 'runtime-input-receipt.json', 'current-prompt.md'].map(async name => [name, await readFile(path.join(phaseDirectory, name))])));
  current = { ...preparation, executionId: crypto.randomUUID() };
  await assert.rejects(prepareForgeCrossLayerCandidate({ ...runArgs, request }));
  current = preparation;
  source.workspaceFingerprint = 'c'.repeat(64);
  await assert.rejects(prepareForgeCrossLayerCandidate({ ...runArgs, request }));
  source.workspaceFingerprint = fingerprint;
  assert.equal(runnerCalls, 1);
  request.probePlan.database = [{ id: 'second-read', table: 'fixture_roles', columns: ['id'], where: [], limit: 1, expectedRows: 1 }];
  const second = await prepareForgeCrossLayerCandidate({ ...runArgs, request });
  assert.equal(second.status, 'runtime-evidence-prepared');
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.candidateCommit, first.candidateCommit);
  assert.equal(second.candidateTree, first.candidateTree);
  assert.equal(runnerCalls, 2);
  assert.notEqual(second.runtimeEvidence.observationId, first.runtimeEvidence.observationId);
  const record = await controller.readForgeCrossLayerRuntimeReprobe({ stateFile: context.stateFile, state: stateBefore });
  const saved = path.join(record.archiveDirectory, 'imported-observations', observations[0]);
  for (const [name, bytes] of Object.entries(firstBytes)) assert.deepEqual(await readFile(path.join(saved, name)), bytes);
  for (const [name, bytes] of Object.entries(original)) assert.deepEqual(await readFile(path.join(record.archiveDirectory, name)), bytes);
  const latestBytes = await readFile(path.join(phaseDirectory, 'runtime-evidence.json'));
  await assert.rejects(prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: resumed.preparationBinding,
    preparationExecution: preparation, expectedPreviousManifestSha256: first.imported.manifestSha256 }),
  { code: 'PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH' });
  assert.deepEqual(await readFile(path.join(phaseDirectory, 'runtime-evidence.json')), latestBytes);
  replayObservation = true;
  await assert.rejects(prepareForgeCrossLayerCandidate({ ...runArgs, request }));
  assert.deepEqual(await readFile(path.join(phaseDirectory, 'runtime-evidence.json')), latestBytes);
  assert.deepEqual(await readForgeDeliveryPhaseState(context.stateFile, context.catalog), stateBefore);
  assert.deepEqual(await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`)))), artifactBytes);
  assert.match(resumed.promptText, /forge-release contract/u);
  assert.match(resumed.promptText, /runnerContract\.runtimeProbeCapabilities/u);
  assert.doesNotMatch(resumed.promptText, /计划 JSON 严格四键 schemaVersion:1|method:"GET"/u);
  assert.match(resumed.promptText, /禁止源码修改、checkpoint、integrate 或正式发布/u);
});

test('cross layer runtime rechecks preserve imported observations and bound authentication completion to the same attempt', async (t) => {
  const context = await fixture(t);
  const oldObservation = '11111111-1111-4111-8111-111111111111';
  const fingerprint = 'a'.repeat(64);
  const initialBinding = { stateDigest: context.accepted.state.stateDigest,
    acceptedArtifactDigests: context.accepted.state.acceptedArtifacts,
    baseSourceCommit: context.accepted.state.sourceCommit, workspaceFingerprint: fingerprint };
  const observation = async (state, observationId, apiStatus, roleAuthorizationVerified = false) => {
    const common = { sourceCommit: context.runtimeCommit, taskId: state.taskId,
      stateDigest: state.stateDigest, baseSourceCommit: state.sourceCommit,
      workspaceFingerprint: fingerprint, acceptedPatchSha256: context.cumulativePatchSha256,
      candidateTree: context.manifest.runtimeSource.tree, observationId };
    for (const kind of ['deployment', 'api', 'database', 'browser']) {
      const document = { ...common, status: kind === 'deployment' ? 'success' : kind === 'api' ? apiStatus : kind === 'browser' ? 'not-executed' : 'passed',
        ...(kind === 'deployment' ? { startup: { migrationValidated: true, applicationStarted: true } } : {}),
        ...(kind === 'browser' ? { reason: 'owner-excluded' } : {}),
        ...(kind === 'api' ? { roleAuthorizationVerified } : {}) };
      const file = path.join(context.evidenceDirectory, `${kind}.json`);
      await privateWrite(file, `${JSON.stringify(document)}\n`);
      context.manifest.evidence[kind].sha256 = digest(await readFile(file));
    }
    context.manifest.subject.stateDigest = state.stateDigest;
    await privateWrite(path.join(context.evidenceDirectory, 'manifest.json'), `${JSON.stringify(context.manifest)}\n`);
    context.expectedManifestSha256 = digest(await readFile(path.join(context.evidenceDirectory, 'manifest.json')));
  };
  await observation(context.accepted.state, oldObservation, 'failed');
  await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: initialBinding });
  const args = browserArgs(context, 'rpc:runtime-review', context.accepted.state.sourceCommit);
  const prepared = await prepareForgeDeliveryBrowserPhase(args);
  await browserExecution(context, prepared);
  const execution = JSON.parse(await readFile(path.join(context.temporary, 'execution', 'taskspaces', '.broker',
    'executions', `${context.accepted.state.taskId}.json`), 'utf8')).current;
  const begin = await beginForgeDeliveryBrowserPhase({ ...args, prepared, execution });
  const attemptDirectory = path.join(path.dirname(context.stateFile), 'browser-attempts', execution.executionId);
  const baseline = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', observedSeq: 100, sessionCwd: '/workspace' };
  const modelResponse = '运行观察失败，保留原候选及原失败，不声明阶段通过。';
  const proof = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-proof/v1',
    terminalReason: 'completed', hostReceiptsDerived: false, baselineObservedSeq: 100,
    requestSeq: 101, assistantMessageSeq: 102, terminalSeq: 103, sessionCwd: '/workspace',
    terminalEventDigest: 'b'.repeat(64), modelResponseSha256: digest(modelResponse) };
  for (const [name, value] of Object.entries({ 'execution.json': execution, 'session-baseline.json': baseline,
    'begin.json': begin, '阶段终态采集.json': { modelResponse, sessionProof: proof } })) {
    await privateWrite(path.join(attemptDirectory, name), `${JSON.stringify(value)}\n`);
  }
  const original = Object.fromEntries(await Promise.all(['runtime-evidence.json', 'runtime-input-receipt.json'].map(async name =>
    [name, await readFile(path.join(path.dirname(context.stateFile), name))])));
  const stateBefore = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  const artifactBytes = await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`))));
  const promptText = `当前跨层验收尚未通过，请继续核对这次候选的匿名认证响应，并补充必要的受控运行检查。

保留原作业 b9de518c-e458-408b-904b-1dd170047b18、候选 7a40893fb5ece587cc84fdc598b8dece991eee82、已成功迁移和原 HTTP 401 期望失败证据。请先读取当前实际接口和认证异常处理合同，判断 HTTP 200 的正文究竟是拒绝提示还是业务数据；只能按真实合同提出有正文断言的检查，不能只改 HTTP 期望让它变绿。

只复用本候选及现有测试库补充探测，不重建、不重复迁移，不改业务源码或测试，不删除或改写旧私有回执，不新建其他业务，不进行浏览器或现场外部联调。若现有受控入口不能读取必要响应证据、不能对当前候选执行补充探测，或不能保留失败再导入新观察，请在原对话明确具体阻塞和最小解除条件；不要用结束答复或伪造通过代替。
`;
  const resumeArgs = { ...args, rpcId: 'rpc:runtime-reprobe', workspaceFingerprint: fingerprint, promptText, attemptDirectory };
  assert.equal(typeof controller.prepareForgeCrossLayerRuntimeReprobe, 'function');
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...resumeArgs, workspaceFingerprint: 'c'.repeat(64) }));
  const resumed = await controller.prepareForgeCrossLayerRuntimeReprobe(resumeArgs);
  assert.equal(resumed.crossLayerPreparation, true);
  assert.equal(resumed.phaseAuthority.actionCeiling, 'read-only');
  assert.deepEqual(resumed.phaseAuthority.ownedPaths, []);
  const next = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.deepEqual(next, stateBefore);
  assert.deepEqual(next.acceptedArtifacts, stateBefore.acceptedArtifacts);
  assert.deepEqual(next.history, stateBefore.history);
  assert.equal(next.activeAttempt.attemptId, begin.attempt.attemptId);
  assert.deepEqual(await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`)))), artifactBytes);
  const binding = await controller.readForgeCrossLayerRuntimeReprobe({ stateFile: context.stateFile, state: next });
  assert.equal(binding.previousObservationId, oldObservation);
  assert.equal(binding.candidateCommit, context.runtimeCommit);
  for (const [name, bytes] of Object.entries(original)) {
    assert.deepEqual(await readFile(path.join(path.dirname(context.stateFile), name)), bytes);
    assert.deepEqual(await readFile(path.join(binding.archiveDirectory, name)), bytes);
  }
  const stateBytes = await readFile(context.stateFile);
  await controller.prepareForgeCrossLayerRuntimeReprobe(resumeArgs);
  assert.deepEqual(await readFile(context.stateFile), stateBytes);
  await observation(next, oldObservation, 'passed');
  await assert.rejects(prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: resumed.preparationBinding }));
  await observation(next, '22222222-2222-4222-8222-222222222222', 'passed');
  await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: resumed.preparationBinding });
  const replaced = await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile: context.stateFile, state: next,
    promptText: (await readFile(context.promptFile, 'utf8')).trimEnd() });
  assert.equal(replaced.evidence.api.status, 'passed');
  assert.equal(replaced.evidence.browser.status, 'not-executed');
  assert.equal((await controller.readForgeCrossLayerRuntimeReprobe({ stateFile: context.stateFile, state: next })).status, 'imported');
  assert.deepEqual(await readFile(context.stateFile), stateBytes);
  const formalArgs = browserArgs(context, 'rpc:runtime-new-observation', next.sourceCommit);
  const formalPrepared = await prepareForgeDeliveryBrowserPhase(formalArgs);
  await prepareProtectedExecutionContext({ projectRoot: path.join(context.temporary, 'execution'), projectSlug: PROJECT_SLUG,
    taskMetadata: browserMetadata(context), request: browserRequest(context, formalPrepared.promptText, formalPrepared.rpcId),
    policyPath: POLICY_FILE, trustedPhase: { sourceCommit: formalPrepared.executionSourceCommit,
      caseFamily: formalPrepared.caseFamily, phaseAuthority: formalPrepared.phaseAuthority }, now: Date.now() });
  const freshExecution = JSON.parse(await readFile(path.join(context.temporary, 'execution', 'taskspaces', '.broker',
    'executions', `${next.taskId}.json`), 'utf8')).current;
  const continued = await beginForgeDeliveryBrowserPhase({ ...formalArgs, prepared: formalPrepared, execution: freshExecution });
  assert.equal(continued.attempt.attemptId, begin.attempt.attemptId);
  assert.ok(continued.attempt.executionGeneration > begin.attempt.executionGeneration);
  const finalState = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.deepEqual(finalState.history, stateBefore.history);
  assert.equal(finalState.revision, stateBefore.revision);
  assert.deepEqual(finalState.limits, stateBefore.limits);
  assert.deepEqual(finalState.acceptedArtifacts, stateBefore.acceptedArtifacts);
  assert.equal((await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile: context.stateFile, state: finalState })).evidence.api.status, 'passed');
  const repeatedPrepared = await prepareForgeDeliveryBrowserPhase(formalArgs);
  assert.equal((await beginForgeDeliveryBrowserPhase({ ...formalArgs, prepared: repeatedPrepared, execution: freshExecution })).idempotent, true);
  assert.deepEqual(await readFile(path.join(binding.archiveDirectory, 'runtime-evidence.json')), original['runtime-evidence.json']);

  // The next real feedback follows a completed formal review of the imported anonymous observation.
  const authenticationFeedback = `继续补充当前消防候选的真实运行检查。上一轮正式跨层产物明确保留了角色权限、数据隔离、CRUD和审批流程未执行的缺口；请回到受控运行检查入口处理这些缺口，保留七个已接受阶段和原候选7a40893fb5ece587cc84fdc598b8dece991eee82、作业b9de518c-e458-408b-904b-1dd170047b18及全部旧观察，不重建、不重复迁移，不将已有匿名检查重做一遍。

平台已定位本项目既有的两名普通测试用户，凭据只允许由Runner从项目受保护配置读取，不能要求在对话中粘贴密码、令牌或冒用数据库连接身份。账号属于同项目不等于已授予消防角色。请先依据真实角色/权限合同核对本候选的角色与授权，再通过实际支持的受控入口制定并执行必要的认证和业务行为检查，明确区分允许、拒绝和未覆盖的角色。

本次业务数据操作只限隔离测试候选及测试库，范围仍为原消防需求。业务检查的请求、数据、顺序及断言由你制定；源码、既有阶段产物和生产数据保持。若当前工具没有受保护账号引用、登录会话或必要HTTP操作的能力，请明确实际工具合同或原始拒绝，以及具体阻断的验收项和最小解除条件，不伪造身份、不自行读取秘密、不靠匿名接口或空查询宣布通过。浏览器和外部现场联调仍不在本次范围。
`;
  const { isForgeCrossLayerRuntimeReprobeContinuation } = await import('../docker/harness/forge-protected-acceptance-service.mjs');
  const phase = { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' };
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(authenticationFeedback, phase), true);
  const original64 = "请继续补充当前消防跨层验收的角色权限验证，复用同一个已准备候选，不重新构建或迁移数据库。\n\n当前只有无权限账号被拒绝的证据，还缺具备消防管理角色时的正常访问证据。请通过现有受控运行能力，核实已登记的 manager 测试身份真实登录后的角色，并实际验证消防管理角色应当允许的代表性访问；探测方案和断言由你依据已接受的角色/API合同制定并执行，不要再重复已有 submitter 拒绝检查和资源存在查询。\n\n如果该登记身份没有所需角色，或者受控平台无法准备对应的测试角色，请保留这次真实身份和访问结果，明确指出缺少的身份准备能力；不得把预期拒绝改写成允许路径通过，也不能只复述旧证据后交给“平台后续校验”。本轮完成后仍须继续完整消防CRUD、审批及数据边界验收，未完成项保持未完成。\n\n仍复用 prepared job 7e1e3b49-d2c6-4d9b-a2c5-842bdee492fd 和候选 b49ea0091d59e1312562f0df856d20a167685cd3。只用原Harness受控入口，不直接访问宿主数据库或改写生产用户权限；浏览器继续不执行。\n";
  assert.equal(digest(Buffer.from(original64)), 'bd51054ff3efe1c3c7ea2c0a33b603faf920a88724740a68c91083e4fd614319');
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original64, phase), true);
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original64.replace('角色权限验证', '角色权限检查'), phase), true);
  for (const denied of [original64 + '\n撤回角色权限验证。', original64 + '\n本轮只读分析，不执行任何操作。',
    original64 + '\n另外新增其他业务模块。', original64 + '\n现在立即发布。']) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(denied, phase), false, denied);
  }
  for (const invalidPhase of [{ ...phase, workflowId: 'other' }, { ...phase, phaseIndex: 6 },
    { ...phase, phaseId: 'access-wiring' }, { ...phase, actionCeiling: 'workspace-write' }]) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original64, invalidPhase), false);
  }
  const original70 = "请继续补充当前消防跨层验收，实际完成剩余的增删改查、审批和数据边界运行验证。\n\n刚才的真实角色允许路径已经通过：同一候选下，受控 manager 身份带有组织 1 和 FIRE_MANAGEMENT 角色，消防设施分页接口的业务断言成功。请保留并复用这项结果以及已有的无权限拒绝、资源存在结果，不再次只做同一分页检查或复述旧结论。\n\n本轮请依据已接受的完整消防需求、角色/API合同及实际实现，在现有受控 prepare 能力内制定并执行剩余探测。按实际依赖顺序验证业务数据的新增、读取、修改、删除，以及审批和租户/组织数据范围；用真实接口响应及受控数据库检查验证写入效果、审计字段、逻辑删除和长ID，不把HTTP200或源码阅读当作业务通过。计划、数据、断言和所需业务修复仍由你在Harness中完成。合理业务细节可以自行决定，无需等待我再次确认。\n\n仍复用 prepared job 7e1e3b49-d2c6-4d9b-a2c5-842bdee492fd、候选 b49ea0091d59e1312562f0df856d20a167685cd3，不重新构建或迁移。需要多个受控探测时请连续完成到本轮明确结果，不以“下一步应继续”代替尚可执行的动作；若真实工具能力或业务缺陷阻止继续，保留具体失败和最小解除条件。不要直接访问宿主数据库、修改生产权限或绕开阶段控制。浏览器继续不执行，现场火警/DCS外部联调缺少真实接口时如实标明，不假称已接通。\n";
  assert.equal(digest(Buffer.from(original70)), '4c31e34d1ab4d7eef8f4c8240fd322f106ec0bdf6883f2e8b58d68f42f44e0c8');
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original70, phase), true);
  for (const localLimit of ['不要只重复旧检查', '不要只做已通过的检查', '不得只重复已通过的验证']) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original70.replace('不再次只做同一分页检查', localLimit), phase), true, localLimit);
  }
  for (const denied of [
    original70 + '\n不要进行本轮检查。', original70 + '\n停止本轮验证。', original70 + '\n撤回本轮补充。',
    original70.replace('不再次只做同一分页检查或复述旧结论', '不要只重复旧检查，同时停止本轮验证'),
    original70.replace('不再次只做同一分页检查或复述旧结论', '不要只重复旧检查并停止本轮验证'),
    original70 + '\n本轮只读分析，不执行任何操作。', original70 + '\n现在立即发布。',
    original70 + '\n修改业务源码。', original70 + '\n是否可以继续？', '> ' + original70,
  ]) assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(denied, phase), false, denied);
  for (const invalidPhase of [{ ...phase, workflowId: 'other' }, { ...phase, phaseIndex: 6 },
    { ...phase, phaseId: 'access-wiring' }, { ...phase, actionCeiling: 'workspace-write' }]) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original70, invalidPhase), false);
  }
  const original73 = "请继续当前消防跨层验收，补充原候选的必要运行验证。\n\n刚才正式报告已经保留设施台账新增、详情、修改、再次读取、逻辑删除的5项接口与1项数据库通过证据，以及此前角色允许和拒绝访问的结果。请复用这些有效原件，把精力放在尚未验证的原需求上。\n\n请依据已接受的消防需求和合同，由你制定并执行剩余业务的受控运行探测：三类审批的完整业务流转、备件出入库、检测与维保、检查任务及签字、维修报告，并覆盖必要的租户和组织越界拒绝、相关状态及数据库效果。消防统计、一张图及火警接入的内部处理和未接通时的状态也属于原范围；真实外部火警/DCS现场联调没有条件时必须如实标为未验证，不能用模拟结果宣称已联调。\n\n设施的筛选、导入导出、附件等尚未覆盖能力，以及审批恢复和驳回重提、备件库存约束、三方签字、地图状态变化，应按已接受的原验收标准继续核对；这些都不能被已通过的代表性设施CRUD替代。请根据工具实际能力分批推进，明确每批未覆盖项。\n\n先读取现有运行工具合同，将同一隔离候选能够完成且尚未覆盖的必要检查纳入本轮计划；计划、数据、断言和操作均由你通过现有受控工具生成及执行。保持同一候选及隔离测试环境，保留已通过证据，不重做已通过的设施检查，不重新构建或迁移，不执行浏览器，本轮不发布。审计字段必须根据实际值及规则判断，不能只凭字段存在；权限和业务操作成功必须有相应业务断言和数据效果，不能只看HTTP状态。\n\n若发现真实业务缺口，请保留原始失败并通过现有受控修复路径处理。请按真实结果说明已通过、失败和仍未执行的范围；同轮工具约束导致无法继续时明确指出，不制造失败或通过状态，也不以代表性设施链路替代完整消防需求。\n";
  assert.equal(digest(Buffer.from(original73)), 'b0e7ce707db9b4b7d3ecca56ccc24ea8da839005297e027c3067917389476a24');
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original73, phase), true);
  for (const denied of [
    original73 + '\n先给出运行探测计划，等我确认再执行。',
    original73 + '\n先制定方案；等我确认再执行。',
    original73 + '\n先只分析当前情况。',
    original73 + '\n停止本轮验证。',
  ]) assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(denied, phase), false, denied);
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original73, { ...phase, phaseIndex: 6 }), false);
  const original77 = "请继续当前消防跨层验收，补充当前候选的必要运行验证。\n\n原76正式报告和既有通过证据保留。上一轮库存观察48d707d0-78b2-46fd-84af-c775d2052f2d的spAdd为HTTP200但业务成功断言失败，后续4项API和1项数据库检查未执行，库存仍未通过。原失败回执只有响应摘要，无法从摘要推断错误原因。\n\n平台已补充失败API的受限诊断能力：实际失败观察的prepare结果会在apiFailureDiagnostics中直接显示对应检查的标准业务错误码、脱敏短消息和断言类型差异，内容与保存的API证据一致。请使用现有公开工具，自行生成并执行取得库存实际错误原因所必需的最小探测，保持原业务成功断言，保留原失败；诊断信息可读取不等于业务通过。不要根据编号规则的源码线索猜定根因。\n\n按实际响应区分测试请求或数据问题、业务缺陷及平台缺口。若为请求或数据问题，由你依据当前业务合同修正并复验库存链路；若为业务缺陷，沿原Harness受控业务修复路径处理。恢复后继续原需求中尚未完成的审批流程、库存约束、检测维保及数据权限边界。需要材料或关联文件时使用真实受控能力，不编造ID或绕过必需材料。\n\n保持同一对话和有效上游阶段，复用未受影响的候选、prepared结果和设施台账等已有通过证据。无需业务变更时不要重建或迁移；不要重跑已通过检查，不执行浏览器，本轮不发布。计划、业务代码和测试仍由你自行完成；按新原件明确报告通过、失败、未执行和具体阻塞。\n";
  assert.equal(digest(Buffer.from(original77)), '20ddcd061c26fb65c3bdcad704b9b90c7649d2d2869e37a4506d91f039ea08d2');
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original77, phase), true);
  for (const previousOnly of ['不要重新执行已通过的检查', '禁止重做旧的检查']) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original77.replace('不要重跑已通过检查', previousOnly), phase), true, previousOnly);
  }
  for (const withdrawal of ['不要重跑本轮检查', '不要重跑尚未通过的检查',
    '不要重跑已通过检查并停止本轮验证', '不要重跑本轮检查，保留已通过检查']) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original77.replace('不要重跑已通过检查', withdrawal), phase), false, withdrawal);
  }
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original77 + '\n本轮只读分析，不执行任何操作。', phase), false);
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(original77, { ...phase, phaseIndex: 6 }), false);

  for (const denied of ['是否继续补充当前候选的真实运行检查？', '不要继续补充当前候选的真实运行检查。',
    '只读分析当前候选的真实运行检查。', '继续补充当前候选的真实运行检查。同时立即发布。',
    '继续补充当前候选的真实运行检查。修改业务源码。']) {
    assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(denied, phase), false);
  }
  assert.equal(isForgeCrossLayerRuntimeReprobeContinuation(authenticationFeedback, { ...phase, phaseIndex: 6 }), false);
  const captureCompleted = async (activeExecution, activeBegin) => {
    const target = path.join(path.dirname(context.stateFile), 'browser-attempts', activeExecution.executionId);
    const response = '匿名检查已通过，角色授权仍未验证；原候选和历史观察保持，不声明验收通过。';
    const sessionProof = { ...activeExecution, schemaVersion: 'forge-delivery-phase-browser-session-proof/v1',
      terminalReason: 'completed', hostReceiptsDerived: false, baselineObservedSeq: 200,
      requestSeq: 201, assistantMessageSeq: 202, terminalSeq: 203, sessionCwd: '/workspace',
      terminalEventDigest: 'b'.repeat(64), modelResponseSha256: digest(response) };
    for (const [name, value] of Object.entries({ 'execution.json': activeExecution,
      'session-baseline.json': { ...activeExecution, schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', observedSeq: 200, sessionCwd: '/workspace' },
      'begin.json': activeBegin, '阶段终态采集.json': { modelResponse: response, sessionProof } })) {
      await privateWrite(path.join(target, name), `${JSON.stringify(value)}\n`);
    }
    return target;
  };
  const activeDirectory = await captureCompleted(freshExecution, continued);
  const directory = path.dirname(context.stateFile);
  const retainedNames = ['state.json', 'runtime-reprobe.json', 'runtime-input-receipt.json', 'runtime-evidence.json', 'current-prompt.md'];
  const retained = Object.fromEntries(await Promise.all(retainedNames.map(async name => [name, await readFile(name === 'current-prompt.md' ? context.promptFile : path.join(directory, name))])));
  const authenticationArgs = { ...resumeArgs, rpcId: 'rpc:runtime-authentication', promptText: authenticationFeedback, attemptDirectory: activeDirectory };
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...authenticationArgs, workspaceFingerprint: 'c'.repeat(64) }));
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...authenticationArgs, attemptDirectory }));
  const authenticationPrepared = await controller.prepareForgeCrossLayerRuntimeReprobe(authenticationArgs);
  assert.equal(authenticationPrepared.phaseAuthority.actionCeiling, 'read-only');
  assert.deepEqual(authenticationPrepared.phaseAuthority.ownedPaths, []);
  assert.deepEqual(await readForgeDeliveryPhaseState(context.stateFile, context.catalog), finalState);
  const authenticationRecord = await controller.readForgeCrossLayerRuntimeReprobe({ stateFile: context.stateFile, state: finalState });
  assert.equal(authenticationRecord.status, 'pending');
  assert.equal(authenticationRecord.previousObservationId, replaced.evidence.deployment.observationId);
  assert.equal(authenticationRecord.previousStateDigest, replaced.evidence.deployment.stateDigest);
  assert.equal(authenticationRecord.candidateCommit, binding.candidateCommit);
  assert.equal(authenticationRecord.candidateTree, binding.candidateTree);
  for (const name of retainedNames) {
    assert.deepEqual(await readFile(path.join(authenticationRecord.archiveDirectory, name)), retained[name]);
    assert.equal(authenticationRecord.archivedSha256[name], digest(retained[name]));
  }
  const priorRecordPath = path.join(authenticationRecord.archiveDirectory, 'runtime-reprobe.json');
  await privateWrite(priorRecordPath, `${retained['runtime-reprobe.json'].toString('utf8')} `);
  await assert.rejects(controller.readForgeCrossLayerRuntimeReprobe({ stateFile: context.stateFile, state: finalState }));
  await privateWrite(priorRecordPath, retained['runtime-reprobe.json']);
  await controller.prepareForgeCrossLayerRuntimeReprobe(authenticationArgs);
  await observation(finalState, '33333333-3333-4333-8333-333333333333', 'passed', true);
  await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: authenticationPrepared.preparationBinding });
  const authenticatedArgs = browserArgs(context, 'rpc:runtime-authenticated-review', finalState.sourceCommit);
  const authenticatedPrepared = await prepareForgeDeliveryBrowserPhase(authenticatedArgs);
  await prepareProtectedExecutionContext({ projectRoot: path.join(context.temporary, 'execution'), projectSlug: PROJECT_SLUG,
    taskMetadata: browserMetadata(context), request: browserRequest(context, authenticatedPrepared.promptText, authenticatedPrepared.rpcId),
    policyPath: POLICY_FILE, trustedPhase: { sourceCommit: authenticatedPrepared.executionSourceCommit,
      caseFamily: authenticatedPrepared.caseFamily, phaseAuthority: authenticatedPrepared.phaseAuthority }, now: Date.now() });
  const authenticatedExecution = JSON.parse(await readFile(path.join(context.temporary, 'execution', 'taskspaces', '.broker',
    'executions', `${finalState.taskId}.json`), 'utf8')).current;
  const authenticatedBegin = await beginForgeDeliveryBrowserPhase({ ...authenticatedArgs, prepared: authenticatedPrepared, execution: authenticatedExecution });
  const authenticatedState = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.equal(authenticatedBegin.attempt.attemptId, begin.attempt.attemptId);
  assert.ok(authenticatedBegin.attempt.executionGeneration > continued.attempt.executionGeneration);
  for (const key of ['history', 'revision', 'limits', 'acceptedArtifacts']) assert.deepEqual(authenticatedState[key], stateBefore[key]);
  const authenticatedBundle = await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile: context.stateFile, state: authenticatedState });
  assert.equal(authenticatedBundle.evidence.api.roleAuthorizationVerified, true);
  assert.equal(authenticatedState.status, 'active');
  for (const name of retainedNames) assert.deepEqual(await readFile(path.join(authenticationRecord.archiveDirectory, name)), retained[name]);
  assert.deepEqual(await readFile(path.join(binding.archiveDirectory, 'runtime-evidence.json')), original['runtime-evidence.json']);
  const authenticatedDirectory = await captureCompleted(authenticatedExecution, authenticatedBegin);
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...authenticationArgs, rpcId: 'rpc:no-runtime-gap', attemptDirectory: authenticatedDirectory }));
});

test('prepared runtime evidence drives A8 through preflight and finalize to an eight-phase completed workflow', async (t) => {
  const context = await fixture(t);
  const projectRoot = path.join(context.temporary, 'execution');
  const phaseDirectory = path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases', context.accepted.state.taskId, 'phase-control');
  const originalArtifacts = context.artifactsDirectory;
  context.stateFile = path.join(phaseDirectory, 'state.json');
  context.artifactsDirectory = path.join(phaseDirectory, 'artifacts');
  context.originalRequestFile = path.join(phaseDirectory, 'original-request.md');
  context.promptFile = path.join(phaseDirectory, 'current-prompt.md');
  await writeForgeDeliveryPhaseState(context.stateFile, context.accepted.state, context.catalog);
  for (const artifact of context.accepted.artifacts) await privateWrite(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`),
    await readFile(path.join(originalArtifacts, `${artifact.artifactKind}.json`)));
  await privateWrite(context.originalRequestFile, '验证已经部署的完整业务功能。\n');
  const fingerprint = 'a'.repeat(64);
  const prepared = await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: { stateDigest: context.accepted.state.stateDigest,
      acceptedArtifactDigests: context.accepted.state.acceptedArtifacts,
      baseSourceCommit: context.accepted.state.sourceCommit, workspaceFingerprint: fingerprint } });
  assert.equal(prepared.manifestSha256, context.expectedManifestSha256);
  assert.equal(prepared.sourceStateDigest, context.accepted.state.stateDigest);
  const idleBundle = await readPreparedForgeCrossLayerRuntimeEvidence({
    stateFile: context.stateFile,
    state: context.accepted.state,
    promptText: await readFile(context.promptFile, 'utf8'),
  });
  assert.equal(idleBundle.runtimeSource.commit, context.runtimeCommit);

  const attempt = await beginAndWriteAttempt(context);
  const retainedPaths = context.accepted.artifacts.flatMap(artifact => artifact.changedPaths).sort();
  await writeFile(attempt.files.phaseChangedPathsFile, `${JSON.stringify(retainedPaths)}\n`);
  await writeFile(attempt.files.phasePatchFile, context.acceptedPatch);
  const originalObservation = await Promise.all([attempt.files.phaseChangedPathsFile, attempt.files.phasePatchFile].map(file => readFile(file)));
  await writeFile(attempt.files.cumulativePatchFile, Buffer.concat([context.acceptedPatch, Buffer.from('unaccepted source change\n')]));
  await assert.rejects(preflightForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE,
    stateFile: context.stateFile, artifactsDirectory: context.artifactsDirectory, ...attempt.files,
  }), { code: 'PHASE_CONTROLLER_ACCEPTED_PATH_REWRITE' });
  await writeFile(attempt.files.cumulativePatchFile, context.acceptedPatch);
  const preflight = await preflightForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    responseFile: attempt.files.responseFile,
    allChangedPathsFile: attempt.files.allChangedPathsFile,
    phaseChangedPathsFile: attempt.files.phaseChangedPathsFile,
    phasePatchFile: attempt.files.phasePatchFile,
    cumulativePatchFile: attempt.files.cumulativePatchFile,
    receiptFile: attempt.files.receiptFile,
  });
  assert.equal(preflight.phaseId, 'cross-layer-acceptance');
  assert.equal(preflight.safeForOperatorHostVerification, true);
  assert.deepEqual(preflight.changedPaths, []);
  assert.equal(preflight.phasePatchDigest, context.cumulativePatchSha256);
  const stateBeforeAcceptance = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  const allObservedPaths = JSON.parse(await readFile(attempt.files.allChangedPathsFile, 'utf8'));
  const inspected = await inspectForgeCrossLayerHostVerificationReuse({
    state: stateBeforeAcceptance, catalog: context.catalog, stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    response: await readFile(attempt.files.responseFile, 'utf8'),
    allChangedPaths: [...allObservedPaths].sort().reverse(),
    phaseChangedPaths: [...retainedPaths].reverse(),
    phasePatchBytes: context.acceptedPatch, cumulativePatchBytes: context.acceptedPatch,
  });
  assert.equal(inspected.candidateArtifactDigest, preflight.candidateArtifactDigest);
  assert.equal(inspected.hostVerificationReuse.artifactDigest, context.accepted.artifacts.at(-1).artifactDigest);
  await writeFile(attempt.files.hostReceiptsFile, '[]\n');
  const result = await finalizeForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    responseFile: attempt.files.responseFile,
    allChangedPathsFile: attempt.files.allChangedPathsFile,
    phaseChangedPathsFile: attempt.files.phaseChangedPathsFile,
    phasePatchFile: attempt.files.phasePatchFile,
    cumulativePatchFile: attempt.files.cumulativePatchFile,
    hostReceiptsFile: attempt.files.hostReceiptsFile,
    outputDirectory: attempt.directory,
    nextPromptFile: context.promptFile,
  });
  assert.equal(result.acceptedPhaseId, 'cross-layer-acceptance');
  assert.equal(result.workflowStatus, 'completed');
  assert.equal(result.nextPhaseId, null);
  const completed = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.history.length, 8);
  assert.equal(Object.keys(completed.acceptedArtifacts).length, 8);
  assert.equal(completed.acceptedArtifacts['cross-layer-acceptance'], result.phaseArtifactDigest);
  const reused = completed.history.at(-1);
  assert.equal(reused.reasonCode, 'CROSS_LAYER_UNCHANGED_SOURCE_HOST_REUSED');
  assert.deepEqual(reused.hostReceiptDigests, []);
  assert.equal(reused.hostVerificationReuse.artifactDigest, context.accepted.artifacts.at(-1).artifactDigest);
  const artifact = JSON.parse(await readFile(path.join(context.artifactsDirectory, 'cross-layer-acceptance.json'), 'utf8'));
  assert.deepEqual(artifact.changedPaths, []);
  assert.equal(artifact.patchDigest, context.cumulativePatchSha256);
  assert.throws(() => completeForgeDeliveryPhase({ state: stateBeforeAcceptance, catalog: context.catalog,
    decision: 'accepted', artifact, hostReceipts: [], reasonCode: reused.reasonCode,
  }), { code: 'PHASE_HOST_RECEIPT_INVALID' });
  const forged = structuredClone(completed);
  const forgedReceipt = forged.history.at(-1);
  forgedReceipt.hostVerificationReuse.sourceFingerprint = digest('different cumulative source');
  const reseal = (value, key) => {
    const { [key]: previous, ...body } = value;
    value[key] = digest(canonicalStringify(body));
  };
  reseal(forgedReceipt.hostVerificationReuse, 'artifactDigest');
  reseal(forgedReceipt, 'receiptDigest');
  reseal(forged, 'stateDigest');
  assert.throws(() => validateForgeDeliveryPhaseState(forged, context.catalog), { code: 'PHASE_HOST_RECEIPT_INVALID' });
  const missingProof = structuredClone(completed);
  delete missingProof.history.at(-1).hostVerificationReuse;
  assert.throws(() => validateForgeDeliveryPhaseState(missingProof, context.catalog));
  assert.deepEqual(await Promise.all([attempt.files.phaseChangedPathsFile, attempt.files.phasePatchFile].map(file => readFile(file))), originalObservation);
  const input = await readFile(path.join(attempt.directory, 'work-package', '00-input.md'), 'utf8');
  assert.match(input, /\[runtime-evidence\.json\]\(\.\.\/runtime-evidence\.json\)/u);
  assert.match(input, new RegExp(context.expectedManifestSha256, 'u'));
  assert.match(input, new RegExp(context.runtimeCommit, 'u'));
  const verification = await readFile(path.join(attempt.directory, 'work-package', '03-verification.md'), 'utf8');
  assert.match(verification, /reused-upstream/u);
  assert.match(verification, /本轮默认 governance、changed-safe、full-regression 均未新执行/u);
  assert.match(verification, /本轮新增 Host 回执为 0/u);

  const retainedFiles = [context.stateFile, context.promptFile,
    ...['runtime-evidence.json', 'runtime-input-receipt.json'].map(name => path.join(phaseDirectory, name)),
    ...Object.keys(completed.acceptedArtifacts).map(kind => path.join(context.artifactsDirectory, `${kind}.json`))];
  const retainedBytes = await Promise.all(retainedFiles.map(file => readFile(file)));
  const acceptedRuntimeCommit = context.runtimeCommit;
  await writeFile(path.join(context.repository, 'app.txt'), 'published repair after phase completion\n');
  await git(context.repository, ['add', 'app.txt']);
  await git(context.repository, ['commit', '--quiet', '-m', 'fixture published repair']);
  context.runtimeCommit = await git(context.repository, ['rev-parse', 'HEAD']);
  const publishedTree = await git(context.repository, ['rev-parse', 'HEAD^{tree}']);
  const publishedFingerprint = 'b'.repeat(64);
  assert.notEqual(context.runtimeCommit, acceptedRuntimeCommit);
  await assert.rejects(controller.readForgeCompletedApiContract({ ...context, catalogFile: CATALOG_FILE,
    workspace: context.repository, sourceCommit: context.runtimeCommit, workspaceFingerprint: publishedFingerprint,
    taskId: completed.taskId, sessionId: completed.sessionId,
  }), { code: 'PHASE_CONTROLLER_COMPLETED_SOURCE_MISMATCH' });
  const workspaceBytes = await readFile(path.join(context.repository, 'app.txt'));
  const postrelease = await controller.prepareForgeCrossLayerPreparation({ ...context, catalogFile: CATALOG_FILE,
    workspace: context.repository, sourceCommit: context.runtimeCommit, workspaceFingerprint: publishedFingerprint,
    taskId: completed.taskId, sessionId: completed.sessionId, rpcId: 'rpc:published-runtime', promptText: '补验已发布候选。' });
  assert.equal(postrelease.preparationBinding.workspaceFingerprint, publishedFingerprint);
  assert.equal(postrelease.preparationBinding.baseSourceCommit, context.runtimeCommit);
  await prepareProtectedExecutionContext({ projectRoot, projectSlug: PROJECT_SLUG, taskMetadata: browserMetadata(context),
    request: browserRequest(context, postrelease.promptText, postrelease.rpcId), policyPath: POLICY_FILE,
    trustedPhase: { sourceCommit: postrelease.executionSourceCommit, caseFamily: postrelease.caseFamily,
      phaseAuthority: postrelease.phaseAuthority, crossLayerPreparation: true, preparationBinding: postrelease.preparationBinding }, now: Date.now() });
  const execution = JSON.parse(await readFile(path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${completed.taskId}.json`), 'utf8')).current;
  const task = { metadata: browserMetadata(context), workspace: context.repository };
  const preparedJobId = crypto.randomUUID(), releaseJobId = crypto.randomUUID();
  const provenance = { source: 'taskspace', taskId: completed.taskId, actorId: task.metadata.actorId,
    conversationId: execution.conversationId, candidateCommit: context.runtimeCommit };
  const diagnosis = { active: false, activeJobId: null,
    lastJob: { status: 'success', stage: 'complete', jobId: releaseJobId, preparedJobId,
      commit: context.runtimeCommit, services: ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'], provenance,
      result: { commit: context.runtimeCommit, services: ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'], provenance } },
    testDatabaseRecovery: { status: 'healthy', lastAttempt: { jobId: preparedJobId, commit: context.runtimeCommit,
      status: 'success', published: true, releaseJobId } } };
  let calls = 0;
  const { prepareForgeCrossLayerCandidate } = await import('../docker/harness/forge-cross-layer-preparation.mjs');
  const args = { projectRoot, task, context: execution, catalogFile: CATALOG_FILE,
    inspectSource: async () => ({ head: context.runtimeCommit, workspaceFingerprint: publishedFingerprint }),
    readContext: async () => execution, readReleaseStatus: async () => diagnosis,
    publishCandidate: async () => assert.fail('published runtime preparation must not publish or create a Git candidate'),
    releaseClient: async request => {
      calls++;
      assert.equal(request.preparedJobId, preparedJobId);
      assert.equal(request.provenance.candidateCommit, context.runtimeCommit);
      assert.equal(request.runtimePreparation.baseSourceCommit, completed.sourceCommit);
      assert.equal(request.runtimePreparation.stateDigest, completed.stateDigest);
      assert.equal(request.runtimePreparation.acceptedPatchSha256, context.cumulativePatchSha256);
      assert.equal(request.runtimePreparation.recheck, undefined);
      const observationId = crypto.randomUUID();
      const root = path.join(projectRoot, 'ops', 'release-candidates', preparedJobId, 'runtime-evidence', observationId);
      const { probePlan, ...binding } = request.runtimePreparation;
      const evidence = Object.fromEntries(['deployment', 'api', 'database', 'browser'].map(kind => {
        const bytes = Buffer.from(`${JSON.stringify({ sourceCommit: context.runtimeCommit, ...binding, observationId,
          probePlanSha256: digest(Buffer.from(JSON.stringify(probePlan))),
          status: kind === 'deployment' ? 'success' : kind === 'browser' ? 'not-executed' : 'passed' })}\n`);
        return [kind, { path: path.join(root, `${kind}.json`), sha256: digest(bytes), bytesBase64: bytes.toString('base64') }];
      }));
      return { status: 'prepared', jobId: preparedJobId, commit: context.runtimeCommit,
        runtimeEvidence: { status: 'passed', observationId, root, evidence } };
    },
    request: { action: 'prepare', expectedHead: context.runtimeCommit, expectedFingerprint: publishedFingerprint,
      probePlan: { schemaVersion: 1, api: [], database: [], browser: { status: 'not-executed', reason: 'owner-excluded' } } },
  };
  const observed = await prepareForgeCrossLayerCandidate(args);
  assert.equal(observed.status, 'runtime-evidence-prepared');
  assert.equal(observed.completedWorkflowPreserved, true);
  assert.equal(observed.candidateCommit, context.runtimeCommit);
  assert.equal(observed.candidateTree, publishedTree);
  assert.equal(observed.jobId, preparedJobId);
  assert.equal(observed.releaseApplied, false);
  assert.equal(observed.sourceModified, false);
  assert.equal(calls, 1);
  diagnosis.testDatabaseRecovery.lastAttempt.published = false;
  await assert.rejects(prepareForgeCrossLayerCandidate(args), { code: 'CROSS_LAYER_PREPARATION_DENIED' });
  assert.equal(calls, 1);
  assert.deepEqual(await Promise.all(retainedFiles.map(file => readFile(file))), retainedBytes);
  assert.deepEqual(await readFile(path.join(context.repository, 'app.txt')), workspaceBytes);
  assert.equal(await git(context.repository, ['rev-parse', 'HEAD']), context.runtimeCommit);
  const preparationPaths = await readdir(path.join(phaseDirectory, 'runtime-observations'), { recursive: true });
  assert.equal(preparationPaths.some(file => String(file).split(/[\\/]/u).includes('source.git')), false);
});

test('missing runtime evidence is rejected before an A8 attempt can begin', async (t) => {
  const context = await fixture(t);
  const before = await readFile(context.stateFile);
  await assert.rejects(readPreparedForgeCrossLayerRuntimeEvidence({
    stateFile: context.stateFile,
    state: context.accepted.state,
    promptText: await readFile(context.promptFile, 'utf8'),
  }), { code: 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED' });
  assert.deepEqual(await readFile(context.stateFile), before);
  const state = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.equal(state.activeAttempt, null);
});

test('preflight rejects a response that cites another runtime evidence digest', async (t) => {
  const context = await fixture(t);
  await prepare(context);
  const attempt = await beginAndWriteAttempt(context, 'f'.repeat(64));
  await assert.rejects(preflightForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    responseFile: attempt.files.responseFile,
    allChangedPathsFile: attempt.files.allChangedPathsFile,
    phaseChangedPathsFile: attempt.files.phaseChangedPathsFile,
    phasePatchFile: attempt.files.phasePatchFile,
    cumulativePatchFile: attempt.files.cumulativePatchFile,
    receiptFile: attempt.files.receiptFile,
  }), { code: 'PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH' });
  const state = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.equal(state.status, 'active');
  assert.equal(state.history.length, 7);
});

test('preflight rejects a prepared runtime evidence sidecar changed after A8 begins', async (t) => {
  const context = await fixture(t);
  await prepare(context);
  const attempt = await beginAndWriteAttempt(context);
  const sidecar = path.join(path.dirname(context.stateFile), 'runtime-evidence.json');
  await writeFile(sidecar, `${await readFile(sidecar, 'utf8')}\n`);
  await assert.rejects(preflightForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    responseFile: attempt.files.responseFile,
    allChangedPathsFile: attempt.files.allChangedPathsFile,
    phaseChangedPathsFile: attempt.files.phaseChangedPathsFile,
    phasePatchFile: attempt.files.phasePatchFile,
    cumulativePatchFile: attempt.files.cumulativePatchFile,
    receiptFile: attempt.files.receiptFile,
  }), { code: 'PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH' });
  const state = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  assert.equal(state.status, 'active');
  assert.equal(state.history.length, 7);
});

test('browser A8 uses the reviewed runtime commit and replays the exact active RPC', async (t) => {
  const context = await fixture(t);
  await prepare(context);
  const rpcId = 'rpc:browser:cross-layer:8';

  await assert.rejects(
    prepareForgeDeliveryBrowserPhase(browserArgs(context, rpcId, context.accepted.state.sourceCommit)),
    (error) => error.code === 'PHASE_CONTROLLER_BROWSER_IDENTITY_MISMATCH',
  );
  const prepared = await prepareForgeDeliveryBrowserPhase(browserArgs(context, rpcId));
  assert.equal(prepared.sourceCommit, context.accepted.state.sourceCommit);
  assert.equal(prepared.executionSourceCommit, context.runtimeCommit);
  const execution = await browserExecution(context, prepared);
  const begun = await beginForgeDeliveryBrowserPhase({
    ...browserArgs(context, rpcId),
    prepared,
    execution,
  });
  const stateAfterBegin = await readFile(context.stateFile);

  const replayPreparation = await prepareForgeDeliveryBrowserPhase(browserArgs(context, rpcId));
  assert.equal(replayPreparation.idempotent, true);
  assert.equal(replayPreparation.activeExecutionGeneration, execution.generation);
  const replay = await beginForgeDeliveryBrowserPhase({
    ...browserArgs(context, rpcId),
    prepared: replayPreparation,
    execution,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.attempt.attemptId, begun.attempt.attemptId);
  assert.deepEqual(await readFile(context.stateFile), stateAfterBegin);
});

test('browser A8 rejects an internally coherent sidecar bound to another valid idle state', async (t) => {
  const context = await fixture(t);
  await prepare(context);
  const rpcId = 'rpc:browser:cross-layer:stale-idle';
  const prepared = await prepareForgeDeliveryBrowserPhase(browserArgs(context, rpcId));
  const execution = await browserExecution(context, prepared);
  await beginForgeDeliveryBrowserPhase({
    ...browserArgs(context, rpcId),
    prepared,
    execution,
  });

  const staleIdle = structuredClone(context.accepted.state);
  staleIdle.updatedAt = '2026-09-13T01:00:15.000Z';
  const { stateDigest: _ignored, ...unsignedState } = staleIdle;
  staleIdle.stateDigest = digest(canonicalStringify(unsignedState));
  assert.doesNotThrow(() => validateForgeDeliveryPhaseState(staleIdle, context.catalog));
  assert.notEqual(staleIdle.stateDigest, context.accepted.state.stateDigest);
  assert.deepEqual(staleIdle.acceptedArtifacts, context.accepted.state.acceptedArtifacts);

  const sidecarFile = path.join(path.dirname(context.stateFile), 'runtime-evidence.json');
  const receiptFile = path.join(path.dirname(context.stateFile), 'runtime-input-receipt.json');
  const sidecar = JSON.parse(await readFile(sidecarFile, 'utf8'));
  sidecar.subject.stateDigest = staleIdle.stateDigest;
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`);
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  receipt.sourceStateDigest = staleIdle.stateDigest;
  receipt.bundleSha256 = digest(sidecarBytes);
  await writeFile(sidecarFile, sidecarBytes);
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

  await assert.rejects(
    prepareForgeDeliveryBrowserPhase(browserArgs(context, rpcId)),
    (error) => error.code === 'PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH',
  );
});

test('completed pending preparation resumes a new RPC without replacing its original record or formal attempt', async (t) => {
  const context = await fixture(t);
  const { prepareForgeCrossLayerCandidate } = await import('../docker/harness/forge-cross-layer-preparation.mjs');
  const projectRoot = path.join(context.temporary, 'execution');
  const phaseDirectory = path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases', context.accepted.state.taskId, 'phase-control');
  const oldArtifacts = context.artifactsDirectory;
  context.stateFile = path.join(phaseDirectory, 'state.json');
  context.artifactsDirectory = path.join(phaseDirectory, 'artifacts');
  context.originalRequestFile = path.join(phaseDirectory, 'original-request.md');
  context.promptFile = path.join(phaseDirectory, 'current-prompt.md');
  await writeForgeDeliveryPhaseState(context.stateFile, context.accepted.state, context.catalog);
  for (const artifact of context.accepted.artifacts) await privateWrite(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`), await readFile(path.join(oldArtifacts, `${artifact.artifactKind}.json`)));
  await privateWrite(context.originalRequestFile, '验证已经部署的完整业务功能。\n');
  await privateWrite(context.promptFile, '尚未准备运行证据。\n');
  await git(context.repository, ['commit', '--amend', '--quiet', '-m', `Accepted cross-layer candidate ${context.cumulativePatchSha256}`]);
  context.runtimeCommit = await git(context.repository, ['rev-parse', 'HEAD']);
  context.manifest.runtimeSource.commit = context.runtimeCommit;
  const retainedRoot = path.join(phaseDirectory, 'runtime-preparations', crypto.randomUUID());
  await mkdir(retainedRoot, { recursive: true, mode: 0o700 });
  await git(context.repository, ['clone', '--bare', '--quiet', context.repository, path.join(retainedRoot, 'source.git')]);
  await privateWrite(path.join(retainedRoot, 'evidence', 'accepted.patch'), context.acceptedPatch);
  await git(context.repository, ['reset', '--mixed', '--quiet', context.accepted.state.sourceCommit]);
  const oldObservation = '11111111-1111-4111-8111-111111111111';
  const fingerprint = 'a'.repeat(64);
  const initialBinding = { stateDigest: context.accepted.state.stateDigest,
    acceptedArtifactDigests: context.accepted.state.acceptedArtifacts,
    baseSourceCommit: context.accepted.state.sourceCommit, workspaceFingerprint: fingerprint };
  const observation = async (state, observationId, apiStatus, roleAuthorizationVerified = false) => {
    const common = { sourceCommit: context.runtimeCommit, taskId: state.taskId,
      stateDigest: state.stateDigest, baseSourceCommit: state.sourceCommit,
      workspaceFingerprint: fingerprint, acceptedPatchSha256: context.cumulativePatchSha256,
      candidateTree: context.manifest.runtimeSource.tree, observationId };
    for (const kind of ['deployment', 'api', 'database', 'browser']) {
      const document = { ...common, status: kind === 'deployment' ? 'success' : kind === 'api' ? apiStatus : kind === 'browser' ? 'not-executed' : 'passed',
        ...(kind === 'deployment' ? { startup: { migrationValidated: true, applicationStarted: true } } : {}),
        ...(kind === 'browser' ? { reason: 'owner-excluded' } : {}),
        ...(kind === 'api' ? { roleAuthorizationVerified } : {}) };
      const file = path.join(context.evidenceDirectory, `${kind}.json`);
      await privateWrite(file, `${JSON.stringify(document)}\n`);
      context.manifest.evidence[kind].sha256 = digest(await readFile(file));
    }
    context.manifest.subject.stateDigest = state.stateDigest;
    await privateWrite(path.join(context.evidenceDirectory, 'manifest.json'), `${JSON.stringify(context.manifest)}\n`);
    context.expectedManifestSha256 = digest(await readFile(path.join(context.evidenceDirectory, 'manifest.json')));
  };
  await observation(context.accepted.state, oldObservation, 'failed');
  await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: initialBinding });
  const args = browserArgs(context, 'rpc:runtime-review', context.accepted.state.sourceCommit);
  const prepared = await prepareForgeDeliveryBrowserPhase(args);
  await browserExecution(context, prepared);
  const execution = JSON.parse(await readFile(path.join(context.temporary, 'execution', 'taskspaces', '.broker',
    'executions', `${context.accepted.state.taskId}.json`), 'utf8')).current;
  const begin = await beginForgeDeliveryBrowserPhase({ ...args, prepared, execution });
  const attemptDirectory = path.join(path.dirname(context.stateFile), 'browser-attempts', execution.executionId);
  const baseline = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', observedSeq: 100, sessionCwd: '/workspace' };
  const modelResponse = '运行观察失败，保留原候选及原失败，不声明阶段通过。';
  const proof = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-proof/v1',
    terminalReason: 'completed', hostReceiptsDerived: false, baselineObservedSeq: 100,
    requestSeq: 101, assistantMessageSeq: 102, terminalSeq: 103, sessionCwd: '/workspace',
    terminalEventDigest: 'b'.repeat(64), modelResponseSha256: digest(modelResponse) };
  for (const [name, value] of Object.entries({ 'execution.json': execution, 'session-baseline.json': baseline,
    'begin.json': begin, '阶段终态采集.json': { modelResponse, sessionProof: proof } })) {
    await privateWrite(path.join(attemptDirectory, name), `${JSON.stringify(value)}\n`);
  }
  const original = Object.fromEntries(await Promise.all(['runtime-evidence.json', 'runtime-input-receipt.json'].map(async name =>
    [name, await readFile(path.join(path.dirname(context.stateFile), name))])));
  const stateBefore = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  const artifactBytes = await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`))));
  const promptText = `当前跨层验收尚未通过，请继续核对这次候选的匿名认证响应，并补充必要的受控运行检查。

保留原作业 b9de518c-e458-408b-904b-1dd170047b18、候选 7a40893fb5ece587cc84fdc598b8dece991eee82、已成功迁移和原 HTTP 401 期望失败证据。请先读取当前实际接口和认证异常处理合同，判断 HTTP 200 的正文究竟是拒绝提示还是业务数据；只能按真实合同提出有正文断言的检查，不能只改 HTTP 期望让它变绿。

只复用本候选及现有测试库补充探测，不重建、不重复迁移，不改业务源码或测试，不删除或改写旧私有回执，不新建其他业务，不进行浏览器或现场外部联调。若现有受控入口不能读取必要响应证据、不能对当前候选执行补充探测，或不能保留失败再导入新观察，请在原对话明确具体阻塞和最小解除条件；不要用结束答复或伪造通过代替。
`;
  const resumeArgs = { ...args, rpcId: 'rpc:runtime-reprobe', workspaceFingerprint: fingerprint, promptText, attemptDirectory };
  let resumed = await controller.prepareForgeCrossLayerRuntimeReprobe(resumeArgs);
  await prepareProtectedExecutionContext({ projectRoot, projectSlug: PROJECT_SLUG, taskMetadata: browserMetadata(context),
    request: browserRequest(context, resumed.promptText, resumed.rpcId), policyPath: POLICY_FILE,
    trustedPhase: { sourceCommit: resumed.executionSourceCommit, caseFamily: resumed.caseFamily,
      phaseAuthority: resumed.phaseAuthority, crossLayerPreparation: true, preparationBinding: resumed.preparationBinding }, now: Date.now() });
  let preparation = JSON.parse(await readFile(path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${stateBefore.taskId}.json`), 'utf8')).current;
  const recordFile = path.join(phaseDirectory, 'runtime-reprobe.json');
  const pendingBytes = await readFile(recordFile);
  const pending = JSON.parse(pendingBytes);
  const archiveBytes = Object.fromEntries(await Promise.all(Object.keys(pending.archivedSha256).map(async name =>
    [name, await readFile(path.join(pending.archiveDirectory, name))])));
  const preparationTerminal = { executionId: preparation.executionId, generation: preparation.generation,
    dshSessionId: preparation.dshSessionId, rpcId: preparation.rpcId, textDigest: preparation.textDigest,
    requestSeq: 201, terminalSeq: 210, turn: 2, terminalReason: 'completed', sessionRunning: false,
    terminalEventDigest: 'd'.repeat(64) };
  const feedback = { ...resumeArgs, rpcId: 'rpc:corrected-runtime-plan',
    promptText: '继续补充当前候选的真实运行检查。按实际合同纠正被拒绝的计划，保留原候选、观察和已接受阶段。',
    preparationExecution: preparation, preparationTerminal };
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...resumeArgs, promptText: `${promptText} changed` }),
    { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  for (const invalid of [
    { preparationTerminal: undefined },
    { preparationTerminal: { ...preparationTerminal, sessionRunning: true } },
    { preparationTerminal: { ...preparationTerminal, terminalReason: 'aborted' } },
    { preparationTerminal: { ...preparationTerminal, rpcId: 'rpc:unrelated' } },
    { preparationTerminal: { ...preparationTerminal, generation: execution.generation } },
    { preparationExecution: { ...preparation, actorUsername: 'another-user' } },
    { workspaceFingerprint: 'e'.repeat(64) },
    { sourceCommit: 'f'.repeat(40) },
    { sessionId: 'session:unrelated' },
  ]) await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...feedback, ...invalid }));
  resumed = await controller.prepareForgeCrossLayerRuntimeReprobe(feedback);
  assert.equal(resumed.rpcId, feedback.rpcId);
  assert.equal(resumed.crossLayerPreparation, true);
  assert.deepEqual(resumed.preparationBinding, preparation.preparationBinding);
  assert.deepEqual(await readFile(recordFile), pendingBytes);
  assert.deepEqual(await readForgeDeliveryPhaseState(context.stateFile, context.catalog), stateBefore);
  for (const [name, bytes] of Object.entries(archiveBytes)) assert.deepEqual(await readFile(path.join(pending.archiveDirectory, name)), bytes);
  await prepareProtectedExecutionContext({ projectRoot, projectSlug: PROJECT_SLUG, taskMetadata: browserMetadata(context),
    request: browserRequest(context, resumed.promptText, resumed.rpcId), policyPath: POLICY_FILE,
    trustedPhase: { sourceCommit: resumed.executionSourceCommit, caseFamily: resumed.caseFamily,
      phaseAuthority: resumed.phaseAuthority, crossLayerPreparation: true, preparationBinding: resumed.preparationBinding }, now: Date.now() });
  preparation = JSON.parse(await readFile(path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${stateBefore.taskId}.json`), 'utf8')).current;
  assert.notEqual(preparation.rpcId, pending.rpcId);
  assert.equal(preparation.workspaceFingerprint, null);
  const task = { metadata: browserMetadata(context), workspace: context.repository };
  const jobId = crypto.randomUUID();
  let runnerCalls = 0, replayObservation = false;
  const observations = [];
  const runnerDocuments = [];
  let current = preparation;
  const source = { head: stateBefore.sourceCommit, workspaceFingerprint: fingerprint };
  const runArgs = { projectRoot, task, context: preparation, catalogFile: CATALOG_FILE,
    inspectSource: async () => source, readContext: async () => current,
    publishCandidate: async () => assert.fail('the accepted candidate must not be rebuilt or published'),
    readReleaseStatus: async () => ({ active: false, activeJobId: null,
      lastJob: { status: 'prepared', jobId, commit: context.runtimeCommit, services: ['forge-admin', 'forge-ui'],
        provenance: { source: 'taskspace', taskId: preparation.taskId, actorId: task.metadata.actorId,
          conversationId: preparation.conversationId, candidateCommit: context.runtimeCommit } },
      testDatabaseRecovery: { status: 'healthy', lastAttempt: { jobId, commit: context.runtimeCommit, status: 'success' } } }),
    releaseClient: async request => {
      runnerCalls++;
      assert.equal(request.preparedJobId, jobId);
      assert.equal(request.provenance.candidateCommit, context.runtimeCommit);
      assert.equal(request.runtimePreparation.executionId, preparation.executionId);
      assert.equal(request.runtimePreparation.stateDigest, stateBefore.stateDigest);
      assert.equal(request.runtimePreparation.recheck.previousObservationId, observations.at(-1) ?? oldObservation);
      const observationId = replayObservation ? observations[0] : crypto.randomUUID();
      const root = path.join(projectRoot, 'ops', 'release-candidates', jobId, 'runtime-evidence', observationId);
      const { probePlan, recheck: _recheck, ...binding } = request.runtimePreparation;
      const evidence = {};
      for (const kind of ['deployment', 'api', 'database', 'browser']) {
        const document = { sourceCommit: context.runtimeCommit, ...binding, observationId,
          probePlanSha256: digest(Buffer.from(JSON.stringify(probePlan))),
          status: kind === 'deployment' ? 'success' : kind === 'browser' ? 'not-executed' : kind === 'api' ? 'blocked' : 'failed',
          ...(kind === 'deployment' ? { startup: { migrationValidated: true, applicationStarted: true } } : {}),
          ...(kind === 'browser' ? { reason: 'owner-excluded' } : {}) };
        const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
        evidence[kind] = { path: path.join(root, `${kind}.json`), sha256: digest(bytes), bytesBase64: bytes.toString('base64') };
        runnerDocuments.push(bytes);
      }
      if (!replayObservation) observations.push(observationId);
      return { status: 'prepared', jobId, commit: context.runtimeCommit,
        runtimeEvidence: { status: 'failed', observationId, root, evidence } };
    } };
  const request = { action: 'prepare', expectedHead: source.head, expectedFingerprint: fingerprint,
    probePlan: { schemaVersion: 1, api: [], database: [], browser: { status: 'not-executed', reason: 'owner-excluded' } } };
  const first = await prepareForgeCrossLayerCandidate({ ...runArgs, request });
  assert.equal(first.status, 'runtime-evidence-prepared');
  const firstBytes = Object.fromEntries(await Promise.all(['runtime-evidence.json', 'runtime-input-receipt.json', 'current-prompt.md'].map(async name => [name, await readFile(path.join(phaseDirectory, name))])));
  current = { ...preparation, executionId: crypto.randomUUID() };
  await assert.rejects(prepareForgeCrossLayerCandidate({ ...runArgs, request }));
  current = preparation;
  source.workspaceFingerprint = 'c'.repeat(64);
  await assert.rejects(prepareForgeCrossLayerCandidate({ ...runArgs, request }));
  source.workspaceFingerprint = fingerprint;
  assert.equal(runnerCalls, 1);
  request.probePlan.database = [{ id: 'second-read', table: 'fixture_roles', columns: ['id'], where: [], limit: 1, expectedRows: 1 }];
  const second = await prepareForgeCrossLayerCandidate({ ...runArgs, request });
  assert.equal(second.status, 'runtime-evidence-prepared');
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.candidateCommit, first.candidateCommit);
  assert.equal(second.candidateTree, first.candidateTree);
  assert.equal(runnerCalls, 2);
  assert.notEqual(second.runtimeEvidence.observationId, first.runtimeEvidence.observationId);
  const record = await controller.readForgeCrossLayerRuntimeReprobe({ stateFile: context.stateFile, state: stateBefore });
  const saved = path.join(record.archiveDirectory, 'imported-observations', observations[0]);
  for (const [name, bytes] of Object.entries(firstBytes)) assert.deepEqual(await readFile(path.join(saved, name)), bytes);
  for (const [name, bytes] of Object.entries(original)) assert.deepEqual(await readFile(path.join(record.archiveDirectory, name)), bytes);
  const latestBytes = await readFile(path.join(phaseDirectory, 'runtime-evidence.json'));
  await assert.rejects(prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: resumed.preparationBinding,
    preparationExecution: preparation, expectedPreviousManifestSha256: first.imported.manifestSha256 }),
  { code: 'PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH' });
  assert.deepEqual(await readFile(path.join(phaseDirectory, 'runtime-evidence.json')), latestBytes);
  replayObservation = true;
  await assert.rejects(prepareForgeCrossLayerCandidate({ ...runArgs, request }));
  assert.deepEqual(await readFile(path.join(phaseDirectory, 'runtime-evidence.json')), latestBytes);
  assert.deepEqual(await readForgeDeliveryPhaseState(context.stateFile, context.catalog), stateBefore);
  assert.deepEqual(await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`)))), artifactBytes);
  assert.match(resumed.promptText, /forge-release contract/u);
  assert.match(resumed.promptText, /runnerContract\.runtimeProbeCapabilities/u);
  assert.doesNotMatch(resumed.promptText, /计划 JSON 严格四键 schemaVersion:1|method:"GET"/u);
  assert.match(resumed.promptText, /禁止源码修改、checkpoint、integrate 或正式发布/u);
  const formalArgs = browserArgs(context, 'rpc:resumed-runtime-review', stateBefore.sourceCommit);
  const formalPrepared = await prepareForgeDeliveryBrowserPhase(formalArgs);
  await prepareProtectedExecutionContext({ projectRoot, projectSlug: PROJECT_SLUG, taskMetadata: browserMetadata(context),
    request: browserRequest(context, formalPrepared.promptText, formalPrepared.rpcId), policyPath: POLICY_FILE,
    trustedPhase: { sourceCommit: formalPrepared.executionSourceCommit, caseFamily: formalPrepared.caseFamily,
      phaseAuthority: formalPrepared.phaseAuthority }, now: Date.now() });
  const formalExecution = JSON.parse(await readFile(path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${stateBefore.taskId}.json`), 'utf8')).current;
  const continued = await beginForgeDeliveryBrowserPhase({ ...formalArgs, prepared: formalPrepared, execution: formalExecution });
  assert.equal(continued.attempt.attemptId, stateBefore.activeAttempt.attemptId);
  assert.ok(continued.attempt.executionGeneration > preparation.generation);
  const formalState = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  for (const key of ['history', 'revision', 'limits', 'acceptedArtifacts']) assert.deepEqual(formalState[key], stateBefore[key]);
  assert.equal(formalState.status, 'active');
  for (const [name, bytes] of Object.entries(archiveBytes)) assert.deepEqual(await readFile(path.join(pending.archiveDirectory, name)), bytes);
});

test('zero-tool provider failure resumes only pending read-only preparation and preserves its formal review', async (t) => {
  const context = await fixture(t);
  const projectRoot = path.join(context.temporary, 'execution');
  const phaseDirectory = path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases', context.accepted.state.taskId, 'phase-control');
  const oldArtifacts = context.artifactsDirectory;
  context.stateFile = path.join(phaseDirectory, 'state.json');
  context.artifactsDirectory = path.join(phaseDirectory, 'artifacts');
  context.originalRequestFile = path.join(phaseDirectory, 'original-request.md');
  context.promptFile = path.join(phaseDirectory, 'current-prompt.md');
  await writeForgeDeliveryPhaseState(context.stateFile, context.accepted.state, context.catalog);
  for (const artifact of context.accepted.artifacts) await privateWrite(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`), await readFile(path.join(oldArtifacts, `${artifact.artifactKind}.json`)));
  await privateWrite(context.originalRequestFile, '验证已经部署的完整业务功能。\n');
  await privateWrite(context.promptFile, '尚未准备运行证据。\n');
  await git(context.repository, ['commit', '--amend', '--quiet', '-m', `Accepted cross-layer candidate ${context.cumulativePatchSha256}`]);
  context.runtimeCommit = await git(context.repository, ['rev-parse', 'HEAD']);
  context.manifest.runtimeSource.commit = context.runtimeCommit;
  const retainedRoot = path.join(phaseDirectory, 'runtime-preparations', crypto.randomUUID());
  await mkdir(retainedRoot, { recursive: true, mode: 0o700 });
  await git(context.repository, ['clone', '--bare', '--quiet', context.repository, path.join(retainedRoot, 'source.git')]);
  await privateWrite(path.join(retainedRoot, 'evidence', 'accepted.patch'), context.acceptedPatch);
  await git(context.repository, ['reset', '--mixed', '--quiet', context.accepted.state.sourceCommit]);
  const oldObservation = '11111111-1111-4111-8111-111111111111';
  const fingerprint = 'a'.repeat(64);
  const initialBinding = { stateDigest: context.accepted.state.stateDigest,
    acceptedArtifactDigests: context.accepted.state.acceptedArtifacts,
    baseSourceCommit: context.accepted.state.sourceCommit, workspaceFingerprint: fingerprint };
  const observation = async (state, observationId, apiStatus, roleAuthorizationVerified = false) => {
    const common = { sourceCommit: context.runtimeCommit, taskId: state.taskId,
      stateDigest: state.stateDigest, baseSourceCommit: state.sourceCommit,
      workspaceFingerprint: fingerprint, acceptedPatchSha256: context.cumulativePatchSha256,
      candidateTree: context.manifest.runtimeSource.tree, observationId };
    for (const kind of ['deployment', 'api', 'database', 'browser']) {
      const document = { ...common, status: kind === 'deployment' ? 'success' : kind === 'api' ? apiStatus : kind === 'browser' ? 'not-executed' : 'passed',
        ...(kind === 'deployment' ? { startup: { migrationValidated: true, applicationStarted: true } } : {}),
        ...(kind === 'browser' ? { reason: 'owner-excluded' } : {}),
        ...(kind === 'api' ? { roleAuthorizationVerified } : {}) };
      const file = path.join(context.evidenceDirectory, `${kind}.json`);
      await privateWrite(file, `${JSON.stringify(document)}\n`);
      context.manifest.evidence[kind].sha256 = digest(await readFile(file));
    }
    context.manifest.subject.stateDigest = state.stateDigest;
    await privateWrite(path.join(context.evidenceDirectory, 'manifest.json'), `${JSON.stringify(context.manifest)}\n`);
    context.expectedManifestSha256 = digest(await readFile(path.join(context.evidenceDirectory, 'manifest.json')));
  };
  await observation(context.accepted.state, oldObservation, 'failed');
  await prepareForgeCrossLayerRuntimePrompt({ ...context, catalogFile: CATALOG_FILE,
    runtimeEvidenceDirectory: context.evidenceDirectory, expectedRuntimeManifestSha256: context.expectedManifestSha256,
    sourceRepository: context.repository, preparationBinding: initialBinding });
  const args = browserArgs(context, 'rpc:runtime-review', context.accepted.state.sourceCommit);
  const prepared = await prepareForgeDeliveryBrowserPhase(args);
  await browserExecution(context, prepared);
  const execution = JSON.parse(await readFile(path.join(context.temporary, 'execution', 'taskspaces', '.broker',
    'executions', `${context.accepted.state.taskId}.json`), 'utf8')).current;
  const begin = await beginForgeDeliveryBrowserPhase({ ...args, prepared, execution });
  const attemptDirectory = path.join(path.dirname(context.stateFile), 'browser-attempts', execution.executionId);
  const baseline = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', observedSeq: 100, sessionCwd: '/workspace' };
  const modelResponse = '运行观察失败，保留原候选及原失败，不声明阶段通过。';
  const proof = { ...execution, schemaVersion: 'forge-delivery-phase-browser-session-proof/v1',
    terminalReason: 'completed', hostReceiptsDerived: false, baselineObservedSeq: 100,
    requestSeq: 101, assistantMessageSeq: 102, terminalSeq: 103, sessionCwd: '/workspace',
    terminalEventDigest: 'b'.repeat(64), modelResponseSha256: digest(modelResponse) };
  for (const [name, value] of Object.entries({ 'execution.json': execution, 'session-baseline.json': baseline,
    'begin.json': begin, '阶段终态采集.json': { modelResponse, sessionProof: proof } })) {
    await privateWrite(path.join(attemptDirectory, name), `${JSON.stringify(value)}\n`);
  }
  const original = Object.fromEntries(await Promise.all(['runtime-evidence.json', 'runtime-input-receipt.json'].map(async name =>
    [name, await readFile(path.join(path.dirname(context.stateFile), name))])));
  const stateBefore = await readForgeDeliveryPhaseState(context.stateFile, context.catalog);
  const artifactBytes = await Promise.all(context.accepted.artifacts.map(artifact => readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`))));
  const promptText = '继续补充当前候选的真实运行检查，保留原候选和观察。';
  const resumeArgs = { ...args, rpcId: 'rpc:runtime-reprobe', workspaceFingerprint: fingerprint, promptText, attemptDirectory };
  let resumed = await controller.prepareForgeCrossLayerRuntimeReprobe(resumeArgs);
  await prepareProtectedExecutionContext({ projectRoot, projectSlug: PROJECT_SLUG, taskMetadata: browserMetadata(context),
    request: browserRequest(context, resumed.promptText, resumed.rpcId), policyPath: POLICY_FILE,
    trustedPhase: { sourceCommit: resumed.executionSourceCommit, caseFamily: resumed.caseFamily,
      phaseAuthority: resumed.phaseAuthority, crossLayerPreparation: true, preparationBinding: resumed.preparationBinding }, now: Date.now() });
  let preparation = JSON.parse(await readFile(path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${stateBefore.taskId}.json`), 'utf8')).current;
  const recordFile = path.join(phaseDirectory, 'runtime-reprobe.json');
  const pendingBytes = await readFile(recordFile);
  const pending = JSON.parse(pendingBytes);
  const archiveBytes = Object.fromEntries(await Promise.all(Object.keys(pending.archivedSha256).map(async name =>
    [name, await readFile(path.join(pending.archiveDirectory, name))])));
  const preparationTerminal = { executionId: preparation.executionId, generation: preparation.generation,
    dshSessionId: preparation.dshSessionId, rpcId: preparation.rpcId, textDigest: preparation.textDigest,
    requestSeq: 201, terminalSeq: 210, turn: 2, terminalReason: 'error', sessionRunning: false,
    terminalErrorCode: 'PI_AI_ERROR', toolCallCount: 0, toolResultCount: 0,
    terminalEventDigest: 'd'.repeat(64) };
  const feedback = { ...resumeArgs, rpcId: 'rpc:corrected-runtime-plan',
    promptText: '上一轮模型服务失败且没有执行工具，请继续当前候选的真实运行检查，保留原失败。',
    preparationExecution: preparation, preparationTerminal };
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...resumeArgs, promptText: `${promptText} changed` }),
    { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  for (const invalid of [
    { preparationTerminal: undefined },
    { preparationTerminal: { ...preparationTerminal, sessionRunning: true } },
    { preparationTerminal: { ...preparationTerminal, terminalReason: 'aborted' } },
    { preparationTerminal: { ...preparationTerminal, terminalErrorCode: 'OTHER_ERROR' } },
    { preparationTerminal: { ...preparationTerminal, terminalErrorCode: undefined } },
    { preparationTerminal: { ...preparationTerminal, toolCallCount: 1 } },
    { preparationTerminal: { ...preparationTerminal, toolResultCount: 1 } },
    { preparationTerminal: { ...preparationTerminal, toolCallCount: undefined } },
    { preparationTerminal: { ...preparationTerminal, toolResultCount: undefined } },
    { preparationTerminal: { ...preparationTerminal, textDigest: 'e'.repeat(64) } },
    { preparationExecution: { ...preparation, actionCeiling: 'workspace-write' } },
    { preparationTerminal: { ...preparationTerminal, rpcId: 'rpc:unrelated' } },
    { preparationTerminal: { ...preparationTerminal, generation: execution.generation } },
    { preparationExecution: { ...preparation, actorUsername: 'another-user' } },
    { workspaceFingerprint: 'e'.repeat(64) },
    { sourceCommit: 'f'.repeat(40) },
    { sessionId: 'session:unrelated' },
  ]) await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe({ ...feedback, ...invalid }));
  // A provider error cannot substitute for the original completed formal review.
  const captureFile = path.join(attemptDirectory, '阶段终态采集.json');
  const captureBytes = await readFile(captureFile);
  await privateWrite(captureFile, `${JSON.stringify({ modelResponse, sessionProof: {
    ...proof, terminalReason: 'error', terminalErrorCode: 'PI_AI_ERROR', toolCallCount: 0, toolResultCount: 0,
  } })}\n`);
  await assert.rejects(controller.prepareForgeCrossLayerRuntimeReprobe(feedback), { code: 'PHASE_CONTROLLER_CONTINUATION_DENIED' });
  await privateWrite(captureFile, captureBytes);
  resumed = await controller.prepareForgeCrossLayerRuntimeReprobe(feedback);
  assert.equal(resumed.rpcId, feedback.rpcId);
  assert.equal(resumed.crossLayerPreparation, true);
  assert.deepEqual(resumed.preparationBinding, preparation.preparationBinding);
  assert.deepEqual(await readFile(recordFile), pendingBytes);
  assert.deepEqual(await readForgeDeliveryPhaseState(context.stateFile, context.catalog), stateBefore);
  for (const [name, bytes] of Object.entries(archiveBytes)) assert.deepEqual(await readFile(path.join(pending.archiveDirectory, name)), bytes);
  assert.equal(resumed.phaseAuthority.actionCeiling, 'read-only');
  assert.deepEqual(await Promise.all(context.accepted.artifacts.map(artifact =>
    readFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`)))), artifactBytes);
  for (const [name, bytes] of Object.entries(original)) assert.deepEqual(await readFile(path.join(phaseDirectory, name)), bytes);
  assert.deepEqual(await readFile(captureFile), captureBytes);
  assert.equal(preparationTerminal.terminalReason, 'error');
});
