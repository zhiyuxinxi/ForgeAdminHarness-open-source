import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExternalSkillBundle } from '../scripts/forge-skill-bundle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'scripts/taskspacectl.sh'), 'utf8').replaceAll('\r\n', '\n');
const shellFunction = (name) => {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, `Missing actual shell function ${name}`);
  return body;
};
const bash = (input) => spawnSync('bash', ['-s'], { input, encoding: 'utf8', timeout: 15_000 });
const hasJq = bash('command -v jq >/dev/null\n').status === 0;

test('bound runtime survives changed project and process defaults; drift is rejected; legacy Skills stay dynamic', {
  skip: !hasJq && 'The available Bash environment has no jq; run this fixture on the Linux consumer.',
}, () => {
  const result = bash(`set -eu
${['task_env_exact_value', 'taskspace_skill_bundle_root', 'taskspace_runtime_compose_environment', 'task_compose'].map(shellFunction).join('\n')}
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/bound" "$fixture/legacy"
cat >"$fixture/bound/metadata.json" <<'JSON'
{"runtimeVersion":{"channel":"stable","versionId":"${'a'.repeat(64)}","harnessImage":"sha256:${'b'.repeat(64)}","skillBundleRoot":"/srv/fixed-stable","skillBundleSha256":"${'d'.repeat(64)}","brokerUrl":"http://taskspace-broker-stable:3100","environment":{"FORGE_DEVELOPMENT_MODE":"direct","FORGE_SEMANTIC_INTENT_ENABLED":"false"}}}
JSON
printf '{}\\n' >"$fixture/legacy/metadata.json"
cat >"$fixture/bound/task.env" <<'ENV'
HARNESS_IMAGE=sha256:${'b'.repeat(64)}
FORGE_SKILL_BUNDLE_ROOT=/srv/fixed-stable
FORGE_TASKSPACE_BROKER_URL=http://taskspace-broker-stable:3100
FORGE_DEVELOPMENT_MODE=direct
FORGE_SEMANTIC_INTENT_ENABLED=false
FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=false
FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED=false
FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED=false
FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED=false
FORGE_CHANGED_VERIFICATION_SUPPORTED=false
FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED=false
FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED=false
ENV
printf 'FORGE_SKILL_BUNDLE_ROOT=/srv/old-default\\n' >"$fixture/legacy/task.env"
task_root_of() { printf '%s/%s' "$fixture" "$1"; }
task_metadata_of() { printf '%s/%s/metadata.json' "$fixture" "$1"; }
task_env_of() { printf '%s/%s/task.env' "$fixture" "$1"; }
taskspace_compose_of() { printf 'compose.yaml'; }
taskspace_network_compose_args() { :; }
env_value() { printf '/srv/new-project-default'; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
validate_taskspace_skill_bundle_root() { [[ "$1" == bound ]]; }
slug=fixture
export HARNESS_IMAGE=parent-image FORGE_SKILL_BUNDLE_ROOT=/srv/parent-skills
export FORGE_DEVELOPMENT_MODE=controlled FORGE_SEMANTIC_INTENT_ENABLED=true
export FORGE_CHANGED_VERIFICATION_SUPPORTED=true
docker() { printf '%s|%s|%s|%s|%s|%s|%s' "$HARNESS_IMAGE" "$FORGE_SKILL_BUNDLE_ROOT" "$FORGE_TASKSPACE_BROKER_URL" "$FORGE_DEVELOPMENT_MODE" "$FORGE_SEMANTIC_INTENT_ENABLED" "$FORGE_CHANGED_VERIFICATION_SUPPORTED" "$TASKSPACE_RUNTIME_BROKER_HOST"; }
expected='sha256:${'b'.repeat(64)}|/srv/fixed-stable|http://taskspace-broker-stable:3100|direct|false|false|taskspace-broker-stable'
[[ "$(task_compose bound config)" == "$expected" ]]
[[ "$(task_compose bound up --detach)" == "$expected" ]]
[[ "$HARNESS_IMAGE" == parent-image && "$FORGE_SKILL_BUNDLE_ROOT" == /srv/parent-skills ]]
[[ "$(taskspace_skill_bundle_root bound)" == /srv/fixed-stable ]]
[[ "$(taskspace_skill_bundle_root legacy)" == /srv/new-project-default ]]
[[ "$(taskspace_runtime_compose_environment legacy)" == FORGE_SKILL_BUNDLE_ROOT=/srv/new-project-default ]]
printf 'HARNESS_IMAGE=changed\\n' >>"$fixture/bound/task.env"
if (task_compose bound up --detach) >"$fixture/rejected.out" 2>"$fixture/rejected.err"; then exit 21; fi
[[ ! -s "$fixture/rejected.out" ]]
grep -q 'runtime binding is inconsistent' "$fixture/rejected.err"
`);
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error ?? ''));
});

