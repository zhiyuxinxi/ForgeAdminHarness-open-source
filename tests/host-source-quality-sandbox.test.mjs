import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOST_BACKEND_SOURCE_QUALITY_PATH, hostSandboxCommand,
  hostVerificationCommand } from '../docker/harness/host-verify-policy.mjs';

const jobRoot = '/srv/forge-delivery/projects/test/verification/host-state/taskspaces/task-one/jobs/job-one';
const paths = { jobRoot, cacheRoot: path.posix.resolve(jobRoot, '../../cache'),
  snapshotRoot: `${jobRoot}/workspace`, outputRoot: `${jobRoot}/output` };
const tools = { node: '/srv/forge-delivery/toolchains/versions/node-v22/bin/node',
  java: '/usr/lib/jvm/java-17/bin/java', git: '/usr/bin/git',
  forgeGovernance: '/srv/forge-delivery/host-runner/versions/prior/bin/forge-governance' };
const scannerInputs = [HOST_BACKEND_SOURCE_QUALITY_PATH,
  fileURLToPath(new URL('../docker/harness/forge-backend-source-quality.mjs', import.meta.url)),
  fileURLToPath(new URL('../docker/harness/backend-source-quality', import.meta.url))];
const mounts = (plan, kind) => plan.argv.flatMap((value, i, argv) => value === kind
  ? [[argv[i + 1], argv[i + 2]]] : []);

test('source quality sandbox exposes the current fixed runner with an older governance toolchain', () => {
  const command = hostVerificationCommand('backend-source-quality',
    { files: ['forge-server/example/src/main/java/Example.java'] }, 'a'.repeat(40), paths, tools);
  const plan = hostSandboxCommand(command.steps[0], paths, tools);
  for (const input of scannerInputs) assert.ok(mounts(plan, '--ro-bind').some(([from, to]) => from === input && to === input));
  assert.deepEqual(mounts(plan, '--bind'), [[jobRoot, jobRoot], [paths.cacheRoot, paths.cacheRoot]]);
  assert.equal(mounts(plan, '--ro-bind').some(([from]) => from === '/srv/forge-delivery'), false);
  assert.deepEqual(plan.argv.slice(-command.steps[0].argv.length), command.steps[0].argv);
});

test('source quality sandbox does not grant scanner mounts to forged script paths or executables', () => {
  for (const step of [
    { executable: tools.node, argv: [`${paths.snapshotRoot}/forge-backend-source-quality-runner.mjs`] },
    { executable: tools.node, argv: [`${HOST_BACKEND_SOURCE_QUALITY_PATH}.other`] },
    { executable: tools.git, argv: [HOST_BACKEND_SOURCE_QUALITY_PATH] },
  ]) {
    const plan = hostSandboxCommand({ ...step, cwd: paths.snapshotRoot }, paths, tools);
    assert.equal(mounts(plan, '--ro-bind').some(([from]) => scannerInputs.includes(from)), false);
    assert.deepEqual(mounts(plan, '--bind'), [[jobRoot, jobRoot], [paths.cacheRoot, paths.cacheRoot]]);
  }
});
