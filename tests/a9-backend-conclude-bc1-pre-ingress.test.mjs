import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canonicalRecoveryDescriptorDigest,
  conclusionWritePlan,
  isExpectedPassivePlatformContainer,
  parseConclusionMode,
  publishExclusiveAtomic,
  runConclusion,
  validateConclusionReceipt,
} from '../output/validation/a9-backend-conclude-bc1-pre-ingress.mjs';
import {
  canonicalJsonBytes as recoveryCanonicalJsonBytes,
} from '../output/validation/forge-runtime-candidate-vpn75-host-runner-2026.09.03.28/forge-host-runner-2026.09.03.28/bin/run-forge-protected-headless-recovery.mjs';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'output',
  'validation',
  'a9-backend-conclude-bc1-pre-ingress.mjs',
);

test('descriptor digest uses the runner canonical form with its self-digest cleared', () => {
  const value = JSON.parse(readFileSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'output',
    'validation',
    'a9-backend-recovery-bc1e4cac-899b-47dc-8587-dfe9b3e875e8.json',
  ), 'utf8'));
  assert.equal(
    canonicalRecoveryDescriptorDigest(value, recoveryCanonicalJsonBytes),
    value.operation.descriptorSha256,
  );
});

test('only exact stable platform services are excluded from overlap false positives', () => {
  const taskspaceBroker = {
    Id: '9a25b99dd8ec9f91ce09cbc0096d3a1652957b0ff11ba9f1deb7d45a23e3a423',
    Name: '/forge-forge-base-taskspace-broker-1',
    Image: 'sha256:f2684ea57f8982f7174821e576a3fbb1757113dbdf77fd21a7f7e5fffd473d73',
    State: {
      Status: 'running',
      Running: true,
      StartedAt: '2026-08-31T08:48:26.077016757Z',
    },
    RestartCount: 0,
  };
  assert.equal(isExpectedPassivePlatformContainer(taskspaceBroker), true);
  assert.equal(isExpectedPassivePlatformContainer({ ...taskspaceBroker, RestartCount: 1 }), false);
  assert.equal(isExpectedPassivePlatformContainer({ ...taskspaceBroker, Image: 'sha256:drift' }), false);
  assert.equal(isExpectedPassivePlatformContainer({ ...taskspaceBroker, Id: 'unexpected' }), false);
});

const descriptor = Object.freeze({
  operation: Object.freeze({
    authorizationIssuedAt: '2026-09-05T06:26:59.307Z',
    authorizationExpiresAt: '2026-09-06T06:26:59.307Z',
  }),
  execution: Object.freeze({
    executionId: 'ce4b031a-eb53-47d3-be0b-bd0948e094d8',
    claimId: '557fa1b3-4aa1-4c00-9627-c7f20b5442f9',
    phaseAttemptId: '78577957-286b-42d4-abf4-4203263481c9',
    generation: 28,
    contractId: '5462439a278ff0742d55bec18cecc489dc65b14a10d77d48c69bc74dd58af1ce',
    expectedBaselineSeq: 231872,
  }),
});

const validReceipt = Object.freeze({
  schemaVersion: 'forge-host-pre-ingress-orphan-conclusion/v1',
  recordedAt: '2026-09-05T07:00:00.000Z',
  operationId: 'bc1e4cac-899b-47dc-8587-dfe9b3e875e8',
  descriptorSha256: 'e3a09ba3af51113fd0ff39acb634f874e5502d6c286a891a4f9156c184b629e3',
  executionId: descriptor.execution.executionId,
  claimId: descriptor.execution.claimId,
  phaseAttemptId: descriptor.execution.phaseAttemptId,
  generation: descriptor.execution.generation,
  contractId: descriptor.execution.contractId,
  helperContainerId: '3e6410192e3850b469dfe6989dd04a9091255bee64d2752d7889ac4616dc0a37',
  helperExitCode: 1,
  failureCode: 'PHASE_CATALOG_CONTRACT_MISMATCH',
  helperStderrSha256: 'c096fa554b4bd2cc25aee0bddb39723de8b3af70efbc1e3281df0c255abac5f3',
  conclusionToolSha256: 'a'.repeat(64),
  hostRunnerSha256: '3ed632b975f43d3c48368c17ec82d3e3c9e78b03d6502eaedf8066372e18f32d',
  hostRunnerManifestSha256: '38dc1a394406dbec89eaecd8679084be77c234e5d016f9e2894081ef54f9d41b',
  hostRunnerTreeSha256: 'cb60c29d2be9cbf317250131917b0e69945d2fe97d2f02d7c5117ce29a59d2c6',
  descriptorFileSha256: 'fb0e09503581a26ed06c13e4475f3ba46fb1ac6bf23d8647dafb035f7c639366',
  executionStateSha256: '19c74f28feef8669c374bcc9449fe2d36836040e45c44236232ffe96766942b3',
  phaseStateSha256: '5e045c363972615d9602c0d9a48ebee20285a240d0372b75b9088de25fcc1653',
  durableSubmissionIntentPresent: false,
  preIngressContinuationPresent: false,
  responsePresent: false,
  requestObserved: false,
  observedSeq: descriptor.execution.expectedBaselineSeq,
  eventDigest: '14d44a31717170b66cc44eed0081f50df388fcc548130330d6f430ade8ae2244',
  safeToRestoreUserIngress: true,
  executionOrPhaseStateMutated: false,
  conclusion: 'exact-stable-pre-permit-pre-claim-pre-intent-pre-forward-pre-model-failure',
});

