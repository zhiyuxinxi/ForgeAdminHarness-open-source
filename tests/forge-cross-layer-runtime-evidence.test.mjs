import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { watch, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  ForgeCrossLayerRuntimeEvidenceError,
  loadForgeCrossLayerRuntimeEvidence,
} from '../docker/harness/forge-cross-layer-runtime-evidence.mjs';
import {
  beginForgeDeliveryPhase,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState,
  loadForgeDeliveryPhaseCatalog,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';

const executeFile = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'docker/harness/skills/forge-task-router/references/phase-profiles.json');

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

async function acceptedState(catalog, sourceCommit, cumulativePatchSha256) {
  const workflow = catalog.workflows.find((entry) => entry.id === 'crud-production');
  let state = createForgeDeliveryPhaseState({
    catalog,
    workflowId: workflow.id,
    caseFamily: 'crud-complete',
    taskId: 'runtime-evidence-fixture',
    sessionId: 'session:runtime-evidence-fixture',
    sourceCommit,
    now: '2026-09-14T00:00:00.000Z',
  });
  const artifacts = [];
  for (const phase of workflow.phases.slice(0, -1)) {
    state = beginForgeDeliveryPhase({
      state,
      catalog,
      phaseId: phase.id,
      rpcId: `rpc:${phase.index}`,
      promptDigest: digest(`prompt:${phase.index}`),
      executionGeneration: phase.index + 1,
      now: `2026-09-14T00:00:${String(phase.index * 2 + 1).padStart(2, '0')}.000Z`,
    });
    const changedPaths = phase.sourceMutation ? [phase.ownedPaths[0]] : [];
    const payload = Object.fromEntries(phase.requiredPayloadKeys.map((key) => [
      key,
      key === 'changedPaths' ? changedPaths : [],
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
      now: `2026-09-14T00:00:${String(phase.index * 2 + 2).padStart(2, '0')}.000Z`,
    }));
    artifacts.push(artifact);
  }
  return { state, artifacts };
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-evidence-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'repository');
  const directory = path.join(temporary, 'evidence');
  await mkdir(repository, { recursive: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await git(repository, ['init', '--quiet']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repository, 'app.txt'), 'base\n');
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['commit', '--quiet', '-m', 'base']);
  const baseCommit = await git(repository, ['rev-parse', 'HEAD']);

  await writeFile(path.join(repository, 'app.txt'), 'base\naccepted\n');
  const acceptedPatchBytes = Buffer.from(`${await git(repository, ['diff', '--binary'])}\n`, 'utf8');
  await privateWrite(path.join(directory, 'accepted.patch'), acceptedPatchBytes);
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['commit', '--quiet', '-m', 'accepted phase patch']);

  await writeFile(path.join(repository, 'app.txt'), 'base\naccepted\nreviewed repair\n');
  const repairPatchBytes = Buffer.from(`${await git(repository, ['diff', '--binary'])}\n`, 'utf8');
  await privateWrite(path.join(directory, 'repair-1.patch'), repairPatchBytes);
  await git(repository, ['add', 'app.txt']);
  await git(repository, ['commit', '--quiet', '-m', 'reviewed repair']);
  const runtimeCommit = await git(repository, ['rev-parse', 'HEAD']);
  const runtimeTree = await git(repository, ['rev-parse', 'HEAD^{tree}']);
  const acceptedPatchSha256 = digest(acceptedPatchBytes);
  const repairPatchSha256 = digest(repairPatchBytes);

  const review = {
    schemaVersion: 'forge-cross-layer-runtime-repair-review/v1',
    reviewerId: 'independent-reviewer',
    candidateAuthorId: 'candidate-author',
    subject: { patchSha256: repairPatchSha256 },
    verdict: 'PASS',
    summary: 'The bounded repair matches the accepted contract and introduces no unrelated change.',
  };
  await privateWrite(path.join(directory, 'repair-1-review.json'), `${JSON.stringify(review)}\n`);
  const deployment = {
    schemaVersion: 1,
    releaseState: { commit: runtimeCommit, status: 'success' },
    checks: ['healthy'],
  };
  const api = { schemaVersion: 1, sourceCommit: runtimeCommit, checks: 31, failures: [] };
  await privateWrite(path.join(directory, 'deployment.json'), `${JSON.stringify(deployment)}\n`);
  await privateWrite(path.join(directory, 'api.json'), `${JSON.stringify(api)}\n`);
  const apiEvidenceSha256 = digest(await readFile(path.join(directory, 'api.json')));
  const deploymentEvidenceSha256 = digest(await readFile(path.join(directory, 'deployment.json')));
  const evidence = {
    deployment,
    api,
    browser: {
      schemaVersion: 1, sourceCommit: runtimeCommit, checks: 14, unknown: [],
      apiEvidenceSha256, deploymentEvidenceSha256,
    },
    database: {
      schemaVersion: 1, sourceCommit: runtimeCommit, checks: 8, failures: [], apiEvidenceSha256,
    },
  };
  for (const kind of ['browser', 'database']) {
    await privateWrite(path.join(directory, `${kind}.json`), `${JSON.stringify(evidence[kind])}\n`);
  }

  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const accepted = await acceptedState(catalog, baseCommit, acceptedPatchSha256);
  const idleStateDigest = accepted.state.stateDigest;
  const state = beginForgeDeliveryPhase({
    state: accepted.state,
    catalog,
    phaseId: 'cross-layer-acceptance',
    rpcId: 'rpc:cross-layer-runtime',
    promptDigest: digest('cross-layer-runtime-prompt'),
    executionGeneration: 8,
    now: '2026-09-14T00:00:20.000Z',
  });
  const fileRef = async (name) => ({
    path: name,
    sha256: digest(await readFile(path.join(directory, name))),
  });
  const manifest = {
    schemaVersion: 'forge-cross-layer-runtime-evidence/v1',
    subject: {
      workflowId: state.workflowId,
      taskId: state.taskId,
      catalogVersion: state.catalogVersion,
      catalogDigest: state.catalogDigest,
      stateDigest: idleStateDigest,
      baseSourceCommit: baseCommit,
      cumulativePatchSha256: acceptedPatchSha256,
    },
    runtimeSource: { commit: runtimeCommit, tree: runtimeTree },
    acceptedPatch: await fileRef('accepted.patch'),
    repairs: [{ patch: await fileRef('repair-1.patch'), review: await fileRef('repair-1-review.json') }],
    evidence: Object.fromEntries(await Promise.all(
      ['deployment', 'api', 'browser', 'database'].map(async (kind) => [kind, await fileRef(`${kind}.json`)]),
    )),
  };
  const writeManifest = async () => {
    await privateWrite(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    return digest(await readFile(path.join(directory, 'manifest.json')));
  };
  const expectedManifestSha256 = await writeManifest();
  const load = (overrides = {}) => loadForgeCrossLayerRuntimeEvidence({
    directory,
    expectedManifestSha256,
    expectedStateDigest: idleStateDigest,
    state,
    catalog,
    acceptedArtifacts: accepted.artifacts,
    sourceRepository: repository,
    ...overrides,
  });
  return {
    directory, repository, catalog, state, accepted, idleStateDigest,
    expectedManifestSha256, manifest, writeManifest, load, runtimeCommit, runtimeTree,
  };
}

