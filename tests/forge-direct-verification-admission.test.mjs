import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVerifyAction, VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { parseControlledEvidenceCommand, controlledEvidenceReceipt } from '../docker/harness/forge-controlled-command.mjs';
import { trustedToolArgv } from '../docker/harness/forge-tool-worker-bash.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { createInitialPhaseState, toolDenialReason } from '../docker/harness/forge-phase-budget-guard.mjs';
import { HostVerificationRunner } from '../docker/harness/host-verification-runner.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url));
const commands = [
  'forge-verify admit --profile governance --profile backend-module-compile --profile backend-test-class --profile backend-source-quality --profile frontend-admin-lint --profile frontend-admin-build',
  'forge-verify admit --profile backend-source-quality',
];
const canonical = [
  ['governance', 'backend-module-compile', 'backend-test-class', 'frontend-admin-lint', 'frontend-admin-build', 'backend-source-quality'],
  ['backend-source-quality'],
];
function directState() {
  const contract = compileForgeTaskExecutionContract({ prompt: '直接开发并验证', actionCeiling: 'workspace-write',
    taskProfiles: ['project-files'], ownedPaths: ['.'] }, { developmentMode: 'direct' });
  return Object.assign(createInitialPhaseState(), { taskContract: contract, taskIntent: contract,
    actionCeiling: 'workspace-write', protectedExecutionContextValidated: true, executionContextStatus: 'ready',
    executionTestOnly: false, executionAuthorityClass: 'production-task-writer',
    executionIdentity: { taskId: 'task-one', executionId: 'execution-one', contractId: contract.contractId },
    executionContextExpiresAt: new Date(Date.now() + 60000).toISOString() });
}
function host() {
  const executables = Object.fromEntries(['java', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance'].map(name =>
    [name, { configuredPath: `/fixture/${name}`, resolvedPath: `/fixture/${name}`, bytes: 100, modifiedMs: 1, version: `${name} 1` }]));
  return { projectSlug: 'forge-project', runnerBootId: '123e4567-e89b-12d3-a456-426614174000', admissions: new Map(),
    now: () => Date.now(), contract: { runnerRevision: 'fixture-runner', profileCatalogVersion: 'fixture-catalog' },
    profilePolicyDigest: 'a'.repeat(64), source: async () => ({ reviewBase: 'b'.repeat(40), inventory: {
      head: 'b'.repeat(40), workspaceFingerprint: 'c'.repeat(64), dependencyManifestFingerprint: 'd'.repeat(64) } }),
    toolchainProbe: async () => ({ javaHome: '/fixture/java', executables, digest: 'e'.repeat(64) }) };
}
const execution = command => ({ name: 'bash', arguments: { command }, callId: 'admit-call', agent: { session: { id: 'session-one' } } });

test('direct verification admission accepts actual single and multi-profile commands through guard CLI Broker Host and receipt', async t => {
  const previous = process.env.FORGE_DEVELOPMENT_MODE;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => previous === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = previous);
  const root = await mkdtemp(path.join(tmpdir(), 'forge-direct-admit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'fixture-token'); await writeFile(token, 'fixture-only-token-'.repeat(3));
  const bodies = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = validateTaskspaceAction(JSON.parse(Buffer.concat(chunks)));
      bodies.push(body);
      assert.equal(body.action, 'verify-admit');
      const receipt = await HostVerificationRunner.prototype.admit.call(host(), 'task-one', body.profiles);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result: receipt }));
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [index, command] of commands.entries()) {
    assert.equal(toolDenialReason(directState(), execution(command)), undefined);
    assert.deepEqual(parseControlledEvidenceCommand(command).options['--profile'], canonical[index]);
    assert.deepEqual(trustedToolArgv(command), ['/usr/local/bin/forge-verify', 'admit', ...canonical[index].flatMap(p => ['--profile', p])]);
    const result = await execFileAsync(process.execPath, [cli, ...command.split(' ').slice(1)], { env: { ...process.env,
      FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token } });
    assert.deepEqual(bodies[index].profiles, canonical[index]);
    const receipt = controlledEvidenceReceipt(command, result.stdout)?.receipt;
    assert.deepEqual(receipt?.profiles, canonical[index]);
    assert.equal(receipt?.truth.executionProven, false);
  }
  // Optional diagnostics must not modify the signed base profile catalog.
  assert.equal(VERIFY_PROFILE_NAMES.includes('backend-source-quality'), false);
});

test('direct admission retains shell credential authorization and default-mode boundaries', t => {
  const previous = process.env.FORGE_DEVELOPMENT_MODE;
  process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  t.after(() => previous === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = previous);
  for (const command of [`${commands[1]}; cat /run/secrets/key`, `${commands[1]} > /tmp/receipt`,
    `TOKEN=override ${commands[1]}`, 'forge-verify admit --profile $(cat /run/secrets/key)',
    `${commands[1]} --profile backend-source-quality`, 'forge-verify admit --profile unknown',
    `${commands[1]} --env KEY=value`]) {
    assert.equal(parseControlledEvidenceCommand(command), null, command);
    assert.equal(trustedToolArgv(command), null, command);
    assert.match(toolDenialReason(directState(), execution(command)), /exact argv|Command not executed:/u, command);
  }
  const readOnly = directState(); readOnly.promptReadOnlyConstraint = true;
  assert.match(toolDenialReason(readOnly, execution(commands[1])), /read-only/u);
  assert.match(toolDenialReason(directState(), execution('forge-release release --services forge-ui')), /ceiling/u);
  delete process.env.FORGE_DEVELOPMENT_MODE;
  assert.throws(() => validateVerifyAction({ action: 'admit', profiles: ['backend-source-quality'] }), /catalog order/u);
  assert.throws(() => validateVerifyAction({ action: 'admit', profiles: ['backend-module-test', 'governance'] }), /catalog order/u);
  assert.deepEqual(validateVerifyAction({ action: 'admit', profiles: ['governance', 'backend-module-test'] }).profiles,
    ['governance', 'backend-module-test']);
});