test('bound Skills consumer rejects a replaced current bundle and payload drift using the existing tree validator', async () => {
  const body = shellFunction('validate_external_skill_bundle_root').match(/<<'SKILL_DIGEST_NODE'\n([\s\S]*?)\nSKILL_DIGEST_NODE/u)?.[1];
  assert.ok(body, 'The shell consumer must invoke the existing Skills validator.');
  const temporary = mkdtempSync(path.join(tmpdir(), 'forge-runtime-skills-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    cpSync(path.join(root, 'tests/fixtures/forge-skill-evals/valid'), sourceRoot, { recursive: true });
    const versions = path.join(temporary, 'versions');
    mkdirSync(versions);
    const build = async (version) => {
      const catalogPath = path.join(sourceRoot, 'catalog.json');
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
      catalog.bundleVersion = version;
      writeFileSync(catalogPath, JSON.stringify(catalog));
      return createExternalSkillBundle({ sourceSkillsRoot: path.join(sourceRoot, 'skills'), sourceCatalogPath: catalogPath,
        outputRoot: path.join(versions, version), compatibleDshVersions: ['0.1.1-rc.2'] });
    };
    const original = await build('2099.01.01.1');
    const replacement = await build('2099.01.01.2');
    const current = path.join(temporary, 'current');
    symlinkSync(original.root, current, process.platform === 'win32' ? 'junction' : 'dir');
    const validate = (digest) => spawnSync(process.execPath, ['--input-type=module', '-',
      path.join(root, 'scripts/forge-skill-bundle.mjs'), realpathSync(current), digest], {
      input: body, encoding: 'utf8', timeout: 15_000,
    });
    let result = validate(original.treeSha256);
    assert.equal(result.status, 0, result.stderr);
    unlinkSync(current);
    symlinkSync(replacement.root, current, process.platform === 'win32' ? 'junction' : 'dir');
    result = validate(original.treeSha256);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /digest differs from its binding/u);
    result = validate(replacement.treeSha256);
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(path.join(replacement.root, 'skills/fixture-read/SKILL.md'), 'changed after selection\n');
    result = validate(replacement.treeSha256);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /payload differs from its exact file inventory/u);
  } finally {
    assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Skills digest dispatch is bound-only and propagates validator failure', () => {
  const result = bash(`set -eu
${shellFunction('validate_external_skill_bundle_root')}
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/versions/selected/skills"
printf '{}\\n' >"$fixture/versions/selected/bundle.manifest.json"
ln -s versions/selected "$fixture/current"
REPO_ROOT=/reviewed/platform
die() { printf '%s\\n' "$*" >&2; exit 1; }
require_command() { [[ "$1" == node ]]; }
node() {
  [[ "$1" == --input-type=module && "$2" == - && "$3" == /reviewed/platform/scripts/forge-skill-bundle.mjs ]]
  [[ "$4" == "$fixture/versions/selected" && "$5" == '${'d'.repeat(64)}' ]]
  cat >/dev/null
  printf 'called\\n' >>"$fixture/node.calls"
  [[ "$validator_valid" == true ]]
}
validator_valid=true
validate_external_skill_bundle_root "$fixture"
[[ ! -e "$fixture/node.calls" ]]
validate_external_skill_bundle_root "$fixture" '${'d'.repeat(64)}'
[[ -s "$fixture/node.calls" ]]
if (validate_external_skill_bundle_root "$fixture" '') 2>"$fixture/error"; then exit 25; fi
grep -q 'digest is invalid' "$fixture/error"
validator_valid=false
if (validate_external_skill_bundle_root "$fixture" '${'d'.repeat(64)}') 2>"$fixture/error"; then exit 26; fi
grep -q 'validation failed' "$fixture/error"
`);
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error ?? ''));
});

