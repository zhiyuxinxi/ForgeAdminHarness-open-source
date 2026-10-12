import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const composeFile = path.join(repositoryRoot, 'templates/taskspace/compose.yaml');
const proxyKeys = ['HTTPS_PROXY', 'NODE_USE_ENV_PROXY', 'NO_PROXY'];

function renderTaskspace(proxyLines = []) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'forge-taskspace-proxy-'));
  try {
    const values = {
      TASKSPACE_COMPOSE_PROJECT_NAME: 'forge-test-proxy',
      HARNESS_IMAGE: 'example.invalid/harness:proxy-test',
      TASKSPACE_ROOT: '/srv/forge-test/task',
      PROJECT_ROOT: '/srv/forge-test/project',
      PROJECT_COMPOSE_NAME: 'forge-test',
      PROJECT_SLUG: 'forge-test',
      FORGE_BIND_ADDRESS: '127.0.0.1',
      TASKSPACE_HARNESS_PORT: '20000',
      HARNESS_UPLOAD_TOKEN: 'non-secret-test-placeholder',
      FORGE_SKILL_BUNDLE_ROOT: '/srv/forge-test/skills',
      PROJECT_FTP_INPUT_ROOT: '/srv/forge-test/ftp',
      PROJECT_SHARED_INPUT_ROOT: '/srv/forge-test/shared',
      PLATFORM_CONVERSATION_AUTH_ROOT: '/srv/forge-test/auth',
      TASKSPACE_ID: 'proxy-test',
      TASKSPACE_ACTOR_ID: 'admin',
      TASKSPACE_ACTOR_USER_ID: '11111111-1111-4111-8111-111111111111',
      TASKSPACE_CONVERSATION_ID: '22222222-2222-4222-8222-222222222222',
      DEEPSEEK_KEY_FILE: '/srv/forge-test/secrets/deepseek',
      KIMI_KEY_FILE: '/srv/forge-test/secrets/kimi',
      GLM_KEY_FILE: '/srv/forge-test/secrets/glm',
    };
    const envFile = path.join(temporaryRoot, 'task.env');
    writeFileSync(envFile, [
      ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
      ...proxyLines,
      '',
    ].join('\n'));
    const environment = { ...process.env };
    for (const key of [...Object.keys(values), 'TASKSPACE_HTTPS_PROXY', 'TASKSPACE_NO_PROXY']) {
      delete environment[key];
    }
    const result = spawnSync('docker', [
      'compose', '--env-file', envFile, '--file', composeFile,
      'config', '--format', 'json', '--no-path-resolution',
    ], { cwd: temporaryRoot, env: environment, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(tmpdir()));
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('TaskSpace proxy is off for both old environments and newly created TaskSpaces', () => {
  const source = readFileSync(path.join(repositoryRoot, 'scripts/taskspacectl.sh'), 'utf8');
  const defaults = source.split(/\r?\n/u).filter((line) => /^TASKSPACE_(?:HTTPS_PROXY|NO_PROXY)=/u.test(line));
  assert.deepEqual(defaults, ['TASKSPACE_HTTPS_PROXY=', 'TASKSPACE_NO_PROXY=']);
  for (const lines of [[], defaults]) {
    const rendered = renderTaskspace(lines);
    assert.equal(rendered.services.harness.environment.HTTPS_PROXY, '');
    assert.equal(rendered.services.harness.environment.NODE_USE_ENV_PROXY, '');
    for (const key of proxyKeys) assert.equal(rendered.services['harness-upload'].environment[key], undefined);
  }
});

test('an explicit TaskSpace proxy persists across rendering and only changes Harness egress fields', () => {
  const baseline = renderTaskspace();
  const enabled = renderTaskspace([
    'TASKSPACE_HTTPS_PROXY=http://10.240.0.1:7897',
    'TASKSPACE_NO_PROXY=.project.internal',
  ]);
  const repeated = renderTaskspace([
    'TASKSPACE_HTTPS_PROXY=http://10.240.0.1:7897',
    'TASKSPACE_NO_PROXY=.project.internal',
  ]);
  assert.deepEqual(repeated, enabled);
  const environment = enabled.services.harness.environment;
  assert.equal(environment.NODE_USE_ENV_PROXY, '1');
  assert.equal(environment.HTTPS_PROXY, 'http://10.240.0.1:7897');
  assert.deepEqual(environment.NO_PROXY.split(','), [
    'localhost', '127.0.0.1', '::1', 'taskspace-broker', 'harness-upload', '.project.internal',
  ]);
  for (const key of proxyKeys) {
    delete baseline.services.harness.environment[key];
    delete enabled.services.harness.environment[key];
  }
  assert.deepEqual(enabled, baseline);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('Node native fetch uses the enabled HTTPS proxy and bypasses loopback HTTP', async () => {
  const connects = [];
  const proxy = createServer((_request, response) => {
    response.writeHead(500).end('unexpected proxy request');
  });
  proxy.on('connect', (request, socket) => {
    connects.push(request.url);
    socket.end('HTTP/1.1 502 Test proxy reached\r\nConnection: close\r\n\r\n');
  });
  const local = createServer((_request, response) => response.end('direct'));
  try {
    const proxyPort = await listen(proxy);
    const localPort = await listen(local);
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (/^(?:http|https|all|no)_proxy$/iu.test(key)) delete environment[key];
    }
    Object.assign(environment, {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: 'localhost,127.0.0.1,::1,taskspace-broker,harness-upload',
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const local = await fetch('http://127.0.0.1:${localPort}', { signal: AbortSignal.timeout(5000) });
        if (await local.text() !== 'direct') process.exit(2);
        try {
          await fetch('https://codex-proxy-probe.invalid/', { signal: AbortSignal.timeout(5000) });
          process.exit(3);
        } catch { process.stdout.write('checked'); }
      `], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'checked');
    assert.deepEqual(connects, ['codex-proxy-probe.invalid:443']);
  } finally {
    proxy.closeAllConnections();
    local.closeAllConnections();
    await Promise.all([proxy, local].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
