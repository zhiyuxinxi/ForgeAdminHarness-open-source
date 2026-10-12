import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DeliveryError,
  ForgeDeliveryStore,
  executeCommand,
} from '../docker/harness/forge-delivery.mjs';

const execFileAsync = promisify(execFile);
const wrapperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'harness', 'forge-delivery');

async function git(root, ...args) {
  return execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

async function fixture({ ignoreDeliveryState = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-delivery-test-'));
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Forge Delivery Test');
  await git(root, 'config', 'user.email', 'forge-delivery@example.invalid');
  await writeFile(path.join(root, 'app.txt'), 'initial\n');
  if (ignoreDeliveryState) await writeFile(path.join(root, '.git', 'info', 'exclude'), '/.forge-delivery/\n');
  await git(root, 'add', 'app.txt');
  await git(root, 'commit', '-m', 'initial');
  return { root, store: new ForgeDeliveryStore(root) };
}

async function removeFixture(value) {
  await rm(value.root, { recursive: true, force: true });
}

async function pathExists(candidate) {
  return stat(candidate).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

function shellPath(candidate) {
  return candidate.replaceAll('\\', '/').replaceAll("'", "'\\''");
}

async function advanceToVerifying(store, changeId = 'feature_one') {
  await store.initChange({ changeId, objective: 'Implement a bounded local feature', idempotencyKey: 'init-key-0001' });
  await store.transitionChange({ changeId, to: 'designed', expectedVersion: 1, idempotencyKey: 'transition-0001' });
  await store.transitionChange({ changeId, to: 'implementing', expectedVersion: 2, idempotencyKey: 'transition-0002' });
  await store.transitionChange({ changeId, to: 'implemented', expectedVersion: 3, idempotencyKey: 'transition-0003' });
  await store.transitionChange({ changeId, to: 'verifying', expectedVersion: 4, idempotencyKey: 'transition-0004' });
}

test('change state uses legal transitions, CAS, and durable idempotency', async () => {
  const value = await fixture();
  try {
    const first = await value.store.initChange({
      changeId: 'feature_one',
      objective: 'Implement one bounded capability',
      idempotencyKey: 'init-feature-001',
    });
    assert.equal(first.idempotent, false);
    assert.equal(first.change.state, 'scoped');
    assert.equal(first.change.version, 1);
    assert.equal((await value.store.inspectWorktree()).clean, true);

    const replayedInit = await value.store.initChange({
      changeId: 'feature_one',
      objective: 'Implement one bounded capability',
      idempotencyKey: 'init-feature-001',
    });
    assert.equal(replayedInit.idempotent, true);
    assert.equal(replayedInit.change.version, 1);

    const designed = await value.store.transitionChange({
      changeId: 'feature_one',
      to: 'designed',
      expectedVersion: 1,
      idempotencyKey: 'design-feature-01',
    });
    assert.equal(designed.idempotent, false);
    assert.equal(designed.change.version, 2);

    const replayedTransition = await value.store.transitionChange({
      changeId: 'feature_one',
      to: 'designed',
      expectedVersion: 1,
      idempotencyKey: 'design-feature-01',
    });
    assert.equal(replayedTransition.idempotent, true);
    assert.equal(replayedTransition.change.version, 2);

    await assert.rejects(
      value.store.transitionChange({
        changeId: 'feature_one', to: 'implementing', expectedVersion: 1, idempotencyKey: 'stale-version-001',
      }),
      (error) => error instanceof DeliveryError && error.code === 'VERSION_CONFLICT',
    );
    await assert.rejects(
      value.store.transitionChange({
        changeId: 'feature_one', to: 'implementing', expectedVersion: 2, idempotencyKey: 'design-feature-01',
      }),
      (error) => error instanceof DeliveryError && error.code === 'IDEMPOTENCY_CONFLICT',
    );

    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(value.root, '.forge-delivery'))).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(value.root, '.forge-delivery', 'changes', 'feature_one.json'))).mode & 0o777, 0o600);
    }
  } finally {
    await removeFixture(value);
  }
});

