import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-local-forge-harness-evals.sh');
const sensitiveDiagnostic = 'DO_NOT_ECHO_SYNTHETIC_DIAGNOSTIC_7f89d3';

function resolvePortableBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (gitExec.status === 0) {
    const candidate = path.resolve(gitExec.stdout.trim(), '../../../bin/bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

async function extractResourceProbe() {
  const runner = await readFile(runnerPath, 'utf8');
  const startMarker = 'RESOURCE_STATE="unknown"\nprobe_resource_state() {';
  const endMarker = '\nremove_owned_container() {';
  const start = runner.indexOf(startMarker);
  const end = runner.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'runner must declare RESOURCE_STATE immediately before probe_resource_state');
  assert.notEqual(end, -1, 'runner must delimit probe_resource_state before remove_owned_container');
  assert.equal(runner.indexOf(startMarker, start + startMarker.length), -1, 'resource probe declaration must be unique');
  return runner.slice(start, end).trimEnd();
}

async function createHarness(root) {
  const extractedProbe = await extractResourceProbe();
  const harnessPath = path.join(root, 'resource-probe-harness.sh');
  const harness = `#!/usr/bin/env bash
set -u

docker() {
  local kind="\${1-}" action="\${2-}" name="\${3-}"
  if [[ "\${action}" != "inspect" ]]; then
    printf 'unexpected fake Docker action\n' >&2
    return 91
  fi
  case "\${FAKE_DOCKER_MODE-}" in
    present)
      printf '{"synthetic":"present"}\n'
      return 0
      ;;
    exact-not-found)
      case "\${kind}" in
        container) printf 'Error response from daemon: No such container: %s\n' "\${name}" >&2 ;;
        volume) printf 'Error response from daemon: get %s: no such volume\n' "\${name}" >&2 ;;
        network) printf 'Error response from daemon: network %s not found\n' "\${name}" >&2 ;;
        *) printf 'unknown resource kind\n' >&2 ;;
      esac
      return 1
      ;;
    wrong-resource-name)
      case "\${kind}" in
        container) printf 'Error response from daemon: No such container: another-resource\n' >&2 ;;
        volume) printf 'Error response from daemon: get another-resource: no such volume\n' >&2 ;;
        network) printf 'Error response from daemon: network another-resource not found\n' >&2 ;;
        *) printf 'unknown resource kind\n' >&2 ;;
      esac
      return 1
      ;;
    daemon-error)
      printf 'Cannot connect to daemon: %s\n' "\${FAKE_PRIVATE_DIAGNOSTIC-}" >&2
      return 1
      ;;
    permission-error)
      printf 'permission denied while inspecting resource: %s\n' "\${FAKE_PRIVATE_DIAGNOSTIC-}" >&2
      return 1
      ;;
    *)
      printf 'unsupported fake Docker mode\n' >&2
      return 92
      ;;
  esac
}

${extractedProbe}

set +e
probe_resource_state "\${PROBE_KIND-}" "\${PROBE_NAME-}"
probe_status=$?
set -e
printf 'status=%s\nstate=%s\n' "\${probe_status}" "\${RESOURCE_STATE}"
exit 0
`;
  await writeFile(harnessPath, harness, { encoding: 'utf8', mode: 0o700 });
  return { extractedProbe, harnessPath };
}

function runProbe(bash, harnessPath, mode, kind, name = 'forge-test-resource') {
  const result = spawnSync(bash, [harnessPath], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      FAKE_DOCKER_MODE: mode,
      FAKE_PRIVATE_DIAGNOSTIC: sensitiveDiagnostic,
      PROBE_KIND: kind,
      PROBE_NAME: name,
    },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout.includes(sensitiveDiagnostic) || stderr.includes(sensitiveDiagnostic)) {
    assert.fail('resource probe exposed a private fake Docker diagnostic');
  }
  assert.equal(result.status, 0, 'temporary Bash harness must execute successfully');
  const statusMatch = /^status=(\d+)$/mu.exec(stdout);
  const stateMatch = /^state=([^\r\n]+)$/mu.exec(stdout);
  assert.ok(statusMatch, 'temporary Bash harness must report probe status');
  assert.ok(stateMatch, 'temporary Bash harness must report resource state');
  return {
    probeStatus: Number.parseInt(statusMatch[1], 10),
    resourceState: stateMatch[1],
    stderr,
  };
}

test('the test harness extracts the production resource probe instead of copying its implementation', async () => {
  const extracted = await extractResourceProbe();
  assert.match(extracted, /^RESOURCE_STATE="unknown"\nprobe_resource_state\(\) \{/u);
  assert.doesNotMatch(extracted, /remove_owned_container/u);
  assert.equal((extracted.match(/probe_resource_state\(\)/gu) ?? []).length, 1);
});

test('a successful Docker inspect proves present for every supported resource kind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-resource-probe-'));
  try {
    const bash = resolvePortableBash();
    const { harnessPath } = await createHarness(root);
    for (const kind of ['container', 'volume', 'network']) {
      const result = runProbe(bash, harnessPath, 'present', kind);
      assert.deepEqual(
        { probeStatus: result.probeStatus, resourceState: result.resourceState },
        { probeStatus: 0, resourceState: 'present' },
        kind,
      );
      assert.equal(result.stderr, '', kind);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only the exact resource-specific Docker not-found diagnostic proves absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-resource-probe-'));
  try {
    const bash = resolvePortableBash();
    const { harnessPath } = await createHarness(root);
    for (const kind of ['container', 'volume', 'network']) {
      const result = runProbe(bash, harnessPath, 'exact-not-found', kind);
      assert.deepEqual(
        { probeStatus: result.probeStatus, resourceState: result.resourceState },
        { probeStatus: 0, resourceState: 'absent' },
        kind,
      );
      assert.equal(result.stderr, '', kind);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon and permission failures remain unknown and do not echo captured diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-resource-probe-'));
  try {
    const bash = resolvePortableBash();
    const { harnessPath } = await createHarness(root);
    for (const mode of ['daemon-error', 'permission-error']) {
      for (const kind of ['container', 'volume', 'network']) {
        const result = runProbe(bash, harnessPath, mode, kind);
        assert.notEqual(result.probeStatus, 0, `${mode}/${kind}`);
        assert.equal(result.resourceState, 'unknown', `${mode}/${kind}`);
        assert.match(result.stderr, new RegExp(`Docker ${kind} state inspection failed closed`), `${mode}/${kind}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a not-found diagnostic naming a different resource fails closed as unknown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-resource-probe-'));
  try {
    const bash = resolvePortableBash();
    const { harnessPath } = await createHarness(root);
    for (const kind of ['container', 'volume', 'network']) {
      const result = runProbe(bash, harnessPath, 'wrong-resource-name', kind, 'expected-resource');
      assert.notEqual(result.probeStatus, 0, kind);
      assert.equal(result.resourceState, 'unknown', kind);
      assert.match(result.stderr, new RegExp(`Docker ${kind} state inspection failed closed`), kind);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown resource kind fails closed without changing the initial unknown state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-resource-probe-'));
  try {
    const bash = resolvePortableBash();
    const { harnessPath } = await createHarness(root);
    const result = runProbe(bash, harnessPath, 'daemon-error', 'image');
    assert.notEqual(result.probeStatus, 0);
    assert.equal(result.resourceState, 'unknown');
    assert.match(result.stderr, /unsupported Docker resource kind: image/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
