import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const { resolveDefaultReleaseServices } = createRequire(import.meta.url)('../docker/harness/forge-release');
const pc = ['forge-admin', 'forge-flow', 'forge-ui'];
const mobile = ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'];
const reply = result => ({ statusCode: 200, responseBody: JSON.stringify({ ok: true, result }) });

test('default services use the reviewed Runner or Broker contract without submitting release', async () => {
  for (const services of [pc, mobile]) {
    const contract = { release: { allowedReleaseServices: services } };
    for (const result of [contract, { runnerContract: contract }]) {
      const requests = [];
      assert.deepEqual(await resolveDefaultReleaseServices(async body => {
        requests.push(body); return reply(result);
      }), services);
      assert.deepEqual(requests, [{ action: 'contract' }]);
    }
  }
});

test('unavailable or unreviewed contracts fail before release without fallback to four services', async () => {
  for (const services of [undefined, [], ['mysql'], [...pc, 'forge-ui'], ['forge-admin', 'forge-ui']]) {
    await assert.rejects(resolveDefaultReleaseServices(async () =>
      reply({ release: { allowedReleaseServices: services } })), /No release was submitted/);
  }
  await assert.rejects(resolveDefaultReleaseServices(async () => ({
    statusCode: 503, responseBody: JSON.stringify({ ok: false }),
  })), /No release was submitted/);
});

test('real CLI resolves omitted services once and preserves explicit service selection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-release-services-'));
  const token = join(directory, 'token');
  await writeFile(token, 'a'.repeat(64));
  let services = pc;
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') {
      response.end(JSON.stringify({ capabilities: {} })); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    response.end(body.action === 'contract'
      ? reply({ runnerContract: { release: { allowedReleaseServices: services } } }).responseBody
      : JSON.stringify({ ok: true, result: { status: 'success' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  for (const scenario of [
    { allowed: pc, args: [], expected: pc },
    { allowed: mobile, args: [], expected: mobile },
    { allowed: pc, args: ['--services', 'forge-ui'], expected: ['forge-ui'] },
    { allowed: ['mysql'], args: [], rejected: true },
  ]) {
    services = scenario.allowed; requests.length = 0;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url)),
      'release', ...scenario.args], {
      env: { ...process.env, FORGE_TASKSPACE_ID: '', FORGE_DEVELOPMENT_MODE: '',
        FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    const releases = requests.filter(item => item.action === 'release');
    if (scenario.rejected) {
      assert.equal(code, 1); assert.equal(releases.length, 0);
      assert.match(stderr, /No release was submitted/);
    } else {
      assert.equal(code, 0, stderr); assert.equal(releases.length, 1);
      assert.deepEqual(releases[0].services, scenario.expected);
    }
    assert.equal(requests.filter(item => item.action === 'contract').length, scenario.args.length ? 0 : 1);
  }
});
