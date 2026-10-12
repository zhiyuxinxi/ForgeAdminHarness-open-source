import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('TaskSpace CLI stop preserves contracted containers and closed state, retaining legacy teardown', async () => {
  const source = (await readFile(new URL('../scripts/taskspacectl.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const body = source.match(/^      stop\)\n([\s\S]*?)^        ;;$/m)?.[1];
  assert.ok(body, 'actual stop branch must be found');
  const script = `set -eu
task_id=closed-task
fixture_root="$(mktemp -d)"
trap 'rm -rf -- "$fixture_root"' EXIT
TASKSPACE_NETWORK_OVERRIDE_NAME=compose.network.override.yaml
TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME=compose.network.recovery.yaml
task_root_of() { printf '%s' "$fixture_root"; }
task_metadata_of() { printf '%s' metadata.json; }
jq() { printf '%s\\n' "$fixture_status"; }
task_compose() { printf 'compose:%s\\n' "$*"; }
atomic_metadata_status() { printf 'metadata:%s\\n' "$*"; }
log() { :; }
run_stop() {
case stop in
stop)
${body}
;;
esac
}
fixture_status=closed
closed_result="$(run_stop)"
[[ -z "$closed_result" ]]
for contract in absent "$TASKSPACE_NETWORK_OVERRIDE_NAME" "$TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME"; do
  rm -f -- "$fixture_root/$TASKSPACE_NETWORK_OVERRIDE_NAME" "$fixture_root/$TASKSPACE_LEGACY_NETWORK_OVERRIDE_NAME"
  expected='down --remove-orphans'
  if [[ "$contract" != absent ]]; then
    : >"$fixture_root/$contract"
    expected='stop --timeout 30'
  fi
  for fixture_status in active stopped; do
    result="$(run_stop)"
    [[ "$result" == "compose:closed-task $expected"$'\\nmetadata:closed-task stopped' ]]
  done
done
`;
  const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error ?? ''));
});

test('root-created TaskSpace is readable as its delivery owner before governance admission', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0,
}, async () => {
  const repo = process.env.FORGE_TEST_REPO_ROOT || path.resolve('.');
  const owner = process.env.FORGE_TEST_DELIVERY_OWNER || 'nobody';
  const command = (program, args, options = {}) => spawnSync(program, args, {
    encoding: 'utf8', ...options,
  });
  const group = command('id', ['-gn', owner]);
  assert.equal(group.status, 0, group.stderr);
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-root-staging-'));
  const stage = path.join(root, '.task.creating');
  const workspace = path.join(stage, 'workspace');
  try {
    await chmod(root, 0o755);
    await mkdir(stage, { mode: 0o700 });
    await mkdir(workspace);
    assert.equal(command('git', ['init', '--quiet', workspace]).status, 0);
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Tracked project instructions\n');
    assert.equal(command('git', ['-C', workspace, 'add', 'AGENTS.md']).status, 0);
    const digest = async (name) => createHash('sha256').update(await readFile(path.join(workspace, name))).digest('hex');
    const before = [await digest('AGENTS.md'), await digest('.git/index')];
    const env = { ...process.env, STAGING_REPO: repo, STAGING_PATH: stage,
      STAGING_OWNER: owner, STAGING_GROUP: group.stdout.trim() };
    const setup = 'set -eu\nsource "$STAGING_REPO/scripts/lib/common.sh"\n'
      + 'DELIVERY_OWNER="$STAGING_OWNER"\nDELIVERY_GROUP="$STAGING_GROUP"\nstage_root="$STAGING_PATH"\n';
    const readTracked = 'project_git_readonly "$stage_root/workspace" ls-files --error-unmatch -- AGENTS.md\n';
    const denied = command('bash', ['-s'], { env, input: setup + readTracked });
    assert.notEqual(denied.status, 0, 'root-owned private staging must not be readable by another identity');
    const script = await readFile(path.join(repo, 'scripts/taskspacectl.sh'), 'utf8');
    const anchor = 'git -C "${stage_root}/workspace" config --local forge-delivery.conversation-id "${conversation_id}"';
    const begin = script.indexOf(anchor) + anchor.length;
    const end = script.indexOf('    ensure_taskspace_cache_contract "${stage_root}"', begin);
    assert.ok(begin >= anchor.length && end > begin);
    const transfer = script.slice(begin, end);
    const accepted = command('bash', ['-s'], { env, input: setup + transfer + readTracked });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout.trim(), 'AGENTS.md');
    assert.deepEqual([await digest('AGENTS.md'), await digest('.git/index')], before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