test('change status rejects unknown schema and tampered state without repairing either record', async () => {
  const value = await fixture();
  try {
    await value.store.initChange({ changeId: 'feature_one', objective: 'Validate protected state reads', idempotencyKey: 'init-feature-001' });
    const file = path.join(value.root, '.forge-delivery', 'changes', 'feature_one.json');
    const valid = JSON.parse(await readFile(file, 'utf8'));
    for (const [patch, code] of [[{ schemaVersion: 99 }, 'INVALID_CHANGE_RECORD'], [{ state: 'implemented' }, 'CHANGE_TAMPERED']]) {
      const bytes = Buffer.from(JSON.stringify({ ...valid, ...patch }) + '\n');
      await writeFile(file, bytes);
      await assert.rejects(value.store.statusChange('feature_one'), error => error instanceof DeliveryError && error.code === code);
      assert.deepEqual(await readFile(file), bytes, 'a failed read cannot silently rewrite the original failure');
    }
  } finally {
    await removeFixture(value);
  }
});

test('illegal transitions fail closed without mutating the state version', async () => {
  const value = await fixture();
  try {
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Keep transition ordering explicit', idempotencyKey: 'init-feature-001',
    });
    await assert.rejects(
      value.store.transitionChange({
        changeId: 'feature_one', to: 'implemented', expectedVersion: 1, idempotencyKey: 'skip-stages-0001',
      }),
      (error) => error instanceof DeliveryError && error.code === 'ILLEGAL_STATE_TRANSITION',
    );
    const status = await value.store.statusChange('feature_one');
    assert.equal(status.change.state, 'scoped');
    assert.equal(status.change.version, 1);
  } finally {
    await removeFixture(value);
  }
});

test('change init fails before writing when .forge-delivery is not ignored', async () => {
  const value = await fixture({ ignoreDeliveryState: false });
  try {
    await assert.rejects(
      value.store.initChange({
        changeId: 'feature_one', objective: 'Require a reviewed ignore rule', idempotencyKey: 'init-feature-001',
      }),
      (error) => error instanceof DeliveryError && error.code === 'DELIVERY_STATE_NOT_IGNORED',
    );
    await assert.rejects(stat(path.join(value.root, '.forge-delivery')), /ENOENT/u);
  } finally {
    await removeFixture(value);
  }
});

test('a repository .gitignore rule cannot replace the platform clone-private exclude contract', async () => {
  const value = await fixture({ ignoreDeliveryState: false });
  try {
    await writeFile(path.join(value.root, '.gitignore'), '/.forge-delivery/\n');
    await assert.rejects(
      value.store.initChange({
        changeId: 'feature_one', objective: 'Require a clone-private state exclusion', idempotencyKey: 'init-feature-001',
      }),
      (error) => error instanceof DeliveryError && error.code === 'DELIVERY_STATE_NOT_PRIVATELY_IGNORED',
    );
  } finally {
    await removeFixture(value);
  }
});

test('the wrapper resolves its adjacent source module without relying on the current directory', async () => {
  const { stdout } = await execFileAsync(process.execPath, [wrapperPath, '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.match(stdout, /Self-recorded argv, exit codes, and logs/u);
});

test('handoff binds source hashes, commit, and change version and detects tampering', async () => {
  const value = await fixture();
  try {
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Create a content-addressed handoff', idempotencyKey: 'init-feature-001',
    });
    const created = await value.store.createHandoff({
      handoffId: 'design_handoff', changeId: 'feature_one', sourcePaths: ['app.txt'],
    });
    assert.equal(created.idempotent, false);
    assert.equal(created.handoff.changeVersion, 1);
    assert.match(created.handoff.sources[0].sha256, /^[0-9a-f]{64}$/u);
    assert.equal((await value.store.verifyHandoff('design_handoff')).recordIntegrityValid, true);

    const replayed = await value.store.createHandoff({
      handoffId: 'design_handoff', changeId: 'feature_one', sourcePaths: ['app.txt'],
    });
    assert.equal(replayed.idempotent, true);

    await writeFile(path.join(value.root, 'app.txt'), 'tampered\n');
    await assert.rejects(
      value.store.verifyHandoff('design_handoff'),
      (error) => error instanceof DeliveryError && error.code === 'HANDOFF_SOURCE_TAMPERED',
    );

    await writeFile(path.join(value.root, 'app.txt'), 'initial\n');
    const handoffPath = path.join(value.root, '.forge-delivery', 'handoffs', 'design_handoff.json');
    const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
    handoff.sources[0].bytes += 1;
    await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
    await assert.rejects(
      value.store.verifyHandoff('design_handoff'),
      (error) => error instanceof DeliveryError && error.code === 'HANDOFF_TAMPERED',
    );
  } finally {
    await removeFixture(value);
  }
});

