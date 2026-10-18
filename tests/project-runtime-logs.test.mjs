import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlledReleaseRunner } from '../docker/harness/release-runner.mjs';
import { validateReleaseRequest, validateRuntimeLogsRequest } from '../docker/harness/release-policy.mjs';

function runtimeContract(withApp = false) {
  const projectRoot = '/srv/forge-delivery/projects/runtime-demo';
  const services = ['forge-admin', ...(withApp ? ['forge-app'] : []), 'forge-flow', 'forge-ui'];
  return {
    schemaVersion: 3, projectSlug: 'runtime-demo', composeProjectName: 'forge-runtime-demo',
    projectRoot, workspaceRoot: `${projectRoot}/workspace`,
    infrastructure: {
      mysql: { mode: 'shared-external', host: 'mysql.internal', port: 3306, database: 'runtime_demo', testDatabase: 'runtime_demo_test', provisioningAllowed: false },
      redis: { mode: 'shared-external', host: 'redis.internal', port: 6379, database: 2, testDatabase: 15, provisioningAllowed: false },
    },
    release: {
      fixedComposeFile: `${projectRoot}/ops/compose.yaml`,
      allowedComposeServices: [...services, 'release-runner', 'taskspace-broker', 'conversation-manager', 'protected-acceptance', 'verification-runner'],
      allowedReleaseServices: services,
      protectedFiles: [...services.map(service => `docker-forge-admin/Dockerfile.${service.slice(6)}`),
        'docker-forge-admin/application-datasource.yml', 'docker-forge-admin/docker-compose.yml', 'docker-forge-admin/nginx.conf']
        .map(relativePath => ({ relativePath, sha256: '1'.repeat(64) })),
      databaseProvisioningAllowed: false, workspaceComposeAllowed: false,
      testDatabaseLifecycle: {
        mode: 'snapshot-restore-on-failure', backupRequired: true, restoreOnFailure: true, fullReplaySupported: false,
        operatorImage: `mysql:8.0@sha256:${'a'.repeat(64)}`,
        backupRoot: `${projectRoot}/backups/test-database-snapshots`, recoveryStateFile: `${projectRoot}/ops/test-database-recovery.json`,
      },
    },
  };
}

