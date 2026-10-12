import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hostReceiptSchema from '../docker/harness/forge-host-verification-receipt.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { createInitialPhaseState, installPhaseBudgetGuard, isReadExecution, toolDenialReason } from '../docker/harness/forge-phase-budget-guard.mjs';
import * as controlledCommands from '../docker/harness/forge-controlled-command.mjs';
import { getRuntimeProbeCapabilities } from '../docker/harness/release-policy.mjs';
import {
  controlledEvidenceReceipt,
  controlledEvidenceCommandHint,
  isControlledEvidenceCommand,
  parseControlledEvidenceCommand,
  parseControlledGovernanceInspectionCommand,
  parseControlledDeliveryCommand,
  parseControlledReleaseInspectionCommand,
  parseControlledReleaseMutationCommand,
} from '../docker/harness/forge-controlled-command.mjs';

test('TODO-117 profiles catalog is a read-only CLI inspection, never execution or evidence', async () => {
  const command = 'forge-verify profiles --format json';
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  state.verificationBlocked = true;
  for (const executable of ['forge-verify', '/usr/local/bin/forge-verify']) {
    const candidate = `${executable} profiles --format json`;
    const exec = { name: 'bash', arguments: { command: candidate } };
    assert.equal(controlledCommands.parseControlledVerificationInspectionCommand(candidate)?.action, 'profiles');
    assert.equal(parseControlledEvidenceCommand(candidate), null);
    assert.equal(isReadExecution(exec), true);
    assert.equal(toolDenialReason(state, exec), undefined);
  }
  for (const rejected of [
    `${command}; forge-verify run`, `${command} > catalog.json`,
    `${command} --profile full-regression`, 'forge-verify profiles --format text',
    'X=1 forge-verify profiles --format json', 'forge-verify profiles --format $(echo json)',
  ]) {
    assert.equal(controlledCommands.parseControlledVerificationInspectionCommand(rejected), null, rejected);
    assert.match(toolDenialReason(state, { name: 'bash', arguments: { command: rejected } }), /exact reviewed argv shape/u);
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url)), 'profiles', '--format', 'json'], {
    env: { ...process.env, FORGE_TASKSPACE_BROKER_URL: 'http://127.0.0.1:1', FORGE_TASKSPACE_TOKEN_FILE: '/nonexistent/profiles-no-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, stderr);
  const catalog = JSON.parse(stdout);
  assert.equal(catalog.schemaVersion, 'forge-verification-profile-catalog/v1');
  assert.ok(catalog.profiles.includes('frontend-admin-test'));
  assert.equal(controlledEvidenceReceipt(command, stdout), null);
  assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ok: true, receiptType: 'forge-verify/run', status: 'passed' })), null);
});

test('TODO-117 help discovers the local profiles catalog through the read-only guard', async () => {
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  state.verificationBlocked = true;
  async function localCli(args) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url)), ...args], {
      env: { ...process.env, FORGE_TASKSPACE_BROKER_URL: 'http://127.0.0.1:1', FORGE_TASKSPACE_TOKEN_FILE: '/nonexistent/help-no-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 0, stderr);
    return stdout;
  }
  for (const executable of ['forge-verify', '/usr/local/bin/forge-verify']) {
    for (const option of ['--help', '-h']) {
      const command = `${executable} ${option}`;
      const execution = { name: 'bash', arguments: { command } };
      assert.equal(controlledCommands.parseControlledVerificationInspectionCommand(command)?.action, 'help');
      assert.equal(isReadExecution(execution), true);
      assert.equal(toolDenialReason(state, execution), undefined);
      assert.equal(parseControlledEvidenceCommand(command), null);
      assert.equal(controlledEvidenceReceipt(command, '{"status":"passed"}'), null);
    }
  }
  for (const executable of ['forge-verify', '/usr/local/bin/forge-verify']) {
    for (const action of ['admit', 'capability', 'run', 'status', 'watch', 'receipt', 'review', 'profiles']) {
      for (const option of ['--help', '-h']) {
        const command = `${executable} ${action} ${option}`;
        const execution = { name: 'bash', arguments: { command } };
        assert.equal(controlledCommands.parseControlledVerificationInspectionCommand(command)?.action, 'help');
        assert.equal(isReadExecution(execution), true);
        assert.equal(toolDenialReason(state, execution), undefined);
        assert.equal(parseControlledEvidenceCommand(command), null);
        assert.equal(controlledEvidenceReceipt(command, '{"status":"passed"}'), null);
      }
    }
  }
  const help = await localCli(['--help']);
  assert.equal(await localCli(['capability', '--help']), help);
  assert.equal(await localCli(['capability', '-h']), help);
  assert.equal(await localCli(['-h']), help);
  const discovered = help.match(/^\s+(forge-verify profiles --format json)$/mu)?.[1];
  assert.ok(discovered, 'ordinary help must reveal the exact supported catalog command');
  assert.equal(toolDenialReason(state, { name: 'bash', arguments: { command: discovered } }), undefined);
  const catalog = JSON.parse(await localCli(discovered.split(' ').slice(1)));
  assert.equal(catalog.schemaVersion, 'forge-verification-profile-catalog/v1');
  assert.ok(catalog.profiles.includes('frontend-admin-test'));
  for (const command of ['forge-verify capability', 'forge-verify unknown-action']) {
    assert.equal(controlledCommands.parseControlledVerificationInspectionCommand(command), null);
    assert.equal(parseControlledEvidenceCommand(command), null);
    assert.match(toolDenialReason(state, { name: 'bash', arguments: { command } }), /forge-verify profiles --format json/u);
  }
  for (const command of ['forge-verify --help extra', 'forge-verify --help --profile governance',
    'forge-verify unknown-action --help', 'forge-verify --help; forge-verify run', 'forge-verify --help > help.txt',
    'X=1 forge-verify --help', 'forge-verify --unknown', 'forge-verify profiles --format json --help',
    '/usr/local/bin/forge-verify capability --help --profile catalog', 'forge-verify capability --help > help.txt']) {
    assert.equal(controlledCommands.parseControlledVerificationInspectionCommand(command), null, command);
    assert.match(toolDenialReason(state, { name: 'bash', arguments: { command } }), /exact reviewed argv shape/u, command);
  }
});

test('TODO-080 native watch prints only new safe progress sequences and preserves terminal collection', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-watch-progress-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'fixture-local-token-'.repeat(4));
  const jobId = '11111111-1111-4111-8111-111111111111';
  const receiptId = '22222222-2222-4222-8222-222222222222';
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const sequence = [1, 1, 2][requests.length - 1];
    const value = sequence ? { jobId, active: true, status: 'accepted',
      progress: { phase: 'frontend-admin-build', phaseStartedAt: '2026-10-08T00:00:00.000Z', output: {
        sequence, observedBytes: sequence * 10, capturedBytes: sequence * 10, truncated: false,
        updatedAt: '2026-10-08T00:00:01.000Z', contentWithheld: true, untrusted: true, verificationProven: false,
        text: 'unknown unreviewed text must never be projected',
      } } } : { jobId, receiptId, active: false, status: 'passed', truth: { verificationProven: true } };
    response.end(JSON.stringify({ ok: true, result: value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url)), 'watch', '--job-id', jobId], {
    env: { ...process.env, FORGE_TASKSPACE_ID: '', FORGE_TASKSPACE_TOKEN_FILE: token,
      FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, stderr);
  const lines = stdout.trim().split('\n');
  const progress = lines.splice(0, 2).map(line => JSON.parse(line));
  assert.deepEqual(progress.map(value => value.output.sequence), [1, 2]);
  for (const value of progress) {
    assert.equal(value.event, 'forge-verification-progress');
    assert.equal(value.status, 'accepted');
    assert.equal(value.untrusted, true);
    assert.equal(value.verificationProven, false);
  }
  assert.doesNotMatch(stdout, /unknown unreviewed/u);
  const terminal = JSON.parse(lines.join('\n'));
  assert.equal(terminal.status, 'passed');
  assert.equal(terminal.observerStatus, 'finished');
  assert.equal(terminal.nextAction, `forge-verify receipt --receipt-id ${receiptId}`);
  assert.equal(requests.length, 4);
  for (const request of requests) assert.deepEqual(request, { action: 'verify-status', jobId, waitSeconds: 60 });
});

