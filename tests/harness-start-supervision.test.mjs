import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const startHarnessPath = path.join(repositoryRoot, 'docker', 'harness', 'start-harness.sh');

function resolvePortableBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (gitExec.status === 0) {
    const candidate = path.resolve(gitExec.stdout.trim(), '../../../bin/bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

function bashPath(value) {
  if (process.platform !== 'win32') return value;
  const matched = /^([A-Za-z]):[\\/](.*)$/u.exec(path.resolve(value));
  if (matched === null) return value.replaceAll('\\', '/');
  return `/${matched[1].toLowerCase()}/${matched[2].replaceAll('\\', '/')}`;
}

function extractSupervisor(source) {
  const start = source.indexOf('supervise_required_processes() {');
  const end = source.indexOf('\n/usr/local/bin/node /usr/local/lib/harness-tcp-proxy.mjs', start);
  assert.ok(start >= 0 && end > start, 'start-harness must expose one bounded supervisor function');
  assert.equal(source.indexOf('supervise_required_processes() {', start + 1), -1);
  return source.slice(start, end);
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-harness-supervisor-'));
  const eventsPath = path.join(root, 'events.log');
  const timingPath = path.join(root, 'timing.log');
  const harnessPath = path.join(root, 'supervisor-harness.sh');
  const source = await readFile(startHarnessPath, 'utf8');
  const supervisor = extractSupervisor(source).replace(
    'sleep 25',
    'sleep "${FORGE_SUPERVISOR_TEST_KILL_DELAY:-25}"',
  );
  const harness = `#!/usr/bin/env bash
set -Eeuo pipefail
${supervisor}

events="$1"
mode="$2"
timing="$3"

term_child() {
  local label="$1"
  trap 'printf "%s:TERM\\n" "$label" >>"$events"; exit 0' TERM
  printf '%s:READY\\n' "$label" >>"$events"
  while true; do sleep 0.05; done
}

ignore_term_child() {
  local label="$1"
  trap '' TERM
  printf '%s:READY\\n' "$label" >>"$events"
  while true; do sleep 0.05; done
}

case "$mode" in
  proxy-exits)
    (sleep 0.15; exit 17) & proxy_pid=$!
    term_child dsh & dsh_pid=$!
    ;;
  dsh-exits)
    term_child proxy & proxy_pid=$!
    (sleep 0.15; exit 23) & dsh_pid=$!
    ;;
  signal)
    term_child proxy & proxy_pid=$!
    term_child dsh & dsh_pid=$!
    (sleep 0.15; kill -TERM "$$") &
    ;;
  kill-stuck-sibling)
    ignore_term_child proxy & proxy_pid=$!
    (sleep 0.15; exit 29) & dsh_pid=$!
    ;;
  *) exit 64 ;;
esac

supervisor_started="$EPOCHREALTIME"
if supervise_required_processes "$proxy_pid" "$dsh_pid"; then
  status=0
else
  status=$?
fi
printf '%s %s\n' "$supervisor_started" "$EPOCHREALTIME" >"$timing"
if kill -0 "$proxy_pid" 2>/dev/null || kill -0 "$dsh_pid" 2>/dev/null; then
  printf 'child-still-alive\\n' >>"$events"
  exit 65
fi
exit "$status"
`;
  await writeFile(eventsPath, '', { encoding: 'utf8' });
  await writeFile(timingPath, '', { encoding: 'utf8' });
  await writeFile(harnessPath, harness, { encoding: 'utf8', mode: 0o700 });
  return { root, eventsPath, timingPath, harnessPath, source };
}

async function runScenario(fixture, mode, expectedStatus) {
  await writeFile(fixture.eventsPath, '', { encoding: 'utf8' });
  await writeFile(fixture.timingPath, '', { encoding: 'utf8' });
  const result = spawnSync(resolvePortableBash(), [
    bashPath(fixture.harnessPath),
    bashPath(fixture.eventsPath),
    mode,
    bashPath(fixture.timingPath),
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: {
      ...process.env,
      FORGE_SUPERVISOR_TEST_KILL_DELAY: '0.2',
    },
  });
  const events = await readFile(fixture.eventsPath, 'utf8');
  const [startedAt, finishedAt] = (await readFile(fixture.timingPath, 'utf8')).trim().split(/\s+/u).map(Number);
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, `${mode}: ${result.stderr}`);
  assert.doesNotMatch(events, /child-still-alive/u);
  assert.ok(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt);
  assert.ok((finishedAt - startedAt) * 1_000 < 3_000, `${mode} did not honor the bounded shutdown`);
  return events;
}

test('Harness startup supervises proxy and DSH as one restartable unit', async () => {
  const fixture = await createFixture();
  try {
    assert.match(fixture.source, /^#!\/bin\/bash/u);
    assert.match(fixture.source, /if \[\[ -z "\$\{HARNESS_PROXY_ADDRESS:-\}" \]\]; then\s+run_dsh/u);
    assert.match(fixture.source, /wait -n "\$\{proxy_pid\}" "\$\{dsh_pid\}"/u);

    assert.match(await runScenario(fixture, 'proxy-exits', 17), /dsh:TERM/u);
    assert.match(await runScenario(fixture, 'dsh-exits', 23), /proxy:TERM/u);

    const signalled = await runScenario(fixture, 'signal', 143);
    assert.match(signalled, /proxy:TERM/u);
    assert.match(signalled, /dsh:TERM/u);

    await runScenario(fixture, 'kill-stuck-sibling', 29);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