test('handoff rejects state-version and Git commit drift', async () => {
  const value = await fixture();
  try {
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Reject stale handoffs', idempotencyKey: 'init-feature-001',
    });
    await value.store.createHandoff({ handoffId: 'state_handoff', changeId: 'feature_one', sourcePaths: ['app.txt'] });
    await value.store.transitionChange({
      changeId: 'feature_one', to: 'designed', expectedVersion: 1, idempotencyKey: 'design-feature-01',
    });
    await assert.rejects(
      value.store.verifyHandoff('state_handoff'),
      (error) => error instanceof DeliveryError && error.code === 'STALE_HANDOFF_STATE',
    );

    await value.store.createHandoff({ handoffId: 'commit_handoff', changeId: 'feature_one', sourcePaths: ['app.txt'] });
    await writeFile(path.join(value.root, 'new-file.txt'), 'new commit\n');
    await git(value.root, 'add', 'new-file.txt');
    await git(value.root, 'commit', '-m', 'advance HEAD');
    await assert.rejects(
      value.store.verifyHandoff('commit_handoff'),
      (error) => error instanceof DeliveryError && error.code === 'STALE_HANDOFF_COMMIT',
    );
  } finally {
    await removeFixture(value);
  }
});

test('identifiers and repository-relative evidence paths reject traversal', async () => {
  const value = await fixture();
  try {
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Reject paths outside the project', idempotencyKey: 'init-feature-001',
    });
    await assert.rejects(
      value.store.createHandoff({ handoffId: '../escape', changeId: 'feature_one', sourcePaths: ['app.txt'] }),
      (error) => error instanceof DeliveryError && error.code === 'INVALID_IDENTIFIER',
    );
    await assert.rejects(
      value.store.createHandoff({ handoffId: 'escape_test', changeId: 'feature_one', sourcePaths: ['../outside.txt'] }),
      (error) => error instanceof DeliveryError && error.code === 'INVALID_RELATIVE_PATH',
    );
    await assert.rejects(
      value.store.createHandoff({ handoffId: 'state_as_source', changeId: 'feature_one', sourcePaths: ['.forge-delivery/changes/feature_one.json'] }),
      (error) => error instanceof DeliveryError && error.code === 'FORBIDDEN_EVIDENCE_PATH',
    );
    assert.equal(await stat(path.dirname(value.root)).then(() => true), true);
  } finally {
    await removeFixture(value);
  }
});

test('handoff canonicalizes path separators before de-duplication and remains readable', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.root, 'folder'));
    await writeFile(path.join(value.root, 'folder', 'file.txt'), 'canonical source\n');
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Canonicalize handoff paths', idempotencyKey: 'init-feature-001',
    });
    const created = await value.store.createHandoff({
      handoffId: 'canonical_handoff',
      changeId: 'feature_one',
      sourcePaths: ['folder/file.txt', 'folder\\file.txt'],
    });
    assert.equal(created.handoff.sources.length, 1);
    assert.equal(created.handoff.sources[0].path, 'folder/file.txt');
    assert.equal((await value.store.verifyHandoff('canonical_handoff')).recordIntegrityValid, true);
  } finally {
    await removeFixture(value);
  }
});