test('cross layer preparation CLI agrees with typed policy and only its protected read only guard context', async (t) => {
  const head = 'a'.repeat(40), fingerprint = 'b'.repeat(64);
  // The transport keeps the structured plan opaque; the Runner owns its probe schema.
  const probePlan = { schemaVersion: 1,
    api: Array.from({ length: 5 }, (_, i) => ({ id: `fixture-${i}`, method: 'GET', path: '/api/fixture', expectedStatus: 200, jsonAssertions: [] })),
    database: [], browser: { status: 'not-executed', reason: 'owner-excluded' } };
  const encoded = Buffer.from(JSON.stringify(probePlan)).toString('base64url');
  const argv = ['prepare', '--expected-head', head, '--expected-fingerprint', fingerprint, '--plan-base64', encoded];
  const command = `forge-release ${argv.join(' ')}`;
  const requestBody = { action: 'prepare', expectedHead: head, expectedFingerprint: fingerprint, probePlan };
  const root = await mkdtemp(path.join(tmpdir(), 'forge-cross-layer-prepare-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'bounded-local-prepare-fixture-'.repeat(3));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      requests.push(validateTaskspaceAction(JSON.parse(Buffer.concat(chunks))));
      response.end(JSON.stringify({ ok: true, result: { captured: true } }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const invoke = async (args, broker = true) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url)), ...args], {
      env: { ...process.env, FORGE_TASKSPACE_ID: '',
        FORGE_TASKSPACE_BROKER_URL: broker ? `http://127.0.0.1:${server.address().port}` : '',
        FORGE_TASKSPACE_TOKEN_FILE: broker ? token : '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { exit, stdout, stderr };
  };
  const accepted = await invoke(argv);
  assert.equal(accepted.exit, 0, accepted.stderr || accepted.stdout);
  assert.deepEqual(requests, [requestBody]);
  const jsonText = JSON.stringify(probePlan).replaceAll(':', ': ');
  const jsonArgv = [...argv.slice(0, -2), '--plan-json', jsonText];
  const jsonPrefix = `forge-release ${argv.slice(0, -2).join(' ')} --plan-json `;
  const jsonCommand = `${jsonPrefix}'${jsonText}'`;
  const inline = await invoke(jsonArgv);
  assert.equal(inline.exit, 0, inline.stderr || inline.stdout);
  assert.deepEqual(requests, [requestBody, requestBody], 'literal JSON and base64 produce exactly the same Broker request');
  const specialPlan = { schemaVersion: 2, api: [
    { id: 'fixture-read', method: 'GET', path: '/api/fixture', expectedStatus: 200, jsonAssertions: [],
      captures: [{ name: 'fixtureId', path: ['data', 'id'] }] },
    { id: 'fixture-write', method: 'POST', path: '/api/fixture', identity: 'fixture-qa', expectedStatus: 200,
      jsonAssertions: [], body: { id: { $capture: 'fixtureId' },
        label: 'literal $HOME ${HOME} $(not-a-command) `not-a-command` ; & | < > "quoted" owner\'s 中文' } },
  ], database: [], browser: { status: 'not-executed', reason: 'owner-excluded' } };
  const specialText = JSON.stringify(specialPlan).replaceAll("'", '\\u0027');
  const specialArgv = [...argv.slice(0, -2), '--plan-json', specialText];
  const specialCommand = `${jsonPrefix}'${specialText}'`;
  assert.deepEqual(controlledCommands.parseControlledReleasePreparationCommand(specialCommand)?.probePlan, specialPlan);
  const special = await invoke(specialArgv);
  assert.equal(special.exit, 0, special.stderr || special.stdout);
  assert.deepEqual(requests.at(-1), { ...requestBody, probePlan: specialPlan }, 'shell-looking characters inside the single literal remain JSON data');
  assert.deepEqual(controlledCommands.parseControlledReleasePreparationCommand(jsonCommand)?.probePlan, probePlan);
  assert.equal(parseControlledReleaseInspectionCommand(jsonCommand), null);
  assert.equal(parseControlledReleaseMutationCommand(jsonCommand), null);
  assert.equal(isReadExecution({ name: 'bash', arguments: { command: jsonCommand } }), false);
  const advertised = getRuntimeProbeCapabilities();
  assert.equal(advertised.maxPlanBytes, 32768);
  assert.deepEqual(advertised.prepareInput.planFlags, ['--plan-base64', '--plan-json']);
  assert.equal(advertised.prepareInput.planFlagRule, 'exactly-one');
  assert.match(advertised.prepareInput.planJson, /single-quoted/u);
  assert.deepEqual(validateTaskspaceAction(requestBody), requestBody);
  const parsed = controlledCommands.parseControlledReleasePreparationCommand(command);
  assert.equal(parsed.action, 'prepare');
  assert.deepEqual(parsed.probePlan, probePlan);
  assert.equal(parseControlledReleaseInspectionCommand(command), null);
  assert.equal(parseControlledReleaseMutationCommand(command), null);
  assert.equal(isReadExecution({ name: 'bash', arguments: { command } }), false);
  const controller = installPhaseBudgetGuard({ on() { return () => {}; }, tools: { guard() { return () => {}; } } }, value => value);
  const agent = { session: { id: 'session:cross-prepare' } };
  const contract = { contractId: 'c'.repeat(64), actionCeiling: 'read-only', ownedPaths: [], requiredSkills: [],
    requiredVerificationProfiles: [], requiredRedProfiles: [], tddRequired: false };
  const binding = { stateDigest: 'd'.repeat(64), acceptedArtifactDigests: Object.fromEntries(
    ['requirements', 'domain-api', 'database', 'ui-design', 'backend', 'frontend', 'access-wiring'].map(key => [key, 'e'.repeat(64)])),
    baseSourceCommit: head, workspaceFingerprint: fingerprint };
  const context = { key: 'cross-prepare-key', taskId: 'task-cross', executionId: 'execution-cross', generation: 2,
    projectSlug: 'forge-project', actorUserId: '123e4567-e89b-42d3-a456-426614174000', conversationId: 'conversation:cross',
    dshSessionId: agent.session.id, rpcId: 'rpc-cross', textDigest: 'f'.repeat(64), contract,
    authorityClass: 'production-read-only', testOnly: false, protectedExecutionContextValidated: true,
    workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7,
    crossLayerPreparation: true, preparationBinding: binding, sourceCommit: null, workspaceFingerprint: null,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const state = controller.stateFor(agent, 1, context);
  const exec = { name: 'bash', callId: 'prepare-call', agent, arguments: { command, workdir: '/workspace' } };
  assert.equal(toolDenialReason(state, exec), undefined);
  for (const literalCommand of [jsonCommand, specialCommand]) {
    assert.equal(toolDenialReason(state, { ...exec, arguments: { ...exec.arguments, command: literalCommand } }), undefined);
  }
  for (const changed of [
    { executionCrossLayerPreparation: false }, { executionPreparationBinding: undefined },
    { executionPhaseIndex: 6 }, { executionPhaseId: 'frontend-implementation' }, { executionWorkflowId: null },
    { protectedExecutionContextValidated: false }, { executionAuthorityClass: 'production-task-writer' },
    { executionTestOnly: true }, { executionContextStatus: 'unavailable' },
    { executionContextExpiresAt: new Date(0).toISOString() }, { actionCeiling: 'release' },
    { executionDshSessionId: 'session:other' },
    { executionPreparationBinding: { ...binding, workspaceFingerprint: '0'.repeat(64) } },
    { executionPreparationBinding: { ...binding, baseSourceCommit: '0'.repeat(40) } },
    { executionPreparationBinding: { ...binding, acceptedArtifactDigests: {} } },
    { executionProjectionRequired: true, executionProjectionStatus: 'unavailable' },
    { progressDecision: { decision: 'STOP', reasonCodes: ['PHASE_BUDGET_EXHAUSTED'] } },
  ]) {
    assert.ok(toolDenialReason({ ...state, ...changed }, exec), JSON.stringify(changed));
    assert.ok(toolDenialReason({ ...state, ...changed }, { ...exec, arguments: { ...exec.arguments, command: jsonCommand } }), JSON.stringify(changed));
  }
  for (const deniedCommand of ['forge-release release --services forge-admin',
    `forge-release checkpoint --path src/app.js --message-base64 c2F2ZQ --expected-head ${head} --expected-fingerprint ${fingerprint}`,
    `forge-release integrate --mode start --expected-head ${head} --expected-fingerprint ${fingerprint} --canonical-head ${head}`,
    'forge-release promote', 'docker ps', 'echo arbitrary']) {
    assert.ok(toolDenialReason(state, { ...exec, arguments: { command: deniedCommand } }), deniedCommand);
  }
  assert.ok(toolDenialReason(state, { ...exec, name: 'write', arguments: { file_path: 'src/app.js', content: 'no' } }));
  assert.ok(toolDenialReason(state, { ...exec, arguments: { ...exec.arguments, workdir: '/integration' } }));
  for (const extra of [{ crossLayerPreparation: true }, { preparationBinding: binding }, { taskId: 'other' },
    { services: ['forge-admin'] }, { command: 'docker ps' }]) assert.throws(() => validateTaskspaceAction({ ...requestBody, ...extra }));
  for (const probePlan of [[], null, { payload: 'x'.repeat(32768) }]) {
    assert.throws(() => validateTaskspaceAction({ ...requestBody, probePlan }));
  }
  const oversizedPlan = Buffer.from(JSON.stringify({ payload: 'x'.repeat(32768) })).toString('base64url');
  assert.equal(controlledCommands.parseControlledReleasePreparationCommand(`forge-release ${[...argv.slice(0, -1), oversizedPlan].join(' ')}`), null);
  const invalidEncodings = ['W10', 'bnVsbA', '_w', encoded + '='];
  for (const value of invalidEncodings) {
    const args = [...argv.slice(0, -1), value];
    assert.equal(controlledCommands.parseControlledReleasePreparationCommand(`forge-release ${args.join(' ')}`), null);
    assert.notEqual((await invoke(args)).exit, 0);
  }
  for (const invalid of [command + '; docker ps', command + ' --plan-base64 ' + encoded,
    command.replace(head, 'HEAD'), command.replace(fingerprint, '0'.repeat(63)), command + ' --service forge-admin']) {
    assert.equal(controlledCommands.parseControlledReleasePreparationCommand(invalid), null);
    assert.ok(toolDenialReason(state, { ...exec, arguments: { command: invalid } }));
  }
  assert.match((await invoke(argv, false)).stderr, /requires the TaskSpace Broker transport/u);
  for (const plan of ['[]', 'null', '{', '{"label":"line\nbreak"}', JSON.stringify({ label: '中'.repeat(11000) })]) {
    assert.equal(controlledCommands.parseControlledReleasePreparationCommand(`${jsonPrefix}'${plan}'`), null);
    assert.notEqual((await invoke([...argv.slice(0, -2), '--plan-json', plan])).exit, 0);
  }
  for (const args of [jsonArgv.concat('--plan-base64', encoded), argv.concat('--plan-json', jsonText),
    jsonArgv.concat('--plan-json', jsonText), jsonArgv.concat('--plan-file', '/tmp/plan.json')]) {
    assert.notEqual((await invoke(args)).exit, 0);
  }
  for (const invalid of [jsonCommand + '; docker ps', jsonCommand + ' && echo unsafe', jsonCommand + ' | cat',
    jsonCommand + ' > /tmp/out', jsonCommand + ' $(echo unsafe)', jsonCommand + ' `echo unsafe`',
    jsonCommand + "''", jsonCommand + '""', jsonCommand + '\nforge-release status',
    jsonPrefix + jsonText, jsonPrefix + '"' + jsonText + '"',
    jsonCommand + ' --plan-base64 ' + encoded, command + ' --plan-json \'{}\'',
    jsonCommand + " --plan-json '{}'", jsonCommand.replace(head, 'HEAD'),
    jsonCommand.replace(fingerprint, '0'.repeat(63))]) {
    assert.equal(controlledCommands.parseControlledReleasePreparationCommand(invalid), null, invalid);
    assert.ok(toolDenialReason(state, { ...exec, arguments: { ...exec.arguments, command: invalid } }), invalid);
  }
  assert.match((await invoke(jsonArgv, false)).stderr, /requires the TaskSpace Broker transport/u);
  assert.equal(requests.length, 3, 'only base64 and the two exact JSON preparations reach the local capture; no release or business writes');
});

test('standalone review command and broker schema enforce the same contract-only input', () => {
  const id = 'a'.repeat(64);
  assert.equal(isControlledEvidenceCommand(`forge-verify review --contract-id ${id}`), true);
  const request = { action: 'verify-review', acceptanceContractId: id };
  assert.deepEqual(validateTaskspaceAction(request), request);
  for (const extra of [{ taskId: 'other-task' }, { reviewerId: 'self' }, { decision: 'approved' },
    { source: {} }, { profile: 'governance' }, { model: 'other-model' }]) {
    assert.throws(() => validateTaskspaceAction({ ...request, ...extra }));
  }
  for (const suffix of ['', '--contract-id bad', `--contract-id ${id} --decision approved`,
    `--contract-id ${id} --contract-id ${id}`, `--contract-id ${id} --profile governance`]) {
    assert.equal(isControlledEvidenceCommand(`forge-verify review ${suffix}`), false);
  }
  assert.equal(controlledEvidenceReceipt(`forge-verify review --contract-id ${id}`,
    JSON.stringify({ status: 'passed', reviewerId: 'self', decision: 'approved' })), null);
});

const sha = 'a'.repeat(40);
const uuid = '123e4567-e89b-12d3-a456-426614174000';
const admission = '123e4567-e89b-12d3-a456-426614174099';

test('governance path audit is a bounded diagnostic and never complete evidence', () => {
  const base = `forge-governance audit --root /workspace --base ${sha} --format json`;
  const command = `${base} --path forge-admin-ui/src/views/fire/index.vue --path forge-admin-ui/src/api/fire.js`;
  const parsed = parseControlledGovernanceInspectionCommand(command);
  assert.equal(parsed?.family, 'governance-inspection');
  assert.equal(parsed.action, 'audit');
  assert.deepEqual(parsed.options['--path'], ['forge-admin-ui/src/views/fire/index.vue', 'forge-admin-ui/src/api/fire.js']);
  assert.equal(parseControlledEvidenceCommand(command), null);
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  assert.equal(toolDenialReason(state, { name: 'bash', arguments: JSON.stringify({ command }) }), undefined);
  assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ok: true, obligations: [], receiptDigest: `sha256:${'b'.repeat(64)}` })), null);
  assert.equal(parseControlledEvidenceCommand(base)?.family, 'governance');
  assert.equal(parseControlledGovernanceInspectionCommand('forge-governance explain --rule DB001 --format json')?.action, 'explain');
  for (const invalid of ['../outside', '/etc/passwd', 'src/../../outside', '.git/config', 'src//file', 'src/./file', 'src/node_modules/file', '--force']) {
    assert.equal(parseControlledGovernanceInspectionCommand(`${base} --path ${invalid}`), null, invalid);
  }
  for (const invalid of [base, `${command}; id`, `${command} --unknown x`, `${base} --path`, command.replace(sha, 'HEAD'), command.replace('/workspace', '/other')]) {
    assert.equal(parseControlledGovernanceInspectionCommand(invalid), null, invalid);
  }
});