test('CLI mode is explicit and fail-closed', () => {
  assert.equal(parseConclusionMode(['--verify-only']), 'verify-only');
  assert.equal(parseConclusionMode(['--execute']), 'execute');
  for (const argv of [[], ['--execute', '--verify-only'], ['verify-only'], ['--dry-run']]) {
    assert.throws(
      () => parseConclusionMode(argv),
      (error) => error?.code === 'CONCLUSION_ARGUMENT_INVALID',
    );
  }
});

test('direct invocation without a mode refuses before any platform or remote check', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /CONCLUSION_ARGUMENT_INVALID/u);
});

test('verify-only dispatch never calls the mutation function', async () => {
  let verifications = 0;
  let executions = 0;
  const expected = Object.freeze({ mode: 'verify-only', status: 'verified-pre-ingress-boundary' });
  const result = await runConclusion(['--verify-only'], {
    verifyBoundary: async () => {
      verifications += 1;
      return { verificationReceipt: expected };
    },
    executeBoundary: async () => {
      executions += 1;
      throw new Error('must not execute');
    },
  });
  assert.deepEqual(result, expected);
  assert.equal(verifications, 1);
  assert.equal(executions, 0);
});

test('real verification path is structurally limited to the reviewed read-only preparation APIs', () => {
  const source = readFileSync(script, 'utf8');
  const preparation = source.slice(
    source.indexOf('async function prepareReadOnlyRecoveryInputs'),
    source.indexOf('function validateExecutionAndPhaseState'),
  );
  const verification = source.slice(
    source.indexOf('async function verifyPreIngressBoundary'),
    source.indexOf('function buildReceiptValue'),
  );
  assert.match(preparation, /prepareHostRecoveryReconciliationInputs/u);
  assert.match(preparation, /revalidateHostRecoveryInputs/u);
  assert.match(verification, /prepareReadOnlyRecoveryInputs/u);
  for (const body of [preparation, verification]) {
    assert.doesNotMatch(body, /\.prepareHostRecoveryInputs\s*\(/u);
    assert.doesNotMatch(
      body,
      /\b(?:writeExclusive|atomicReplace|chmod|chown|rename|unlink|mkdir)\s*\(/u,
    );
  }
});

test('execute dispatch requires a second complete verification', async () => {
  let verifications = 0;
  let executionContext;
  const contexts = [{ observation: 1 }, { observation: 2 }];
  const result = await runConclusion(['--execute'], {
    verifyBoundary: async () => contexts[verifications++],
    executeBoundary: async (context) => {
      executionContext = context;
      return { mode: 'execute', status: 'restored' };
    },
  });
  assert.equal(verifications, 2);
  assert.equal(executionContext, contexts[1]);
  assert.deepEqual(result, { mode: 'execute', status: 'restored' });
});

test('write plan is crash-resumable and idempotent only for reviewed state pairs', () => {
  assert.deepEqual(conclusionWritePlan({
    journalState: 'ambiguous-no-resend', fenceState: 'maintenance', receiptPresent: false,
  }), [
    'create-conclusion-receipt',
    'bind-conclusion-to-journal',
    'restore-original-fence',
    'record-restored-journal',
  ]);
  assert.deepEqual(conclusionWritePlan({
    journalState: 'ambiguous-no-resend', fenceState: 'maintenance', receiptPresent: true,
  }), ['bind-conclusion-to-journal', 'restore-original-fence', 'record-restored-journal']);
  assert.deepEqual(conclusionWritePlan({
    journalState: 'pre-ingress-host-concluded', fenceState: 'maintenance', receiptPresent: true,
  }), ['restore-original-fence', 'record-restored-journal']);
  assert.deepEqual(conclusionWritePlan({
    journalState: 'pre-ingress-host-concluded', fenceState: 'original', receiptPresent: true,
  }), ['record-restored-journal']);
  assert.deepEqual(conclusionWritePlan({
    journalState: 'restored', fenceState: 'original', receiptPresent: true,
  }), []);
  for (const state of [
    { journalState: 'ambiguous-no-resend', fenceState: 'original', receiptPresent: false },
    { journalState: 'pre-ingress-host-concluded', fenceState: 'maintenance', receiptPresent: false },
    { journalState: 'restored', fenceState: 'maintenance', receiptPresent: true },
  ]) {
    assert.throws(
      () => conclusionWritePlan(state),
      (error) => error?.code === 'CONCLUSION_STATE_INVALID',
    );
  }
});

test('conclusion receipt is atomically published only after complete durable staging', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-conclusion-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'conclusion.json');
  const bytes = Buffer.from('{"complete":true}\n', 'utf8');
  await assert.rejects(
    publishExclusiveAtomic(
      target,
      bytes,
      { mode: 0o600 },
      {
        beforePublish: async ({ file, temporary }) => {
          await assert.rejects(lstat(file), (error) => error?.code === 'ENOENT');
          assert.deepEqual(await readFile(temporary), bytes);
          throw new Error('injected-before-publish-crash');
        },
      },
    ),
    /injected-before-publish-crash/u,
  );
  await assert.rejects(lstat(target), (error) => error?.code === 'ENOENT');
  assert.deepEqual(await readdir(directory), []);

  await publishExclusiveAtomic(target, bytes, { mode: 0o600 });
  assert.deepEqual(await readFile(target), bytes);
  await assert.rejects(
    publishExclusiveAtomic(target, bytes, { mode: 0o600 }),
    (error) => error?.code === 'CONCLUSION_FILE_EXISTS',
  );
});

