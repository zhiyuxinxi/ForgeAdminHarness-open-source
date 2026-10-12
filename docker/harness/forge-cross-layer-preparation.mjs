import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { prepareForgeCrossLayerPreparation, prepareForgeCrossLayerRuntimePrompt, readForgeAccessWiringRepairContinuation, readForgeCrossLayerRuntimeReprobe, readForgeDeliveryAcceptedArtifact } from './forge-delivery-phase-controller.mjs';
import { snapshotForgeDeliveryWorkspace, observeForgeDeliveryPhase } from './forge-delivery-phase-workspace-observer.mjs';
import { validateRuntimeProbeScope, validateRuntimeIdentityScope } from './release-policy.mjs';
import { currentForgeRuntimeSourceArtifactKind } from './forge-delivery-phase-runtime.mjs';

const execute = promisify(execFile);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { const error = new Error(message); error.code = 'CROSS_LAYER_PREPARATION_DENIED'; throw error; };
const same = (left, right) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
async function git(repository, args, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = await execute('git', ['-C', repository, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', ...extra } });
  return result.stdout.trim();
}
async function exclusive(file, bytes) { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }

// Called only with the accepted artifact read from the protected phase directory.
// Shorthand and model-supplied paths never grant additional candidate API access.
export function deriveForgeRuntimeApiScope(artifactBytes) {
  if (!Buffer.isBuffer(artifactBytes) || artifactBytes.length > 1024 * 1024) fail('The accepted API contract is unavailable or too large.');
  let artifact;
  try { artifact = JSON.parse(artifactBytes.toString('utf8')); }
  catch { fail('The accepted API contract is not valid JSON.'); }
  const groups = artifact?.payload?.apiContracts?.endpoints;
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > 256) fail('The accepted API contract has no bounded endpoint declarations.');
  const endpoints = [];
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group?.operations) || group.operations.length === 0 || group.operations.length > 256) fail('The accepted API contract has no bounded operations.');
    for (const operation of group.operations) {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)
        || Object.hasOwn(operation, 'path') === Object.hasOwn(operation, 'exactPaths')) fail('An accepted API operation requires unambiguous literal paths.');
      const paths = Object.hasOwn(operation, 'path') ? [operation.path] : operation.exactPaths;
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 256) fail('An accepted API operation has no bounded literal paths.');
      for (const apiPath of paths) {
        const endpoint = { method: operation.method, path: apiPath };
        const key = JSON.stringify(endpoint);
        if (!seen.has(key)) { endpoints.push(endpoint); seen.add(key); }
        if (endpoints.length > 256) fail('The accepted API endpoint scope exceeds its bound.');
      }
    }
  }
  return validateRuntimeProbeScope({ artifactSha256: sha256(artifactBytes), endpoints });
}

// The caller supplies the current access artifact returned by the protected accepted-artifact reader.
// Only explicit role declarations grant scope; nested prose and deny rules never do.
export function deriveForgeRuntimeIdentityScope(artifact) {
  const contract = artifact?.payload?.roleVisibilityContract;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  if (!object(contract) || Object.keys(contract).length > 256) fail('The accepted access contract has no bounded role declarations.');
  const roleKeys = [];
  for (const [key, declaration] of Object.entries(contract)) {
    if (key === 'denyRules' || key === 'roleSeedPolicy') continue;
    if (key === 'roles' && Array.isArray(declaration)) {
      if (declaration.length > 256 || declaration.some(role => !object(role) || typeof role.roleKey !== 'string'
        || !Array.isArray(role.visibleCapabilities) || role.visibleCapabilities.length === 0
        || !role.visibleCapabilities.every(value => typeof value === 'string' && value.trim())
        || typeof role.dataScope !== 'string' || !role.dataScope.trim())) {
        fail('An explicit accepted role record is incomplete.');
      }
      roleKeys.push(...declaration.map(role => role.roleKey));
      continue;
    }
    if (!object(declaration)) continue;
    const visibility = ['canSee', 'canAct', 'dataScope'].some(field => Object.hasOwn(declaration, field));
    if (visibility && (!Array.isArray(declaration.canSee) || !declaration.canSee.every(value => typeof value === 'string')
      || !Array.isArray(declaration.canAct) || !declaration.canAct.every(value => typeof value === 'string')
      || typeof declaration.dataScope !== 'string' || !declaration.dataScope.trim())) fail('An accepted role declaration is incomplete.');
    if (Object.hasOwn(declaration, 'roles')) {
      if (!Array.isArray(declaration.roles) || declaration.roles.length > 256) fail('An accepted role group requires bounded explicit role keys.');
      roleKeys.push(...declaration.roles);
    } else if (visibility) roleKeys.push(key);
    if (roleKeys.length > 256) fail('The accepted role scope exceeds its bound.');
  }
  if (!roleKeys.length) fail('The accepted access contract declares no explicit roles.');
  return validateRuntimeIdentityScope({ artifactSha256: artifact.artifactDigest, roleKeys: roleKeys.sort() });
}

