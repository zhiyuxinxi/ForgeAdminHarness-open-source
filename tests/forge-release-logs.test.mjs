import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TaskspaceBroker, createTaskspaceBrokerServer } from '../docker/harness/taskspace-broker.mjs';
import { hashTaskspaceToken, validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';

const { parseArguments } = createRequire(import.meta.url)('../docker/harness/forge-release');
const cli = fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url));

async function runCli(args, environment) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, FORGE_TASKSPACE_ID: '', FORGE_TASKSPACE_BROKER_URL: '',
      FORGE_TASKSPACE_TOKEN_FILE: '', ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

test('logs CLI preserves startup history by default and converts only bounded log options', async () => {
  assert.deepEqual(await parseArguments(['logs']), { command: 'logs', tail: 200 });
  assert.deepEqual(await parseArguments(['logs', '--services', 'forge-admin,forge-ui', '--tail', '1000', '--since', '24h']),
    { command: 'logs', services: ['forge-admin', 'forge-ui'], tail: 1000, sinceSeconds: 86400 });
  for (const duration of ['1s', '10m', '2h', '86400s', '1440m']) {
    assert.ok((await parseArguments(['logs', '--since', duration])).sinceSeconds >= 1);
  }
  for (const args of [
    ['--tail', '0'], ['--tail', '1001'], ['--tail', '01'], ['--tail', '1.5'],
    ['--tail', '1', '--tail', '2'], ['--since', '0s'], ['--since', '25h'],
    ['--since', '86401s'], ['--since', '-1m'], ['--since', '2026-10-14'],
    ['--services', 'forge-admin,forge-admin'], ['--services', 'forge-admin,'],
    ['--services', 'mysql'], ['--services', 'other-project-forge-admin'],
    ['--project', 'other-project'], ['--follow', 'true'], ['--tail'],
  ]) await assert.rejects(parseArguments(['logs', ...args]), undefined, args.join(' '));
});

test('Broker log schema rejects container selection, source authority and unbounded requests', () => {
  assert.deepEqual(validateTaskspaceAction({ action: 'logs' }), { action: 'logs', tail: 200 });
  assert.deepEqual(validateTaskspaceAction({ action: 'logs', services: ['forge-app'], tail: 1, sinceSeconds: 86400 }),
    { action: 'logs', services: ['forge-app'], tail: 1, sinceSeconds: 86400 });
  for (const extra of [
    { projectSlug: 'other-project' }, { taskId: 'release-owner' }, { containerId: 'arbitrary' },
    { composeFile: '/workspace/docker-compose.yml' }, { approvalRef: 'unused' },
    { services: [] }, { services: ['forge-app', 'forge-app'] }, { services: ['mysql'] },
    { tail: 0 }, { tail: 1001 }, { tail: '10' }, { tail: null },
    { sinceSeconds: 0 }, { sinceSeconds: 86401 }, { sinceSeconds: 1.5 }, { follow: true },
  ]) assert.throws(() => validateTaskspaceAction({ action: 'logs', ...extra }), undefined, JSON.stringify(extra));
});

test('two project Harness tokens read runtime logs during maintenance without candidate or release authority', async t => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-project-logs-'));
  const calls = [];
  const broker = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base',
    command: async () => { throw new Error('Runtime logs must not inspect or modify a candidate.'); },
    releaseClient: async request => {
      calls.push(request);
      return { source: 'project-runtime', projectSlug: 'forge-base', services: ['forge-admin'],
        output: 'forge-admin | Startup failure: missing configuration\n', truncated: false };
    },
  });
  const tasks = [
    { taskId: 'task-a', actorId: 'actor-a', projectSlug: 'forge-base', status: 'active', token: 'a'.repeat(64) },
    { taskId: 'task-b', actorId: 'actor-b', projectSlug: 'forge-base', status: 'active', token: 'b'.repeat(64) },
    { taskId: 'task-closed', actorId: 'actor-c', projectSlug: 'forge-base', status: 'closed', token: 'c'.repeat(64) },
    { taskId: 'task-other', actorId: 'actor-d', projectSlug: 'other-project', status: 'active', token: 'd'.repeat(64) },
  ];
  for (const task of tasks) {
    const taskRoot = path.join(broker.taskspacesRoot, task.taskId);
    await mkdir(path.join(taskRoot, 'workspace'), { recursive: true });
    await writeFile(path.join(taskRoot, 'workspace', 'dirty.txt'), 'uncommitted local work\n');
    await writeFile(path.join(taskRoot, 'metadata.json'), JSON.stringify({
      schemaVersion: 2, projectSlug: task.projectSlug, taskId: task.taskId, actorId: task.actorId,
      actorUserId: randomUUID(), conversationId: `conversation-${task.taskId}`, accessMode: 'conversation',
      branch: `task/${task.actorId}/${task.taskId}`, baseCommit: 'a'.repeat(40), status: task.status,
      accessTokenHash: hashTaskspaceToken(task.token), harnessPort: 21001,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
  }
  await mkdir(broker.stateRoot, { recursive: true });
  await writeFile(broker.maintenanceFile, JSON.stringify({ operationId: 'reviewed-maintenance' }));
  const server = createTaskspaceBrokerServer({ broker });
  server.keepAliveTimeout = 1;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(projectRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const task of tasks.slice(0, 2)) {
    const tokenFile = path.join(projectRoot, `${task.taskId}.token`);
    await writeFile(tokenFile, task.token);
    const result = await runCli(['logs', '--services', 'forge-admin', '--tail', '50', '--since', '10m'], {
      FORGE_TASKSPACE_BROKER_URL: origin, FORGE_TASKSPACE_TOKEN_FILE: tokenFile,
    });
    assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.result.projectSlug, 'forge-base');
    assert.match(response.result.output, /Startup failure/u);
  }
  assert.deepEqual(calls, Array(2).fill({ action: 'runtime-logs', services: ['forge-admin'], tail: 50, sinceSeconds: 600 }));
  const post = async (body, token) => {
    const response = await fetch(`${origin}/v1/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-forge-taskspace-token': token }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const closed = await post({ action: 'logs' }, tasks[2].token);
  assert.equal(closed.status, 422); assert.equal(closed.body.error.code, 'TASKSPACE_NOT_ACTIVE');
  for (const token of [tasks[3].token, 'e'.repeat(64), undefined]) {
    const denied = await post({ action: 'logs' }, token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'TASKSPACE_AUTHENTICATION_FAILED');
  }
  assert.equal((await post({ action: 'logs', projectSlug: 'other-project' }, tasks[0].token)).status, 422);
  assert.equal(calls.length, 2);
  const defaults = await post({ action: 'logs' }, tasks[0].token);
  assert.equal(defaults.status, 200);
  assert.deepEqual(calls.at(-1), { action: 'runtime-logs', tail: 200 });
});

test('direct project Harness uses its existing Runner socket for read-only runtime logs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-direct-logs-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-logs-${randomUUID()}` : path.join(root, 'runner.sock');
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks)));
    response.end(JSON.stringify({ ok: true, result: { source: 'project-runtime', output: 'startup log' } }));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  const result = await runCli(['logs'], { FORGE_RELEASE_RUNNER_SOCKET: socketPath });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.output, 'startup log');
  assert.deepEqual(calls, [{ action: 'runtime-logs', tail: 200 }]);
});