test('H5 test command classification delegates exact selectors to shared verification policy', () => {
  const command = (profile, files) => `forge-verify run --profile ${profile} --admission-id ${admission}`
    + ' --idempotency-key h5-selector-boundary'
    + files.map((file) => ` --test-file ${file}`).join('');
  const h5 = 'forge-h5-ui/src/utils/__tests__/bilingual-display-contract.test.js';
  const pc = 'forge-admin-ui/src/example.test.js';
  for (const [profile, file] of [['frontend-h5-test', h5], ['frontend-admin-test', pc]]) {
    const parsed = parseControlledEvidenceCommand(command(profile, [file]));
    assert.equal(parsed?.family, `forge-verify-${profile}`);
    assert.deepEqual(parsed.options['--test-file'], [file]);
  }
  const maximum = Array.from({ length: 32 }, (_, i) => `forge-h5-ui/src/example-${i}.test.js`);
  assert.equal(parseControlledEvidenceCommand(command('frontend-h5-test', maximum))?.options['--test-file'].length, 32);
  for (const files of [[], [pc], [h5, h5], [...maximum, 'forge-h5-ui/src/extra.test.js'],
    ['forge-h5-ui/tests/example.test.js'], ['forge-h5-ui/src/example.test.ts'],
    ['forge-h5-ui/src/../example.test.js'], ['forge-h5-ui/src/*.test.js'],
    ['forge-h5-ui/src/example.js'], [h5 + ';id']]) {
    assert.equal(parseControlledEvidenceCommand(command('frontend-h5-test', files)), null, JSON.stringify(files));
  }
  assert.equal(parseControlledEvidenceCommand(command('frontend-admin-test', [h5])), null);
});

test('delivery parser admits bounded literal argv and rejects shell and forged evidence', () => {
  const init = 'forge-delivery change init --change coverage-fsm --objective "验证正常推进与非法跳级" --idempotency-key coverage-init-01';
  assert.equal(parseControlledDeliveryCommand(init)?.options['--objective'], '验证正常推进与非法跳级');
  assert.equal(parseControlledDeliveryCommand(init.replace('"验证正常推进与非法跳级"', '验证正常推进与非法跳级'))?.options['--objective'], '验证正常推进与非法跳级');
  assert.equal(parseControlledDeliveryCommand(init.replace('"验证正常推进与非法跳级"', "'正常 task 状态'"))?.mutation, true);
  for (const command of [
    'forge-delivery --help',
    '/usr/local/bin/forge-delivery change status --change coverage-fsm',
    'forge-delivery handoff verify --handoff coverage-handoff',
    'forge-delivery worktree inspect',
  ]) assert.equal(parseControlledDeliveryCommand(command)?.mutation, false, command);
  const transition = 'forge-delivery change transition --change coverage-fsm --to designed --expected-version 1 --idempotency-key coverage-step-01';
  assert.equal(parseControlledDeliveryCommand(transition)?.mutation, true);
  assert.equal(parseControlledDeliveryCommand('forge-delivery handoff create --handoff coverage-handoff --change coverage-fsm --source forge-server/example/Test.java')?.mutation, true);
  for (const command of [
    init + '; id', init + ' | cat', init + ' > result', init + '\nwhoami',
    init.replace('验证正常推进与非法跳级', '$(id)'), init.replace('验证正常推进与非法跳级', '$HOME'),
    init.replace('"验证正常推进与非法跳级"', '"one"two'),
    init.replace('--change coverage-fsm', '--change ../other'),
    init + ' --change another', init + ' --root /other',
    transition.replace('--expected-version 1', '--expected-version 9007199254740992'),
    transition.replace('--expected-version 1', '--expected-version 0'),
    'forge-delivery change init --change coverage-fsm',
    'forge-delivery verify record --verification fake --change coverage-fsm',
    'forge-delivery handoff create --handoff h --change c --source ../other/file',
    'forge-delivery handoff create --handoff h --change c --source .forge-delivery/changes/c.json',
    'forge-delivery handoff create --handoff h --change c --source /another/project/file',
    'node /usr/local/lib/forge-delivery.mjs --help',
    'FORGE_ROOT=/other forge-delivery --help',
  ]) assert.equal(parseControlledDeliveryCommand(command), null, command);
  assert.equal(controlledEvidenceReceipt(init, JSON.stringify({ ok: true, executionProven: true })), null);
});

test('real verify client submits long checks as jobs and preserves focused and explicit modes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-client-background-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'local-test-capability-'.repeat(3));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { status: 'accepted', jobId: uuid } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const cli = fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url));
  const cases = [
    { profile: 'full-regression', extra: [], expected: 'background' },
    { profile: 'frontend-admin-build', extra: [], expected: 'background' },
    { profile: 'frontend-admin-test', extra: [], expected: 'background' },
    { profile: 'frontend-admin-test', extra: ['--test-file', 'forge-admin-ui/src/example.test.ts'], expected: undefined },
    { profile: 'frontend-admin-build', extra: ['--execution-mode', 'background'], expected: 'background' },
    { profile: 'frontend-admin-build', extra: ['--reuse-receipt', uuid], expected: undefined },
  ];
  for (const item of cases) {
    const child = spawn(process.execPath, [cli, 'run', '--profile', item.profile,
      '--admission-id', admission, '--idempotency-key', 'client-mode-test', ...item.extra], {
      env: { ...process.env, FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 0, stderr);
    assert.equal(requests.at(-1).executionMode, item.expected);
  }
  assert.equal(requests.length, cases.length);
});

test('real verify client makes native observation actionable without changing the accepted job evidence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-client-observer-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'local-observer-capability-'.repeat(3));
  let responseBody;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume the actual CLI request */ }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: responseBody }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const cli = fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url));
  const command = `forge-verify run --profile full-regression --admission-id ${admission} --idempotency-key observer-feedback`;
  const ack = { schemaVersion: 1, receiptType: 'forge-verify/host-job', jobId: uuid, receiptId: uuid,
    status: 'accepted', active: true,
    request: { profile: 'full-regression', admissionId: admission, idempotencyKey: 'observer-feedback', selectors: {} },
    truth: { executionProven: false, verificationProven: false, releaseProven: false } };
  for (const value of [ack, { ...ack, active: false, status: 'passed' },
    { ...ack, active: false, status: 'failed', error: { code: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED', retryable: false } },
    { ...ack, jobId: 'bad; inject-command' }]) {
    responseBody = value;
    const child = spawn(process.execPath, [cli, ...command.split(' ').slice(1)], {
      env: { ...process.env, FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 0, stderr);
    const result = JSON.parse(stdout);
    if (value === ack) {
      assert.deepEqual(result.nativeObserver, { tool: 'bash', arguments: { command: `forge-verify watch --job-id ${uuid}`, run_in_background: true } });
      assert.match(result.nextAction, /before ending/u);
      assert.equal(parseControlledEvidenceCommand(result.nativeObserver.arguments.command)?.action, 'watch');
      const { nativeObserver, nextAction, ...evidence } = controlledEvidenceReceipt(command, stdout).receipt;
      assert.deepEqual(evidence, ack, 'execution and its evidence consumer retain the same job and false success claims');
    } else {
      assert.equal(result.nativeObserver, undefined, 'terminal failures and malformed jobs cannot trigger another observer');
      assert.deepEqual(result, value);
    }
  }
});

test('explicit Host receipt reuse binds the original execution to the current admission', () => {
  const currentAdmission = '123e4567-e89b-12d3-a456-426614174098';
  const ordinaryCommand = `forge-verify run --profile governance --admission-id ${currentAdmission} --idempotency-key host-reuse-1`;
  const reuseCommand = `${ordinaryCommand} --reuse-receipt ${uuid}`;
  assert.equal(isControlledEvidenceCommand(reuseCommand), true);
  const original = hostRunReceipt();
  const projection = { ...original, revalidation: {
    schemaVersion: 1, receiptType: 'forge-verify/host-revalidation',
    contractId: '9'.repeat(64), observedAt: '2026-09-03T12:03:00.000Z',
    originalReceiptSha256: hostReceiptSchema.hostRunReceiptDigest(original),
    admissionReceipt: { ...hostAdmissionReceipt(), admissionId: currentAdmission },
  } };
  assert.deepEqual(controlledEvidenceReceipt(reuseCommand, JSON.stringify(projection))?.receipt, projection);
  assert.equal(controlledEvidenceReceipt(ordinaryCommand, JSON.stringify(projection)), null);
  assert.equal(controlledEvidenceReceipt(reuseCommand, JSON.stringify(original)), null);
  assert.equal(controlledEvidenceReceipt(`${ordinaryCommand} --reuse-receipt ${currentAdmission}`, JSON.stringify(projection)), null);
  const tampered = structuredClone(projection);
  tampered.logs.sha256 = '0'.repeat(64);
  assert.equal(controlledEvidenceReceipt(reuseCommand, JSON.stringify(tampered)), null);
  const wrongAdmission = structuredClone(projection);
  wrongAdmission.revalidation.admissionReceipt.admissionId = admission;
  assert.equal(controlledEvidenceReceipt(reuseCommand, JSON.stringify(wrongAdmission)), null);
  const legacy = { ...original, schemaVersion: 1, receiptType: 'forge-verify/run', request: { ...original.request, admissionId: currentAdmission } };
  assert.equal(controlledEvidenceReceipt(reuseCommand, JSON.stringify(legacy)), null);
});

test('Host diagnostic text is readable output but cannot alter canonical evidence', () => {
  const canonical = hostRunReceipt();
  const command = `forge-verify run --profile governance --admission-id ${admission} --idempotency-key host-diagnostics-1`;
  const response = { ...canonical, logs: { ...canonical.logs, excerpt: 'Untrusted tool output: failed assertion\n测试详情' } };
  assert.deepEqual(controlledEvidenceReceipt(command, JSON.stringify(response))?.receipt, canonical);
  for (const excerpt of [42, '\u001b[31mred', '界'.repeat(6000)]) {
    assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ...response, logs: { ...response.logs, excerpt } })), null);
  }
  assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ...response, logs: { ...response.logs, arbitrary: true } })), null);
  assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ...response, status: 'failed' })), null);
  const stale = { ...response, freshness: 'stale' };
  assert.equal(controlledEvidenceReceipt(`forge-verify receipt --receipt-id ${uuid}`, JSON.stringify(stale)), null);
});