test('loads complete runtime evidence and materializes only accepted and independently reviewed patches', {
  concurrency: false,
}, async (t) => {
  const value = await fixture(t);
  const materializationTemporary = await mkdtemp(path.join(value.directory, 'materialization-temp-'));
  const temporaryVariables = ['TMPDIR', 'TMP', 'TEMP'];
  const previousTemporaryEnvironment = Object.fromEntries(
    temporaryVariables.map((name) => [name, process.env[name]]),
  );
  for (const name of temporaryVariables) process.env[name] = materializationTemporary;
  let originalPatchMutated = false;
  const watcher = watch(materializationTemporary, (event, filename) => {
    if (event === 'rename' && String(filename ?? '').startsWith('forge-cross-layer-runtime-')) {
      writeFileSync(path.join(value.directory, 'accepted.patch'), 'changed after verified read\n');
      originalPatchMutated = true;
      watcher.close();
    }
  });
  let bundle;
  try {
    bundle = await value.load();
  } finally {
    watcher.close();
    for (const name of temporaryVariables) {
      if (previousTemporaryEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousTemporaryEnvironment[name];
    }
  }
  assert.equal(originalPatchMutated, true);
  assert.equal(bundle.manifestSha256, value.expectedManifestSha256);
  assert.equal(bundle.subject.stateDigest, value.idleStateDigest);
  assert.equal(bundle.runtimeSource.commit, value.runtimeCommit);
  assert.equal(bundle.sourceLineage.materializedTree, value.runtimeTree);
  assert.equal(bundle.sourceLineage.patchInput, 'verified-byte-snapshots');
  assert.equal(bundle.sourceLineage.repairs[0].review.verdict, 'PASS');
  assert.equal(bundle.evidence.deployment.releaseState.status, 'success');
  assert.equal(bundle.evidence.api.checks, 31);
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(bundle.evidence.api));
});

