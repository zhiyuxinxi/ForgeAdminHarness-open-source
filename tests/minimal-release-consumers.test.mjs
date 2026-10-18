import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { configureReleaseInputs } from '../scripts/configure-release-inputs.mjs';
import { TaskspaceBroker } from '../docker/harness/taskspace-broker.mjs';
import { publicReleaseOperation } from '../docker/harness/project-release-status.mjs';
import { parseControlledReleaseInspectionCommand } from '../docker/harness/forge-controlled-command.mjs';
import { verificationInputIdentity } from '../docker/harness/verification-inputs.mjs';

test('input configuration prepares both consumers, preserves custom definitions and is idempotent', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'release-input-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'ops')); await mkdir(path.join(root, 'verification'));
  const runtime = { schemaVersion: 3, projectRoot: root, release: { allowedReleaseServices: ['forge-admin', 'forge-flow', 'forge-ui'] } };
  const template = JSON.parse(await readFile('templates/project/host-verification-contract.json.tpl', 'utf8'));
  const host = { ...template, taskspacesRoot: path.join(root, 'taskspaces') }; delete host.inputScopes;
  const runtimeFile = path.join(root, 'ops/runtime-contract.json'), hostFile = path.join(root, 'verification/host-contract.json');
  await writeFile(runtimeFile, JSON.stringify(runtime)); await writeFile(hostFile, JSON.stringify(host));
  const preview = await configureReleaseInputs(root);
  assert.equal(preview.files.length, 2);
  assert.deepEqual(JSON.parse(await readFile(runtimeFile, 'utf8')), runtime, 'preview has no writes');
  assert.equal((await configureReleaseInputs(root, { write: true })).files.length, 2);
  const configured = JSON.parse(await readFile(runtimeFile, 'utf8'));
  assert.deepEqual(Object.keys(configured.release.inputModel.services), runtime.release.allowedReleaseServices);
  configured.release.inputModel.services['forge-ui'].roots.push('shared-components');
  await writeFile(runtimeFile, JSON.stringify(configured));
  assert.deepEqual((await configureReleaseInputs(root, { write: true })).files, []);
  assert.deepEqual(JSON.parse(await readFile(runtimeFile, 'utf8')), configured);
});

test('Broker impact plan binds the actual task base without promoting or preparing a release', async () => {
  const broker = Object.create(TaskspaceBroker.prototype), calls = [];
  broker.maintenanceState = async () => ({ active: false });
  broker.inspectCandidate = async () => ({ head: 'b'.repeat(40), workspaceClean: true, includesCanonical: true });
  broker.workspaceRoot = '/project/workspace';
  broker.git = async (...args) => { calls.push(['git', ...args]); };
  broker.releaseClient = async request => { calls.push(request); return { status: 'planned', selectedServices: ['worker'] }; };
  const task = { workspace: '/project/task/workspace', metadata: { taskId: 'task-one', actorId: 'actor-one', conversationId: 'conversation-one', baseCommit: 'a'.repeat(40) } };
  const result = await broker.executeForTask(task, { action: 'plan' });
  assert.equal(result.status, 'planned');
  assert.deepEqual(calls[1], { action: 'plan', provenance: { source: 'taskspace', taskId: 'task-one', actorId: 'actor-one',
    conversationId: 'conversation-one', candidateCommit: 'b'.repeat(40), sourceBaseCommit: 'a'.repeat(40) } });
});

test('no-op terminal and plan remain explicit read-only facts', () => {
  assert.equal(parseControlledReleaseInspectionCommand('forge-release plan').action, 'plan');
  assert.equal(parseControlledReleaseInspectionCommand('forge-release plan; deploy-everything'), null);
  const result = publicReleaseOperation({ status: 'success', stage: 'complete', services: [], releaseApplied: false, outcome: 'unchanged' });
  assert.equal(result.releaseApplied, false); assert.equal(result.outcome, 'unchanged');
});

test('verification identity includes declared shared roots, selector and definition changes', async () => {
  const scope = { check: { kind: 'tree', root: 'feature', inputs: ['shared'], rootFiles: true } };
  const source = { workspace: path.resolve('.'), inventory: { files: [
    { relative: 'feature/test.js', bytes: 1, sha256: 'a'.repeat(64) },
    { relative: 'shared/schema.json', bytes: 1, sha256: 'b'.repeat(64) },
    { relative: 'other/file.js', bytes: 1, sha256: 'c'.repeat(64) },
  ] } };
  const first = await verificationInputIdentity(source, 'check', {}, scope);
  source.inventory.files[2].sha256 = 'd'.repeat(64);
  assert.deepEqual(await verificationInputIdentity(source, 'check', {}, scope), first);
  source.inventory.files[1].sha256 = 'e'.repeat(64);
  assert.notEqual((await verificationInputIdentity(source, 'check', {}, scope)).digest, first.digest);
  assert.notEqual((await verificationInputIdentity(source, 'check', { test: 'other' }, scope)).digest, first.digest);
  assert.equal(await verificationInputIdentity(source, 'unknown', {}, scope), null);
});