const admissionReceipt = (profiles, outcome = 'ready') => JSON.stringify({
  schemaVersion: 1,
  receiptType: 'forge-verify/execution-admission',
  admissionId: outcome === 'ready' ? admission : null,
  projectSlug: 'forge-project',
  taskId: 'task-one',
  runner: { bootId: uuid, revision: 'vpn-forge-delivery-toolkit-72' },
  profiles,
  source: {
    head: 'a'.repeat(40),
    workspaceFingerprint: 'b'.repeat(64),
    dependencyManifestFingerprint: 'c'.repeat(64),
  },
  cache: {
    mode: 'project-scoped-immutable-pack',
    compatible: outcome === 'ready',
    ...(outcome === 'ready' ? { packDigest: `sha256:${'d'.repeat(64)}` } : {}),
  },
  executor: {
    proven: outcome === 'ready',
    dockerApiProven: outcome === 'ready',
    toolchainImageProven: outcome === 'ready',
    samePathBindProven: outcome === 'ready',
    stateWriteProven: outcome === 'ready',
    cleanupProven: outcome === 'ready',
  },
  issuedAt: outcome === 'ready' ? '2026-09-01T00:00:00.000Z' : null,
  expiresAt: outcome === 'ready' ? '2026-09-01T00:05:00.000Z' : null,
  outcome,
  reasonCode: outcome === 'ready' ? null : 'VERIFY_CACHE_MISS',
  truth: {
    executionProven: false,
    verificationProven: false,
    semanticCorrectnessProven: false,
    databaseIntegrationProven: false,
    releaseProven: false,
  },
});