test('post-restore bookkeeping never depends on mutable DSH, execution, or phase state', () => {
  const source = readFileSync(script, 'utf8');
  const postRestore = source.slice(
    source.indexOf('async function assertPostRestoreState'),
    source.indexOf('async function executeVerifiedConclusion'),
  );
  assert.match(postRestore, /EXPECTED_ORIGINAL_FENCE_SHA256/u);
  assert.match(postRestore, /inspectCanaryBoundary/u);
  assert.match(postRestore, /observeStableFenceHealth/u);
  assert.doesNotMatch(postRestore, /readDsh/u);
  assert.doesNotMatch(postRestore, /readExactExecutionAndPhaseState/u);
  assert.doesNotMatch(postRestore, /revalidateHostRecoveryInputs/u);
  assert.doesNotMatch(postRestore, /assertPreMutationState/u);

  const postFenceExecute = source.slice(
    source.indexOf('const postRestore = await assertPostRestoreState(context)'),
    source.indexOf("status: 'restored'", source.indexOf('const postRestore = await assertPostRestoreState(context)')),
  );
  assert.match(postFenceExecute, /pre-ingress-host-concluded/u);
  assert.match(postFenceExecute, /hostConclusion\?\.sha256 !== receipt\.sha256/u);
  assert.match(postFenceExecute, /atomicReplace/u);
  assert.doesNotMatch(postFenceExecute, /readDsh/u);
  assert.doesNotMatch(postFenceExecute, /readExactExecutionAndPhaseState/u);
  assert.doesNotMatch(postFenceExecute, /revalidateHostRecoveryInputs/u);
  assert.doesNotMatch(postFenceExecute, /assertPreMutationState/u);
});

test('receipt validation binds every safety-critical conclusion field', () => {
  const options = { conclusionToolSha256: 'a'.repeat(64) };
  assert.equal(validateConclusionReceipt(validReceipt, descriptor, options), validReceipt);
  for (const mutation of [
    { helperStderrSha256: '0'.repeat(64) },
    { responsePresent: true },
    { requestObserved: true },
    { executionOrPhaseStateMutated: true },
    { conclusion: 'pre-ingress-ish' },
  ]) {
    assert.throws(
      () => validateConclusionReceipt({ ...validReceipt, ...mutation }, descriptor, options),
      (error) => error?.code === 'CONCLUSION_RECEIPT_INVALID',
    );
  }
});