async function fixture(t, { output = 'forge-admin | Application failed to start\n', environment = '', command, withApp = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = runtimeContract(withApp);
  const calls = [];
  const runner = new ControlledReleaseRunner({
    projectRoot: contract.projectRoot, contractPath: '/project-runtime/contract.json',
    command: async (...args) => { calls.push(args); return command ? command(...args) : { code: 0, output }; },
  });
  runner.envFile = path.join(root, 'project.env');
  await writeFile(runner.envFile, environment, { mode: 0o600 });
  runner.loadContract = async () => contract;
  runner.preflight = runner.release = async () => { throw new Error('Runtime logs must not run release/preflight.'); };
  return { runner, contract, calls };
}

test('runtime logs default to only the trusted project business services with bounded tail and no implicit time window', () => {
  assert.deepEqual(validateRuntimeLogsRequest({ action: 'runtime-logs' }), { action: 'runtime-logs', tail: 200 });
  for (const withApp of [false, true]) {
    const contract = runtimeContract(withApp);
    assert.deepEqual(validateReleaseRequest({ action: 'runtime-logs' }, contract), {
      action: 'runtime-logs', services: contract.release.allowedReleaseServices, tail: 200,
    });
  }
  assert.deepEqual(validateReleaseRequest({ action: 'runtime-logs', services: ['forge-ui'], tail: 1000, sinceSeconds: 86400 }, runtimeContract()), {
    action: 'runtime-logs', services: ['forge-ui'], tail: 1000, sinceSeconds: 86400,
  });
});

test('runtime logs reject infrastructure, foreign projects, arbitrary inputs and unbounded requests', () => {
  const contract = runtimeContract();
  for (const extra of [
    { services: [] }, { services: ['forge-admin', 'forge-admin'] }, { services: ['forge-app'] },
    { services: ['release-runner'] }, { services: ['mysql'] }, { services: ['other-forge-admin'] },
    { services: ['--follow'] }, { services: ['forge-admin;id'] }, { services: 'forge-admin' },
    { tail: 0 }, { tail: 1001 }, { tail: '200' }, { tail: 1.5 }, { tail: null },
    { sinceSeconds: 0 }, { sinceSeconds: 86401 }, { sinceSeconds: '60' }, { sinceSeconds: 1.5 },
    { projectSlug: 'other' }, { container: 'other-forge-admin' }, { path: '/var/log' },
    { command: 'id' }, { follow: true }, { jobId: 'foreign' }, { approvalRef: 'owner' },
  ]) assert.throws(() => validateReleaseRequest({ action: 'runtime-logs', ...extra }, contract));
  assert.throws(() => validateRuntimeLogsRequest({ action: 'release' }));
});

test('runtime logs use fixed Compose and explicit project scope during another release without job ownership', async t => {
  const { runner, contract, calls } = await fixture(t);
  runner.activeJob = { jobId: 'another-conversation-release' };
  const result = await runner.execute({ action: 'runtime-logs' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'docker');
  assert.deepEqual(calls[0][1], ['compose', '--env-file', runner.envFile, '--file', contract.release.fixedComposeFile,
    '--project-name', contract.composeProjectName, 'logs', '--no-color', '--timestamps', '--tail', '200', ...contract.release.allowedReleaseServices]);
  assert.deepEqual(calls[0][2], { cwd: runner.opsRoot, timeoutMs: 30000 });
  assert.equal(result.source, 'project-runtime');
  assert.equal(result.projectSlug, 'runtime-demo');
  assert.deepEqual(result.services, contract.release.allowedReleaseServices);
  assert.match(result.output, /Application failed to start/u);
  assert.equal(result.truncated, false);
  assert.equal(result.maxOutputBytes, 65536);
  assert.equal(Object.hasOwn(result, 'sinceSeconds'), false);
  assert.ok(!Number.isNaN(Date.parse(result.observedAt)));
});

test('runtime logs narrow service and time selection without adding follow or starting services', async t => {
  const { runner, calls } = await fixture(t);
  const result = await runner.execute({ action: 'runtime-logs', services: ['forge-admin'], tail: 100, sinceSeconds: 600 });
  assert.deepEqual(calls[0][1].slice(calls[0][1].indexOf('logs')), ['logs', '--no-color', '--timestamps', '--tail', '100', '--since', '600s', 'forge-admin']);
  assert.equal(result.sinceSeconds, 600);
  assert.deepEqual(result.services, ['forge-admin']);
});

test('runtime log output redacts credentials before clipping and retains useful failure diagnostics', async t => {
  const { runner } = await fixture(t, {
    environment: 'MYSQL_PASSWORD=known-password-value\nPROJECT_AES_KEY="known-cryptographic-value"\nMODEL_API_TOKEN=known-model-value\n',
    output: [
      '\u001b[31mApplication failed: database unavailable\u001b[0m',
      'known-password-value known-cryptographic-value known-model-value',
      '{"MYSQL_PASSWORD":"json-password","access_token":"json-token"}',
      'mysql://operator:url-password@mysql.internal/db',
      'Bearer bearer-token-value', 'Basic basic-auth-value',
      'Cookie: session=cookie-value; other=other-cookie-value',
      '{"Authorization":"Bearer header-token-value"}',
      '-----BEGIN PRIVATE KEY-----\nprivate-key-content\n-----END PRIVATE KEY-----',
      'token=assignment-token\u0007',
    ].join('\n'),
  });
  const result = await runner.execute({ action: 'runtime-logs' });
  assert.match(result.output, /Application failed: database unavailable/u);
  assert.match(result.output, /REDACTED/u);
  for (const secret of ['known-password-value', 'known-cryptographic-value', 'known-model-value', 'json-password', 'json-token',
    'url-password', 'bearer-token-value', 'basic-auth-value', 'cookie-value', 'other-cookie-value', 'header-token-value', 'private-key-content', 'assignment-token']) {
    assert.equal(result.output.includes(secret), false, secret);
  }
  assert.doesNotMatch(result.output, /[\u001b\u0007]/u);
});

test('runtime logs bound UTF-8 output to 64 KiB while preserving the newest diagnostics', async t => {
  const { runner } = await fixture(t, { output: '中'.repeat(30000) + '\nLatest startup failure\n' });
  const result = await runner.execute({ action: 'runtime-logs' });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 65536);
  assert.ok(result.output.endsWith('Latest startup failure\n'));
  assert.doesNotMatch(result.output, /\ufffd/u);
});

test('runtime logs fully redact quoted credential assignments containing spaces outside project environment values', async t => {
  const { runner } = await fixture(t, {
    output: 'password="alpha beta gamma"\nCLIENT_SECRET=\'delta epsilon zeta\'\nStartup failed: connection refused\n',
  });
  const result = await runner.execute({ action: 'runtime-logs' });
  for (const secretPart of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    assert.equal(result.output.includes(secretPart), false, secretPart);
  }
  assert.match(result.output, /password=\[REDACTED\]/u);
  assert.match(result.output, /CLIENT_SECRET=\[REDACTED\]/u);
  assert.match(result.output, /Startup failed: connection refused/u);
});

test('runtime log errors expose bounded sanitized diagnostics without raw Docker errors', async t => {
  const { runner } = await fixture(t, {
    environment: 'MYSQL_PASSWORD=secret-on-error\n',
    command: async () => { const error = new Error('raw sensitive error'); error.output = 'docker unavailable secret-on-error Cookie: session=private-cookie'; throw error; },
  });
  await assert.rejects(runner.execute({ action: 'runtime-logs' }), error => {
    assert.equal(error.code, 'RUNTIME_LOGS_UNAVAILABLE');
    assert.equal(error.stage, 'runtime-logs');
    assert.match(error.diagnosticExcerpt, /docker unavailable/u);
    assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostic: error.diagnosticExcerpt }), /secret-on-error|private-cookie|raw sensitive/u);
    return true;
  });
});

test('runtime logs fail closed before Docker when project redaction inputs cannot be read', async t => {
  const { runner, calls } = await fixture(t);
  runner.envFile += '.missing';
  await assert.rejects(runner.execute({ action: 'runtime-logs' }), { code: 'RUNTIME_LOGS_UNAVAILABLE' });
  assert.equal(calls.length, 0);
});

test('invalid runtime log scope cannot reach Docker', async t => {
  const { runner, calls } = await fixture(t);
  await assert.rejects(runner.execute({ action: 'runtime-logs', services: ['release-runner'] }));
  await assert.rejects(runner.execute({ action: 'runtime-logs', projectSlug: 'another' }));
  assert.equal(calls.length, 0);
});