function hostToolchain() {
  const executables = {};
  for (const name of ['java', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance']) {
    executables[name] = {
      configuredPath: `/opt/forge-tools/${name}`,
      resolvedPath: `/opt/forge-tools/${name}`,
      bytes: 100,
      modifiedMs: 1,
      version: `${name} 1.0.0`,
    };
  }
  return { javaHome: '/opt/forge-tools/java-home', executables, digest: '8'.repeat(64) };
}

function hostAdmissionReceipt(profiles = ['governance']) {
  return {
    schemaVersion: 2,
    receiptType: 'forge-verify/host-execution-admission',
    outcome: 'ready',
    reasonCode: null,
    admissionId: admission,
    projectSlug: 'forge-project',
    taskId: 'task-one',
    profiles,
    source: {
      head: sha,
      workspaceFingerprint: 'b'.repeat(64),
      dependencyManifestFingerprint: 'c'.repeat(64),
    },
    runner: { bootId: uuid, revision: 'vpn73-host-runner-2026.09.03.12' },
    profileCatalogVersion: '2026.09.03.3',
    profilePolicyDigest: '7'.repeat(64),
    toolchain: hostToolchain(),
    issuedAt: '2026-09-03T12:00:00.000Z',
    expiresAt: '2026-09-03T12:05:00.000Z',
    truth: {
      executionProven: false,
      verificationProven: false,
      semanticCorrectnessProven: false,
      databaseIntegrationProven: false,
      releaseProven: false,
    },
  };
}

function hostRunReceipt(profile = 'governance', selectors = {}) {
  return {
    schemaVersion: 2,
    receiptType: 'forge-verify/host-run',
    receiptId: uuid,
    jobId: '123e4567-e89b-12d3-a456-426614174001',
    projectSlug: 'forge-project',
    taskId: 'task-one',
    status: 'passed',
    source: {
      head: sha,
      workspaceFingerprint: 'b'.repeat(64),
      dependencyManifestFingerprint: 'c'.repeat(64),
      snapshotSha256: 'b'.repeat(64),
      fileCount: 10,
      bytes: 1000,
    },
    request: {
      profile,
      selectors,
      selectorsSha256: '4'.repeat(64),
      idempotencyDigest: '5'.repeat(64),
      admissionId: admission,
    },
    policy: { profileCatalogVersion: '2026.09.03.3', profilePolicyDigest: '7'.repeat(64) },
    toolchain: hostToolchain(),
    isolation: {
      mode: 'host-toolchain-isolated-taskspace',
      taskStateRoot: '/srv/forge/state/task-one',
      cacheRoot: '/srv/forge/state/task-one/cache',
      globalUserConfigRead: false,
      arbitraryShell: false,
      requestControlledEnvironment: false,
      cleanupProven: true,
    },
    execution: {
      steps: [{
        executable: '/opt/forge-tools/forgeGovernance', argv: ['audit'], cwd: '/srv/forge/job',
        exitCode: 0, signal: null, timedOut: false, processEnded: true,
        transportUncertain: false, cleanup: { proven: true },
      }],
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-03T12:00:01.000Z',
      finishedAt: '2026-09-03T12:00:02.000Z',
    },
    results: { executed: 0, passed: 0, failed: 0, skipped: 0, reportFiles: 0, zeroTestsRejected: false },
    logs: { path: '/srv/forge/logs/run.log', sha256: '6'.repeat(64), bytes: 10, truncated: false, redacted: false },
    truth: {
      executionProven: true,
      verificationProven: true,
      semanticCorrectnessProven: false,
      databaseIntegrationProven: false,
      releaseProven: false,
    },
  };
}

test('accepts only bounded argv-shaped governance and verification commands', () => {
  assert.equal(isControlledEvidenceCommand('forge-verify admit --profile governance --profile backend-module-test'), true);
  assert.equal(isControlledEvidenceCommand(`forge-governance audit --root /workspace --base ${sha} --format json`), true);
  assert.equal(isControlledEvidenceCommand('forge-verify capability --profile backend-module-test'), true);
  assert.equal(isControlledEvidenceCommand(`forge-verify run --profile backend-test-class --module forge-server/forge-framework/core --test PageQueryTest --admission-id ${admission} --idempotency-key task-12345678`), true);
  assert.equal(isControlledEvidenceCommand(`forge-verify run --profile backend-red-test --module forge-server/forge-framework/core --test PageQueryTest#failsFirst --admission-id ${admission} --idempotency-key red-back-12345678`), true);
  assert.equal(isControlledEvidenceCommand(`forge-verify run --profile frontend-red-test --test-file forge-admin-ui/src/views/example/Example.spec.ts --admission-id ${admission} --idempotency-key red-front-12345678`), true);
  assert.equal(isControlledEvidenceCommand(`forge-verify run --profile frontend-admin-lint --file forge-admin-ui/src/views/example/index.vue --file forge-admin-ui/src/api/example.ts --admission-id ${admission} --idempotency-key lint-front-12345678`), true);
  assert.equal(isControlledEvidenceCommand(`forge-verify run --profile frontend-admin-test --test-file forge-admin-ui/src/views/example/Example.spec.ts --test-file forge-admin-ui/tests/example.test.ts --admission-id ${admission} --idempotency-key test-front-12345678`), true);
  assert.equal(isControlledEvidenceCommand(`forge-verify receipt --receipt-id ${uuid}`), true);

  for (const command of [
    `printf '{"ok":true}'; forge-governance audit --base ${sha}`,
    `forge-governance audit --base ${sha} | tail -1`,
    `forge-governance audit --base ${sha} > receipt.json`,
    `PATH=./bin forge-verify capability --profile backend-module-test`,
    'echo forge-verify run --profile backend-module-test',
    'forge-governance audit --format json',
    'forge-verify run --profile backend-module-test --module ../outside',
    'forge-verify status --job-id not-a-uuid',
    'forge-verify capability --profile made-up-profile',
    'forge-verify admit --profile backend-module-test --profile governance',
    'forge-verify admit --profile backend-module-test --profile backend-module-test',
    'forge-verify run --profile made-up-profile --idempotency-key task-12345678',
    'forge-verify run --profile frontend-admin-test --module forge-server/app --idempotency-key task-12345678',
    'forge-verify run --profile backend-module-test --idempotency-key task-12345678',
    `forge-verify run --profile backend-module-test --module forge-server/app --test AppTest --admission-id ${admission} --idempotency-key red-fake-12345678`,
    `forge-verify run --profile backend-red-test --module forge-server/app --admission-id ${admission} --idempotency-key red-missing-12345678`,
    `forge-verify run --profile backend-red-test --module forge-server/app --test AppTest --test OtherTest --admission-id ${admission} --idempotency-key red-wide-12345678`,
    `forge-verify run --profile backend-red-test --module forge-server/app --module forge-server/other --test AppTest --admission-id ${admission} --idempotency-key red-multi-module-12345678`,
    `forge-verify run --profile frontend-red-test --module forge-server/app --admission-id ${admission} --idempotency-key red-front-wrong-12345678`,
    `forge-verify run --profile frontend-red-test --test-file forge-admin-ui/src/a.spec.ts --test-file forge-admin-ui/src/b.spec.ts --admission-id ${admission} --idempotency-key red-front-wide-12345678`,
    `forge-verify run --profile frontend-admin-lint --file forge-admin-ui/src/../escape.ts --admission-id ${admission} --idempotency-key lint-traversal-12345678`,
    `forge-verify run --profile frontend-admin-lint --file other-ui/src/example.ts --admission-id ${admission} --idempotency-key lint-path-12345678`,
    `forge-verify run --profile frontend-admin-lint --file forge-admin-ui/src/example.css --admission-id ${admission} --idempotency-key lint-suffix-12345678`,
    `forge-verify run --profile frontend-admin-lint --file forge-admin-ui/src/example.ts --file forge-admin-ui/src/example.ts --admission-id ${admission} --idempotency-key lint-duplicate-12345678`,
    `forge-verify run --profile frontend-admin-test --test-file forge-admin-ui/src/example.ts --admission-id ${admission} --idempotency-key test-suffix-12345678`,
    `forge-verify run --profile frontend-admin-build --file forge-admin-ui/src/example.ts --admission-id ${admission} --idempotency-key build-selector-12345678`,
    `forge-verify run --profile frontend-admin-lint --file forge-admin-ui/src/example.ts --test-file forge-admin-ui/src/example.test.ts --admission-id ${admission} --idempotency-key mixed-selector-12345678`,
  ]) assert.equal(isControlledEvidenceCommand(command), false, command);

  const overLimit = Array.from({ length: 33 }, (_, index) => `--file forge-admin-ui/src/generated/file-${index}.ts`).join(' ');
  assert.equal(isControlledEvidenceCommand(`forge-verify run --profile frontend-admin-lint ${overLimit} --admission-id ${admission} --idempotency-key lint-over-limit-12345678`), false);
});

test('requires a complete typed receipt and rejects surrounding or forged-looking text', () => {
  const admitCommand = 'forge-verify admit --profile governance --profile backend-module-test';
  assert.equal(
    controlledEvidenceReceipt(admitCommand, admissionReceipt(['governance', 'backend-module-test']))?.receipt.outcome,
    'ready',
  );
  assert.equal(
    controlledEvidenceReceipt(admitCommand, admissionReceipt(['governance'], 'ready')),
    null,
  );
  assert.equal(
    controlledEvidenceReceipt(admitCommand, admissionReceipt(['governance', 'backend-module-test'], 'cache_miss'))?.receipt.outcome,
    'cache_miss',
  );
  const overlongLease = JSON.parse(admissionReceipt(['governance', 'backend-module-test']));
  overlongLease.expiresAt = '2026-09-01T01:00:00.000Z';
  assert.equal(controlledEvidenceReceipt(admitCommand, JSON.stringify(overlongLease)), null);
  const governance = JSON.stringify({
    ok: true,
    receiptDigest: `sha256:${'b'.repeat(64)}`,
    obligations: [],
  });
  assert.equal(
    controlledEvidenceReceipt(`forge-governance audit --base ${sha} --format json`, governance)?.receipt.ok,
    true,
  );
  assert.equal(
    controlledEvidenceReceipt(`forge-governance audit --base ${sha} --format json`, `PASS\n${governance}`),
    null,
  );
  assert.equal(
    controlledEvidenceReceipt(`echo '${governance}'`, governance),
    null,
  );

  const verification = JSON.stringify({
    receiptType: 'forge-verify/run',
    receiptId: uuid,
    status: 'passed',
    source: { workspaceFingerprint: 'c'.repeat(64) },
    request: { profile: 'frontend-admin-test', selectors: {}, admissionId: admission },
    truth: { verificationProven: true },
  });
  const parsed = controlledEvidenceReceipt(
    `forge-verify run --profile frontend-admin-test --admission-id ${admission} --idempotency-key front-12345678`,
    `${verification}\n[exit code: 0]`,
  );
  assert.equal(parsed?.receipt.receiptId, uuid);
  assert.equal(controlledEvidenceReceipt('forge-verify run --profile frontend-admin-test', '{"status":"passed"}'), null);

  const selectedTestCommand = `forge-verify run --profile frontend-admin-test --test-file forge-admin-ui/src/views/example/Example.spec.ts --admission-id ${admission} --idempotency-key front-selected-12345678`;
  const selectedTestReceipt = {
    ...JSON.parse(verification),
    request: {
      profile: 'frontend-admin-test',
      selectors: { testFiles: ['forge-admin-ui/src/views/example/Example.spec.ts'] },
      admissionId: admission,
    },
  };
  assert.equal(controlledEvidenceReceipt(selectedTestCommand, JSON.stringify(selectedTestReceipt))?.receipt.receiptId, uuid);
  selectedTestReceipt.request.selectors.testFiles[0] = 'forge-admin-ui/src/views/other/Other.spec.ts';
  assert.equal(controlledEvidenceReceipt(selectedTestCommand, JSON.stringify(selectedTestReceipt)), null);

  for (const [status, verificationProven] of [
    ['failed', false], ['timed-out', false], ['failed-zero-tests', false],
  ]) {
    const failedReceipt = JSON.stringify({
      ...JSON.parse(verification), status, truth: { verificationProven },
    });
    assert.equal(
      controlledEvidenceReceipt(
        `forge-verify run --profile frontend-admin-test --admission-id ${admission} --idempotency-key front-12345678`,
        failedReceipt,
      )?.receipt.status,
      status,
    );
  }

  const profileMismatch = JSON.stringify({
    ...JSON.parse(verification), request: { profile: 'frontend-admin-build', admissionId: admission },
  });
  assert.equal(
    controlledEvidenceReceipt(
      `forge-verify run --profile frontend-admin-test --admission-id ${admission} --idempotency-key front-12345678`,
      profileMismatch,
    ),
    null,
  );
  assert.equal(
    controlledEvidenceReceipt(
      `forge-verify run --profile frontend-admin-test --admission-id ${admission} --idempotency-key front-12345678`,
      JSON.stringify({ ...JSON.parse(verification), status: 'failed' }),
    ),
    null,
    'a failed receipt cannot claim verificationProven=true',
  );

  const capability = JSON.stringify({
    receiptType: 'forge-verify/capability', receiptId: uuid,
    profile: 'backend-module-test', outcome: 'ready',
  });
  assert.equal(
    controlledEvidenceReceipt('forge-verify capability --profile backend-module-test', capability)?.receipt.outcome,
    'ready',
  );
  assert.equal(
    controlledEvidenceReceipt('forge-verify capability --profile frontend-admin-test', capability),
    null,
  );
});

test('parsing reports the exact evidence family without executing shell syntax', () => {
  assert.equal(
    parseControlledEvidenceCommand('forge-verify capability --profile frontend-admin-build')?.family,
    'forge-verify-frontend-admin-build',
  );
  assert.equal(
    parseControlledEvidenceCommand('forge-verify capability --profile frontend-admin-typecheck')?.family,
    'forge-verify-frontend-admin-typecheck',
  );
  assert.equal(
    parseControlledEvidenceCommand(`forge-governance audit --base ${sha} --root . --format json`)?.family,
    'governance',
  );
});

test('parsing admits only exact read-only release inspection commands', () => {
  assert.equal(parseControlledReleaseInspectionCommand('forge-release --help')?.action, '--help');
  assert.equal(parseControlledReleaseInspectionCommand('forge-release --help; forge-release release'), null);
  assert.equal(parseControlledReleaseInspectionCommand('forge-release --help extra'), null);
  for (const action of ['contract', 'capability', 'preflight', 'status', 'diagnose']) {
    assert.deepEqual(
      parseControlledReleaseInspectionCommand(`forge-release ${action}`),
      {
        family: 'forge-release-inspection',
        executable: 'forge-release',
        action,
        options: {},
      },
    );
    assert.equal(
      parseControlledReleaseInspectionCommand(`/usr/local/bin/forge-release ${action}`)?.action,
      action,
    );
  }
  for (const command of [
    'forge-release release --services forge-admin',
    'forge-release preflight --verbose',
    'forge-release contract; id',
    'env FOO=bar forge-release contract',
    '/tmp/forge-release contract',
  ]) {
    assert.equal(parseControlledReleaseInspectionCommand(command), null, command);
  }
});

test('release operation tracking inspection is exact, read-only and cannot submit work', () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const command = `forge-release status --operation-id ${operationId}`;
  assert.equal(parseControlledReleaseInspectionCommand(command)?.options['--operation-id'], operationId);
  assert.equal(isReadExecution({ name: 'bash', arguments: { command } }), true);
  assert.deepEqual(validateTaskspaceAction({ action: 'status', operationId }), { action: 'status', operationId });
  for (const denied of [`${command} --operation-id ${operationId}`, `${command}; forge-release release`,
    'forge-release status --operation-id ../../other', 'forge-release status --operation-id 11111111--------------------------------',
    `forge-release diagnose --operation-id ${operationId}`]) {
    assert.equal(parseControlledReleaseInspectionCommand(denied), null, denied);
  }
  assert.throws(() => validateTaskspaceAction({ action: 'status', operationId: '../other' }));
  assert.throws(() => validateTaskspaceAction({ action: 'status', executionMode: 'background' }));
  assert.throws(() => validateTaskspaceAction({ action: 'release', services: ['forge-ui'], approvalRef: 'owner', executionMode: 'retry' }));
});

