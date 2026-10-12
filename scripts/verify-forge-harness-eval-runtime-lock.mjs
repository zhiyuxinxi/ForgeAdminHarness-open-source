#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

const LOCK_SCHEMA = 'forge-harness-eval-runtime-trust-lock/v1';
const RECEIPT_SCHEMA = 'forge-harness-eval-runtime-trust-receipt/v1';
const PACKAGE_ID = 'forge-admin-harness/forge-harness-behavior-eval-runtime';
const PACKAGE_VERSION = '2026.09.14.3';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LOCK_BYTES = 256 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const EXPECTED_PATHS = Object.freeze([
  'docker/harness/forge-acceptance-aggregator.mjs',
  'docker/harness/forge-behavior-qualification.mjs',
  'docker/harness/forge-business-data-approval.mjs',
  'docker/harness/forge-business-data-consumption.mjs',
  'docker/harness/forge-business-data-preview.mjs',
  'docker/harness/forge-business-object-mutation.mjs',
  'docker/harness/forge-capability-negotiator.mjs',
  'docker/harness/forge-change-contract.mjs',
  'docker/harness/forge-completion-claim-guard.mjs',
  'docker/harness/forge-cross-layer-runtime-evidence.mjs',
  'docker/harness/forge-delivery-phase-controller.mjs',
  'docker/harness/forge-delivery-phase-response.mjs',
  'docker/harness/forge-delivery-phase-runtime.mjs',
  'docker/harness/forge-delivery-phase-workspace-observer.mjs',
  'docker/harness/forge-execution-capability-registry.json',
  'docker/harness/forge-execution-capability-registry.mjs',
  'docker/harness/forge-execution-context.mjs',
  'docker/harness/forge-execution-orchestrator.mjs',
  'docker/harness/forge-execution-pack.mjs',
  'docker/harness/forge-execution-store.mjs',
  'docker/harness/forge-governance-policy.json',
  'docker/harness/forge-host-verification-receipt.mjs',
  'docker/harness/forge-model-qualification.mjs',
  'docker/harness/forge-obligation-ledger.mjs',
  'docker/harness/forge-phase-budget-guard.mjs',
  'docker/harness/forge-phase-work-package.mjs',
  'docker/harness/forge-prepare-headless-execution.mjs',
  'docker/harness/forge-prepare-task.mjs',
  'docker/harness/forge-production-task-grant.mjs',
  'docker/harness/forge-progress-detector.mjs',
  'docker/harness/forge-protected-headless-runner.mjs',
  'docker/harness/forge-protected-issuer-adapter.mjs',
  'docker/harness/forge-protected-session-mode.mjs',
  'docker/harness/forge-recover-headless-execution.mjs',
  'docker/harness/forge-reference-adoption-coverage.json',
  'docker/harness/forge-reference-adoption-coverage.mjs',
  'docker/harness/forge-semantic-resource-lease.mjs',
  'docker/harness/forge-task-execution-contract.mjs',
  'docker/harness/forge-typed-file-removal.mjs',
  'docker/harness/forge-ui-edit-session.mjs',
  'docker/harness/forge-workflow-migration-safety.mjs',
  'docker/harness/skills.catalog.json',
  'docker/harness/skills/forge-task-router/references/phase-profiles.json',
  'docs/forge-governance-reference-adoption.md',
  'scripts/analyze-forge-harness-session.mjs',
  'scripts/forge-skill-bundle.mjs',
  'scripts/run-forge-protected-headless-recovery.mjs',
  'scripts/run-local-forge-harness-evals.sh',
  'scripts/snapshot-forge-harness-eval-inputs.mjs',
  'scripts/snapshot-local-secret.mjs',
  'tests/fixtures/forge-behavior-qualification/prompts/eval-fake-test-output.v1.md',
  'tests/fixtures/forge-behavior-qualification/prompts/eval-nonexistent-tool.v1.md',
  'tests/fixtures/forge-behavior-qualification/prompts/eval-stale-reference.v1.md',
  'tests/fixtures/forge-behavior-qualification/prompts/feasibility-readonly.v1.md',
  'tests/fixtures/forge-behavior-qualification/prompts/small-fix-routing.v1.md',
  'tests/fixtures/forge-behavior-qualification/suite.json',
  'tests/fixtures/forge-business-data-approval/valid.json',
  'tests/fixtures/forge-business-object-mutation/valid.json',
  'tests/fixtures/forge-change-contract/valid.json',
  'tests/fixtures/forge-harness-behavior-evals/execution-policy.test-shadow.json',
  'tests/fixtures/forge-harness-behavior-evals/headless-audit.patch.yml',
  'tests/fixtures/forge-harness-behavior-evals/prompts/adversarial-shortcuts.v1.md',
  'tests/fixtures/forge-harness-behavior-evals/prompts/crud-complete.v1.md',
  'tests/fixtures/forge-harness-behavior-evals/prompts/edge-pagination-shared-owner.v1.md',
  'tests/fixtures/forge-harness-behavior-evals/prompts/frontend-aicrudpage-api-contract.v1.md',
  'tests/fixtures/forge-harness-behavior-evals/suite.json',
  'tests/fixtures/forge-semantic-resource-lease/valid.json',
  'tests/fixtures/forge-ui-edit-session/valid.json',
  'tests/fixtures/forge-workflow-migration-safety/valid.json',
  'tests/forge-behavior-qualification.test.mjs',
  'tests/forge-business-data-approval.test.mjs',
  'tests/forge-business-data-consumption.test.mjs',
  'tests/forge-business-data-preview.test.mjs',
  'tests/forge-business-object-mutation.test.mjs',
  'tests/forge-change-contract.test.mjs',
  'tests/forge-delivery-phase-controller.test.mjs',
  'tests/forge-delivery-phase-response.test.mjs',
  'tests/forge-delivery-phase-runtime.test.mjs',
  'tests/forge-delivery-phase-workspace-observer.test.mjs',
  'tests/forge-execution-context.test.mjs',
  'tests/forge-model-qualification.test.mjs',
  'tests/forge-phase-work-package.test.mjs',
  'tests/forge-production-task-grant.test.mjs',
  'tests/forge-protected-headless-recovery-host.test.mjs',
  'tests/forge-protected-session-mode.test.mjs',
  'tests/forge-recover-headless-execution.test.mjs',
  'tests/forge-reference-adoption-coverage.test.mjs',
  'tests/forge-semantic-resource-lease.test.mjs',
  'tests/forge-task-execution-contract.test.mjs',
  'tests/forge-ui-edit-session.test.mjs',
  'tests/forge-workflow-migration-safety.test.mjs',
]);

