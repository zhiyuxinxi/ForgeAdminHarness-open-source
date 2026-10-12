import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyPatch, patchToolWorkerTransport } from '../docker/harness/forge-tool-worker-native-patch.mjs';

const runtime = resolve(process.env.FORGE_NATIVE_TEST_RUNTIME ?? '../ForgeAdminHarness/tmp/runtime-deps-ci');
const require = createRequire(join(runtime, 'package.json'));

test('TODO-047 pinned workflow transport installs on a copy, remains idempotent and rejects drift', async t => {
  const original = require.resolve('@deepseek-ai/dsh-workflow-worker-thread');
  const packageBytes = await readFile(require.resolve('@deepseek-ai/dsh-workflow-worker-thread/package.json'));
  const source = await readFile(original);
  const temporary = await mkdtemp(join(tmpdir(), 'forge-tool-worker-native-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, '@deepseek-ai/dsh-workflow-worker-thread');
  await mkdir(join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'package.json'), packageBytes);
  await writeFile(join(root, 'lib/index.js'), source);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-tool-worker-transport-v1', changed: true });
  const installed = await readFile(join(root, 'lib/index.js'), 'utf8');
  assert.equal(installed, patchToolWorkerTransport(source.toString('utf8')));
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-tool-worker-transport-v1', changed: false });
  assert.throws(() => patchToolWorkerTransport(source.toString('utf8').replace('new Worker(entry, options)', 'new Worker(entry, {})')), /Unsupported/);
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...JSON.parse(packageBytes), version: 'unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported native workflow package/);
  assert.equal(await readFile(join(root, 'lib/index.js'), 'utf8'), installed);
  assert.deepEqual(await readFile(original), source, 'the fixed shared runtime remains unchanged');
});

test('TODO-047 production tool-worker composition exposes public files without credential mounts or native process namespaces', async () => {
  const yaml = require('yaml');
  const compose = yaml.parse(await readFile(new URL('../templates/taskspace/compose.tool-worker.yaml', import.meta.url), 'utf8'));
  const worker = compose.services['harness-tool-worker'];
  assert.equal(worker.image, '${HARNESS_IMAGE:?HARNESS_IMAGE is required}');
  assert.equal(worker.read_only, true);
  assert.deepEqual(worker.cap_drop, ['ALL']);
  assert.deepEqual(worker.security_opt, ['no-new-privileges:true']);
  for (const key of ['privileged', 'pid', 'ipc', 'secrets', 'env_file', 'ports', 'devices', 'cap_add']) assert.equal(worker[key], undefined, key);
  const targets = worker.volumes.map(volume => typeof volume === 'string' ? volume.match(/:(\/[^:]+)(?::(?:ro|rw))?$/)[1] : volume.target);
  assert.deepEqual(targets.sort(), ['/workspace', '/workspace/PROJECT_CONTEXT.md', '/integration', '/opt/forge-skill-bundles',
    '/project-inputs', '/project-ftp-inputs', '/project-shared-inputs', '/workspace/.forge-cache/m2',
    '/workspace/.forge-cache/npm', '/workspace/.forge-cache/pnpm', '/workspace/.forge-cache/general', '/run/forge-tool-worker'].sort());
  assert.deepEqual(Object.keys(worker.environment).sort(), ['HOME', 'DSH_PERMISSION_MODE', 'DSH_BUNDLED_SKILL_DIR', 'MAVEN_CONFIG', 'MAVEN_OPTS',
    'NPM_CONFIG_CACHE', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PNPM_HOME', 'DSH_TELEMETRY_DISABLED', 'TZ'].sort());
  assert.equal(compose.services.harness.volumes[0].read_only, true);
  assert.equal(compose.services.harness.depends_on['harness-tool-worker'].condition, 'service_healthy');
});