test('selected Broker lookup is limited to this project and service and rejects ambiguity', () => {
  const result = bash(`set -eu
${shellFunction('assert_taskspace_broker_healthy')}
slug=project-a
project_env=/unused/project.env
project_root=/unused
die() { printf '%s\\n' "$*" >&2; exit 1; }
docker() {
  if [[ "$1" == ps ]]; then
    [[ "$*" == *'label=com.docker.compose.project=forge-project-a'* ]]
    [[ "$*" == *'label=com.docker.compose.service=taskspace-broker-enhanced'* ]]
    printf '%s\\n' "$fixture_containers"
  elif [[ "$1" == inspect ]]; then
    [[ "$4" == broker-one ]]
    printf 'healthy\\n'
  else return 29; fi
}
fixture_containers=broker-one
assert_taskspace_broker_healthy http://taskspace-broker-enhanced:3100
fixture_containers=$'broker-one\\nbroker-two'
if (assert_taskspace_broker_healthy http://taskspace-broker-enhanced:3100) 2>/dev/null; then exit 22; fi
if (assert_taskspace_broker_healthy http://other-project:3100) 2>/dev/null; then exit 23; fi
`);
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error ?? ''));
});

test('Compose renders the selected image and Skills for Harness and worker, with the selected Broker', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'forge-runtime-compose-'));
  try {
    const values = {
      TASKSPACE_COMPOSE_PROJECT_NAME: 'forge-fixture-task-bound', PROJECT_COMPOSE_NAME: 'forge-fixture',
      HARNESS_IMAGE: `sha256:${'c'.repeat(64)}`, TASKSPACE_ROOT: '/srv/fixture/task', PROJECT_ROOT: '/srv/fixture',
      PROJECT_SLUG: 'fixture', FORGE_BIND_ADDRESS: '127.0.0.1', TASKSPACE_HARNESS_PORT: '20001',
      HARNESS_UPLOAD_TOKEN: 'fixture-only', FORGE_SKILL_BUNDLE_ROOT: '/srv/fixed-stable',
      PROJECT_FTP_INPUT_ROOT: '/srv/fixture/input', PROJECT_SHARED_INPUT_ROOT: '/srv/fixture/shared',
      PLATFORM_CONVERSATION_AUTH_ROOT: '/srv/fixture/auth', TASKSPACE_ID: 'bound', TASKSPACE_ACTOR_ID: 'owner',
      TASKSPACE_ACTOR_USER_ID: '11111111-1111-4111-8111-111111111111',
      TASKSPACE_CONVERSATION_ID: '22222222-2222-4222-8222-222222222222',
      DEEPSEEK_KEY_FILE: '/srv/fixture/secrets/deepseek', KIMI_KEY_FILE: '/srv/fixture/secrets/kimi',
      GLM_KEY_FILE: '/srv/fixture/secrets/glm', FORGE_DEVELOPMENT_MODE: 'direct', FORGE_SEMANTIC_INTENT_ENABLED: 'false',
      FORGE_TASKSPACE_BROKER_URL: 'http://taskspace-broker-stable:3100', TASKSPACE_RUNTIME_BROKER_HOST: 'taskspace-broker-stable',
    };
    const file = path.join(temporary, 'task.env');
    writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
    const environment = { ...process.env };
    for (const key of [...Object.keys(values), 'TASKSPACE_HTTPS_PROXY', 'TASKSPACE_NO_PROXY']) delete environment[key];
    const result = spawnSync('docker', ['compose', '--env-file', file,
      '--file', path.join(root, 'templates/taskspace/compose.yaml'),
      '--file', path.join(root, 'templates/taskspace/compose.tool-worker.yaml'),
      'config', '--format', 'json', '--no-path-resolution'], { env: environment, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const rendered = JSON.parse(result.stdout);
    for (const name of ['harness', 'harness-tool-worker']) {
      const service = rendered.services[name];
      assert.equal(service.image, values.HARNESS_IMAGE);
      assert.equal(service.environment.FORGE_DEVELOPMENT_MODE, 'direct');
      assert.equal(service.environment.FORGE_SEMANTIC_INTENT_ENABLED, 'false');
      assert.equal(service.volumes.find((volume) => volume.target === '/opt/forge-skill-bundles').source, values.FORGE_SKILL_BUNDLE_ROOT);
    }
    assert.equal(rendered.services.harness.environment.FORGE_TASKSPACE_BROKER_URL, values.FORGE_TASKSPACE_BROKER_URL);
    assert.ok(rendered.services.harness.environment.NO_PROXY.split(',').includes('taskspace-broker-stable'));
  } finally {
    assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