test('worktree inspect is read-only and classifies repository-relative changes', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.root, 'docs'));
    await mkdir(path.join(value.root, 'tests'));
    await mkdir(path.join(value.root, 'db', 'migration'), { recursive: true });
    await writeFile(path.join(value.root, 'app.txt'), 'changed\n');
    await writeFile(path.join(value.root, 'docs', 'design.md'), '# Design\n');
    await writeFile(path.join(value.root, 'tests', 'feature.test.mjs'), 'export {};\n');
    await writeFile(path.join(value.root, 'db', 'migration', 'V2__feature.sql'), 'select 1;\n');

    const inspected = await value.store.inspectWorktree();
    assert.equal(inspected.clean, false);
    assert.equal(inspected.entries.every((entry) => !path.isAbsolute(entry.path)), true);
    assert.equal(inspected.entries.some((entry) => entry.category === 'source'), true);
    assert.equal(inspected.entries.some((entry) => entry.category === 'documentation'), true);
    assert.equal(inspected.entries.some((entry) => entry.category === 'test'), true);
    assert.equal(inspected.entries.some((entry) => entry.category === 'migration'), true);
    await assert.rejects(stat(path.join(value.root, '.forge-delivery')), /ENOENT/u);
  } finally {
    await removeFixture(value);
  }
});

