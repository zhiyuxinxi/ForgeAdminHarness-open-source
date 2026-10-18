import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const pcServices = ['forge-admin', 'forge-flow', 'forge-ui'];
const mobileServices = ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'];
const shellOptions = { encoding: 'utf8', windowsHide: true, timeout: 10_000 };

function findBash() {
  const candidates = ['bash'];
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], shellOptions);
    if (git.status === 0) {
      const gitBash = path.resolve(git.stdout.trim(), '../../../bin/bash.exe');
      if (existsSync(gitBash)) candidates.unshift(gitBash);
    }
  }
  for (const executable of candidates) {
    const probe = spawnSync(executable, ['-lc', 'command -v jq >/dev/null'], shellOptions);
    if (probe.status === 0) return { executable, hasJq: true };
  }
  return { executable: candidates[0], hasJq: false };
}

const bash = findBash();

async function releaseFixture(context, needsJq = true) {
  if (needsJq && !bash.hasJq) {
    context.skip('The available Bash runtimes do not provide jq.');
    return null;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-application-runtime-'));
  await mkdir(path.join(root, 'templates', 'project'), { recursive: true });
  await writeFile(path.join(root, 'templates', 'project', 'release-inputs.json'), await readFile(path.resolve('templates/project/release-inputs.json')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const library = (await readFile(path.resolve('scripts/lib/release-contract.sh'), 'utf8')).replaceAll('\r\n', '\n');
  const invoke = (script, ...args) => spawnSync(bash.executable, ['-s', '--', root, ...args], {
    ...shellOptions,
    input: [
      'set -Eeuo pipefail',
      'fixture_root="$1"; shift',
      'if command -v wslpath >/dev/null; then fixture_root="$(wslpath -u "$fixture_root")";',
      'elif command -v cygpath >/dev/null; then fixture_root="$(cygpath -u "$fixture_root")"; fi',
      'cd -- "$fixture_root"',
      'REPO_ROOT="$PWD"',
      library,
      script,
    ].join('\n'),
  });
  return { root, invoke };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

test('mobile runtime upgrade binds one clean TaskSpace candidate without recreating applications', async () => {
  const source = await readFile(path.resolve('scripts/upgrade-mobile-runtime.sh'), 'utf8');
  const helperInstaller = await readFile(path.resolve('scripts/install-mobile-runtime-deploy-helper.sh'), 'utf8');
  const privilegedHelper = await readFile(path.resolve('scripts/forge-delivery-mobile-runtime-root.sh'), 'utf8');
  const projectControl = await readFile(path.resolve('scripts/projectctl.sh'), 'utf8');

  for (const guardedSource of [source, helperInstaller, privilegedHelper]) {
    assert.match(guardedSource, /\^c-\[a-f0-9\]\{24\}\$/);
    assert.doesNotMatch(guardedSource, /\^c-\[a-f0-9\]\{20\}\$/);
  }

  assert.match(source, /--candidate-taskspace/);
  assert.match(source, /--confirm-maintenance-window mobile-runtime/);
  assert.match(source, /status --require-synchronized/);
  assert.match(source, /status --porcelain=v1 --untracked-files=all/);
  assert.match(source, /merge-base --is-ancestor/);
  assert.match(source, /render_release_contract[\s\S]*candidate_workspace/);
  assert.match(source, /application-container-ids\.before/);
  assert.match(source, /application-container-ids\.after/);
  assert.match(source, /force-recreate --no-deps release-runner/);
  assert.match(source, /force-recreate --no-deps taskspace-broker/);
  assert.doesNotMatch(source, /up --detach(?: --force-recreate)? --no-deps forge-(?:admin|app|flow|ui)/);
  assert.match(source, /allowedReleaseServices \| index\("forge-app"\)/);
  assert.match(source, /restoring the prior env, Compose, contract and control plane/);
  assert.match(projectControl, /mobile-runtime[\s\S]*upgrade-mobile-runtime\.sh/);
});

test('mobile release contract protects App and same-origin Nginx deployment inputs', async () => {
  const source = await readFile(path.resolve('scripts/lib/release-contract.sh'), 'utf8');
  const policy = await readFile(path.resolve('docker/harness/release-policy.mjs'), 'utf8');
  const runner = await readFile(path.resolve('docker/harness/release-runner.mjs'), 'utf8');

  assert.match(source, /docker-forge-admin\/Dockerfile\.app/);
  assert.match(source, /docker-forge-admin\/nginx\.conf/);
  assert.match(source, /release_contract_default_allowed_release_services_json[\s\S]*\["forge-admin","forge-app","forge-flow","forge-ui"\]/u);
  assert.match(source, /allowedReleaseServices: \$allowed_release_services/u);
  assert.match(source, /if index\("forge-app"\) == null then \[\] else \["docker-forge-admin\/Dockerfile\.app"\] end/u);
  assert.match(policy, /'forge-admin', 'forge-app', 'forge-flow', 'forge-ui'/);
  assert.match(runner, /mobile-ui[\s\S]*\/forge-h5\//);
  assert.match(runner, /mobile-api[\s\S]*\/forge-h5-api\/auth\/captcha/);
  assert.match(runner, /FORGE_APP_IMAGE/);
});

test('application runtime selection keeps mobile explicit and rejects unknown modes', async (context) => {
  const fixture = await releaseFixture(context, false);
  for (const [mode, services] of [['pc-only', pcServices], ['pc-mobile', mobileServices]]) {
    const result = fixture.invoke('release_contract_application_runtime_services_json "$1"', mode);
    assertSuccess(result);
    assert.deepEqual(JSON.parse(result.stdout), services);
  }
  const defaultResult = fixture.invoke('release_contract_default_allowed_release_services_json');
  assertSuccess(defaultResult);
  assert.deepEqual(JSON.parse(defaultResult.stdout), mobileServices);
  for (const mode of ['', 'pc', 'mobile-only']) {
    const result = fixture.invoke('release_contract_application_runtime_services_json "$1"', mode);
    assert.notEqual(result.status, 0, `unexpected runtime accepted: ${mode}`);
    assert.equal(result.stdout, '', 'invalid modes must not produce a fallback service set');
  }
});

test('PC deployment inputs pass without App while mobile requires its own Dockerfile', async (context) => {
  const fixture = await releaseFixture(context);
  if (!fixture) return;
  const protectedNames = ['Dockerfile.admin', 'Dockerfile.flow', 'Dockerfile.ui', 'application-datasource.yml', 'docker-compose.yml', 'nginx.conf'];
  await mkdir(path.join(fixture.root, 'docker-forge-admin'));
  await Promise.all(protectedNames.map((name) => writeFile(path.join(fixture.root, 'docker-forge-admin', name), `fixture: ${name}\n`)));

  const validate = (services) => fixture.invoke('release_contract_validate_protected_inputs "$PWD" "$1"', JSON.stringify(services));
  assertSuccess(validate(pcServices));
  const missingApp = validate(mobileServices);
  assert.notEqual(missingApp.status, 0);
  assert.match(missingApp.stderr, /docker-forge-admin\/Dockerfile\.app/u);
  const protectedPaths = fixture.invoke('release_contract_protected_input_paths "$1"', JSON.stringify(pcServices));
  assertSuccess(protectedPaths);
  assert.deepEqual(protectedPaths.stdout.trim().split('\n').sort(), protectedNames.map((name) => `docker-forge-admin/${name}`).sort());

  await writeFile(path.join(fixture.root, 'shared.env'), 'MYSQL_HOST=fixture.invalid\nMYSQL_PORT=3306\nREDIS_HOST=fixture.invalid\nREDIS_PORT=6379\n');
  const renderContract = (services, composeServices) => fixture.invoke([
    'die() { printf "%s\\n" "$*" >&2; exit 1; }',
    'require_command() { command -v "$1" >/dev/null; }',
    'validate_slug() { [[ "$1" == fixture ]]; }',
    'DELIVERY_ROOT="$PWD"; DELIVERY_OWNER="$(id -un)"; DELIVERY_GROUP="$(id -gn)"',
    'printf "%s\\n" COMPOSE_PROJECT_NAME=forge-fixture MYSQL_DATABASE=forge_fixture MYSQL_TEST_DATABASE=forge_fixture_test REDIS_DATABASE=1 REDIS_TEST_DATABASE=2 > project.env',
    'printf "SHARED_SERVICES_ENV_FILE=%s/shared.env\\n" "$PWD" >> project.env',
    `printf '%s\\n' 'RELEASE_DB_OPERATOR_IMAGE=example.invalid/mysql:fixture@sha256:${'a'.repeat(64)}' >> project.env`,
    'render_release_contract fixture "$PWD/projects/fixture" "$PWD" "$PWD/project.env" "$PWD/runtime-contract.json" "$PWD" "$1" "${@:2}"',
    'cat runtime-contract.json',
  ].join('\n'), JSON.stringify(services), ...(composeServices ? [JSON.stringify(composeServices)] : []));
  for (const composeServices of [undefined, pcServices, mobileServices]) {
    const result = renderContract(pcServices, composeServices);
    assertSuccess(result);
    const contract = JSON.parse(result.stdout);
    assert.deepEqual(contract.release.allowedReleaseServices, pcServices);
    assert.deepEqual(contract.release.allowedComposeServices.filter((name) => name.startsWith('forge-')).sort(), composeServices ?? mobileServices,
      'omitting argument eight must retain the legacy four-service Compose contract');
    assert.deepEqual(contract.release.protectedFiles.map((file) => file.relativePath).sort(), protectedNames.map((name) => `docker-forge-admin/${name}`).sort());
  }
  const missingMobileContract = renderContract(mobileServices, mobileServices);
  assert.notEqual(missingMobileContract.status, 0);
  assert.match(missingMobileContract.stderr, /docker-forge-admin\/Dockerfile\.app/u);
  await writeFile(path.join(fixture.root, 'docker-forge-admin', 'Dockerfile.app'), 'FROM fixture\n');
  assertSuccess(validate(mobileServices));
  const mobileContract = renderContract(mobileServices, mobileServices);
  assertSuccess(mobileContract);
  assert.equal(JSON.parse(mobileContract.stdout).release.protectedFiles.length, 7);
  const unreviewed = validate(['forge-admin', 'forge-ui']);
  assert.notEqual(unreviewed.status, 0, 'missing required PC services cannot bypass protected-input validation');
});

test('real project template retains every non-App byte for PC and every byte for mobile', async (context) => {
  const fixture = await releaseFixture(context);
  if (!fixture) return;
  const canonical = (await readFile(path.resolve('templates/project/compose.yaml'), 'utf8')).replaceAll('\r\n', '\n');
  for (const eol of ['\n', '\r\n']) {
    const template = canonical.replaceAll('\n', eol);
    await writeFile(path.join(fixture.root, 'compose.yaml'), template);
    const render = (services) => fixture.invoke('release_contract_render_project_compose compose.yaml "$1"', JSON.stringify(services));
    const mobile = render(mobileServices);
    assertSuccess(mobile);
    assert.equal(mobile.stdout, template, 'mobile rendering must preserve canonical bytes including line endings');

    const pc = render(pcServices);
    assertSuccess(pc);
    const appStart = template.indexOf(`  forge-app:${eol}`);
    const uiStart = template.indexOf(`  forge-ui:${eol}`, appStart);
    assert.ok(appStart > 0 && uiStart > appStart, 'the real template must contain the reviewed application blocks');
    const expected = (template.slice(0, appStart) + template.slice(uiStart)).replace(`      - forge-app${eol}`, '');
    assert.equal(pc.stdout, expected, 'only the App service block and UI dependency may change');
    assert.match(pc.stdout, /\$\{HARNESS_UPLOAD_TOKEN:\?HARNESS_UPLOAD_TOKEN is required\}/u, 'rendering must leave environment variables unexpanded');
    const reordered = render([...pcServices].reverse());
    assertSuccess(reordered);
    assert.equal(reordered.stdout, pc.stdout, 'reviewed service sets must not depend on JSON array order');

    for (const invalid of [[], ['forge-admin', 'forge-ui'], [...pcServices, 'forge-ui'], [...pcServices, 'mysql']]) {
      const rejected = render(invalid);
      assert.notEqual(rejected.status, 0, `unreviewed service set accepted: ${JSON.stringify(invalid)}`);
      assert.equal(rejected.stdout, '', 'a rejected service set must not emit a partial Compose file');
    }
  }
});

test('project control derives build and startup services from a matching runtime contract', async (context) => {
  const fixture = await releaseFixture(context);
  if (!fixture) return;
  const source = (await readFile(path.resolve('scripts/projectctl.sh'), 'utf8')).replaceAll('\r\n', '\n');
  const start = source.indexOf('validate_project_application_runtime() {');
  assert.ok(start >= 0, 'project control must validate its selected runtime');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start);
  const runtimeFunction = source.slice(start, end + 2);
  const controls = ['release-runner', 'taskspace-broker', 'conversation-manager', 'protected-acceptance', 'verification-runner'];
  const invoke = (services, configured, allowedApplications = services) => fixture.invoke([
    'die() { printf "%s\\n" "$*" >&2; exit 1; }',
    'require_command() { command -v "$1" >/dev/null; }',
    'slug=fixture; ops_path="$PWD"; compose_file="$PWD/compose.yaml"',
    'jq --arg compose "$compose_file" ".release.fixedComposeFile = \\$compose" <<<"$1" > runtime-contract.json',
    'configured_services_fixture="$2"',
    'compose() { [[ "$*" == "config --services" ]] || exit 2; jq --raw-output ".[]" <<<"$configured_services_fixture"; }',
    runtimeFunction,
    'validate_project_application_runtime',
    'printf "build:%s\\n" "${application_services[*]}"',
    'printf "start:%s\\n" "${startup_services[*]}"',
  ].join('\n'), JSON.stringify({
    projectSlug: 'fixture', composeProjectName: 'forge-fixture',
    release: { allowedReleaseServices: services, allowedComposeServices: [...allowedApplications, ...controls] },
  }), JSON.stringify(configured));

  for (const services of [pcServices, mobileServices]) {
    const result = invoke(services, [...controls, ...services, 'harness', 'harness-upload'].reverse());
    assertSuccess(result);
    const [build, startup] = result.stdout.trim().split('\n').map((line) => line.slice(line.indexOf(':') + 1).split(' ').sort());
    assert.deepEqual(build, [...services].sort());
    assert.deepEqual(startup, [...controls, ...services].sort(), 'legacy shared Harness services must never join normal startup');
  }
  const mismatch = invoke(pcServices, [...controls, ...mobileServices]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Compose application services differ from the release runtime contract/u);
  assert.equal(mismatch.stdout, '', 'a mismatched runtime must fail before emitting build or startup commands');
  const legacy = invoke(pcServices, [...controls, ...mobileServices], mobileServices);
  assertSuccess(legacy);
  const [legacyBuild, legacyStartup] = legacy.stdout.trim().split('\n').map((line) => line.slice(line.indexOf(':') + 1).split(' ').sort());
  assert.deepEqual(legacyBuild, pcServices, 'legacy PC contracts must only build their three release services');
  assert.deepEqual(legacyStartup, [...controls, ...mobileServices].sort(), 'legacy projects must retain their existing Compose topology');
  const missingMobile = invoke(mobileServices, [...controls, ...pcServices], pcServices);
  assert.notEqual(missingMobile.status, 0, 'a mobile release cannot use a PC-only Compose contract');
  assert.match(missingMobile.stderr, /Compose application set omits a required release service/u);
  assert.match(source, /compose build "\$\{application_services\[@\]\}"/u);
  assert.match(source, /compose up --detach --no-build "\$\{startup_services\[@\]\}"/u);
});

test('project creation and toolkit upgrades reuse the selected service set and renderer', async () => {
  const creation = await readFile(path.resolve('scripts/create-project.sh'), 'utf8');
  const upgrade = await readFile(path.resolve('scripts/upgrade-forge-delivery-toolkit.sh'), 'utf8');
  assert.match(creation, /application_runtime='pc-mobile'/u);
  assert.match(creation, /--application-runtime\) application_runtime=/u);
  assert.match(creation, /release_contract_application_runtime_services_json "\$\{application_runtime\}"/u);
  assert.match(creation, /release_contract_render_project_compose[\s\S]*?"\$\{allowed_release_services_json\}"/u);
  const contractCall = creation.match(/render_release_contract[\s\S]*?(?=\r?\n\r?\n)/u)?.[0].replace(/\\\r?\n\s*/gu, '');
  assert.match(contractCall, /render_release_contract [^\r\n]* "\$\{stage_path\}\/workspace" "\$\{allowed_release_services_json\}" "\$\{allowed_release_services_json\}"$/u);
  assert.match(upgrade, /project_target_compose_hash\["\$\{slug\}"\]="\$\(release_contract_render_project_compose/u);
  assert.match(upgrade, /umask 0027; release_contract_render_project_compose/u);
});

test('Docker Compose consumes rendered PC and mobile service sets without touching runtime resources', async (context) => {
  const fixture = await releaseFixture(context);
  if (!fixture) return;
  if (spawnSync('docker', ['compose', 'version'], shellOptions).status !== 0) {
    context.skip('Docker Compose is unavailable; shell rendering is tested separately.');
    return;
  }
  const template = await readFile(path.resolve('templates/project/compose.yaml'), 'utf8');
  await writeFile(path.join(fixture.root, 'template.yaml'), template);
  await writeFile(path.join(fixture.root, 'shared.env'), 'MYSQL_HOST=fixture.invalid\n');
  await writeFile(path.join(fixture.root, 'empty.env'), '');
  const variableNames = new Set([...template.matchAll(/\$\{([A-Z0-9_]+)/gu)].map((match) => match[1]));
  const requiredNames = new Set([...template.matchAll(/\$\{([A-Z0-9_]+):\?/gu)].map((match) => match[1]));
  const fixtureEnv = Object.fromEntries([...requiredNames].map((name) => [name, `/tmp/forge-runtime-fixture/${name.toLowerCase()}`]));
  Object.assign(fixtureEnv, {
    COMPOSE_PROJECT_NAME: 'forge-runtime-fixture',
    FORGE_ADMIN_REF: 'fixture',
    HARNESS_IMAGE: 'example.invalid/forge-harness:fixture',
    FORGE_UI_PORT: '18080',
    HARNESS_PORT: '13080',
    HARNESS_UPLOAD_TOKEN: 'fixture-only-token',
    HOST_UID: '1000', HOST_GID: '1000', DOCKER_GID: '1000',
    DELIVERY_OWNER: 'fixture', DELIVERY_GROUP: 'fixture',
    REDIS_DATABASE: '1', PROJECT_SLUG: 'fixture',
    PROJECT_VERIFICATION_MODE: 'container-toolchain',
    SHARED_SERVICES_ENV_FILE: path.join(fixture.root, 'shared.env').replaceAll('\\', '/'),
  });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !variableNames.has(name))),
    ...fixtureEnv,
  };
  const models = [];
  for (const services of [pcServices, mobileServices]) {
    const rendered = fixture.invoke('release_contract_render_project_compose template.yaml "$1"', JSON.stringify(services));
    assertSuccess(rendered);
    const composeFile = path.join(fixture.root, 'compose.yaml');
    await writeFile(composeFile, rendered.stdout);
    const result = spawnSync('docker', ['compose', '--env-file', path.join(fixture.root, 'empty.env'), '--file', composeFile, 'config', '--format', 'json'], {
      ...shellOptions, env,
    });
    assertSuccess(result);
    const model = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(model.services).filter((name) => name.startsWith('forge-')).sort(), [...services].sort());
    assert.deepEqual(Object.keys(model.services['forge-ui'].depends_on).sort(), services.filter((name) => name !== 'forge-ui').sort());
    models.push(model);
  }
  const [pc, mobile] = models;
  for (const [name, service] of Object.entries(pc.services)) {
    if (name === 'forge-ui') {
      const withoutApp = structuredClone(mobile.services[name]);
      delete withoutApp.depends_on['forge-app'];
      assert.deepEqual(service, withoutApp);
    } else {
      assert.deepEqual(service, mobile.services[name], `Compose changed the retained ${name} service`);
    }
  }
  for (const section of ['networks', 'volumes', 'secrets']) assert.deepEqual(pc[section], mobile[section]);
});