test('rejects a manifest digest not reviewed by the caller', async (t) => {
  const value = await fixture(t);
  await assert.rejects(value.load({ expectedManifestSha256: '0'.repeat(64) }),
    (error) => error instanceof ForgeCrossLayerRuntimeEvidenceError
      && error.code === 'CROSS_LAYER_RUNTIME_DIGEST_MISMATCH');
});

test('rejects an evidence subject bound to another base state', async (t) => {
  const value = await fixture(t);
  value.manifest.subject.baseSourceCommit = '1'.repeat(40);
  const digest_ = await value.writeManifest();
  await assert.rejects(value.load({ expectedManifestSha256: digest_ }),
    (error) => error.code === 'CROSS_LAYER_RUNTIME_BINDING_MISMATCH');
});

test('rejects a repair without an independent passing review of its exact patch', async (t) => {
  const value = await fixture(t);
  const file = path.join(value.directory, 'repair-1-review.json');
  const review = JSON.parse(await readFile(file, 'utf8'));
  review.verdict = 'rejected';
  await privateWrite(file, `${JSON.stringify(review)}\n`);
  value.manifest.repairs[0].review.sha256 = digest(await readFile(file));
  const digest_ = await value.writeManifest();
  await assert.rejects(value.load({ expectedManifestSha256: digest_ }),
    (error) => error.code === 'CROSS_LAYER_RUNTIME_REPAIR_REVIEW_INVALID');
});

test('rejects a runtime tree not materialized by the accepted patch and reviewed repairs', async (t) => {
  const value = await fixture(t);
  value.manifest.runtimeSource.tree = await git(value.repository, ['rev-parse', `${value.manifest.subject.baseSourceCommit}^{tree}`]);
  const digest_ = await value.writeManifest();
  await assert.rejects(value.load({ expectedManifestSha256: digest_ }),
    (error) => error.code === 'CROSS_LAYER_RUNTIME_SOURCE_MISMATCH');
});

test('rejects missing evidence and evidence from another runtime commit', async (t) => {
  const missing = await fixture(t);
  await rm(path.join(missing.directory, 'database.json'));
  await assert.rejects(missing.load(), (error) => error.code === 'CROSS_LAYER_RUNTIME_FILE_MISSING');

  const stale = await fixture(t);
  const apiFile = path.join(stale.directory, 'api.json');
  const api = JSON.parse(await readFile(apiFile, 'utf8'));
  api.sourceCommit = stale.manifest.subject.baseSourceCommit;
  await privateWrite(apiFile, `${JSON.stringify(api)}\n`);
  stale.manifest.evidence.api.sha256 = digest(await readFile(apiFile));
  const digest_ = await stale.writeManifest();
  await assert.rejects(stale.load({ expectedManifestSha256: digest_ }),
    (error) => error.code === 'CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE_MISMATCH');

  const contradictory = await fixture(t);
  const deploymentFile = path.join(contradictory.directory, 'deployment.json');
  const deployment = JSON.parse(await readFile(deploymentFile, 'utf8'));
  deployment.sourceCommit = contradictory.manifest.subject.baseSourceCommit;
  await privateWrite(deploymentFile, `${JSON.stringify(deployment)}\n`);
  contradictory.manifest.evidence.deployment.sha256 = digest(await readFile(deploymentFile));
  const contradictoryDigest = await contradictory.writeManifest();
  await assert.rejects(contradictory.load({ expectedManifestSha256: contradictoryDigest }),
    (error) => error.code === 'CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE_MISMATCH');

  const crossRun = await fixture(t);
  const browserFile = path.join(crossRun.directory, 'browser.json');
  const browser = JSON.parse(await readFile(browserFile, 'utf8'));
  browser.apiEvidenceSha256 = 'f'.repeat(64);
  await privateWrite(browserFile, `${JSON.stringify(browser)}\n`);
  crossRun.manifest.evidence.browser.sha256 = digest(await readFile(browserFile));
  const crossRunDigest = await crossRun.writeManifest();
  await assert.rejects(crossRun.load({ expectedManifestSha256: crossRunDigest }),
    (error) => error.code === 'CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE_MISMATCH');
});