test('Git environment, config, hooks, aliases, and PATH cannot redirect read-only discovery or classification', async () => {
  const value = await fixture();
  const decoy = await fixture();
  try {
    const fsmonitorMarker = path.join(value.root, 'fsmonitor-invoked.txt');
    const aliasMarker = path.join(value.root, 'alias-invoked.txt');
    const traceMarker = path.join(value.root, 'git-trace.txt');
    const fakeGitMarker = path.join(value.root, 'fake-git-invoked.txt');
    const externalDiffMarker = path.join(value.root, 'external-diff-invoked.txt');
    const fsmonitorHook = path.join(value.root, '.git', 'hooks', 'hostile-fsmonitor');
    const externalDiff = path.join(value.root, '.git', 'hooks', 'hostile-diff');
    const fakeBin = path.join(value.root, 'hostile-bin');
    const fakeGit = path.join(fakeBin, process.platform === 'win32' ? 'git.exe' : 'git');
    const hostileGlobalConfig = path.join(value.root, 'hostile-global.gitconfig');

    await mkdir(path.join(value.root, 'docs'));
    await mkdir(fakeBin);
    await writeFile(path.join(decoy.root, 'decoy-base.txt'), 'different committed history\n');
    await git(decoy.root, 'add', 'decoy-base.txt');
    await git(decoy.root, 'commit', '-m', 'different decoy HEAD');
    const actualCommit = (await git(value.root, 'rev-parse', '--verify', 'HEAD')).stdout.trim();
    const decoyCommit = (await git(decoy.root, 'rev-parse', '--verify', 'HEAD')).stdout.trim();
    assert.notEqual(actualCommit, decoyCommit);
    await writeFile(path.join(value.root, 'app.txt'), 'actual root changed\n');
    await writeFile(path.join(value.root, 'docs', 'actual.md'), '# Actual repository\n');
    await writeFile(path.join(decoy.root, 'decoy.txt'), 'decoy-only change\n');
    await writeFile(fsmonitorHook, [
      '#!/bin/sh',
      `printf fsmonitor-invoked > '${shellPath(fsmonitorMarker)}'`,
      'exit 1',
      '',
    ].join('\n'));
    await writeFile(externalDiff, [
      '#!/bin/sh',
      `printf external-diff-invoked > '${shellPath(externalDiffMarker)}'`,
      'exit 1',
      '',
    ].join('\n'));
    await writeFile(fakeGit, [
      '#!/bin/sh',
      `printf fake-git-invoked > '${shellPath(fakeGitMarker)}'`,
      'exit 97',
      '',
    ].join('\n'));
    await Promise.all([
      chmod(fsmonitorHook, 0o755).catch(() => {}),
      chmod(externalDiff, 0o755).catch(() => {}),
      chmod(fakeGit, 0o755).catch(() => {}),
    ]);
    await git(value.root, 'config', 'core.fsmonitor', shellPath(fsmonitorHook));
    await git(value.root, 'config', 'core.hooksPath', shellPath(path.dirname(fsmonitorHook)));
    await git(value.root, 'config', 'alias.fd-probe', `!printf alias-invoked > '${shellPath(aliasMarker)}'`);
    await git(value.root, 'config', 'alias.status', `!printf alias-invoked > '${shellPath(aliasMarker)}'`);
    await writeFile(hostileGlobalConfig, [
      '[core]',
      `\tfsmonitor = ${shellPath(fsmonitorHook)}`,
      '[alias]',
      `\trev-parse = !printf alias-invoked > '${shellPath(aliasMarker)}'`,
      '',
    ].join('\n'));

    await git(value.root, 'fd-probe');
    assert.equal(await pathExists(aliasMarker), true, 'the hostile alias fixture must be executable without hardening');
    await rm(aliasMarker);
    const fsmonitorProbe = await git(value.root, 'status', '--porcelain');
    assert.equal(
      await pathExists(fsmonitorMarker),
      true,
      `the hostile fsmonitor fixture must execute without hardening: ${fsmonitorProbe.stderr}`,
    );
    await rm(fsmonitorMarker);

    const indexBefore = await stat(path.join(value.root, '.git', 'index'));
    const hostileEnvironment = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      TEMP: value.root,
      TMP: value.root,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(decoy.root, '.git', 'objects'),
      GIT_CEILING_DIRECTORIES: value.root,
      GIT_COMMON_DIR: path.join(decoy.root, '.git'),
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_GLOBAL: hostileGlobalConfig,
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_KEY_1: 'alias.symbolic-ref',
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_PARAMETERS: 'malformed-config-parameters',
      GIT_CONFIG_SYSTEM: hostileGlobalConfig,
      GIT_CONFIG_VALUE_0: shellPath(fsmonitorHook),
      GIT_CONFIG_VALUE_1: `!printf alias-invoked > '${shellPath(aliasMarker)}'`,
      GIT_DIR: path.join(decoy.root, '.git'),
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
      GIT_EXEC_PATH: fakeBin,
      GIT_EXTERNAL_DIFF: externalDiff,
      GIT_GRAFT_FILE: path.join(decoy.root, '.git', 'info', 'grafts'),
      GIT_INDEX_FILE: path.join(decoy.root, '.git', 'index'),
      GIT_NAMESPACE: 'redirected',
      GIT_OBJECT_DIRECTORY: path.join(decoy.root, '.git', 'objects'),
      GIT_OPTIONAL_LOCKS: '1',
      GIT_PAGER: externalDiff,
      GIT_PREFIX: 'redirected/',
      GIT_SHALLOW_FILE: path.join(decoy.root, '.git', 'shallow'),
      GIT_TRACE: traceMarker,
      GIT_TRACE2_EVENT: traceMarker,
      GIT_WORK_TREE: decoy.root,
    };
    const { stdout } = await execFileAsync(process.execPath, [wrapperPath, 'worktree', 'inspect'], {
      cwd: value.root,
      encoding: 'utf8',
      env: hostileEnvironment,
    });
    const inspected = JSON.parse(stdout);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.commit, actualCommit);
    assert.notEqual(inspected.commit, decoyCommit);
    assert.equal(inspected.clean, false);
    assert.equal(inspected.entries.some((entry) => entry.path === 'app.txt' && entry.category === 'source'), true);
    assert.equal(inspected.entries.some((entry) => entry.path === 'docs/actual.md' && entry.category === 'documentation'), true);
    assert.equal(inspected.entries.some((entry) => entry.path === 'decoy.txt'), false);
    assert.equal(inspected.entries.some((entry) => entry.path.startsWith('forge-delivery-empty-hooks-')), false);
    assert.equal((await stat(path.join(value.root, '.git', 'index'))).mtimeMs, indexBefore.mtimeMs);
    for (const marker of [fsmonitorMarker, aliasMarker, traceMarker, fakeGitMarker, externalDiffMarker]) {
      assert.equal(await pathExists(marker), false, `${path.basename(marker)} must not be created by hardened Git reads`);
    }
    await assert.rejects(stat(path.join(value.root, '.forge-delivery')), /ENOENT/u);
  } finally {
    await Promise.all([removeFixture(value), removeFixture(decoy)]);
  }
});