const SAFE_MESSAGES = Object.freeze({
  usage: 'Invalid command arguments.',
  root: 'Runtime trust root is invalid.',
  lock: 'Runtime trust lock is invalid or changed while being read.',
  entry: 'Runtime trust entry is invalid or changed while being read.',
  mismatch: 'Runtime trust content does not match the external lock.',
});

class SafeError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.mismatch);
    this.name = 'SafeError';
    this.code = code;
  }
}

function fail(code) {
  throw new SafeError(code);
}

function usage() {
  return 'Usage: node verify-forge-harness-eval-runtime-lock.mjs verify --repository-root DIR --lock FILE --expected-runner-sha256 HEX';
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'help' };
  if (argv[0] !== 'verify') fail('usage');
  const values = { command: 'verify' };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || typeof value !== 'string' || value.length === 0) {
      fail('usage');
    }
    const name = flag.slice(2);
    if (Object.hasOwn(values, name)) fail('usage');
    values[name] = value;
  }
  const expected = ['expected-runner-sha256', 'lock', 'repository-root'];
  const actual = Object.keys(values).filter((name) => name !== 'command').sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail('usage');
  if (!SHA256_PATTERN.test(values['expected-runner-sha256'])) fail('usage');
  return values;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function metadataIdentity(info) {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.nlink,
    info.uid,
    info.gid,
    info.rdev,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
  ].join(':');
}

function stableRead(file, maximumBytes, failureCode) {
  let before;
  try {
    before = lstatSync(file);
  } catch {
    fail(failureCode);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > maximumBytes) fail(failureCode);
  let first;
  let middle;
  let second;
  let after;
  try {
    first = readFileSync(file);
    middle = lstatSync(file);
    second = readFileSync(file);
    after = lstatSync(file);
  } catch {
    fail(failureCode);
  }
  if (metadataIdentity(before) !== metadataIdentity(middle)
    || metadataIdentity(middle) !== metadataIdentity(after)
    || first.length !== after.size
    || !first.equals(second)) fail(failureCode);
  return first;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function checkedPortablePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value.includes('\\') || value.includes('\0') || isAbsolute(value)) fail('lock');
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) fail('lock');
  return value;
}