test('release operation tracking CLI negotiates once before its only release and preserves old Brokers', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-release-tracking-cli-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'a'.repeat(64));
  const requests = [];
  let supported = true;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      requests.push('capability');
      response.end(JSON.stringify({ ok: true, ...(supported ? { capabilities: { releaseOperationTracking: 1 } } : {}) }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = validateTaskspaceAction(JSON.parse(Buffer.concat(chunks)));
    requests.push(body);
    response.end(JSON.stringify({ ok: true, result: { status: body.executionMode ? 'accepted' : 'success',
      operationId: '11111111-1111-4111-8111-111111111111', terminal: !body.executionMode } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const invoke = async (args) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url)), ...args], {
      env: { ...process.env, FORGE_TASKSPACE_ID: '', FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`,
        FORGE_TASKSPACE_TOKEN_FILE: token }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  };
  for (const capability of [true, false]) {
    supported = capability;
    requests.length = 0;
    const result = await invoke(['release', '--services', 'forge-ui']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 2);
    assert.equal(requests[0], 'capability');
    assert.equal(requests[1].action, 'release');
    assert.equal(requests[1].executionMode, supported ? 'background' : undefined);
    assert.equal(JSON.parse(result.stdout).result.status, supported ? 'accepted' : 'success');
  }
  requests.length = 0;
  const unsupported = await invoke(['status', '--operation-id', '11111111-1111-4111-8111-111111111111']);
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /does not support exact release operation status/u);
  assert.deepEqual(requests, ['capability']);
  supported = true;
  requests.length = 0;
  assert.equal((await invoke(['status', '--operation-id', '11111111-1111-4111-8111-111111111111'])).code, 0);
  assert.deepEqual(requests[1], { action: 'status', operationId: '11111111-1111-4111-8111-111111111111' });
});

test('parsing admits only fixed checkpoint and release mutation argv', () => {
  const messageBase64 = Buffer.from('Checkpoint reviewed source', 'utf8').toString('base64url');
  const checkpoint = `forge-release checkpoint --path src/app.mjs --path tests/app.test.mjs --message-base64 ${messageBase64} --expected-head ${sha} --expected-fingerprint ${'b'.repeat(64)}`;
  assert.deepEqual(parseControlledReleaseMutationCommand(checkpoint), {
    family: 'forge-release-mutation',
    executable: 'forge-release',
    action: 'checkpoint',
    options: {
      '--path': ['src/app.mjs', 'tests/app.test.mjs'],
      '--message-base64': messageBase64,
      '--expected-head': sha,
      '--expected-fingerprint': 'b'.repeat(64),
    },
  });
  assert.equal(
    parseControlledReleaseMutationCommand('/usr/local/bin/forge-release release --services forge-admin,forge-ui --version v1.2.3 --approval-ref owner-approved')?.action,
    'release',
  );

  const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString('base64url');
  for (const command of [
    checkpoint.replace('--path tests/app.test.mjs', '--path src/app.mjs'),
    checkpoint.replace('--path src/app.mjs', '--path ../app.mjs'),
    checkpoint.replace('--path src/app.mjs', '--path src/node_modules/app.mjs'),
    checkpoint.replace(messageBase64, invalidUtf8),
    checkpoint.replace(messageBase64, Buffer.from('bad\nmessage').toString('base64url')),
    `${checkpoint}; id`,
    'forge-release release --services forge-admin,forge-admin',
    'forge-release release --services forge-admin --services forge-ui',
    'forge-release release --services forge-admin --approval-ref owner approved',
    'forge-release release --version v1.2.3',
  ]) {
    assert.equal(parseControlledReleaseMutationCommand(command), null, command);
  }

  assert.equal(parseControlledReleaseInspectionCommand(checkpoint), null);
  assert.equal(isControlledEvidenceCommand(checkpoint), false);
  assert.equal(controlledEvidenceCommandHint(checkpoint), '');

  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  const guard = command => toolDenialReason(state, { name: 'bash', arguments: { command } });
  const missingMessage = `/usr/local/bin/forge-release checkpoint --expected-head ${sha} --expected-fingerprint ${'b'.repeat(64)} --path src/app.mjs --path tests/app.test.mjs`;
  for (const [command, expected] of [
    [missingMessage, /checkpoint is missing required --message-base64/u],
    ['forge-release checkpoint', /missing required --path, --message-base64, --expected-head, --expected-fingerprint/u],
    ['forge-release checkpoint --help', /checkpoint --help is not supported; use forge-release --help/u],
  ]) {
    assert.equal(parseControlledReleaseMutationCommand(command), null, command);
    const rejection = guard(command);
    assert.match(rejection, /FORGE_PHASE_BUDGET_GUARD_V1/u);
    assert.match(rejection, expected, command);
    assert.match(rejection, /Command not executed/u);
    assert.match(rejection, /Load or reload forge-git-checkpoint/u);
    assert.match(rejection, /Exact checkpoint argv: forge-release checkpoint --path/u);
    assert.match(rejection, /do not request new user confirmation merely for this syntax error/u);
    assert.match(rejection, /Existing permission, source, and checkpoint checks still apply/u);
  }
  for (const command of [`${missingMessage}; id`, `TOKEN=secret ${missingMessage}`, `echo ${missingMessage}`]) {
    assert.equal(parseControlledReleaseMutationCommand(command), null, command);
    assert.equal(controlledEvidenceCommandHint(command), '', command);
    assert.ok(guard(command), command);
  }
  const corrected = `${missingMessage} --message-base64 ${messageBase64}`;
  assert.equal(parseControlledReleaseMutationCommand(corrected)?.action, 'checkpoint');
  assert.equal(controlledEvidenceCommandHint(corrected), '');
  assert.match(guard(corrected), /exceeds the protected contract ceiling read-only/u,
    'correct syntax does not grant checkpoint authority');
});

test('release and contract argv diagnostics identify corrections without changing admission or authority', () => {
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  const guard = command => toolDenialReason(state, { name: 'bash', arguments: { command } });
  const preparePrefix = `forge-release prepare --expected-head ${sha} --expected-fingerprint ${'b'.repeat(64)}`;
  const prepare = `${preparePrefix} --plan-base64 ${Buffer.from('{"schemaVersion":1}').toString('base64url')}`;
  const release = '/usr/local/bin/forge-release release --services forge-admin';
  const inspect = 'forge-delivery contract inspect --source docs/task.json';
  const bind = 'forge-delivery contract bind --source docs/task.json --binding task-v1 --purpose implementation';
  const verify = 'forge-delivery contract verify --source docs/task.json --binding task-v1';
  const preparationParser = controlledCommands.parseControlledReleasePreparationCommand;
  const cases = [
    [preparationParser, 'forge-release prepare', /missing required --expected-head, --expected-fingerprint, exactly one of --plan-base64 or --plan-json/u, 'prepare'],
    [preparationParser, preparePrefix, /exactly one of --plan-base64 or --plan-json/u, 'prepare'],
    [preparationParser, prepare.replace(sha, 'HEAD'), /invalid value for --expected-head/u, 'prepare'],
    [preparationParser, `${prepare} --plan-json '{}'`, /not both/u, 'prepare'],
    [preparationParser, `${preparePrefix} --plan-base64 W10`, /JSON object, not null or an array/u, 'prepare'],
    [preparationParser, `${preparePrefix} --plan-base64 _w`, /valid UTF-8 JSON/u, 'prepare'],
    [preparationParser, `${preparePrefix} --plan-json '{"private":"do-not-echo-this",}'`, /valid UTF-8 JSON/u, 'prepare'],
    [preparationParser, `${preparePrefix} --plan-json`, /single-quoted, single-line JSON object/u, 'prepare'],
    [preparationParser, 'forge-release prepare --help', /unsupported option --help/u, 'prepare'],
    [parseControlledReleaseMutationCommand, 'forge-release release', /missing required --services/u, 'release'],
    [parseControlledReleaseMutationCommand, release.replace('forge-admin', 'unsupported-service'), /supported service names/u, 'release'],
    [parseControlledReleaseMutationCommand, release.replace('forge-admin', 'forge-admin,forge-admin'), /must not contain duplicates/u, 'release'],
    [parseControlledReleaseMutationCommand, `${release} --services forge-ui`, /duplicate option --services/u, 'release'],
    [parseControlledReleaseMutationCommand, `${release} --service forge-ui`, /unsupported option --service/u, 'release'],
    [parseControlledDeliveryCommand, 'forge-delivery contract inspect', /missing required --source/u, 'contract'],
    [parseControlledDeliveryCommand, 'forge-delivery contract bind --source docs/task.json', /missing required --binding, --purpose/u, 'contract'],
    [parseControlledDeliveryCommand, 'forge-delivery contract verify --source docs/task.json', /missing required --binding/u, 'contract'],
    [parseControlledDeliveryCommand, bind.replace('implementation', 'release'), /invalid value for --purpose/u, 'contract'],
    [parseControlledDeliveryCommand, inspect.replace('docs/task.json', '../outside.json'), /ordinary repository-relative files/u, 'contract'],
    [parseControlledDeliveryCommand, inspect.replace('docs/task.json', '.forge-delivery/task.json'), /outside generated .forge-delivery state/u, 'contract'],
    [parseControlledDeliveryCommand, `${inspect} --source docs/other.json`, /exactly one --source/u, 'contract'],
    [parseControlledDeliveryCommand, `${inspect} --root other`, /unsupported option --root/u, 'contract'],
  ];
  for (const [parse, command, expected, family] of cases) {
    assert.equal(parse(command), null, command);
    const denial = guard(command);
    assert.match(denial, expected, command);
    assert.match(denial, /Command not executed/u);
    assert.match(denial, new RegExp(`Exact ${family} argv:`));
    assert.match(denial, /continue in this turn within the existing authorization/u);
    assert.match(denial, /do not request new user confirmation merely for this syntax error/u);
    assert.doesNotMatch(denial, /do-not-echo-this/u, 'invalid JSON contents must not be copied into diagnostics');
  }
  for (const [parse, command] of [[preparationParser, prepare], [parseControlledReleaseMutationCommand, release],
    [parseControlledDeliveryCommand, inspect], [parseControlledDeliveryCommand, bind], [parseControlledDeliveryCommand, verify]]) {
    assert.ok(parse(command), command);
    assert.equal(controlledEvidenceCommandHint(command), '', command);
    for (const unsafe of [`${command}; id`, `${command} | cat`, `${command} > output`, `TOKEN=secret ${command}`, `echo ${command}`]) {
      assert.equal(parse(unsafe), null, unsafe);
      assert.equal(controlledEvidenceCommandHint(unsafe), '', unsafe);
      assert.ok(guard(unsafe), unsafe);
    }
  }
  assert.match(guard(prepare), /requires the current protected cross-layer preparation context/u);
  assert.match(guard(release), /exceeds the protected contract ceiling read-only/u);
  assert.match(guard(bind), /requires the current validated protected task context/u);
});

test('release mutation parsing retains all 66 paths of a complete module', () => {
  const paths = Array.from({ length: 66 }, (_, index) => `src/module/File${index}.java`);
  const pathOptions = paths.map(file => `--path ${file}`).join(' ');
  const binding = `--expected-head ${sha} --expected-fingerprint ${'b'.repeat(64)}`;
  for (const command of [
    `forge-release checkpoint ${pathOptions} --message-base64 ${Buffer.from('Complete module').toString('base64url')} ${binding}`,
    `forge-release integrate --mode start ${binding} --canonical-head ${sha} ${pathOptions}`,
  ]) assert.deepEqual(parseControlledReleaseMutationCommand(command)?.options['--path'], paths);
});

test('release mutation parsing preserves deep module paths beyond eight KiB', () => {
  const paths = Array.from({ length: 80 }, (_, index) => `forge-server/forge-business/forge-business-core/src/main/java/com/example/business/core/leadership/service/ModuleImplementation${index}.java`);
  const pathOptions = paths.map(file => `--path ${file}`).join(' ');
  const binding = `--expected-head ${sha} --expected-fingerprint ${'b'.repeat(64)}`;
  for (const command of [
    `forge-release checkpoint ${pathOptions} --message-base64 Y2hlY2twb2ludA ${binding}`,
    `/usr/local/bin/forge-release integrate --mode start ${binding} --canonical-head ${sha} ${pathOptions}`,
  ]) {
    assert.ok(command.length > 8192 && command.length < 64 * 1024);
    assert.deepEqual(parseControlledReleaseMutationCommand(command)?.options['--path'], paths);
    for (const invalid of [`${command}; id`, `${command} --path ../outside`, `${command} --path ${paths[0]}`, `${command} --unexpected value`, command + ' '.repeat(64 * 1024)]) {
      assert.equal(parseControlledReleaseMutationCommand(invalid), null);
    }
  }
  assert.equal(parseControlledReleaseInspectionCommand('forge-release status' + ' '.repeat(8192)), null);
});

test('backend test coverage directories agree across policy, controlled parser and real release CLI', async (t) => {
  const core = 'forge-server/forge-business/forge-business-core/src/test';
  const flow = 'forge-server/forge-flow/forge-flow-server/src/test/java/com/mdframe/forge/flow/coverage';
  const paths = [
    ...['MigrationBaselineMySqlTest', 'SeedReplayMySqlTest', 'SmallFixOrderRemarkFixture', 'SmallFixOrderRemarkValidationTest']
      .map(name => `${core}/java/com/mdframe/forge/business/core/coverage/${name}.java`),
    `${core}/resources/coverage/rbac-role-omitted.sql`,
    ...['FlowableBusinessCallbackIntegrationTest', 'FlowableKeepOnVersionIntegrationTest'].map(name => `${flow}/${name}.java`),
  ];
  const root = await mkdtemp(path.join(tmpdir(), 'forge-test-coverage-paths-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'local-path-check-fixture-'.repeat(3));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(validateTaskspaceAction(body));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { captured: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const cli = fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url));
  const invoke = async argv => {
    const child = spawn(process.execPath, [cli, ...argv], {
      env: { ...process.env, FORGE_TASKSPACE_ID: '', FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { exit, stderr };
  };
  const forbidden = [
    'coverage/report.json', 'forge-admin-ui/src/test/java/coverage/Test.java',
    'forge-server/module/coverage/src/test/java/Test.java',
    'forge-server/module/src/main/java/coverage/Test.java',
    `${core}/resources/coverage`, `${core}/resources/coverage/../outside.sql`,
    `${core}/resources/coverage/invalid name.sql`, `${core}/resources/coverage/测试.sql`,
    `${core}/resources/coverage/${'x'.repeat(512)}`,
    ...['.git', '.forge-cache', 'node_modules', 'target', 'dist', 'build', '.pnpm-store']
      .map(segment => `${core}/resources/coverage/${segment}/artifact.sql`),
  ];
  for (const action of ['checkpoint', 'integrate']) {
    await t.test(action, async () => {
      const fixed = action === 'checkpoint'
        ? ['--message-base64', Buffer.from('Save reviewed test sources').toString('base64url')]
        : ['--mode', 'start', '--canonical-head', sha];
      const argv = selected => [action, ...fixed, '--expected-head', sha,
        '--expected-fingerprint', 'b'.repeat(64), ...selected.flatMap(value => ['--path', value])];
      const request = selected => ({ action, paths: selected, expectedHead: sha, expectedWorkspaceFingerprint: 'b'.repeat(64),
        ...(action === 'checkpoint' ? { message: 'Save reviewed test sources' } : { mode: 'start', canonicalHead: sha }) });
      assert.deepEqual(validateTaskspaceAction(request(paths)).paths, paths);
      assert.deepEqual(parseControlledReleaseMutationCommand(`forge-release ${argv(paths).join(' ')}`)?.options['--path'], paths);
      const accepted = await invoke(argv(paths));
      assert.equal(accepted.exit, 0, accepted.stderr);
      assert.deepEqual(requests.at(-1), request(paths));
      for (const invalid of forbidden) {
        assert.throws(() => validateTaskspaceAction(request([invalid])), /checkpoint path/u, invalid);
        assert.equal(parseControlledReleaseMutationCommand(`forge-release ${argv([invalid]).join(' ')}`), null, invalid);
        const before = requests.length;
        const refused = await invoke(argv([invalid]));
        assert.equal(refused.exit, 1, invalid);
        assert.match(refused.stderr, /Invalid (?:checkpoint|integrate) path/u);
        assert.equal(requests.length, before, 'invalid paths never reach the local capture fixture');
      }
    });
  }
  assert.equal(requests.length, 2, 'only two local capture requests, no real checkpoint or integration');
});

test('dynamic route paths agree across policy, quoted controlled command and real release CLI', async (t) => {
  const route = 'forge-admin-ui/src/views/accident/report-form/[type].vue';
  const root = await mkdtemp(path.join(tmpdir(), 'forge-dynamic-route-path-'));
  const token = path.join(root, 'token');
  await writeFile(token, 'local-dynamic-route-fixture-'.repeat(3));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(validateTaskspaceAction(JSON.parse(Buffer.concat(chunks))));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { captured: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const invoke = async argv => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url)), ...argv], {
      env: { ...process.env, FORGE_TASKSPACE_ID: '', FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { exit, stderr };
  };
  const forbidden = ['../[type].vue', '/src/[type].vue', 'src/../[type].vue', 'src//[type].vue',
    'src/node_modules/[type].vue', 'src/.git/[type].vue', 'src/*/[type].vue', 'src/?/[type].vue',
    'src/$(id)/[type].vue', `src/${'x'.repeat(512)}/[type].vue`];
  for (const action of ['checkpoint', 'integrate']) {
    await t.test(action, async () => {
      const fixed = action === 'checkpoint' ? ['--message-base64', Buffer.from('Save dynamic route').toString('base64url')]
        : ['--mode', 'start', '--canonical-head', sha];
      const argv = file => [action, ...fixed, '--expected-head', sha, '--expected-fingerprint', 'b'.repeat(64), '--path', file];
      const request = file => ({ action, paths: [file], expectedHead: sha, expectedWorkspaceFingerprint: 'b'.repeat(64),
        ...(action === 'checkpoint' ? { message: 'Save dynamic route' } : { mode: 'start', canonicalHead: sha }) });
      assert.deepEqual(validateTaskspaceAction(request(route)).paths, [route]);
      for (const quote of ["'", '"']) {
        assert.deepEqual(parseControlledReleaseMutationCommand(`forge-release ${argv(`${quote}${route}${quote}`).join(' ')}`)?.options['--path'], [route]);
      }
      assert.equal(parseControlledReleaseMutationCommand(`forge-release ${argv(route).join(' ')}`), null, 'unquoted brackets remain shell globs');
      const accepted = await invoke(argv(route));
      assert.equal(accepted.exit, 0, accepted.stderr);
      assert.deepEqual(requests.at(-1), request(route));
      for (const file of forbidden) {
        assert.throws(() => validateTaskspaceAction(request(file)), /checkpoint path/u);
        assert.equal(parseControlledReleaseMutationCommand(`forge-release ${argv(`'${file}'`).join(' ')}`), null);
        const before = requests.length;
        const rejected = await invoke(argv(file));
        assert.equal(rejected.exit, 1, file);
        assert.equal(requests.length, before, 'invalid path never leaves the CLI');
      }
      for (const command of [
        `forge-release ${argv(`'${route}'`).join(' ')}; id`,
        `forge-release ${argv(`'${route}'suffix`).join(' ')}`,
        `forge-release ${argv(`"${route}"`).join(' ')} --path '${route}'`,
      ]) assert.equal(parseControlledReleaseMutationCommand(command), null);
    });
  }
  assert.equal(requests.length, 2);
  assert.equal(parseControlledEvidenceCommand(`forge-verify run --profile frontend-admin-lint --file '${route}' --idempotency-key route-test-01`), null,
    'quoted route handling is confined to release mutations');
});

test('parsing admits only the exact bounded integrate argv', () => {
  const fingerprint = 'b'.repeat(64);
  const canonicalHead = 'c'.repeat(40);
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  const start = `forge-release integrate --mode start --expected-head ${sha} --expected-fingerprint ${fingerprint} --canonical-head ${canonicalHead} --path src/app.mjs --path tests/app.test.mjs`;
  assert.deepEqual(parseControlledReleaseMutationCommand(start), {
    family: 'forge-release-mutation',
    executable: 'forge-release',
    action: 'integrate',
    options: {
      '--mode': 'start',
      '--expected-head': sha,
      '--expected-fingerprint': fingerprint,
      '--canonical-head': canonicalHead,
      '--path': ['src/app.mjs', 'tests/app.test.mjs'],
    },
  });
  assert.equal(
    parseControlledReleaseMutationCommand(`/usr/local/bin/forge-release integrate --mode continue --operation-id ${operationId} --expected-head ${sha} --expected-fingerprint ${fingerprint} --canonical-head ${canonicalHead}`)?.action,
    'integrate',
  );

  const requiredFlags = ['--mode', '--expected-head', '--expected-fingerprint', '--canonical-head'];
  for (const flag of requiredFlags) {
    const tokens = start.split(' ');
    const index = tokens.indexOf(flag);
    tokens.splice(index, 2);
    assert.equal(parseControlledReleaseMutationCommand(tokens.join(' ')), null, `missing ${flag}`);
  }
  for (const command of [
    start.replace('--mode start', '--mode finish'),
    start.replace('--mode start', '--mode start --mode start'),
    start.replace(`--expected-head ${sha}`, `--expected-head ${sha} --expected-head ${sha}`),
    start.replace(`--expected-fingerprint ${fingerprint}`, `--expected-fingerprint ${fingerprint} --expected-fingerprint ${fingerprint}`),
    start.replace(`--canonical-head ${canonicalHead}`, `--canonical-head ${canonicalHead} --canonical-head ${canonicalHead}`),
    `${start} --operation-id ${operationId}`,
    start.replace('--path tests/app.test.mjs', '--path src/app.mjs'),
    start.replace('--path src/app.mjs', '--path ../app.mjs'),
    `${start} --unknown value`,
    `${start}; id`,
    `forge-release integrate --mode continue --expected-head ${sha} --expected-fingerprint ${fingerprint} --canonical-head ${canonicalHead}`,
    `forge-release integrate --mode continue --operation-id not-a-uuid --expected-head ${sha} --expected-fingerprint ${fingerprint} --canonical-head ${canonicalHead}`,
    `forge-release integrate --mode start --expected-head ${'A'.repeat(40)} --expected-fingerprint ${fingerprint} --canonical-head ${canonicalHead}`,
    `forge-release integrate --mode start --expected-head ${sha} --expected-fingerprint ${'x'.repeat(64)} --canonical-head ${canonicalHead}`,
    `forge-release integrate --mode start --expected-head ${sha} --expected-fingerprint ${fingerprint} --canonical-head ${'x'.repeat(40)}`,
    `forge-release integrate --mode start --expected-head ${sha} --expected-fingerprint ${fingerprint} --canonical-head ${canonicalHead} ${Array.from({ length: 65 }, (_, index) => `--path src/${index}.mjs`).join(' ')} --path ../outside`,
  ]) assert.equal(parseControlledReleaseMutationCommand(command), null, command);
});

test('accepts truthful host-toolchain receipts without inventing container cache or Docker proofs', () => {
  const admitCommand = 'forge-verify admit --profile governance';
  const hostAdmission = hostAdmissionReceipt();
  assert.equal(
    controlledEvidenceReceipt(admitCommand, JSON.stringify(hostAdmission))?.receipt.admissionId,
    admission,
  );
  const forged = structuredClone(hostAdmission);
  forged.cache = { compatible: true, packDigest: `sha256:${'f'.repeat(64)}` };
  assert.equal(controlledEvidenceReceipt(admitCommand, JSON.stringify(forged)), null);

  const runCommand = `forge-verify run --profile governance --admission-id ${admission} --idempotency-key host-run-0001`;
  assert.equal(
    controlledEvidenceReceipt(runCommand, JSON.stringify(hostRunReceipt()))?.receipt.receiptType,
    'forge-verify/host-run',
  );
  const selectedCommand = `forge-verify run --profile frontend-admin-lint --file forge-admin-ui/src/views/example/index.vue --admission-id ${admission} --idempotency-key host-lint-0001`;
  const selectedReceipt = hostRunReceipt('frontend-admin-lint', { files: ['forge-admin-ui/src/views/example/index.vue'] });
  assert.equal(controlledEvidenceReceipt(selectedCommand, JSON.stringify(selectedReceipt))?.receipt.receiptType, 'forge-verify/host-run');
  assert.equal(
    controlledEvidenceReceipt(
      selectedCommand,
      JSON.stringify(hostRunReceipt('frontend-admin-lint', { files: ['forge-admin-ui/src/views/other/index.vue'] })),
    ),
    null,
  );
  const unclean = hostRunReceipt();
  unclean.execution.steps[0].cleanup.proven = false;
  assert.equal(controlledEvidenceReceipt(runCommand, JSON.stringify(unclean)), null);
});
test('background verification has a bounded argv and an acknowledgement cannot prove success', () => {
  const command = `forge-verify run --profile full-regression --admission-id ${admission} --idempotency-key background-12345 --execution-mode background`;
  assert.equal(parseControlledEvidenceCommand(command)?.options['--execution-mode'], 'background');
  for (const invalid of [command.replace('full-regression', 'governance'),
    command.replace('--execution-mode background', '--execution-mode detached'), `${command} --reuse-receipt ${admission}`,
    `${command} --execution-mode background`, `${command} &`]) {
    assert.equal(parseControlledEvidenceCommand(invalid), null);
  }
  const ack = { schemaVersion: 1, receiptType: 'forge-verify/host-job', jobId: admission, receiptId: admission,
    status: 'accepted', request: { profile: 'full-regression', admissionId: admission, idempotencyKey: 'background-12345', selectors: {} },
    truth: { executionProven: false, verificationProven: false, releaseProven: false } };
  assert.ok(controlledEvidenceReceipt(command, JSON.stringify(ack)));
  assert.equal(controlledEvidenceReceipt(command, JSON.stringify({ ...ack, truth: { ...ack.truth, verificationProven: true } })), null);
  assert.equal(controlledEvidenceReceipt(command.replace('full-regression', 'frontend-admin-build'), JSON.stringify(ack)), null);
});

test('long default commands submit in background while focused tests and receipt reuse stay immediate', () => {
  for (const profile of ['full-regression', 'frontend-admin-build', 'frontend-admin-test']) {
    const command = 'forge-verify run --profile ' + profile + ' --admission-id ' + admission + ' --idempotency-key default-background';
    assert.equal(parseControlledEvidenceCommand(command)?.options['--execution-mode'], 'background');
    assert.equal(parseControlledEvidenceCommand(command + ' --reuse-receipt ' + admission)?.options['--execution-mode'], undefined);
  }
  const focused = 'forge-verify run --profile frontend-admin-test --admission-id ' + admission
    + ' --idempotency-key focused-test --test-file forge-admin-ui/src/example.test.js';
  assert.equal(parseControlledEvidenceCommand(focused)?.options['--execution-mode'], undefined);
  for (const profile of ['backend-module-compile', 'backend-module-test', 'backend-test-class']) {
    const exact = profile === 'backend-test-class';
    const command = `forge-verify run --profile ${profile} --module forge-server/example`
      + (exact ? ' --test ExampleTest#behavior' : '')
      + ` --admission-id ${admission} --idempotency-key backend-long-default`;
    assert.equal(parseControlledEvidenceCommand(command)?.options['--execution-mode'], 'background');
    assert.equal(parseControlledEvidenceCommand(`${command} &`), null);
  }
  const red = `forge-verify run --profile backend-red-test --module forge-server/example --test ExampleTest#behavior --admission-id ${admission} --idempotency-key legacy-red`;
  assert.equal(parseControlledEvidenceCommand(red)?.options['--execution-mode'], undefined);
  assert.equal(parseControlledEvidenceCommand(`${red} --execution-mode background`), null);
});

test('wrong backend selectors explain the supported focused command without permitting shell composition', () => {
  const command = `forge-verify run --profile backend-module-test --module forge-server/example --test ExampleTest --admission-id ${admission} --idempotency-key focused-selector`;
  assert.equal(parseControlledEvidenceCommand(command), null);
  assert.match(controlledEvidenceCommandHint(command), /Use backend-test-class/u);
  assert.match(controlledEvidenceCommandHint(command), /does not satisfy the required module test/u);
  assert.equal(controlledEvidenceCommandHint(`${command}; arbitrary-command`), '');
  assert.match(controlledEvidenceCommandHint(command.replace('forge-server/example', '../outside')), /invalid value for --module/u);
});

test('verification argv diagnostics preserve actual validation failures and never admit malformed commands', () => {
  const focused = `forge-verify run --profile backend-test-class --admission-id ${admission} --idempotency-key single-direct-letter-backend-v1`;
  for (const [command, expected] of [
    [focused, /--module.*--test/u],
    [`${focused} --module forge-server/example`, /--test/u],
    [focused.replace(/ --admission-id [^ ]+/u, ''), /--admission-id/u],
    [focused.replace(/ --idempotency-key [^ ]+/u, ''), /--idempotency-key/u],
    [`${focused} --modules forge-server/example`, /unsupported option.*--modules/u],
    [`${focused} --profile backend-test-class`, /duplicate option.*--profile/u],
    [focused.replace('backend-test-class', 'unknown-profile'), /profile is not allowed/u],
    [`forge-verify run --profile frontend-red-test --admission-id ${admission} --idempotency-key frontend-missing-test`, /--test-file/u],
  ]) {
    assert.equal(parseControlledEvidenceCommand(command), null);
    assert.match(controlledEvidenceCommandHint(command), expected, command);
    assert.match(controlledEvidenceCommandHint(command), /not executed|did not execute/u);
  }
  const corrected = `${focused} --module forge-server/example --test ExampleTest`;
  assert.ok(parseControlledEvidenceCommand(corrected));
  assert.equal(controlledEvidenceCommandHint(corrected), '');
  for (const command of [`${focused}; echo done`, `TOKEN=secret ${focused}`, `echo ${focused}`]) {
    assert.equal(parseControlledEvidenceCommand(command), null);
    assert.equal(controlledEvidenceCommandHint(command), '');
  }
});

test('module verification hints identify missing modules without admitting invalid commands', () => {
  for (const profile of ['backend-module-test', 'backend-module-compile']) {
    const command = `forge-verify run --profile ${profile} --admission-id ${admission} --idempotency-key missing-module`;
    assert.equal(parseControlledEvidenceCommand(command), null);
    assert.match(controlledEvidenceCommandHint(command), /Missing required --module/u);
    assert.match(controlledEvidenceCommandHint(command), new RegExp(`run --profile ${profile} --module`));
    const combined = `${command} --test ExampleTest`;
    assert.equal(parseControlledEvidenceCommand(combined), null);
    assert.match(controlledEvidenceCommandHint(combined), /Missing required --module/u);
    assert.match(controlledEvidenceCommandHint(combined), /does not accept --test/u);
    assert.equal(controlledEvidenceCommandHint(`${command}; arbitrary-command`), '');
    assert.match(controlledEvidenceCommandHint(`${command} --unknown value`), /unsupported option --unknown/u);
    assert.match(controlledEvidenceCommandHint(`${command} --module`), /missing value for --module/u);
    const valid = `${command} --module forge-server/example`;
    assert.ok(parseControlledEvidenceCommand(valid));
    assert.equal(controlledEvidenceCommandHint(valid), '');
  }
});

test('the native completion watcher permits only observing one existing job', () => {
  const command = `forge-verify watch --job-id ${admission}`;
  assert.equal(parseControlledEvidenceCommand(command)?.action, 'watch');
  for (const invalid of [`${command} --wait-seconds 60`, `${command} --profile full-regression`,
    `${command} --job-id ${admission}`, `${command}; echo unsafe`, command.replace(admission, '../other')]) {
    assert.equal(parseControlledEvidenceCommand(invalid), null);
  }
});