test('self-recorded verification is commit/log bound and can authorize only evidence-recorded', async () => {
  const value = await fixture();
  try {
    await advanceToVerifying(value.store);
    await writeFile(path.join(value.root, 'verification.log'), '12 tests passed\n');
    const recorded = await value.store.recordVerification({
      verificationId: 'unit_tests',
      changeId: 'feature_one',
      argv: ['node', '--test', 'tests/feature.test.mjs'],
      exitCode: 0,
      logPath: 'verification.log',
    });
    assert.equal(recorded.recordedExitCodeZero, true);
    assert.equal(recorded.executionProven, false);
    assert.equal(recorded.verificationProven, false);
    assert.equal(recorded.record.authority, 'self-recorded-local');

    const checked = await value.store.checkVerification('unit_tests');
    assert.equal(checked.recordIntegrityValid, true);
    assert.equal(checked.recordedExitCodeZero, true);
    assert.equal(checked.executionProven, false);
    assert.equal(checked.verificationProven, false);
    assert.equal(checked.releaseProven, false);
    assert.equal(checked.deploymentProven, false);

    const evidence = await value.store.verifyEvidence({ changeId: 'feature_one', verificationIds: ['unit_tests'] });
    assert.equal(evidence.recordIntegrityValid, true);
    assert.equal(evidence.authority, 'self-recorded-local');
    assert.equal(evidence.executionProven, false);
    assert.equal(evidence.verificationProven, false);
    assert.equal(evidence.releaseProven, false);

    const recordedState = await value.store.transitionChange({
      changeId: 'feature_one',
      to: 'evidence-recorded',
      expectedVersion: 5,
      idempotencyKey: 'evidence-state-01',
      verificationIds: ['unit_tests'],
    });
    assert.equal(recordedState.change.state, 'evidence-recorded');
    assert.equal(recordedState.change.version, 6);
    assert.equal((await value.store.checkVerification('unit_tests')).consumedByEvidenceRecordedTransition, true);
    const afterTransition = await value.store.verifyEvidence({ changeId: 'feature_one', verificationIds: ['unit_tests'] });
    assert.equal(afterTransition.recordIntegrityValid, true);
    assert.equal(afterTransition.verificationProven, false);
  } finally {
    await removeFixture(value);
  }
});

test('failed, absent, tampered, or natural-language evidence never produces false success', async () => {
  const value = await fixture();
  try {
    await advanceToVerifying(value.store);
    await writeFile(path.join(value.root, 'failed.log'), '1 test failed\n');
    const failed = await value.store.recordVerification({
      verificationId: 'failed_tests',
      changeId: 'feature_one',
      argv: ['node', '--test'],
      exitCode: 1,
      logPath: 'failed.log',
    });
    assert.equal(failed.recordedExitCodeZero, false);
    assert.equal((await value.store.checkVerification('failed_tests')).recordedExitCodeZero, false);
    await assert.rejects(
      value.store.verifyEvidence({ changeId: 'feature_one', verificationIds: ['failed_tests'] }),
      (error) => error instanceof DeliveryError && error.code === 'VERIFICATION_FAILED',
    );
    await assert.rejects(
      value.store.transitionChange({
        changeId: 'feature_one', to: 'evidence-recorded', expectedVersion: 5, idempotencyKey: 'no-evidence-0001', verificationIds: [],
      }),
      (error) => error instanceof DeliveryError && error.code === 'VERIFICATION_EVIDENCE_REQUIRED',
    );
    await assert.rejects(
      executeCommand(['evidence', 'verify', '--change', 'feature_one', '--statement', 'tests passed'], { cwd: value.root }),
      (error) => error instanceof DeliveryError && error.code === 'UNKNOWN_OPTION',
    );

    const recordPath = path.join(value.root, '.forge-delivery', 'verifications', 'failed_tests.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.exitCode = 0;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await assert.rejects(
      value.store.checkVerification('failed_tests'),
      (error) => error instanceof DeliveryError && error.code === 'VERIFICATION_TAMPERED',
    );
  } finally {
    await removeFixture(value);
  }
});