function resolveInside(root, portable) {
  const target = resolve(root, ...checkedPortablePath(portable).split('/'));
  if (!target.startsWith(`${root}${sep}`)) fail('lock');
  return target;
}

function verify(values) {
  let repositoryRoot;
  let lockPath;
  try {
    const suppliedRoot = lstatSync(values['repository-root']);
    if (!suppliedRoot.isDirectory() || suppliedRoot.isSymbolicLink()) fail('root');
    repositoryRoot = realpathSync(values['repository-root']);
  } catch {
    fail('root');
  }
  try {
    const suppliedLock = lstatSync(values.lock);
    if (!suppliedLock.isFile() || suppliedLock.isSymbolicLink() || suppliedLock.nlink !== 1) fail('lock');
    lockPath = realpathSync(values.lock);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail('lock');
  }
  const rootInfo = lstatSync(repositoryRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('root');
  const lockBytes = stableRead(lockPath, MAX_LOCK_BYTES, 'lock');
  let lock;
  try {
    lock = JSON.parse(lockBytes.toString('utf8'));
  } catch {
    fail('lock');
  }
  if (!exactKeys(lock, ['schemaVersion', 'packageId', 'packageVersion', 'entries', 'assuranceBoundaries'])
    || lock.schemaVersion !== LOCK_SCHEMA
    || lock.packageId !== PACKAGE_ID
    || lock.packageVersion !== PACKAGE_VERSION
    || !Array.isArray(lock.entries)
    || !exactKeys(lock.assuranceBoundaries, [
      'contentAddressed',
      'gitCommitIdentityProven',
      'signedAttestation',
      'sameHostMaliciousTamperingExcluded',
    ])
    || lock.assuranceBoundaries.contentAddressed !== true
    || lock.assuranceBoundaries.gitCommitIdentityProven !== false
    || lock.assuranceBoundaries.signedAttestation !== false
    || lock.assuranceBoundaries.sameHostMaliciousTamperingExcluded !== false) fail('lock');

  const entries = new Map();
  for (const entry of lock.entries) {
    if (!exactKeys(entry, ['path', 'sha256', 'bytes'])
      || !SHA256_PATTERN.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 1
      || entry.bytes > MAX_ENTRY_BYTES) fail('lock');
    const portable = checkedPortablePath(entry.path);
    if (entries.has(portable)) fail('lock');
    entries.set(portable, entry);
  }
  const observedPaths = [...entries.keys()].sort();
  if (JSON.stringify(observedPaths) !== JSON.stringify(EXPECTED_PATHS)) fail('lock');

  for (const portable of EXPECTED_PATHS) {
    const entry = entries.get(portable);
    const bytes = stableRead(resolveInside(repositoryRoot, portable), MAX_ENTRY_BYTES, 'entry');
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail('mismatch');
  }
  if (entries.get('scripts/run-local-forge-harness-evals.sh').sha256
    !== values['expected-runner-sha256']) fail('mismatch');

  return {
    schemaVersion: RECEIPT_SCHEMA,
    packageId: PACKAGE_ID,
    packageVersion: PACKAGE_VERSION,
    lockSha256: sha256(lockBytes),
    lockBytes: lockBytes.length,
    entryCount: EXPECTED_PATHS.length,
    runnerSha256: values['expected-runner-sha256'],
    contentAddressed: true,
    gitCommitIdentityProven: false,
    signedAttestation: false,
    sameHostMaliciousTamperingExcluded: false,
  };
}

try {
  const values = parseArgs(process.argv.slice(2));
  if (values.command === 'help') {
    process.stdout.write(`${usage()}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(verify(values))}\n`);
  }
} catch (error) {
  const safe = error instanceof SafeError ? error.message : SAFE_MESSAGES.mismatch;
  process.stderr.write(`${safe}\n`);
  process.exitCode = 2;
}