async function retainedRuntimeCandidate(directory, reprobe, patch) {
  const root = path.join(directory, 'runtime-preparations');
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== path.resolve(root)) fail('The original candidate storage is not private.');
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name));
  if (entries.length > 64) fail('The original candidate lookup exceeds its bound.');
  for (const entry of entries) {
    const candidateRoot = path.join(root, entry.name);
    const repository = path.join(candidateRoot, 'source.git');
    const evidence = path.join(candidateRoot, 'evidence');
    const patchFile = path.join(evidence, 'accepted.patch');
    const paths = await Promise.all([candidateRoot, repository, evidence, patchFile].map(file => lstat(file)));
    if (paths.some(info => info.isSymbolicLink()) || paths.slice(0, 3).some(info => !info.isDirectory())
      || !paths[3].isFile() || paths[3].size !== patch.length) continue;
    if (!(await readFile(patchFile)).equals(patch)) continue;
    let source;
    try { source = await git(repository, ['show', '-s', '--format=%T%n%P%n%B', reprobe.candidateCommit]); }
    catch { continue; }
    const [tree, parent, ...message] = source.split(/\r?\n/u);
    if (tree === reprobe.candidateTree && parent === reprobe.baseSourceCommit
      && /^Accepted cross-layer candidate [a-f0-9]{64}$/u.test(message.join('\n').trim())) return repository;
  }
  fail('The exact previously prepared candidate is unavailable; rebuilding is not permitted.');
}

function retainedRuntimeJob(diagnosis, reprobe, task, context) {
  const job = diagnosis?.lastJob;
  const recovery = diagnosis?.testDatabaseRecovery;
  const provenance = { source: 'taskspace', taskId: context.taskId, actorId: task.metadata.actorId,
    conversationId: context.conversationId, candidateCommit: reprobe.candidateCommit };
  if (diagnosis?.active !== false || diagnosis.activeJobId !== null || job?.status !== 'prepared'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(job.jobId ?? '')
    || job.commit !== reprobe.candidateCommit || !same(job.provenance ?? {}, provenance)
    || JSON.stringify(job.services) !== JSON.stringify(['forge-admin', 'forge-ui'])
    || recovery?.status !== 'healthy' || recovery.lastAttempt?.jobId !== job.jobId
    || recovery.lastAttempt.commit !== job.commit || recovery.lastAttempt.status !== 'success') {
    fail('The exact prepared candidate and healthy test database are not available for recheck.');
  }
  return job.jobId;
}

function retainedPublishedRuntimeJob(diagnosis, task, context) {
  const job = diagnosis?.lastJob;
  const recovery = diagnosis?.testDatabaseRecovery;
  const provenance = { source: 'taskspace', taskId: context.taskId, actorId: task.metadata.actorId,
    conversationId: context.conversationId, candidateCommit: context.sourceCommit };
  if (diagnosis?.active !== false || diagnosis.activeJobId !== null || job?.status !== 'success'
    || job.stage !== 'complete' || job.commit !== context.sourceCommit
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(job.preparedJobId ?? '')
    || !same(job.provenance ?? {}, provenance) || !Array.isArray(job.services)
    || !['forge-admin', 'forge-ui'].every(service => job.services.includes(service))
    || recovery?.status !== 'healthy' || recovery.lastAttempt?.jobId !== job.preparedJobId
    || recovery.lastAttempt.commit !== job.commit || recovery.lastAttempt.status !== 'success'
    || recovery.lastAttempt.published !== true || recovery.lastAttempt.releaseJobId !== job.jobId) {
    fail('The current published candidate and its healthy test database are unavailable for observation.');
  }
  return job.preparedJobId;
}