test('secret-bearing verification argv is rejected before any record is written', async () => {
  const value = await fixture();
  try {
    await advanceToVerifying(value.store);
    await writeFile(path.join(value.root, 'verification.log'), 'command was intentionally not recorded\n');
    for (const [verificationId, argv] of [
      ['header_secret', ['curl', '-H', 'Authorization: Bearer secret-value']],
      ['compact_password', ['mysql', '-pSecretValue']],
      ['scheme_secret', ['tool', 'Bearer opaque-value']],
    ]) {
      await assert.rejects(
        value.store.recordVerification({
          verificationId, changeId: 'feature_one', argv, exitCode: 0, logPath: 'verification.log',
        }),
        (error) => error instanceof DeliveryError && error.code === 'SECRET_LIKE_ARGV',
      );
    }
    const verificationDirectory = path.join(value.root, '.forge-delivery', 'verifications');
    assert.deepEqual(await readdir(verificationDirectory), []);
  } finally {
    await removeFixture(value);
  }
});

test('verification log tampering and commit drift invalidate a previously successful record', async () => {
  const value = await fixture();
  try {
    await advanceToVerifying(value.store);
    await writeFile(path.join(value.root, 'verification.log'), 'tests passed\n');
    await value.store.recordVerification({
      verificationId: 'unit_tests', changeId: 'feature_one', argv: ['node', '--test'], exitCode: 0, logPath: 'verification.log',
    });
    await writeFile(path.join(value.root, 'verification.log'), 'different output\n');
    await assert.rejects(
      value.store.checkVerification('unit_tests'),
      (error) => error instanceof DeliveryError && error.code === 'VERIFICATION_LOG_TAMPERED',
    );

    await writeFile(path.join(value.root, 'verification.log'), 'tests passed\n');
    await writeFile(path.join(value.root, 'new-file.txt'), 'new commit\n');
    await git(value.root, 'add', 'new-file.txt');
    await git(value.root, 'commit', '-m', 'drift');
    await assert.rejects(
      value.store.checkVerification('unit_tests'),
      (error) => error instanceof DeliveryError && error.code === 'STALE_VERIFICATION_COMMIT',
    );
  } finally {
    await removeFixture(value);
  }
});

test('an interrupted Windows-style replacement backup is recoverable without losing the last valid state', async () => {
  const value = await fixture();
  try {
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Recover the last atomic state', idempotencyKey: 'init-feature-001',
    });
    const statePath = path.join(value.root, '.forge-delivery', 'changes', 'feature_one.json');
    const backupPath = `${statePath}.replace-backup`;
    const before = await readFile(statePath, 'utf8');
    await rename(statePath, backupPath);

    const recovered = await value.store.statusChange('feature_one');
    assert.equal(recovered.change.version, 1);
    assert.equal(await readFile(statePath, 'utf8'), before);
    await assert.rejects(stat(backupPath), /ENOENT/u);
  } finally {
    await removeFixture(value);
  }
});

test('foreign locks remain fail-closed after expiry while a dead same-host owner is recoverable', async () => {
  const now = '2026-08-30T10:00:00.000Z';
  const value = await fixture();
  const store = new ForgeDeliveryStore(value.root, { now: () => now });
  try {
    await store.ensureWritableState();
    const stateLock = path.join(value.root, '.forge-delivery', 'locks', 'global-state.lock');
    await writeFile(stateLock, `${JSON.stringify({
      schemaVersion: 1,
      pid: 41,
      hostname: 'another-host.invalid',
      nonce: 'foreign-fresh-owner',
      at: '2026-08-30T09:59:00.000Z',
    })}\n`);
    await assert.rejects(
      store.initChange({
        changeId: 'fresh_change', objective: 'Do not steal a live foreign lease', idempotencyKey: 'fresh-lock-0001',
      }),
      (error) => error instanceof DeliveryError && error.code === 'CHANGE_LOCKED',
    );
    await rm(stateLock);

    await writeFile(stateLock, `${JSON.stringify({
      schemaVersion: 1,
      pid: 42,
      hostname: 'another-host.invalid',
      nonce: 'foreign-stale-owner',
      at: '2026-08-30T09:40:00.000Z',
    })}\n`);
    await assert.rejects(
      store.initChange({
        changeId: 'stale_change', objective: 'Do not steal an expired foreign lease', idempotencyKey: 'stale-lock-0001',
      }),
      (error) => error instanceof DeliveryError && error.code === 'STALE_CHANGE_LOCK_REVIEW_REQUIRED',
    );
    await rm(stateLock);

    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid;
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await writeFile(stateLock, `${JSON.stringify({
      schemaVersion: 1,
      pid: deadPid,
      hostname: os.hostname(),
      nonce: 'dead-same-host-owner',
      at: '2026-08-30T09:59:00.000Z',
    })}\n`);
    const recovered = await store.initChange({
      changeId: 'recovered_change', objective: 'Recover a provably dead same-host owner', idempotencyKey: 'dead-lock-0001',
    });
    assert.equal(recovered.change.state, 'scoped');
    assert.equal(await pathExists(stateLock), false);
  } finally {
    await removeFixture(value);
  }
});

test('the global mutation lock makes category capacity scan and write atomic across changes', async () => {
  const value = await fixture();
  try {
    await value.store.ensureWritableState();
    const handoffDirectory = path.join(value.root, '.forge-delivery', 'handoffs');
    const writes = [];
    for (let index = 0; index < 2047; index += 1) {
      writes.push(writeFile(path.join(handoffDirectory, `retained_${String(index).padStart(4, '0')}.json`), '{}\n'));
      if (writes.length === 128) await Promise.all(writes.splice(0));
    }
    await Promise.all(writes);
    await value.store.initChange({
      changeId: 'change_one', objective: 'Compete for one retained slot', idempotencyKey: 'init-change-0001',
    });
    await value.store.initChange({
      changeId: 'change_two', objective: 'Compete for one retained slot', idempotencyKey: 'init-change-0002',
    });
    const results = await Promise.allSettled([
      value.store.createHandoff({ handoffId: 'last_slot_one', changeId: 'change_one', sourcePaths: ['app.txt'] }),
      value.store.createHandoff({ handoffId: 'last_slot_two', changeId: 'change_two', sourcePaths: ['app.txt'] }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason instanceof DeliveryError, true);
    assert.equal(rejected.reason.code, 'CHANGE_LOCKED');
    const missingHandoff = results[0].status === 'rejected' ? 'last_slot_one' : 'last_slot_two';
    const missingChange = results[0].status === 'rejected' ? 'change_one' : 'change_two';
    await assert.rejects(
      value.store.createHandoff({ handoffId: missingHandoff, changeId: missingChange, sourcePaths: ['app.txt'] }),
      (error) => error instanceof DeliveryError && error.code === 'DELIVERY_STATE_CAPACITY',
    );
    assert.equal((await readdir(handoffDirectory)).length, 2048);
  } finally {
    await removeFixture(value);
  }
});

test('delivery state refuses a new record after the bounded category retention limit', async () => {
  const value = await fixture();
  try {
    await value.store.ensureWritableState();
    const handoffDirectory = path.join(value.root, '.forge-delivery', 'handoffs');
    const writes = [];
    for (let index = 0; index < 2048; index += 1) {
      writes.push(writeFile(path.join(handoffDirectory, `retained_${String(index).padStart(4, '0')}.json`), '{}\n'));
      if (writes.length === 128) await Promise.all(writes.splice(0));
    }
    await Promise.all(writes);
    await value.store.initChange({
      changeId: 'feature_one', objective: 'Bound retained local state', idempotencyKey: 'init-feature-001',
    });
    await assert.rejects(
      value.store.createHandoff({ handoffId: 'over_capacity', changeId: 'feature_one', sourcePaths: ['app.txt'] }),
      (error) => error instanceof DeliveryError && error.code === 'DELIVERY_STATE_CAPACITY',
    );
    assert.equal(await pathExists(path.join(handoffDirectory, 'over_capacity.json')), false);
  } finally {
    await removeFixture(value);
  }
});