// This producer only materializes the already accepted patch in private Git storage.
// It never stages, commits, integrates or edits the TaskSpace business workspace.
export async function prepareForgeCrossLayerCandidate({ projectRoot, task, context, request, catalogFile,
  inspectSource, readContext, publishCandidate, releaseClient, readReleaseStatus }) {
  const binding = context.preparationBinding;
  if (context.crossLayerPreparation !== true || context.authorityClass !== 'production-read-only' || context.testOnly
    || context.workflowId !== 'crud-production' || context.phaseId !== 'cross-layer-acceptance' || context.phaseIndex !== 7
    || context.actionCeiling !== 'read-only' || context.ownedPaths.length !== 0
    || request.expectedHead !== binding?.baseSourceCommit || request.expectedFingerprint !== binding?.workspaceFingerprint) fail('Preparation requires the current readonly cross-layer source binding.');
  const parentDirectory = path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases', task.metadata.taskId, 'phase-control');
  const resolveDirectory = async () => (await readForgeAccessWiringRepairContinuation({ catalogFile,
    sourceStateFile: path.join(parentDirectory, 'state.json'), sourceArtifactsDirectory: path.join(parentDirectory, 'artifacts'),
    sourceCommit: JSON.parse(await readFile(path.join(parentDirectory, 'state.json'), 'utf8')).sourceCommit,
    taskId: context.taskId, sessionId: context.dshSessionId }))?.phaseDirectory ?? parentDirectory;
  const directory = await resolveDirectory();
  const files = { catalogFile, stateFile: path.join(directory, 'state.json'), artifactsDirectory: path.join(directory, 'artifacts'),
    originalRequestFile: path.join(directory, 'original-request.md'), promptFile: path.join(directory, 'current-prompt.md') };
  const check = async () => {
    if (await resolveDirectory() !== directory) fail('Linked access repair changed during candidate preparation.');
    const current = await readContext();
    const live = await inspectSource();
    if (current.executionId !== context.executionId || current.generation !== context.generation
      || live.head !== binding.baseSourceCommit || live.workspaceFingerprint !== binding.workspaceFingerprint) fail('Execution or source changed during candidate preparation.');
    const prepared = await prepareForgeCrossLayerPreparation({ ...files, sourceCommit: live.head, workspace: task.workspace,
      workspaceFingerprint: live.workspaceFingerprint, taskId: context.taskId, sessionId: context.dshSessionId,
      rpcId: context.rpcId, promptText: '', preparationExecution: context });
    if (prepared.preparationBinding.stateDigest !== binding.stateDigest
      || !same(prepared.preparationBinding.acceptedArtifactDigests, binding.acceptedArtifactDigests)) fail('Accepted phase state changed during preparation.');
    return JSON.parse(await readFile(files.stateFile, 'utf8'));
  };
  const state = await check();
  const completed = state.status === 'completed';
  const access = await readForgeDeliveryAcceptedArtifact({ state, artifactsDirectory: files.artifactsDirectory,
    artifactKind: 'access-wiring-implementation' });
  const apiScope = request.probePlan?.schemaVersion === 2
    ? deriveForgeRuntimeApiScope(await readFile(path.join(files.artifactsDirectory, 'domain-api-contract.json')))
    : undefined;
  const identityScope = request.probePlan?.schemaVersion === 2 && request.probePlan.identityFixtures?.length
    ? validateRuntimeIdentityScope(deriveForgeRuntimeIdentityScope(access), request.probePlan)
    : undefined;
  const before = completed ? undefined : await snapshotForgeDeliveryWorkspace({ workspace: task.workspace, baseCommit: state.sourceCommit });
  const observed = completed ? undefined : await observeForgeDeliveryPhase({ workspace: task.workspace, baseCommit: state.sourceCommit, before });
  const sourceKind = currentForgeRuntimeSourceArtifactKind(completed ? { ...state, history: state.history.slice(0, -1) } : state);
  const acceptedSource = sourceKind === 'access-wiring-implementation' ? access
    : await readForgeDeliveryAcceptedArtifact({ state, artifactsDirectory: files.artifactsDirectory, artifactKind: sourceKind });
  if (!completed && observed.cumulativePatchDigest !== acceptedSource.sourceFingerprint) fail('Live source is not the accepted cumulative patch.');
  const acceptedPatchSha256 = acceptedSource.sourceFingerprint;
  if (completed && typeof readReleaseStatus !== 'function') fail('Published runtime observation requires current release evidence.');
  const reprobe = completed ? undefined : await readForgeCrossLayerRuntimeReprobe({ stateFile: files.stateFile, state });
  if (reprobe && (!['pending', 'imported'].includes(reprobe.status) || reprobe.acceptedPatchSha256 !== observed.cumulativePatchDigest
    || reprobe.workspaceFingerprint !== binding.workspaceFingerprint || typeof readReleaseStatus !== 'function')) {
    fail('Runtime recheck differs from the protected unchanged candidate.');
  }
  const root = completed ? path.join(directory, 'runtime-observations', crypto.randomUUID())
    : reprobe ? path.join(reprobe.archiveDirectory, 'observations', crypto.randomUUID())
    : path.join(directory, 'runtime-preparations', crypto.randomUUID());
  const repository = completed ? undefined : reprobe ? await retainedRuntimeCandidate(directory, reprobe, observed.cumulativePatch) : path.join(root, 'source.git');
  const preparedJobId = completed ? retainedPublishedRuntimeJob(await readReleaseStatus(), task, context)
    : reprobe ? retainedRuntimeJob(await readReleaseStatus(), reprobe, task, context) : undefined;
  const evidenceDirectory = path.join(root, 'evidence');
  if (!reprobe && !completed) await mkdir(repository, { recursive: true, mode: 0o700 });
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const patchFile = path.join(evidenceDirectory, 'accepted.patch');
  if (!completed) await exclusive(patchFile, observed.cumulativePatch);
  let candidateTree = completed ? await git(task.workspace, ['rev-parse', 'HEAD^{tree}']) : reprobe?.candidateTree;
  let candidateCommit = completed ? context.sourceCommit : reprobe?.candidateCommit;
  if (!reprobe && !completed) {
    await git(repository, ['init', '--bare', '--quiet']);
    await git(repository, ['fetch', '--quiet', '--no-tags', task.workspace, state.sourceCommit]);
    const env = { GIT_INDEX_FILE: path.join(root, 'candidate.index'), GIT_AUTHOR_NAME: 'Forge accepted candidate',
      GIT_AUTHOR_EMAIL: 'forge-candidate@example.invalid', GIT_COMMITTER_NAME: 'Forge accepted candidate',
      GIT_COMMITTER_EMAIL: 'forge-candidate@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
    await git(repository, ['read-tree', state.sourceCommit], env);
    if (observed.cumulativePatch.length > 0) await git(repository, ['apply', '--cached', '--binary', '--whitespace=nowarn', patchFile], env);
    candidateTree = await git(repository, ['write-tree'], env);
    candidateCommit = await git(repository, ['commit-tree', candidateTree, '-p', state.sourceCommit,
      '-m', `Accepted cross-layer candidate ${binding.stateDigest}`], env);
  }
  await check();
  if (completed) {
    if (retainedPublishedRuntimeJob(await readReleaseStatus(), task, context) !== preparedJobId) fail('The published candidate changed before observation.');
  } else if (!reprobe) await publishCandidate(repository, candidateCommit);
  else if (retainedRuntimeJob(await readReleaseStatus(), reprobe, task, context) !== preparedJobId) fail('The prepared candidate changed before recheck.');
  const result = await releaseClient({ action: 'prepare', services: ['forge-admin', 'forge-ui'],
    ...(preparedJobId ? { preparedJobId } : {}),
    approvalRef: `cross-layer:${context.executionId}`, provenance: { source: 'taskspace', taskId: context.taskId,
      actorId: task.metadata.actorId, conversationId: context.conversationId, candidateCommit },
    runtimePreparation: { taskId: context.taskId, executionId: context.executionId, stateDigest: binding.stateDigest,
      baseSourceCommit: state.sourceCommit, workspaceFingerprint: binding.workspaceFingerprint,
      acceptedPatchSha256, candidateTree, probePlan: request.probePlan,
      ...(apiScope ? { apiScope } : {}),
      ...(identityScope ? { identityScope } : {}),
      ...(reprobe ? { recheck: { previousObservationId: reprobe.status === 'imported' ? reprobe.replacementObservationId : reprobe.previousObservationId,
        previousStateDigest: reprobe.status === 'imported' ? binding.stateDigest : reprobe.previousStateDigest } } : {}) } });
  await check();
  const runtime = result?.runtimeEvidence;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (result?.status !== 'prepared' || result.commit !== candidateCommit || !uuid.test(result.jobId ?? '')
    || (preparedJobId && result.jobId !== preparedJobId) || (reprobe && runtime?.observationId === reprobe.previousObservationId)
    || !uuid.test(runtime?.observationId ?? '') || !['passed', 'failed', 'blocked'].includes(runtime?.status)) fail('Runner did not return the bound candidate observation.');
  const expectedRoot = path.join(projectRoot, 'ops', 'release-candidates', result.jobId, 'runtime-evidence', runtime.observationId);
  if (runtime.root !== expectedRoot) fail('Runner evidence root is not the protected candidate path.');
  const refs = {};
  for (const kind of ['deployment', 'api', 'database', 'browser']) {
    const ref = runtime.evidence?.[kind];
    const source = path.join(expectedRoot, `${kind}.json`);
    if (ref?.path !== source || !/^[0-9a-f]{64}$/u.test(ref.sha256 ?? '')) fail('Runner evidence reference is outside its protected observation.');
    const encoded = ref.bytesBase64;
    if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 4 * Math.ceil(1024 * 1024 / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      fail('Runner evidence bytes are not canonical bounded base64.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 1024 * 1024 || bytes.toString('base64') !== encoded || sha256(bytes) !== ref.sha256) {
      fail('Runner evidence bytes differ from their protected digest.');
    }
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); } catch { fail('Runner evidence is not a JSON document.'); }
    const expected = { sourceCommit: candidateCommit, taskId: context.taskId, executionId: context.executionId,
      stateDigest: binding.stateDigest, baseSourceCommit: state.sourceCommit, workspaceFingerprint: binding.workspaceFingerprint,
      acceptedPatchSha256, candidateTree,
      probePlanSha256: sha256(Buffer.from(JSON.stringify(request.probePlan))), observationId: runtime.observationId };
    if (document === null || typeof document !== 'object' || Array.isArray(document)
      || Object.entries(expected).some(([key, value]) => document[key] !== value)) {
      fail('Runner evidence belongs to another protected preparation or probe plan.');
    }
    await exclusive(path.join(evidenceDirectory, `${kind}.json`), bytes);
    refs[kind] = { path: `${kind}.json`, sha256: ref.sha256 };
  }
  if (completed) {
    await check();
    const observation = { status: 'runtime-evidence-prepared', candidateCommit, candidateTree, jobId: result.jobId,
      runtimeEvidence: runtime, completedWorkflowPreserved: true, releaseApplied: false, sourceModified: false,
      cannotClaim: ['production-release', 'browser-execution', 'phase-accepted'] };
    await exclusive(path.join(evidenceDirectory, 'observation.json'), `${JSON.stringify(observation)}\n`);
    return observation;
  }
  const manifest = { schemaVersion: 'forge-cross-layer-runtime-evidence/v1',
    subject: { workflowId: state.workflowId, taskId: state.taskId, catalogVersion: state.catalogVersion,
      catalogDigest: state.catalogDigest, stateDigest: state.stateDigest, baseSourceCommit: state.sourceCommit,
      cumulativePatchSha256: observed.cumulativePatchDigest }, runtimeSource: { commit: candidateCommit, tree: candidateTree },
    acceptedPatch: { path: 'accepted.patch', sha256: observed.cumulativePatchDigest }, repairs: [], evidence: refs };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await exclusive(path.join(evidenceDirectory, 'manifest.json'), manifestBytes);
  await check();
  const imported = await prepareForgeCrossLayerRuntimePrompt({ ...files, runtimeEvidenceDirectory: evidenceDirectory,
    expectedRuntimeManifestSha256: sha256(manifestBytes), sourceRepository: repository, preparationBinding: binding,
    preparationExecution: context, expectedPreviousManifestSha256: reprobe?.replacementManifestSha256 });
  return { status: 'runtime-evidence-prepared', candidateCommit, candidateTree, jobId: result.jobId,
    runtimeEvidence: runtime, imported, releaseApplied: false, sourceModified: false,
    cannotClaim: ['production-release', 'authenticated-role-matrix', 'CRUD-workflows', 'browser-execution', 'phase-accepted'] };
}
