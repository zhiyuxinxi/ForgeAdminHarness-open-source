import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { compileConversationTaskProposal, isCurrentProjectWriterScope } from '../docker/harness/forge-conversation-task-proposal.mjs';

const read = (relativePath) => readFile(path.resolve(relativePath), 'utf8');

test('new TaskSpace capabilities stay off for legacy project configuration', async () => {
  const source = await read('scripts/taskspacectl.sh');
  for (const capability of ['FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED',
    'FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED', 'FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED', 'FORGE_CHANGED_VERIFICATION_SUPPORTED',
    'FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED', 'FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED']) {
    const assignment = source.split(/\r?\n/u).find((line) => line.startsWith(`${capability}=`));
    assert.ok(assignment);
    for (const [configured, expected] of [['', 'false'], ['false', 'false'], ['true', 'true'], ['invalid', 'false']]) {
      const result = spawnSync('bash', ['-s'], {
        input: [
          'set -eu',
          `FIXTURE_RUNTIME_CAPABILITY='${configured}'`,
          `env_value() { test "$1" = ${capability}; printf "%s" "$FIXTURE_RUNTIME_CAPABILITY"; }`,
          assignment,
          `printf "%s" "$${capability}"`,
        ].join('\n'),
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected, `${capability}: ${configured}`);
    }
  }
});

function extractShellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `missing shell function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `unterminated shell function ${name}`);
  return source.slice(start, end + 2);
}

test('ordinary final verification capability probes the exact image and defaults off without its export', async () => {
  const source = await read('scripts/lib/harness-image-verifier.sh');
  const probe = extractShellFunction(source, 'harness_image_supports_ordinary_final_verification');
  for (const [exportValue, expected] of [['true', 'true'], ['false', 'false'], ['missing', 'false']]) {
    const fixtureModule = exportValue === 'missing' ? 'export const legacy = true;'
      : `export const FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED = ${exportValue};`;
    const fixtureUrl = `data:text/javascript,${encodeURIComponent(fixtureModule)}`;
    const script = [
      'set -eu',
      `fixture_url='${fixtureUrl.replaceAll("'", "'\\''")}'`,
      `fixture_image='sha256:${'a'.repeat(64)}'`,
      'calls=0',
      'timeout() { test "$1" = 20; shift; "$@"; }',
      'docker() {',
      '  calls=$((calls+1))',
      '  local expected=(run --rm --pull never --network none --read-only --entrypoint node "$fixture_image" --input-type=module -e)',
      '  local arg',
      '  for arg in "${expected[@]}"; do test "$1" = "$arg" || return 20; shift; done',
      '  test "$#" = 1 || return 21',
      '  local fixture_js="${1//\\/usr\\/local\\/lib\\/forge-execution-context.mjs/$fixture_url}"',
      `  ${process.platform === 'win32' ? 'node.exe' : 'node'} --input-type=module -e "$fixture_js" </dev/null`,
      '}',
      probe,
      'observed=false',
      'if harness_image_supports_ordinary_final_verification "$fixture_image"; then observed=true; fi',
      'test "$calls" = 1',
      `test "$observed" = '${expected}'`,
      'if harness_image_supports_ordinary_final_verification forge/example:latest; then exit 22; fi',
      'test "$calls" = 1',
      'printf "%s" "$observed"',
    ].join('\n');
    const result = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || `image probe rejected ${exportValue} fixture`);
    assert.equal(result.stdout, expected);
  }
});

test('Harness identity receipt roots preserve the shared baseline and versioned platform path', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('Linux Bash, /proc descriptor identity, and GNU file metadata are required; run this case in the cached Linux image.');
    return;
  }
  const options = { cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true };
  const probe = spawnSync('bash', ['-c', 'for tool in awk cat getent id readlink sha256sum stat chmod ln mkdir cmp cp sed rm; do command -v "$tool" >/dev/null || exit 1; done; test -d /proc/self/fd'], options);
  assert.equal(probe.status, 0, probe.stderr || 'Required Linux receipt-verification tools are missing.');

  const createSource = await read('scripts/create-project.sh');
  const renderLines = createSource.split('\n').filter((line) => line.startsWith('rendered_env=') && line.includes('__PLATFORM_ROOT__'));
  assert.equal(renderLines.length, 1, 'creation must render the versioned platform root exactly once');
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-identity-receipts-'));
  const script = String.raw`set -Eeuo pipefail
fixture="$1"
source scripts/lib/harness-image-verifier.sh
die() { printf '%s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null || die "Missing command: $1"; }
docker() { die 'Image verification must use the separately verified cached image, not call Docker in this receipt test.'; }
DELIVERY_ROOT="$fixture/delivery"
DELIVERY_OWNER="$(id -un)"
DELIVERY_GROUP="$(id -gn)"
HARNESS_FOUNDATION_IMAGE=fixture/foundation:reviewed
HARNESS_IMAGE=fixture/target:old
TAMPER_RECEIPT=''
old_id="sha256:$(printf '%064d' 1)"
new_id="sha256:$(printf '%064d' 2)"
foundation_id="sha256:$(printf '%064d' 3)"
mkdir -p "$DELIVERY_ROOT/baselines" "$fixture/private" "$fixture/unsafe"
write_receipt() {
  printf 'HARNESS_FOUNDATION_IMAGE=%s\nHARNESS_FOUNDATION_IMAGE_ID=%s\nHARNESS_IMAGE=%s\nHARNESS_IMAGE_ID=%s\n' \
    "$HARNESS_FOUNDATION_IMAGE" "$foundation_id" "$1" "$2" > "$3"
  chmod 640 "$3"
}
write_receipt fixture/target:old "$old_id" "$DELIVERY_ROOT/baselines/baseline.lock"
write_receipt fixture/target:new "$new_id" "$fixture/private/baseline.lock"
cp "$DELIVERY_ROOT/baselines/baseline.lock" "$fixture/shared-before"
cp "$fixture/private/baseline.lock" "$fixture/private-before"
shared_digest="$(sha256sum "$DELIVERY_ROOT/baselines/baseline.lock")"
verify_harness_foundation_image() {
  FORGE_VERIFIED_HARNESS_FOUNDATION_IMAGE_ID="$2"
  if [[ -n "$TAMPER_RECEIPT" ]]; then printf '# changed during verification\n' >> "$TAMPER_RECEIPT"; fi
}
verify_target_harness_image() {
  case "$1" in
    fixture/target:old) FORGE_VERIFIED_HARNESS_IMAGE_ID="$old_id" ;;
    fixture/target:new) FORGE_VERIFIED_HARNESS_IMAGE_ID="$new_id" ;;
    *) die 'Unexpected fixture target' ;;
  esac
}
expect_rejected() {
  local resolver="$1" expected="$2" observed
  if observed="$($resolver 2>&1)"; then die "$resolver unexpectedly accepted an unsafe receipt"; fi
  [[ "$observed" == *"$expected"* ]] || die "Unexpected rejection: $observed"
}
unset HARNESS_IDENTITY_RECEIPT_ROOT
[[ "$(resolve_configured_harness_foundation_image_id)" == "$foundation_id" ]]
[[ "$(resolve_configured_harness_image_id)" == "$old_id" ]]
HARNESS_IDENTITY_RECEIPT_ROOT="$fixture/private"
HARNESS_IMAGE=fixture/target:new
[[ "$(resolve_configured_harness_foundation_image_id)" == "$foundation_id" ]]
[[ "$(resolve_configured_harness_image_id)" == "$new_id" ]]
ln -s "$fixture/private" "$fixture/linked-root"
for resolver in resolve_configured_harness_foundation_image_id resolve_configured_harness_image_id; do
  HARNESS_IDENTITY_RECEIPT_ROOT="$fixture/linked-root"
  expect_rejected "$resolver" 'missing or unsafe'
  HARNESS_IDENTITY_RECEIPT_ROOT="$fixture/unsafe"
  ln -s "$fixture/private/baseline.lock" "$fixture/unsafe/baseline.lock"
  expect_rejected "$resolver" 'missing or unsafe'
  rm "$fixture/unsafe/baseline.lock"
  cp "$fixture/private-before" "$fixture/unsafe/baseline.lock"
  chmod 644 "$fixture/unsafe/baseline.lock"
  expect_rejected "$resolver" 'ownership, mode, link count, or type is invalid'
  write_receipt fixture/target:new "$new_id" "$fixture/unsafe/baseline.lock"
  sed -i 's#fixture/foundation:reviewed#fixture/foundation:unreviewed#' "$fixture/unsafe/baseline.lock"
  expect_rejected "$resolver" 'persisted'
  write_receipt fixture/target:new "$new_id" "$fixture/unsafe/baseline.lock"
  TAMPER_RECEIPT="$fixture/unsafe/baseline.lock"
  expect_rejected "$resolver" 'changed during image verification'
  TAMPER_RECEIPT=''
  rm "$fixture/unsafe/baseline.lock"
done
HARNESS_IDENTITY_RECEIPT_ROOT="$fixture/private"
HARNESS_IMAGE=fixture/target:unreviewed
expect_rejected resolve_configured_harness_image_id 'persisted target identity receipt'
cmp "$DELIVERY_ROOT/baselines/baseline.lock" "$fixture/shared-before"
[[ "$(sha256sum "$DELIVERY_ROOT/baselines/baseline.lock")" == "$shared_digest" ]]
cmp "$fixture/private/baseline.lock" "$fixture/private-before"
REPO_ROOT=/srv/forge-delivery/platform-releases/reviewed-release
rendered_env="$(cat "$2")"
eval "$3"
[[ "$rendered_env" == *"PLATFORM_ROOT=$REPO_ROOT"* ]]
[[ "$rendered_env" != *'__PLATFORM_ROOT__'* ]]
printf '%s\n' 'PASS default/private identity roots, receipt integrity, unchanged baseline, and versioned platform rendering'
`;
  try {
    const result = spawnSync('bash', ['-s', '--', fixtureRoot, path.resolve('templates/project/project.env.tpl'), renderLines[0]], { ...options, input: script });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /PASS default\/private identity roots/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('acceptance writer-scope migration executes atomically and preserves explicit configuration', async (context) => {
  const options = {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  };
  const jqProbe = spawnSync('bash', ['-lc', 'command -v jq >/dev/null 2>&1'], options);
  if (jqProbe.status !== 0) {
    context.skip('The host Bash environment does not provide jq; the deployment preflight exercises this migration on Linux.');
    return;
  }

  const source = await read('scripts/upgrade-forge-delivery-toolkit.sh');
  const migrate = extractShellFunction(source, 'migrate_acceptance_writer_scopes');
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-acceptance-scopes-'));
  const paths = {
    missing: path.join(fixtureRoot, 'missing.json'),
    legacy: path.join(fixtureRoot, 'legacy.json'),
    brokenDefault: path.join(fixtureRoot, 'broken-default.json'),
    canonicalDefault: path.join(fixtureRoot, 'canonical-default.json'),
    backendDefault: path.join(fixtureRoot, 'backend-default.json'),
    projectDefault: path.join(fixtureRoot, 'project-default.json'),
    disabled: path.join(fixtureRoot, 'disabled.json'),
    empty: path.join(fixtureRoot, 'empty.json'),
    custom: path.join(fixtureRoot, 'custom.json'),
    state: path.join(fixtureRoot, 'state.json'),
  };
  const base = {
    schemaVersion: 1,
    serviceType: 'forge-protected-acceptance-service/v1',
    projectSlug: 'fixture',
    policyId: 'keep-policy',
    stateRoot: '/var/lib/forge-acceptance',
    trustWindow: { issuedAt: '2026-09-11T00:00:00.000Z', expiresAt: '2027-09-11T00:00:00.000Z' },
    keys: { platform: { keyId: 'keep-platform-key' } },
  };
  const empty = { ...base, conversationWriterScopes: [] };
  const canonicalScope = { taskProfile: 'frontend-admin', ownedPaths: [
    'forge-admin-ui/jsconfig.json', 'forge-admin-ui/package.json', 'forge-admin-ui/pnpm-lock.yaml', 'forge-admin-ui/src',
  ] };
  const disabled = { ...base, conversationTaskPreparation: false, conversationWriterScopes: [canonicalScope] };
  const backendDefault = { ...base, conversationTaskPreparation: true, conversationWriterScopes: [canonicalScope,
    { taskProfile: 'backend', ownedPaths: ['forge-server/forge-business/forge-business-core/src'] },
    { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
  ] };
  const projectDefault = { ...base, conversationTaskPreparation: true, conversationWriterScopes: [canonicalScope,
    { taskProfile: 'backend', ownedPaths: ['docker-forge-admin/Dockerfile.admin', 'forge-server/forge-business/forge-business-core/src'] },
    { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
    { taskProfile: 'shared-owner', ownedPaths: ['forge-h5-ui/src'] },
  ] };
  const custom = {
    ...base,
    conversationWriterScopes: [{ taskProfile: 'frontend-admin', ownedPaths: [
      'code-copilot/changes/customer-qualification-archive/spec.md',
      'forge-admin-ui/src/views/accident',
    ] }],
  };
  const state = '{"keep":"state-bytes"}\n';

  const invoke = (file) => spawnSync('bash', ['-s', '--', file], {
    ...options,
    input: `set -Eeuo pipefail\ndie() { printf '%s\\n' "$*" >&2; return 1; }\nREPO_ROOT="$PWD"\nDELIVERY_OWNER="$(id -u)"\nDELIVERY_GROUP="$(id -g)"\n${migrate}\nmigrate_acceptance_writer_scopes "$1"\n[[ "$(stat -c '%a' -- "$1")" == 600 ]]\n`,
  });

  try {
    await Promise.all([
      writeFile(paths.missing, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.legacy, `${JSON.stringify({ ...base, conversationWriterScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }] }, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.brokenDefault, `${JSON.stringify({ ...base, conversationWriterScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src', 'forge-admin-ui/package.json', 'forge-admin-ui/pnpm-lock.yaml', 'forge-admin-ui/jsconfig.json'] }] }, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.canonicalDefault, `${JSON.stringify({ ...base, conversationWriterScopes: [canonicalScope] }, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.backendDefault, `${JSON.stringify(backendDefault, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.projectDefault, `${JSON.stringify(projectDefault, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.disabled, `${JSON.stringify(disabled, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.empty, `${JSON.stringify(empty, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.custom, `${JSON.stringify(custom, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.state, state, { mode: 0o600 }),
    ]);
    const emptyBefore = await readFile(paths.empty, 'utf8');
    const customBefore = await readFile(paths.custom, 'utf8');
    const disabledBefore = await readFile(paths.disabled, 'utf8');

    for (const file of [paths.missing, paths.legacy, paths.brokenDefault, paths.canonicalDefault, paths.backendDefault, paths.projectDefault, paths.disabled, paths.empty, paths.custom]) {
      const result = invoke(file);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const migratedOnce = await readFile(paths.missing, 'utf8');
    const second = invoke(paths.missing);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(await readFile(paths.missing, 'utf8'), migratedOnce, 'second migration must be byte-idempotent');

    const migrated = JSON.parse(migratedOnce);
    assert.deepEqual(migrated.conversationWriterScopes, [
      { taskProfile: 'project-files', scopeRoot: 'current-project', ownedPaths: [] },
      { taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/jsconfig.json', 'forge-admin-ui/package.json', 'forge-admin-ui/pnpm-lock.yaml', 'forge-admin-ui/src'] },
      { taskProfile: 'backend', ownedPaths: ['docker-forge-admin/Dockerfile.admin', 'forge-server/forge-business/forge-business-core/src'] },
      { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
      { taskProfile: 'shared-owner', ownedPaths: ['forge-h5-ui/src'] },
    ]);
    const { conversationWriterScopes, conversationTaskPreparation, ...unchanged } = migrated;
    assert.equal(conversationTaskPreparation, true);
    assert.deepEqual(JSON.parse(await readFile(paths.legacy, 'utf8')), migrated, 'the former exact default must include the reviewed typecheck configuration in checkpoint ownership');
    assert.deepEqual(JSON.parse(await readFile(paths.brokenDefault, 'utf8')), migrated, 'the non-canonical four-path default must migrate to canonical order');
    assert.deepEqual(JSON.parse(await readFile(paths.canonicalDefault, 'utf8')), migrated, 'the old canonical default must enable bounded ordinary-task preparation');
    assert.deepEqual(JSON.parse(await readFile(paths.backendDefault, 'utf8')), migrated, 'the exact old three-scope default must gain only the supported Admin packaging path');
    assert.deepEqual(JSON.parse(await readFile(paths.projectDefault, 'utf8')), migrated, 'the exact four-scope default must gain the current-project ordinary-file scope');
    assert.deepEqual(unchanged, base, 'migration must preserve every existing config field');
    assert.equal(await readFile(paths.empty, 'utf8'), emptyBefore, 'explicit [] must remain byte-identical');
    assert.equal(await readFile(paths.custom, 'utf8'), customBefore, 'custom scopes must remain byte-identical');
    assert.equal(await readFile(paths.disabled, 'utf8'), disabledBefore, 'explicitly disabled preparation must remain byte-identical');
    assert.equal(await readFile(paths.state, 'utf8'), state, 'acceptance state must remain unchanged');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('the acceptance template default writer scope is accepted by task-contract canonicalization', async () => {
  const template = JSON.parse(await read('templates/project/acceptance-service.json.tpl'));
  assert.equal(template.conversationTaskPreparation, true);
  for (const scope of template.conversationWriterScopes) {
    if (isCurrentProjectWriterScope(scope)) {
      const result = compileConversationTaskProposal({ writerScopes: [scope], proposal: {
        goal: '创建当前项目的 HTML 文件。', taskProfiles: ['project-files'], ownedPaths: ['examples/index.html'],
        references: [{ path: 'README.md', sha256: '1'.repeat(64) }],
      } });
      assert.deepEqual(result.contract.ownedPaths, ['examples/index.html']);
      continue;
    }
    const contract = compileForgeTaskExecutionContract({
      prompt: 'Configured workspace source scope',
      actionCeiling: 'workspace-write',
      ownedPaths: scope.ownedPaths,
      taskProfiles: [scope.taskProfile],
    });
    assert.deepEqual(contract.ownedPaths, scope.ownedPaths);
  }
  assert.deepEqual(template.conversationWriterScopes.find(scope => scope.taskProfile === 'frontend-admin').ownedPaths, [
    'forge-admin-ui/jsconfig.json',
    'forge-admin-ui/package.json',
    'forge-admin-ui/pnpm-lock.yaml',
    'forge-admin-ui/src',
  ]);
});

test('runtime template Compose filtering preserves service configuration without allocating networks', async (context) => {
  const jqProbe = spawnSync('jq', ['--version'], { encoding: 'utf8', windowsHide: true });
  const composeProbe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true });
  if (jqProbe.status !== 0 || composeProbe.status !== 0) {
    context.skip('jq and Docker Compose are required for the runtime-template filter integration check.');
    return;
  }

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-template-'));
  const filteredPath = path.join(fixtureRoot, 'filtered.json');
  const input = {
    name: 'forge-runtime-template-fixture',
    services: {
      selected: {
        image: 'fixture/runtime:1',
        command: ['sh', '-c', 'printf %s "$HOME"'],
        environment: { LITERAL: 'cost=$VALUE' },
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        ports: [{ mode: 'ingress', target: 3080, published: '13080', protocol: 'tcp' }],
        volumes: [{ type: 'bind', source: '/tmp/source', target: '/runtime/source', read_only: true }],
        secrets: [{ source: 'required-secret', target: 'required-secret' }],
        configs: [{ source: 'required-config', target: '/runtime/config.json' }],
        depends_on: { dependency: { condition: 'service_healthy', required: true } },
        networks: { transient: null },
        healthcheck: { test: ['CMD-SHELL', 'test "$READY" = yes'], interval: '1s', timeout: '1s', retries: 3 },
      },
      dependency: { image: 'fixture/dependency:1' },
    },
    networks: { transient: { driver: 'bridge', internal: true } },
    volumes: { unused: {} },
    secrets: {
      'required-secret': { file: '/tmp/required-secret' },
      'unused-secret': { file: '/tmp/unused-secret' },
    },
    configs: {
      'required-config': { file: '/tmp/required-config' },
      'unused-config': { file: '/tmp/unused-config' },
    },
  };
  const invoke = (value, services = ['selected']) => spawnSync(
    'jq', ['--argjson', 'services', JSON.stringify(services), '--from-file', path.resolve('scripts/lib/runtime-template-compose.jq')],
    { input: `${JSON.stringify(value)}\n`, encoding: 'utf8', windowsHide: true },
  );

  try {
    const filteredResult = invoke(input);
    assert.equal(filteredResult.status, 0, filteredResult.stderr || filteredResult.stdout);
    const filtered = JSON.parse(filteredResult.stdout);
    assert.deepEqual(Object.keys(filtered.services), ['selected']);
    assert.equal(filtered.services.selected.network_mode, 'none');
    assert.equal(Object.hasOwn(filtered.services.selected, 'depends_on'), false);
    assert.equal(Object.hasOwn(filtered.services.selected, 'networks'), false);
    assert.equal(Object.hasOwn(filtered, 'networks'), false);
    assert.equal(Object.hasOwn(filtered, 'volumes'), false);
    assert.deepEqual(Object.keys(filtered.secrets), ['required-secret']);
    assert.deepEqual(Object.keys(filtered.configs), ['required-config']);
    assert.equal(filtered.services.selected.environment.LITERAL, 'cost=$$VALUE');
    assert.equal(filtered.services.selected.command[2], 'printf %s "$$HOME"');

    await writeFile(filteredPath, `${filteredResult.stdout.trimEnd()}\n`, { mode: 0o600 });
    const reparsedResult = spawnSync(
      'docker', ['compose', '--file', filteredPath, 'config', '--format', 'json'],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(reparsedResult.status, 0, reparsedResult.stderr || reparsedResult.stdout);
    const reparsed = JSON.parse(reparsedResult.stdout);
    assert.deepEqual(Object.keys(reparsed.services), ['selected']);
    assert.equal(reparsed.services.selected.network_mode, 'none');
    assert.equal(Object.hasOwn(reparsed, 'networks'), false);
    for (const field of ['image', 'read_only', 'cap_drop', 'security_opt', 'ports', 'volumes', 'secrets', 'configs']) {
      assert.deepEqual(reparsed.services.selected[field], input.services.selected[field], `second Compose parse changed ${field}`);
    }
    assert.equal(reparsed.services.selected.environment.LITERAL, 'cost=$$VALUE');
    assert.equal(reparsed.services.selected.command[2], 'printf %s "$$HOME"');
    assert.deepEqual(reparsed.services.selected.healthcheck, {
      ...input.services.selected.healthcheck,
      test: ['CMD-SHELL', 'test "$$READY" = yes'],
    });

    const namedVolume = structuredClone(input);
    namedVolume.services.selected.volumes = [{ type: 'volume', source: 'unused', target: '/runtime/source' }];
    const namedVolumeResult = invoke(namedVolume);
    assert.notEqual(namedVolumeResult.status, 0, 'a selected named volume must be rejected');
    assert.match(namedVolumeResult.stderr, /runtime-template services may use only bind volumes/u);

    const missingServiceResult = invoke(input, ['absent']);
    assert.notEqual(missingServiceResult.status, 0, 'a missing selected service must be rejected');
    assert.match(missingServiceResult.stderr, /requested runtime-template service is absent/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('release contract application sets execute through the real shell and jq parser', (context) => {
  const options = {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  };
  const jqProbe = spawnSync('bash', ['-lc', 'command -v jq >/dev/null 2>&1'], options);
  if (jqProbe.status !== 0) {
    context.skip('The host Bash environment does not provide jq; the deployment preflight exercises this parser on Linux.');
    return;
  }

  const validate = (services) => spawnSync('bash', [
    '-lc',
    'set -euo pipefail; command -v jq >/dev/null; source scripts/lib/release-contract.sh; release_contract_validate_allowed_release_services_json "$1"',
    'release-contract-test',
    JSON.stringify(services),
  ], options);
  for (const accepted of [
    ['forge-admin', 'forge-flow', 'forge-ui'],
    ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'],
  ]) {
    const result = validate(accepted);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const rejected = validate(['forge-admin', 'forge-ui']);
  assert.notEqual(rejected.status, 0, 'An unreviewed release service set must fail validation.');
});

test('toolkit upgrade closes the required control-plane topology while preserving application and TaskSpace identity', async () => {
  const [entry, shadowCutover, runtimeTemplateFilter, builder, cutover, legacy, verifier, common, versions, projectEnv, projectCompose, createProject] = await Promise.all([
    read('scripts/upgrade-forge-delivery-toolkit.sh'),
    read('scripts/lib/container-image-cutover.sh'),
    read('scripts/lib/runtime-template-compose.jq'),
    read('scripts/upgrade-prototype-archive-support.sh'),
    read('scripts/upgrade-project-material-isolation.sh'),
    read('scripts/upgrade-harness-vpn-access.sh'),
    read('scripts/lib/harness-image-verifier.sh'),
    read('scripts/lib/common.sh'),
    read('config/versions.env'),
    read('templates/project/project.env.tpl'),
    read('templates/project/compose.yaml'),
    read('scripts/create-project.sh'),
  ]);

  assert.match(entry, /--confirm-maintenance-window forge-delivery-toolkit/);
  assert.match(entry, /readonly approved_pre_external_skill_manager_compose_hash='afb484b6ce9543897ff27380c41aeebe8c98c63516032b242f113ffb26e72e41'/u);
  assert.match(entry, /readonly approved_pre_server_baseline_forge_base_compose_hash='4e6c277dd5769c7f3dd29977dbebf2599f56e396c46c0f6b937fce9d18db7c24'/u);
  assert.match(entry, /readonly approved_pre_server_baseline_replica_compose_hash='f9e2d9085bd43ee7c11e11ebbafe0095f6cf04df696bb285aefe6f5bf1756d76'/u);
  assert.match(entry, /"\$\{hash\}" == "\$\{approved_pre_server_baseline_forge_base_compose_hash\}"[\s\S]*?"\$\{hash\}" == "\$\{approved_pre_server_baseline_replica_compose_hash\}"/u);
  assert.doesNotMatch(entry, /slug" == "forge-(?:base|replica-acceptance)"[\s\S]{0,240}approved_pre_server_baseline/u);
  assert.match(entry, /all_runtime_ready/);
  assert.match(entry, /acceptance_writer_scopes_ready\(\)[\s\S]*has\("conversationWriterScopes"\)[\s\S]*all\(\.conversationWriterScopes\[\];/u);
  assert.match(entry, /acceptance_writer_scopes_ready "\$\{root\}\/acceptance\/service\.json" \|\| return 1/u);
  assert.match(entry, /env_value "\$\{env_file\}" FORGE_SKILL_BUNDLE_ROOT\)" == "\$\{DELIVERY_ROOT\}\/skill-bundles"/u);
  assert.match(entry, /env_value "\$\{env_file\}" TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED\)" == true/u);
  assert.match(entry, /env_value "\$\{env_file\}" FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED\)" == true/u);
  assert.match(entry, /already active for future TaskSpaces; deferred active TaskSpaces were not recreated/);
  assert.doesNotMatch(entry, /upgrade-(?:prototype-archive-support|project-material-isolation)\.sh/);
  assert.match(entry, /harness-image-verifier\.sh/);
  assert.match(entry, /acquire_harness_image_upgrade_lock/);
  assert.match(entry, /verify_target_harness_image/);
  assert.match(entry, /runtime_inventory_exact/);
  assert.match(entry, /runtime_compose_project_is_managed/);
  assert.match(entry, /probe_project_verification_mode\(\)[\s\S]*compose\.host-verification\.yaml/u);
  assert.match(entry, /cmp -- "\$\{REPO_ROOT\}\/templates\/project\/compose\.host-verification\.yaml" "\$\{override\}"/u);
  assert.match(entry, /freeze_project_verification_modes\(\)[\s\S]*project_verification_mode\["\$\{slug\}"\]="\$\{mode\}"/u);
  assert.match(entry, /project_compose\(\)[\s\S]*?case "\$\{mode\}" in\s+host\) compose\+=\(--file "\$\{root\}\/ops\/compose\.host-verification\.yaml"\)/u);
  const frozenModePredicate = entry.slice(
    entry.indexOf('project_uses_host_verification() {'),
    entry.indexOf('\n}\nproject_compose() {', entry.indexOf('project_uses_host_verification() {')) + 2,
  );
  assert.match(frozenModePredicate, /project_verification_mode\[\$\{slug\}\]/u);
  assert.doesNotMatch(frozenModePredicate, /systemctl|stat|cmp|die|compose\.host-verification/u);
  assert.match(entry, /project_broker_inventory_contract_ready\(\)[\s\S]*expected_mode=host-toolchain[\s\S]*host-contract\.json[\s\S]*expected_mode=container-toolchain[\s\S]*contract\.json/u);
  assert.match(entry, /project_broker_inventory_contract_ready "\$\{slug\}" \|\| return 1/u);
  assert.ok(entry.indexOf('\nfreeze_project_verification_modes\n')
    < entry.indexOf('\nif all_runtime_ready; then'));
  assert.match(entry, /host_verification_is_ready\(\)[\s\S]*?\.schemaVersion==2 and \.executionMode=="host-toolchain"[\s\S]*?systemctl is-active --quiet "forge-host-verification@\$\{slug\}\.service"[\s\S]*?source_socket[\s\S]*?controlled-source-observer/u);
  assert.match(entry, /host_retained_legacy_is_stopped\(\)[\s\S]*?State\.Status[\s\S]*?== exited/u);
  assert.match(entry, /broker_uses_host_verification\(\)[\s\S]*?value\.projectSlug===slug[\s\S]*?value\.runnerRevision===revision/u);
  assert.match(entry, /observed_project.*registered_project}-task-/s);
  assert.match(entry, /runtime_compose_project_is_managed "\$\{compose_project\}" \|\| continue/);
  assert.match(entry, /docker ps -a --format/);
  assert.match(entry, /HARNESS_IMAGE_SOURCE/);
  assert.match(entry, /local file="\$1" key="\$2" value="\$3" temporary\n\s*temporary="\$\{file\}\.toolkit\.\$\$"/u);
  assert.doesNotMatch(entry, /local file="\$1"[^\n]*temporary="\$\{file\}/u);
  assert.match(entry, /upsert_env "\$\{staged_env\}" RELEASE_RUNNER_IMAGE "\$\{target_image_id\}"/);
  assert.doesNotMatch(entry, /upsert_env .*task_env/);
  assert.match(entry, /upsert_env "\$\{staged_env\}" FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED true/u);
  assert.match(entry, /glm_unconfigured_key_file="\$\{DELIVERY_ROOT\}\/secrets\/glm-api-key-unconfigured"/u);
  assert.match(entry, /0:0:400:1/u);
  assert.match(entry, /glm_provider_status=unconfigured/u);
  assert.match(entry, /glm_unconfigured_marker_needed=false/u);
  assert.match(entry, /glm_unconfigured_marker_created_by_operation=false/u);
  assert.match(entry, /all_runtime_ready\(\) \{[\s\S]*?\[\[ "\$\{glm_unconfigured_marker_needed\}" != true \]\] \|\| return 1/u);
  assert.match(entry, /Project \$\{slug\} must use an explicit non-root HOST_UID while GLM is unconfigured/u);
  assert.match(entry, /trap rollback ERR EXIT\nestablish_glm_provider_compatibility/u);
  assert.match(entry, /remove_operation_glm_unconfigured_marker \|\| rollback_ok=false/u);
  assert.match(entry, /project_git_root_created_by_operation/u);
  assert.match(entry, /Project \$\{slug\} has an unsafe or duplicate PROJECT_GIT_SSH_ROOT/u);
  assert.match(entry, /install -d -m 0700 -o "\$\{host_uid\}" -g "\$\{host_gid\}" "\$\{root\}"/u);
  assert.match(entry, /remove_operation_project_git_roots \|\| rollback_ok=false/u);
  assert.match(entry, /rmdir -- "\$\{root\}" \|\| return 1/u);
  assert.match(entry, /upsert_env "\$\{staged_env\}" PROJECT_GIT_SSH_ROOT "\$\{DELIVERY_ROOT\}\/git-remotes\/\$\{slug\}"/u);
  assert.match(entry, /upsert_env "\$\{staged_env\}" GLM_KEY_FILE "\$\{GLM_KEY_FILE\}"/u);
  assert.match(entry, /upsert_env "\$\{staged_env\}" FORGE_SKILL_BUNDLE_ROOT "\$\{DELIVERY_ROOT\}\/skill-bundles"/u);
  assert.match(entry, /upsert_env "\$\{staged_env\}" TASKSPACE_GOVERNANCE_CONTEXT_REQUIRED true/u);
  assert.match(entry, /if project_uses_host_verification "\$\{slug\}"; then[\s\S]*upsert_env "\$\{staged_env\}" PROJECT_VERIFICATION_MODE host-toolchain[\s\S]*PROJECT_VERIFICATION_CONTRACT "\$\{verify_root\}\/host-contract\.json"[\s\S]*else[\s\S]*PROJECT_VERIFICATION_MODE container-toolchain[\s\S]*PROJECT_VERIFICATION_CONTRACT "\$\{verify_root\}\/contract\.json"/u);
  assert.match(entry, /glm-provider-status\.txt/u);
  assert.doesNotMatch(entry, /GLM_KEY_FILE.*(?:DEEPSEEK_KEY_FILE|KIMI_KEY_FILE)/u);
  assert.match(entry, /generationPolicy":"new-taskspaces-only/);
  assert.match(entry, /generation:"deferred-active"/);
  assert.match(entry, /capture_preserved_topology/);
  assert.match(entry, /task_hash="\$\(sha256sum .*task\.env/);
  assert.match(entry, /cmp "\$\{backup_root\}\/preserved\.before\.tsv" "\$\{backup_root\}\/preserved\.after\.tsv"/);
  assert.match(entry, /compose_project="\$\(env_value "\$\{task_env\}" TASKSPACE_COMPOSE_PROJECT_NAME\)"/);
  assert.match(entry, /expected_project="forge-\$\{slug\}-task-\$\{task_id\}"/);
  assert.match(entry, /label=com\.docker\.compose\.project=\$\{compose_project\}/);
  assert.match(entry, /label=com\.docker\.compose\.service=\$\{service\}/);
  assert.match(entry, /case "\$\{service\}" in harness\|harness-upload/);
  assert.match(entry, /expected_name="\$\{compose_project\}-\$\{service\}-1"/);
  assert.match(entry, /Unexpected running TaskSpace candidate/);
  assert.match(entry, /task_compose "\$\{slug\}" "\$\{task_id\}" ps --all --quiet harness/);
  assert.match(entry, /if \[\[ "\$\{service\}" == harness \|\| "\$\{service\}" == harness-upload \]\]; then \[\[ "\$\{state\}" == running \]\] \|\| continue; fi/);
  assert.doesNotMatch(entry, /templates\/taskspace\/compose\.yaml/);
  assert.doesNotMatch(entry, /taskspace_network_compose_args/);
  const withoutRequiredServiceBootstrap = entry
    .replaceAll('project_compose "${slug}" up --detach --no-deps protected-acceptance', '')
    .replaceAll('project_compose "${slug}" up --detach --no-deps verification-runner', '');
  assert.match(entry, /project_compose "\$\{slug\}" up --detach --no-deps protected-acceptance/);
  assert.match(entry, /project_compose "\$\{slug\}" up --detach --no-deps verification-runner/);
  assert.doesNotMatch(withoutRequiredServiceBootstrap, /project_compose .*\bup\b/);
  assert.doesNotMatch(entry, /control_compose .*\bup\b/);
  assert.match(entry, /runtime-template-compose\.jq/u);
  assert.match(entry, /install -d -m 0700[^\n]*\\[\s\S]*"\$\{backup_root\}\/runtime-templates"/u);
  assert.match(entry, /config --format json \\\n+\s*\| render_runtime_template_compose "\$\{gateway_template_file\}" '\["conversation-gateway"\]'/u);
  assert.match(entry, /control_runtime_template_compose "\$\{staged_control\}" "\$\{gateway_template_project\}" "\$\{gateway_template_file\}" create --no-build conversation-gateway/);
  assert.match(entry, /gateway_hash="\$\(docker compose --project-name "\$\{gateway_template_project\}"[\s\S]{0,400}templates\/conversation-control-plane\/compose\.yaml"[\s\S]{0,200}config --hash conversation-gateway/u);
  assert.match(entry, /forge_cutover_prepare gateway[^\n]+"\$\{gateway_template_id\}"/);
  assert.equal((entry.match(/forge_cutover_prepare gateway/gu) ?? []).length, 1);
  assert.match(entry, /gateway_maintenance_contract/);
  assert.match(entry, /expected_source="\$\(readlink -f -- "\$\{maintenance_root\}"\)"/);
  assert.match(entry, /partial maintenance contract/);
  assert.match(entry, /gateway_open_protocol_matches "\$\{gateway_contract\}"/);
  assert.match(entry, /legacy-source-maintenance-cutover-no-pre-drain-claim/);
  assert.match(entry, /activate_gateway_candidate\(\)[\s\S]*forge_cutover_activate "\$\{FORGE_CUTOVER_RECORD_ROOT\}\/gateway\.json"/u);
  assert.match(entry, /restore_gateway_fence \|\| rollback_ok=false/);
  assert.match(entry, /if \[\[ "\$\{runtime_rollback_safe\}" == true && -f "\$\{gateway_record\}" && ! -L "\$\{gateway_record\}" \]\]/);
  assert.match(entry, /wait_restored_gateway_open "\$\{gateway_before_id\}"/);
  assert.ok(entry.indexOf('forge_cutover_prepare gateway') < entry.indexOf('gateway_contract="$(gateway_maintenance_contract'));
  assert.match(entry, /wait_project_service_health "\$\{slug\}" conversation-manager/);
  assert.match(entry, /project_compose "\$\{slug\}" config --format json \\\n+\s*\| render_runtime_template_compose "\$\{runtime_template_file\}" '\["conversation-manager","release-runner","taskspace-broker"\]'/u);
  assert.match(entry, /runtime_template_compose "\$\{slug\}" "\$\{runtime_template_project\}" "\$\{runtime_template_file\}" up --no-start --no-build --no-deps conversation-manager release-runner taskspace-broker/);
  assert.match(entry, /forge_cutover_prepare "\$\{slug\}-manager"[^\n]+"\$\{manager_template_id\}"/);
  assert.match(entry, /forge_cutover_prepare "\$\{slug\}-release"[^\n]+"\$\{release_template_id\}"/);
  assert.match(entry, /forge_cutover_prepare "\$\{slug\}-broker"[^\n]+"\$\{broker_template_id\}"/);
  assert.match(entry, /forge_cutover_activate "\$\{FORGE_CUTOVER_RECORD_ROOT\}\/\$\{slug\}-release\.json"/);
  assert.match(entry, /Target Release Runner unhealthy for \$\{slug\}/);
  assert.match(entry, /Target Release Runner is active or unavailable for \$\{slug\}/);
  assert.match(entry, /cleanup_runtime_template \|\| die "Compose runtime templates could not be removed/);
  assert.doesNotMatch(entry, /runtime_template_compose[^\n]+down[^\n]+--volumes/);
  assert.match(runtimeTemplateFilter, /runtime-template services may use only bind volumes/u);
  assert.match(runtimeTemplateFilter, /del\(\.depends_on, \.networks\)/u);
  assert.match(runtimeTemplateFilter, /\.network_mode = "none"/u);
  assert.match(runtimeTemplateFilter, /del\(\.networks, \.volumes, \.secrets, \.configs\)/u);
  assert.match(runtimeTemplateFilter, /gsub\("\\\\\$"; "\$\$"\)/u);
  assert.match(entry, /if \[\[ "\$\{verification_id\}" != absent \]\]/);
  assert.match(entry, /Existing optional Verification Runner must be running and healthy or absent/);
  assert.match(entry, /if project_uses_host_verification "\$\{slug\}"; then\s+host_retained_legacy_is_stopped "\$\{slug\}" "\$\{verification_id\}"[\s\S]{0,300}else\s+if \[\[ "\$\{verification_id\}" != absent \]\]/u);
  assert.match(entry, /if project_uses_host_verification "\$\{slug\}"; then\s+verification_id="\$\(selected_id "\$\{slug\}" verification-runner\)"[\s\S]{0,320}else\s+if \[\[ -f "\$\{FORGE_CUTOVER_RECORD_ROOT\}\/\$\{slug\}-verification\.json" \]\]/u);
  assert.match(entry, /if project_uses_host_verification "\$\{slug\}"; then\s+host_verification_is_ready "\$\{slug\}" && broker_uses_host_verification "\$\{slug\}"[\s\S]{0,260}else\s+wait_container_health "\$\{verification_id\}"/u);
  assert.match(entry, /verification\.created-id/);
  assert.match(entry, /Target Verification Runner unhealthy/);
  assert.match(entry, /Broker cannot reach Verification Runner/);
  assert.match(entry, /CONVERSATION_MANAGER_IMAGE/);
  assert.match(entry, /write_gateway_fence maintenance/);
  assert.match(entry, /wait_gateway_maintenance/);
  assert.match(entry, /backup_control_state/);
  assert.match(entry, /control-plane-state\.tar\.gz/);
  assert.match(entry, /forge_cutover_rollback "\$\{record\}" true/);
  assert.match(entry, /selected\.before\.tsv/);
  assert.match(entry, /selected\.rollback\.tsv/);
  assert.match(entry, /ambiguous; the Gateway was stopped and remains fail-closed/);
  assert.match(entry, /trap rollback ERR EXIT/);
  assert.match(entry, /release\.lock/);
  assert.match(entry, /install -m 0640 "\$\{runtime_contract\}" "\$\{backup_root\}\/projects\/\$\{slug\}\/runtime-contract\.json"/);
  assert.match(entry, /project_release_services_json/u);
  assert.match(entry, /allowed_release_services="\$\(jq --compact-output '\.release\.allowedReleaseServices'/u);
  assert.match(entry, /release_contract_validate_allowed_release_services_json "\$\{allowed_release_services\}"/u);
  assert.match(entry, /release_contract_validate_protected_inputs "\$\{root\}\/workspace" "\$\{allowed_release_services\}"/u);
  assert.match(entry, /render_release_contract "\$\{slug\}" "\$\{root\}" "\$\{root\}\/workspace" "\$\{env_file\}"[\s\S]{0,180}"\$\{project_release_services_json\[\$\{slug\}\]\}"/u);
  assert.ok(entry.indexOf('release_contract_validate_protected_inputs "${root}/workspace" "${allowed_release_services}"')
    < entry.indexOf('timestamp="$(date -u +%Y%m%dT%H%M%SZ)"'));
  assert.match(entry, /release_runtime_contract_ready "\$\{slug\}"/);
  assert.match(entry, /expected_release_services="\$\{project_release_services_json\[\$\{slug\}\]:-\}"/u);
  assert.match(entry, /install -m 0640 -o "\$\{DELIVERY_OWNER\}" -g "\$\{DELIVERY_GROUP\}" "\$\{source\}\/runtime-contract\.json" "\$\{root\}\/ops\/runtime-contract\.json"/);
  assert.match(entry, /docker stop --time 30 "\$\{acceptance_original_id\}"/u);
  assert.match(entry, /docker start "\$\{acceptance_original_id\}"[\s\S]{0,180}acceptance_is_healthy "\$\{slug\}"/u);
  assert.match(entry, /runtime_rollback_safe=true/u);
  assert.match(entry, /optional_service_inventory_matches_baseline "\$\{slug\}" "\$\{service\}" "\$\{baseline_id\}"/u);
  assert.match(entry, /if \[\[ "\$\{runtime_rollback_safe\}" != true \]\]; then\s+rollback_ok=false\s+continue\s+fi\s+acceptance_original_id=/u);
  assert.doesNotMatch(entry, /install -m 0600[^\n]+project\.env[^\n]+\|\| true/u);
  assert.doesNotMatch(entry, /install -m 0640[^\n]+compose\.yaml[^\n]+\|\| true/u);
  assert.doesNotMatch(entry, /\[\[ -f "\$\{source\}\/contract\.json" \]\] && cp[^\n]+\|\| rm/u);
  assert.doesNotMatch(entry, /\[\[ -f "\$\{source\}\/generations\.json" \]\] && cp[^\n]+\|\| rm/u);
  assert.match(entry, /contract\.absent[\s\S]{0,240}rm -f -- "\$\{verify_root\}\/contract\.json" \|\| rollback_ok=false/u);
  assert.match(entry, /generations\.absent[\s\S]{0,260}rm -f -- "\$\{verify_root\}\/taskspace-generations\.json" \|\| rollback_ok=false/u);
  assert.match(entry, /cmp "\$\{source\}\/project\.env" "\$\{root\}\/ops\/project\.env"/u);
  assert.match(entry, /cmp "\$\{source\}\/compose\.yaml" "\$\{root\}\/ops\/compose\.yaml"/u);
  const rollbackStart = entry.indexOf('rollback() {');
  const rollbackEnd = entry.indexOf('\n}\ntrap rollback ERR EXIT', rollbackStart);
  const rollbackSource = entry.slice(rollbackStart, rollbackEnd);
  assert.match(rollbackSource, /local code=\$\?\s+trap - ERR EXIT\s+set \+e/u);
  assert.match(rollbackSource, /\( capture_preserved_topology "\$\{backup_root\}\/preserved\.rollback\.tsv" \).*?\|\| rollback_ok=false/u);
  assert.match(rollbackSource, /\( capture_selected_topology "\$\{backup_root\}\/selected\.rollback\.tsv" \).*?\|\| rollback_ok=false/u);
  assert.ok(rollbackSource.indexOf('runner_release_is_idle "${slug}"')
    < rollbackSource.indexOf('leave_project_maintenance "${slug}"'));
  assert.match(entry, /gateway_container_is_stopped\(\)[\s\S]*docker stop --time 30[\s\S]*docker kill/u);
  assert.match(entry, /fail_close_gateway_for_operator_review\(\)[\s\S]*gateway_container_is_stopped "\$\{id\}"[\s\S]*"\$\{status\}" != 200/u);
  assert.match(rollbackSource, /if \[\[ "\$\{rollback_ok\}" != true \]\]; then[\s\S]*fail_close_gateway_for_operator_review[\s\S]*Gateway was stopped and remains fail-closed/u);
  assert.match(entry, /taskspaces\.lock/);
  assert.match(entry, /\.recovery\.lock/);
  assert.match(entry, /maintenance\.json/);
  assert.match(entry, /PROJECT_VERIFY_ROOT/);
  assert.match(entry, /VERIFICATION_RUNNER_IMAGE/);
  assert.match(entry, /VERIFICATION_TOOLCHAIN_IMAGE/);

  assert.match(projectEnv, /^PROJECT_VERIFICATION_MODE=container-toolchain$/mu);
  assert.match(projectEnv, /^PROJECT_VERIFICATION_CONTRACT=\/srv\/forge-delivery\/projects\/__PROJECT_SLUG__\/verification\/contract\.json$/mu);
  assert.match(projectCompose, /TASKSPACE_VERIFICATION_MODE: \$\{PROJECT_VERIFICATION_MODE:\?PROJECT_VERIFICATION_MODE is required\}/u);
  assert.match(projectCompose, /TASKSPACE_VERIFICATION_CONTRACT: \/etc\/forge-verification\/inventory-contract\.json/u);
  assert.match(projectCompose, /source: \$\{PROJECT_VERIFICATION_CONTRACT:\?PROJECT_VERIFICATION_CONTRACT is required\}[\s\S]*target: \/etc\/forge-verification\/inventory-contract\.json[\s\S]*read_only: true[\s\S]*create_host_path: false/u);

  assert.match(versions, /^CONVERSATION_MANAGER_IMAGE=.+$/m);
  assert.match(projectEnv, /^CONVERSATION_MANAGER_IMAGE=__CONVERSATION_MANAGER_IMAGE__$/m);
  assert.match(projectCompose, /conversation-manager:[\s\S]*image: \$\{CONVERSATION_MANAGER_IMAGE:-\$\{HARNESS_IMAGE:/);
  assert.match(projectCompose, /conversation-manager:[\s\S]*?FORGE_SKILL_BUNDLE_ROOT[^\n]*:\$\{FORGE_SKILL_BUNDLE_ROOT[^\n]*:ro/u);
  assert.doesNotMatch(projectCompose, /conversation-manager:[\s\S]{0,160}image: \$\{RELEASE_RUNNER_IMAGE/);
  assert.match(createProject, /verify_target_harness_image "\$\{CONVERSATION_MANAGER_IMAGE\}"/);
  assert.match(createProject, /conversation_manager_image_id="\$\{FORGE_VERIFIED_HARNESS_IMAGE_ID\}"/);
  assert.match(createProject, /__CONVERSATION_MANAGER_IMAGE__\/\$\{conversation_manager_image_id\}/);

  assert.match(shadowCutover, /forge_cutover_server_api_prefix/);
  assert.match(shadowCutover, /command docker --host unix:\/\/\/var\/run\/docker\.sock/);
  assert.match(shadowCutover, /--unix-socket \/var\/run\/docker\.sock[\s\S]*http:\/\/localhost\/version/);
  assert.match(shadowCutover, /\$\{api_prefix\}\/containers\/create/);
  assert.match(shadowCutover, /forge_cutover_prepare/);
  assert.match(shadowCutover, /runtime_template_id/);
  assert.match(shadowCutover, /runtime_template_file/);
  assert.match(shadowCutover, /"\$\{runtime_template_mode\}" == true[\s\S]{0,120}"\$\{runtime_image_id\}" != "\$\{target_image_id\}"/u);
  assert.match(shadowCutover, /forge_cutover_promote/);
  assert.match(shadowCutover, /forge_cutover_rollback/);
  assert.match(shadowCutover, /forge_cutover_restore_original_state/);
  assert.match(shadowCutover, /jq --null-input --arg logical/);
  assert.match(shadowCutover, /source_image_labels/);
  assert.match(shadowCutover, /target_image_labels \+ \$container_label_overrides/);
  assert.match(shadowCutover, /Docker canonicalized the candidate away from the original container contract/);
  assert.match(shadowCutover, /forge_cutover_write_equivalence_diagnostic/);
  assert.match(shadowCutover, /\.\$\{logical_name\}\.equivalence-diagnostic\.json/);
  assert.match(shadowCutover, /differingConfigKeys: differing_keys\(\$expected_config; \$created\.Config\)/);
  assert.match(shadowCutover, /differingHostConfigKeys: differing_keys\(\(\$expected_host \| normalize_host\); \(\$created\.HostConfig \| normalize_host\)\)/);
  assert.match(shadowCutover, /\(\$created\.Mounts \| canonical_mounts\) == \(\$runtime\.Mounts \| canonical_mounts\)/);
  assert.match(shadowCutover, /networkIdMismatchNames: \$network_id_mismatch_names/);
  assert.match(shadowCutover, /networkRegistryIdMismatchNames: \$network_registry_mismatch_names/);
  assert.match(shadowCutover, /endpointContractMismatchNames: \$endpoint_contract_mismatch_names/);
  assert.match(shadowCutover, /hostMountDifferences: \$host_mount_differences/);
  assert.match(shadowCutover, /A redacted equivalence diagnostic could not be published/);
  assert.match(shadowCutover, /\$\{#candidate_name\} -le 128 && \$\{#rollback_name\} -le 128/);
  assert.match(shadowCutover, /\.original\.fullId/);
  assert.match(shadowCutover, /contracts:\{originalSha256:\$original_contract_sha,candidateSha256:\$candidate_contract_sha\}/);
  assert.match(shadowCutover, /\(\$original_now\.HostConfig \| normalize_host\) == \(\$original\.HostConfig \| normalize_host\)/);
  assert.match(shadowCutover, /\$original_now\.NetworkSettings\.Networks/);
  assert.match(shadowCutover, /created_endpoints\[\$network\]\.NetworkID/);
  assert.match(shadowCutover, /\$created\.Config == \$expected_config/);
  assert.match(shadowCutover, /\(\$created\.HostConfig \| normalize_host\) == \(\$expected_host \| normalize_host\)/);
  assert.match(shadowCutover, /\.Mounts = \(\.Mounts \| canonical_host_mounts\)/);
  assert.match(shadowCutover, /\.ReadOnlyNonRecursive = \(\.ReadOnlyNonRecursive \/\/ false\)/);
  assert.match(shadowCutover, /\$created\.HostConfig\.Mounts \| host_mounts_have_unique_targets/);
  assert.match(shadowCutover, /\(\$created_endpoints\[\$network\]\.GwPriority \/\/ 0\)[\s\S]*== \(\$expected_endpoints\[\$network\]\.GwPriority \/\/ 0\)/);
  assert.match(shadowCutover, /\$created\.Mounts \| mounts_have_unique_destinations/);
  assert.match(shadowCutover, /\(\$created\.Mounts \| canonical_mounts\) == \(\$runtime\.Mounts \| canonical_mounts\)/);
  assert.match(shadowCutover, /\(\(\$original\.Config\.Labels \/\/ \{\}\) \| to_entries/);
  assert.match(shadowCutover, /NetworkMode: \(if \$runtime_template_mode then \$original\.HostConfig\.NetworkMode else \$container\.HostConfig\.NetworkMode end\)/);
  assert.match(shadowCutover, /\[\[ "\$\{runtime_image_id\}" != "\$\{target_image_id\}" \]\]/);
  assert.match(shadowCutover, /\$container\.Config\.MacAddress/);
  assert.match(shadowCutover, /mapfile -t additional_networks/);
  assert.match(shadowCutover, /\$\{api_prefix\}\/networks\/\$\{network_id\}\/connect/);
  assert.match(shadowCutover, /\.promoted \| if type == "boolean" then tostring/);
  assert.match(shadowCutover, /Mounts: \$container\.HostConfig\.Mounts/);
  assert.match(shadowCutover, /promotionState:"prepared"/);
  assert.match(shadowCutover, /forge_cutover_transition_record "\$\{record\}" promotion-intent false/);
  assert.match(shadowCutover, /forge_cutover_transition_record "\$\{record\}" promoted true/);
  assert.match(shadowCutover, /forge_cutover_container_snapshot/);
  assert.match(shadowCutover, /forge_cutover_remove_candidate/);
  assert.match(shadowCutover, /docker ps --all --quiet --no-trunc --filter "id=\$\{candidate_id\}"/);
  assert.match(shadowCutover, /docker rename "\$\{original_id\}" "\$\{rollback_name\}"/);
  assert.match(shadowCutover, /docker rename "\$\{candidate_id\}" "\$\{original_name\}"/);
  assert.match(shadowCutover, /"\$\{current_name\}" == "\$\{original_name\}" && "\$\{current_status\}" == "\$\{original_status\}"/);

  const diagnosticStart = shadowCutover.indexOf('forge_cutover_write_equivalence_diagnostic()');
  const healthStart = shadowCutover.indexOf('forge_cutover_container_health()');
  const diagnostic = shadowCutover.slice(diagnosticStart, healthStart);
  assert.doesNotMatch(diagnostic, /(?:Config|HostConfig|Mounts|Networks)(?:Value|Json|Payload):/);
  assert.doesNotMatch(diagnostic, /\.Env\b/);
  assert.doesNotMatch(diagnostic, /(?:Source|Destination):/);
  const equivalenceFailure = shadowCutover.indexOf("printf 'Docker canonicalized the candidate away from the original container contract.");
  const diagnosticPublish = shadowCutover.indexOf('forge_cutover_write_equivalence_diagnostic "${logical_name}"', equivalenceFailure);
  const candidateCleanup = shadowCutover.indexOf('forge_cutover_remove_candidate "${candidate_id}" "${candidate_name}"', equivalenceFailure);
  assert.ok(equivalenceFailure >= 0 && equivalenceFailure < diagnosticPublish && diagnosticPublish < candidateCleanup);

  const intentWrite = shadowCutover.indexOf('forge_cutover_transition_record "${record}" promotion-intent false');
  const originalRename = shadowCutover.indexOf('docker rename "${original_id}" "${rollback_name}"');
  const candidateRename = shadowCutover.indexOf('docker rename "${candidate_id}" "${original_name}"');
  const promotedWrite = shadowCutover.indexOf('forge_cutover_transition_record "${record}" promoted true');
  assert.ok(intentWrite >= 0 && intentWrite < originalRename);
  assert.ok(originalRename < candidateRename && candidateRename < promotedWrite);

  const activateStart = shadowCutover.indexOf('forge_cutover_activate()');
  const promoteStart = shadowCutover.indexOf('forge_cutover_promote()');
  const activate = shadowCutover.slice(activateStart, promoteStart);
  assert.ok(activate.indexOf('forge_cutover_contract_sha_for_id "${original_full_id}"')
    < activate.indexOf('docker stop --time 30 "${original_id}"'));
  assert.ok(activate.indexOf('"${candidate_current_status}" == created')
    < activate.indexOf('docker stop --time 30 "${original_id}"'));

  const discardStart = shadowCutover.indexOf('forge_cutover_discard_original()');
  const discard = shadowCutover.slice(discardStart);
  assert.match(discard, /"\$\{promoted\}" == true && "\$\{promotion_state\}" == promoted/);
  assert.match(discard, /"\$\{candidate_current_status\}" == running && "\$\{candidate_health\}" == healthy/);
  assert.match(discard, /"\$\{original_current_name\}" == "\$\{rollback_name\}"/);
  assert.ok(discard.indexOf('candidate_health="$(forge_cutover_container_health')
    < discard.indexOf('forge_cutover_remove_candidate "${original_full_id}"'));

  assert.match(builder, /acquire_harness_image_upgrade_lock/);
  assert.match(builder, /verify_target_harness_image/);
  assert.match(builder, /HARNESS_BASE_IMAGE=\$\{foundation_image_build_ref\}/);
  assert.match(builder, /HARNESS_BASE_IMAGE_ID=\$\{expected_base_image_id\}/);
  assert.match(builder, /HARNESS_RUNTIME_PROFILE/);

  assert.match(verifier, /validate-image-build-inputs\.mjs/);
  assert.match(verifier, /validate-runtime-dependencies\.mjs/);
  assert.match(verifier, /verify_harness_agent_preset_contract/);
  assert.match(verifier, /forge-agent-preset-policy\.mjs verify/);
  assert.match(verifier, /agent-preset-prompt-contract\.json/);
  assert.match(verifier, /image-build-inputs\.json/);
  assert.match(verifier, /runtime-dependency-receipt\.json/);
  assert.match(verifier, /validate-runtime-dependencies\.mjs[\s\S]*--smoke/);
  assert.match(verifier, /harness-runtime-profile/);
  assert.match(verifier, /harness-base-image-id/);
  assert.match(verifier, /HARNESS_PRIVILEGED_API_MODE=trusted-host/);
  assert.match(verifier, /FORGE_VERIFIED_HARNESS_IMAGE_ID/);
  assert.match(verifier, /embedded_digest/);
  assert.match(common, /harness-image-upgrade\.lock/);
  assert.match(common, /FORGE_HARNESS_IMAGE_LOCK_FD/);

  // The older material-isolation path remains available for its explicit
  // maintenance operation, but the toolkit upgrade no longer delegates to it.
  assert.match(cutover, /assert_project_sessions_idle/);
  assert.match(cutover, /assert_project_release_idle/);
  assert.match(cutover, /wait_project_runner_idle/);
  assert.match(cutover, /stop taskspace-broker/);
  assert.match(cutover, /stop release-runner/);
  assert.match(cutover, /active == false/);
  assert.match(cutover, /pre-project-material-isolation/);
  assert.match(cutover, /task-env/);
  assert.match(cutover, /restore_project_files/);
  assert.match(cutover, /trap rollback ERR EXIT/);
  assert.match(cutover, /projects\.lock/);
  assert.match(cutover, /\.recovery\.lock/);
  assert.match(cutover, /taskspaces\.lock/);
  assert.match(cutover, /active-taskspaces\.manifest\.tsv/);
  assert.match(cutover, /assert_runtime_inventory_exact/);
  assert.match(cutover, /com\.docker\.compose\.project/);
  assert.match(cutover, /Unregistered, inactive, legacy, or orphan governed runtime/);
  assert.match(cutover, /metadataSha256.*taskEnvSha256.*harnessContainer.*harnessImage/);
  assert.match(cutover, /verify_active_manifest_unchanged/);
  assert.match(cutover, /control-runtime\.before\.tsv/);
  assert.match(cutover, /gateway-runtime\.before\.tsv/);
  assert.match(cutover, /release\.lock/);
  assert.match(cutover, /forge-admin forge-app forge-flow forge-ui/);
  assert.match(cutover, /application-container-ids\.before/);
  assert.match(cutover, /application-container-ids\.after/);
  assert.match(cutover, /\.status.*== active/);
  assert.match(cutover, /Active TaskSpace .* did not converge/);
  assert.match(cutover, /validate-skill-bundle\.mjs/);
  assert.match(cutover, /forge-delivery --help/);
  assert.match(cutover, /\/\.forge-delivery\//);
  assert.match(cutover, /task-exclude/);
  assert.match(cutover, /rollback-status\.txt/);
  assert.match(cutover, /incomplete-gateway-closed/);
  assert.match(cutover, /restored-gateway-closed/);
  assert.match(cutover, /verify_restored_project_runtime/);
  assert.match(cutover, /verify_restored_gateway_runtime/);
  assert.match(cutover, /project_release_is_idle/);
  assert.match(cutover, /verify_target_control_runtime/);
  assert.match(cutover, /verify_target_active_taskspaces/);
  assert.match(cutover, /write_gateway_fence maintenance/);
  assert.match(cutover, /write_gateway_fence committed/);
  assert.match(cutover, /gateway_fence_transaction_state/);
  assert.match(cutover, /committed-postcommit-failure-gateway-closed/);
  assert.match(cutover, /ambiguous-commit-gateway-closed/);
  assert.match(cutover, /destructive rollback was suppressed/);
  assert.match(cutover, /postcommit_failure/);
  assert.match(cutover, /wait_conversation_gateway_maintenance/);
  assert.match(cutover, /\.drain\.mode == "connection-tracked"/);
  assert.match(cutover, /\.drain\.drained == true/);
  assert.match(cutover, /assert_conversation_gateway_stopped/);
  assert.match(cutover, /assert_taskspace_runtime_removed/);
  assert.match(cutover, /TaskSpace TCP\/WebSocket runtime did not hard-drain completely/);
  assert.match(cutover, /write_taskspace_fence/);
  assert.match(cutover, /wait_taskspace_maintenance/);
  assert.match(cutover, /TASKSPACE_MAINTENANCE/);
  assert.match(cutover, /activeUpgradeConnections == 0/);
  assert.match(cutover, /Active legacy TaskSpace .* has no deterministic maintenance fence/);
  assert.match(cutover, /scanning \/proc or session mtimes would recreate the original TOCTOU/);
  assert.match(cutover, /long-running work was left running and the upgrade was aborted/);
  assert.match(cutover, /capture_project_session_manifest/);
  assert.match(cutover, /backup_project_sessions/);
  assert.match(cutover, /session-state\.tar\.gz/);
  assert.match(cutover, /backup_ready=true/);
  assert.match(cutover, /aborted-prebackup-ingress-reopened/);
  assert.match(cutover, /prepare_project_governance_context/);
  assert.match(cutover, /Project governance context failed hash admission/);
  assert.match(cutover, /Tracked AGENTS\.md must remain a regular non-symbolic-link file/);
  assert.match(cutover, /docker ps -a --format/);
  assert.match(cutover, /HARNESS_IMAGE_SOURCE/);
  assert.match(cutover, /RELEASE_RUNNER_IMAGE_SOURCE/);
  assert.match(cutover, /upsert_env "\$\{control_env\}" HARNESS_IMAGE "\$\{target_image_id\}"/);
  assert.match(cutover, /upsert_env "\$\{env_file\}" RELEASE_RUNNER_IMAGE "\$\{target_image_id\}"/);
  assert.match(cutover, /upsert_env "\$\{task_env\}" HARNESS_IMAGE "\$\{target_image_id\}"/);
  assert.match(cutover, /upsert_env "\$\{task_env\}" FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED true/u);
  assert.match(cutover, /cutover-status\.txt/);
  assert.match(cutover, /sourceHarnessImage=%s/);
  assert.match(cutover, /sourceRunnerImage=%s/);
  assert.doesNotMatch(cutover, /down\s+--volumes|docker volume rm|rm -rf/);

  assert.match(legacy, /TaskSpace-managed projects must use upgrade-forge-delivery-toolkit\.sh/);
});

test('project Git credential directory validation is locale-independent', async () => {
  const source = await read('scripts/upgrade-forge-delivery-toolkit.sh');
  assert.match(source, /metadata="\$\(stat -Lc '%u:%a' -- "\$\{root\}" 2>\/dev\/null \|\| true\)"/u);
  assert.match(source, /\[\[ -d "\$\{root\}" && ! -L "\$\{root\}" && "\$\{metadata\}" == "\$\{host_uid\}:700" \]\]/u);
  assert.doesNotMatch(source, /stat -Lc '%u:%a:%F'/u);
});

test('foundation candidates are fully verified before first baseline persistence and re-read through the trusted lock', async () => {
  const [verifier, sync] = await Promise.all([
    read('scripts/lib/harness-image-verifier.sh'),
    read('scripts/sync-baseline.sh'),
  ]);
  const verifierStart = verifier.indexOf('verify_harness_foundation_image()');
  const resolverStart = verifier.indexOf('resolve_configured_harness_foundation_image_id()');
  const targetStart = verifier.indexOf('verify_target_harness_image()');
  const targetResolverStart = verifier.indexOf('resolve_configured_harness_image_id()');
  assert.ok(
    verifierStart >= 0
      && resolverStart > verifierStart
      && targetStart > resolverStart
      && targetResolverStart > targetStart,
  );

  const candidateVerifier = verifier.slice(verifierStart, resolverStart);
  const persistedResolver = verifier.slice(resolverStart, targetStart);
  assert.doesNotMatch(candidateVerifier, /baseline\.lock/);
  assert.match(candidateVerifier, /org\.opencontainers\.image\.revision/);
  assert.match(candidateVerifier, /HARNESS_FOUNDATION_IMAGE_REVISION/);
  assert.match(candidateVerifier, /HARNESS_FOUNDATION_SKILL_BUNDLE_VERSION/);
  assert.match(candidateVerifier, /"\$\{skill_bundle\}" == "\$\{expected_skill_bundle\}"/);
  assert.match(candidateVerifier, /--skill-bundle "\$\{expected_skill_bundle\}"/);
  assert.doesNotMatch(candidateVerifier, /HARNESS_IMAGE_REVISION\}-base/);
  assert.match(candidateVerifier, /com\.forge-delivery\.harness-node-base-manifest/);
  assert.match(candidateVerifier, /com\.forge-delivery\.harness-maven-base-manifest/);
  assert.match(candidateVerifier, /HARNESS_PRIVILEGED_API_MODE=loopback-only/);
  assert.match(candidateVerifier, /validate-image-build-inputs\.mjs/);
  assert.match(candidateVerifier, /validate-runtime-dependencies\.mjs/);
  assert.match(candidateVerifier, /harness_json_required_field schemaVersion[\s\S]*== 3/);
  assert.match(candidateVerifier, /validate-runtime-dependencies\.mjs[^\n]*--smoke --json/);
  assert.match(candidateVerifier, /runtime-dependency-receipt\.json/);
  assert.match(candidateVerifier, /verify_harness_agent_preset_contract "\$\{foundation_image_id\}"/);
  assert.match(candidateVerifier, /verify_harness_core_runtime_contract/);
  assert.match(verifier, /DSH_BUNDLED_SKILL_DIR:-.*forge-skill-bundles\/current\/skills/);
  assert.match(verifier, /test ! -e \/usr\/local\/share\/dsh-skills/);
  assert.match(candidateVerifier, /Harness foundation reference changed during verification/);

  assert.match(persistedResolver, /baseline\.lock/);
  assert.match(persistedResolver, /stat -L -c '%u:%g:%a:%h:%F'/);
  assert.match(persistedResolver, /:640:1:regular file/);
  assert.match(persistedResolver, /\/proc\/\$\{BASHPID\}\/fd\/\$\{lock_fd\}/);
  assert.match(persistedResolver, /cat <&\$\{lock_fd\}/);
  assert.match(persistedResolver, /sha256sum -- "\$\{lock_fd_path\}"/);
  assert.match(
    persistedResolver,
    /verify_harness_foundation_image "\$\{HARNESS_FOUNDATION_IMAGE\}" "\$\{foundation_image_id\}"/,
  );
  assert.match(persistedResolver, /identity receipt changed during image verification/);

  const persistedTargetResolver = verifier.slice(targetResolverStart);
  assert.match(persistedTargetResolver, /\/proc\/\$\{BASHPID\}\/fd\/\$\{lock_fd\}/);
  assert.doesNotMatch(verifier, /\/proc\/\$\$\/fd\/\$\{lock_fd\}/);
  assert.match(persistedTargetResolver, /baseline\.lock/);
  assert.match(persistedTargetResolver, /HARNESS_FOUNDATION_IMAGE_ID/);
  assert.match(persistedTargetResolver, /HARNESS_IMAGE_ID/);
  assert.match(
    persistedTargetResolver,
    /verify_harness_foundation_image "\$\{HARNESS_FOUNDATION_IMAGE\}" "\$\{foundation_image_id\}"/,
  );
  assert.match(
    persistedTargetResolver,
    /verify_target_harness_image "\$\{HARNESS_IMAGE\}" "\$\{foundation_image_id\}"/,
  );
  assert.match(persistedTargetResolver, /verified_target_id="\$\{FORGE_VERIFIED_HARNESS_IMAGE_ID\}"/);
  assert.match(persistedTargetResolver, /verified_target_id.*target_image_id/);

  const candidateInspect = sync.indexOf("foundation_image_id=\"$(docker image inspect --format '{{.Id}}'");
  const candidateVerify = sync.indexOf(
    'verify_harness_foundation_image "${HARNESS_FOUNDATION_IMAGE}" "${foundation_image_id}"',
  );
  const overlayBuild = sync.indexOf('log "Building trusted-host Harness target');
  const lockWrite = sync.indexOf('baselines_root="${DELIVERY_ROOT}/baselines"', overlayBuild);
  const lockPublish = sync.indexOf('mv --no-target-directory --', lockWrite);
  const persistedReadback = sync.indexOf('resolve_configured_harness_image_id', lockPublish);
  for (const position of [candidateInspect, candidateVerify, overlayBuild, lockWrite, lockPublish, persistedReadback]) {
    assert.notEqual(position, -1);
  }
  assert.ok(candidateInspect < candidateVerify);
  assert.ok(candidateVerify < overlayBuild);
  assert.ok(overlayBuild < lockWrite);
  assert.ok(lockWrite < lockPublish);
  assert.ok(lockPublish < persistedReadback);
  assert.match(sync, /harness_image_id="\$\{FORGE_VERIFIED_HARNESS_IMAGE_ID\}"/);
  assert.match(sync, /--build-arg "HARNESS_IMAGE_REVISION=\$\{HARNESS_FOUNDATION_IMAGE_REVISION\}"/);
  assert.match(sync, /persisted_harness_image_id.*harness_image_id/);
  assert.doesNotMatch(sync, /temp_lock="\$\{lock_file\}\.tmp\.\$\$"/);
  assert.match(sync, /exec \{baseline_dir_fd\}<"\$\{baselines_root\}"/);
  assert.match(sync, /mktemp "\$\{baseline_dir_fd_path\}\/\.baseline\.lock\.XXXXXX"/);
  assert.match(sync, /exec \{baseline_temp_fd\}<>"\$\{baseline_dir_fd_path\}\/\$\{baseline_temp_name\}"/);
  assert.match(sync, /stat -L -c '%u:%g:%a:%h:%F' -- "\$\{baseline_temp_fd_path\}"/);
  assert.match(sync, /:600:1:regular file/);
  assert.match(sync, /:640:1:regular file/);
  assert.match(sync, /SHARED_SERVICES_ENV_FILE=.*>&\$\{baseline_temp_fd\}/);
  assert.match(sync, /sha256sum -- "\$\{baseline_temp_fd_path\}"/);
  assert.match(sync, /sync -- "\$\{baseline_temp_fd_path\}"/);
  assert.match(sync, /sync -- "\$\{baseline_dir_fd_path\}"/);
  assert.match(sync, /mv --no-target-directory --/);
  assert.match(sync, /cleanup_baseline_receipt/);
  const tempCreate = sync.indexOf('baseline_temp_path="$(mktemp');
  const tempOpen = sync.indexOf('exec {baseline_temp_fd}<>', tempCreate);
  const fdWrite = sync.indexOf('>&${baseline_temp_fd}', tempOpen);
  const fdChown = sync.indexOf('chown --dereference', fdWrite);
  const prePublishIdentity = sync.indexOf('candidate or directory changed before publication', fdChown);
  for (const position of [tempCreate, tempOpen, fdWrite, fdChown, prePublishIdentity]) {
    assert.notEqual(position, -1);
  }
  assert.ok(tempCreate < tempOpen);
  assert.ok(tempOpen < fdWrite);
  assert.ok(fdWrite < fdChown);
  assert.ok(fdChown < prePublishIdentity);
  assert.ok(prePublishIdentity < lockPublish);
  assert.doesNotMatch(
    sync,
    /harness-node-base-manifest[\s\S]*harness-maven-base-manifest[\s\S]*Harness foundation was not built/,
  );
  const adoption = sync.slice(sync.indexOf('adopt_verified_images()'), sync.indexOf('restore_baseline_receipt()'));
  const restore = sync.slice(sync.indexOf('restore_baseline_receipt()'), sync.indexOf('if [[ $# -gt 0 ]]'));
  assert.match(sync, /--expected-current-lock-sha256/);
  assert.match(adoption, /verify_harness_foundation_image "\$foundation_ref" "\$foundation_id"/);
  assert.match(adoption, /verify_target_harness_image "\$target_ref" "\$foundation_id"/);
  assert.match(adoption, /write_or_validate_adoption_transition "\$transition_file" "\$next_sha"\n\s*publish_bound_baseline_lock/u);
  assert.match(adoption, /publish_bound_baseline_lock "\$expected_current" "\$next_sha" write_adoption_receipt/);
  assert.match(adoption, /resolve_configured_harness_foundation_image_id/);
  assert.match(adoption, /resolve_configured_harness_image_id/);
  assert.doesNotMatch(adoption, /git\s|docker build|docker tag|fetch/u);
  assert.match(sync, /adoption_receipt_contents="\$\(canonical_adoption_receipt "\$generated_at"/);
  assert.match(sync, /printf '%s\\n' "\$adoption_receipt_contents" \| sha256sum/);
  assert.match(sync, /require_adoption_transition_path\(\)[\s\S]*vpn78-internal-test-\*\/baseline-lock-transition[\s\S]*0:0:700:directory/u);
  assert.match(sync, /read_adoption_transition_sha\(\)[\s\S]*0:0:600:1:regular file[\s\S]*bytes" == 65/u);
  assert.match(sync, /write_or_validate_adoption_transition\(\)[\s\S]*existing adoption transition differs[\s\S]*mv --no-target-directory/u);
  assert.match(sync, /candidate_fd_path="\/proc\/\$\{BASHPID\}\/fd\/\$\{candidate_fd\}"[\s\S]*?cat -- "\$candidate_fd_path"/u);
  assert.doesNotMatch(sync, /\$\(cat <&\$\{candidate_fd\}\)/u);
  assert.match(sync, /\[\[ \$# == 13[\s\S]*"\$\{10\}" == --target-image-id[\s\S]*"\$\{12\}" == --transition-file/u);
  assert.match(sync, /adopt_verified_images "\$3" "\$5" "\$7" "\$9" "\$\{11\}" "\$\{13\}"/u);
  assert.match(sync, /--backup-file/);
  assert.match(restore, /baseline restore backup path is outside the bounded vpn78 backup roots/);
  assert.match(restore, /vpn78-rollback-safety-\*\/baseline\.lock/);
  assert.match(restore, /publish_bound_baseline_lock "\$expected_current" "\$backup_sha" write_baseline_backup/);
  assert.doesNotMatch(restore, /resolve_configured_harness|verify_harness_foundation_image|verify_target_harness_image|docker image inspect|cp\s/u);
  const restoreBootstrap = sync.slice(0, sync.indexOf('baseline_dir_fd='));
  assert.match(restoreBootstrap, /if \[\[ "\$\{1:-\}" == --restore-baseline-lock \]\]; then[\s\S]*:\s*"\$\{DELIVERY_ROOT:\?DELIVERY_ROOT is required for baseline-lock restore\}"[\s\S]*:\s*"\$\{DELIVERY_OWNER:\?DELIVERY_OWNER is required for baseline-lock restore\}"[\s\S]*:\s*"\$\{DELIVERY_GROUP:\?DELIVERY_GROUP is required for baseline-lock restore\}"[\s\S]*else\s*load_platform_config/su);
  assert.doesNotMatch(restoreBootstrap, /readonly DELIVERY_(?:ROOT|OWNER|GROUP)/u);
  assert.ok(sync.indexOf('if [[ "${1:-}" == --restore-baseline-lock ]]') < sync.indexOf('load_platform_config'));
});

test('descriptor identity uses the command-substitution Bash process', { skip: process.platform !== 'linux' }, () => {
  const script = [
    'set -Eeuo pipefail',
    'probe() {',
    '  local descriptor descriptor_path',
    '  exec {descriptor}</dev/null',
    '  descriptor_path="/proc/${BASHPID}/fd/${descriptor}"',
    '  [[ "$(readlink -f -- "${descriptor_path}")" == /dev/null ]]',
    '  printf verified',
    '}',
    'observed="$(probe)"',
    '[[ "${observed}" == verified ]]',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('transition candidate readback uses its bound fd path after writing', { skip: process.platform !== 'linux' }, () => {
  const script = [
    'set -Eeuo pipefail',
    'candidate="$(mktemp)"',
    'trap \'rm -f -- "${candidate}"\' EXIT',
    'exec {candidate_fd}<>"${candidate}"',
    'candidate_fd_path="/proc/${BASHPID}/fd/${candidate_fd}"',
    'printf \'%064d\\n\' 0 >&${candidate_fd}',
    '[[ "$(cat -- "${candidate_fd_path}")" =~ ^0{64}$ ]]',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('both Harness image paths package the CLI and enforce the external Skill boundary', async () => {
  const dockerfiles = await Promise.all([
    read('docker/harness/Dockerfile'),
    read('docker/harness/Dockerfile.overlay'),
  ]);
  for (const source of dockerfiles) {
    assert.match(source, /docker\/harness\/forge-delivery(?:\s|\\)/);
    assert.match(source, /docker\/harness\/forge-delivery\.mjs(?:\s|\\)/);
    assert.match(source, /\/usr\/local\/bin\//);
    assert.match(source, /\/usr\/local\/lib\//);
    assert.match(source, /DSH_BUNDLED_SKILL_DIR=\/opt\/forge-skill-bundles\/current\/skills/);
    assert.match(source, /test ! -e \/usr\/local\/share\/dsh-skills/);
    assert.match(source, /validate-skill-bundle\.mjs/);
    assert.match(source, /validate-image-build-inputs\.mjs/);
    assert.match(source, /validate-runtime-dependencies\.mjs/);
    assert.match(source, /image-build-inputs\.json/);
    assert.match(source, /runtime-dependencies\/package-lock\.json/);
    assert.match(source, /forge-image-build\/receipt\.json/);
    assert.match(source, /runtime-dependency-receipt\.json/);
    assert.match(source, /com\.forge-delivery\.harness-runtime-profile/);
    assert.doesNotMatch(source, /COPY docker\/harness\/skills\//);
  }
  assert.match(dockerfiles[0], /ARG HARNESS_RUNTIME_PROFILE=loopback-safe/);
  assert.match(dockerfiles[1], /ARG HARNESS_RUNTIME_PROFILE=vpn-trusted-host/);
  assert.match(dockerfiles[1], /com\.forge-delivery\.harness-base-image-id/);
  assert.match(dockerfiles[1], /ARG HARNESS_BASE_IMAGE_ID/);
  assert.match(dockerfiles[1], /\^sha256:\[0-9a-f\]\{64\}\$/);
});

test('every Harness tag writer shares the global lock, immutable parent ID, and complete verifier', async () => {
  const builders = [
    'scripts/sync-baseline.sh',
    'scripts/upgrade-controlled-release.sh',
    'scripts/upgrade-conversation-gateway-ui.sh',
    'scripts/upgrade-harness-vpn-access.sh',
    'scripts/upgrade-prototype-archive-support.sh',
    'scripts/upgrade-release-runner-readiness.sh',
    'scripts/upgrade-taskspace-isolation.sh',
    'scripts/forge-delivery-deploy-root.sh',
    'scripts/forge-delivery-mobile-runtime-root.sh',
  ];
  for (const file of builders) {
    const source = await read(file);
    assert.match(source, /acquire_harness_image_(?:upgrade_)?lock/, `${file} has no shared tag-writer lock`);
    assert.match(source, /verify_target_harness_image/, `${file} bypasses complete image verification`);
    if (source.includes('Dockerfile.overlay')) {
      assert.match(source, /HARNESS_BASE_IMAGE=\$\{(?:current_image_build_ref|foundation_image_build_ref)\}/,
        `${file} does not use a locally resolvable, prechecked parent reference`);
      assert.match(source, /HARNESS_BASE_IMAGE_ID=\$\{(?:(?:current|foundation)_image_id|expected_base_image_id)\}/,
        `${file} does not bind the overlay to an immutable parent ID`);
      assert.match(source, /HARNESS_RUNTIME_PROFILE=/, `${file} does not bind its runtime profile`);
    }
  }
});


test('control-plane identity preserves legacy installations and rejects implicit renames', async () => {
  const common = await read('scripts/lib/common.sh');
  const resolve = extractShellFunction(common, 'control_plane_compose_project_name');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'forge-control-identity-'));
  const file = path.join(fixture, 'control-plane.env');
  const cases = [
    { name: 'legacy missing field', configured: '', content: 'HARNESS_IMAGE=fixture\n', expected: 'forge-conversation-control-plane' },
    { name: 'persisted isolated identity', configured: 'forge-coverage-upgrade-b', content: 'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b\n', expected: 'forge-coverage-upgrade-b' },
    { name: 'legacy cannot silently rename', configured: 'forge-coverage-upgrade-b', content: 'HARNESS_IMAGE=fixture\n', reject: true },
    { name: 'persisted identity cannot silently rename', configured: 'forge-coverage-upgrade-c', content: 'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b\n', reject: true },
    { name: 'missing isolated configuration cannot choose the default plane', configured: '', content: 'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b\n', reject: true },
    { name: 'duplicate identity', configured: 'forge-coverage-upgrade-b', content: 'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b\nCONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b\n', reject: true },
    { name: 'empty persisted identity', configured: '', content: 'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=\n', reject: true },
    { name: 'invalid configured identity', configured: 'bad/name', content: 'HARNESS_IMAGE=fixture\n', reject: true },
  ];
  try {
    for (const item of cases) {
      await writeFile(file, item.content);
      const result = spawnSync('bash', ['-s', '--', file.replaceAll('\\', '/')], {
        input: ['set -eu', 'die() { printf "%s\\n" "$*" >&2; exit 1; }', resolve,
          'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME="$FIXTURE_PLANE"',
          'control_plane_compose_project_name "$1"'].join('\n'),
        env: { ...process.env, FIXTURE_PLANE: item.configured }, encoding: 'utf8', windowsHide: true,
      });
      if (item.reject) assert.notEqual(result.status, 0, item.name);
      else { assert.equal(result.status, 0, `${item.name}: ${result.stderr}`); assert.equal(result.stdout.trim(), item.expected); }
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('control-plane preparation persists its chosen identity idempotently and targets it explicitly', async () => {
  const common = await read('scripts/lib/common.sh');
  const source = await read('scripts/conversation-control-planectl.sh');
  const resolve = extractShellFunction(common, 'control_plane_compose_project_name');
  const writer = extractShellFunction(source, 'write_control_env');
  const compose = extractShellFunction(source, 'compose');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'forge-control-prepare-'));
  try {
    const result = spawnSync('bash', ['-s', '--', fixture.replaceAll('\\', '/')], {
      input: ['set -eu', 'die() { printf "%s\\n" "$*" >&2; exit 1; }', resolve, writer, compose,
        'resolve_harness_runtime() { :; }', 'getent() { test "$1" = group; printf "fixture:x:1000:\\n"; }',
        'chown() { :; }',
        'control_root="$1"; control_env="$1/control-plane.env"; compose_file="$1/compose.yaml"',
        'registry_file="$1/projects.tsv"; DELIVERY_OWNER="$(id -un)"; DELIVERY_GROUP=fixture',
        'CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b',
        'CONVERSATION_GATEWAY_BIND_ADDRESS=127.0.0.1; CONVERSATION_GATEWAY_PORT=23080',
        'HARNESS_IMAGE=fixture/harness:pinned; harness_image_id="sha256:fixture"',
        'control_plane_project_name="$(control_plane_compose_project_name "$control_env")"',
        'write_control_env', 'cp "$control_env" "$1/before.env"',
        'test "$(control_plane_compose_project_name "$control_env")" = forge-coverage-upgrade-b',
        'write_control_env', 'cmp "$control_env" "$1/before.env"',
        'docker() { printf "%s\\n" "$@"; }',
        'export COMPOSE_PROJECT_NAME=unrelated-shared-plane', 'compose config --format json',
      ].join('\n'), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const persisted = await readFile(path.join(fixture, 'control-plane.env'), 'utf8');
    assert.match(persisted, /^CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME=forge-coverage-upgrade-b$/mu);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u).slice(0, 3), ['compose', '--project-name', 'forge-coverage-upgrade-b']);
    const template = await read('templates/conversation-control-plane/compose.yaml');
    assert.match(template, /^name: \$\{CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME:-forge-conversation-control-plane\}$/mu);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('control-plane upgrade inventory isolates its Gateway and still rejects missing or duplicate consumers', async () => {
  const source = await read('scripts/upgrade-forge-delivery-toolkit.sh');
  const managed = extractShellFunction(source, 'runtime_compose_project_is_managed');
  const inventory = extractShellFunction(source, 'runtime_inventory_exact');
  const own = 'own\tforge-coverage-upgrade-b\tconversation-gateway\trunning';
  const other = 'other\tforge-conversation-control-plane\tconversation-gateway\trunning';
  const cases = [
    { lines: [own, other], pass: true },
    { lines: [other], pass: false },
    { lines: [own, own.replace('own\t', 'duplicate\t'), other], pass: false },
    { lines: [own, 'unexpected\tforge-coverage-upgrade-b\trelease-runner\trunning'], pass: false },
  ];
  for (const item of cases) {
    const result = spawnSync('bash', ['-s'], {
      input: ['set -eu', managed, inventory,
        'control_plane_project_name=forge-coverage-upgrade-b', 'project_slugs=()',
        'runtime_compose_project_is_managed forge-coverage-upgrade-b',
        'if runtime_compose_project_is_managed forge-conversation-control-plane; then exit 71; fi',
        'docker() { test "$1" = ps; printf "%s\\n" "$FIXTURE_INVENTORY"; }',
        'runtime_inventory_exact',
      ].join('\n'), env: { ...process.env, FIXTURE_INVENTORY: item.lines.join('\n') }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status === 0, item.pass, result.stderr || result.stdout || item.lines.join(' / '));
  }
});

test('control-plane migration forwards the selected installation project with only its local roots', async () => {
  const source = await read('scripts/conversation-control-planectl.sh');
  const migration = extractShellFunction(source, 'run_migration');
  const assignment = source.split(/\r?\n/u).find((line) => line.startsWith('canonical_project='));
  assert.ok(assignment);
  for (const configured of ['', 'coverage-upgrade-b']) {
    const result = spawnSync('bash', ['-s'], {
      input: ['set -eu', assignment, migration,
        'resolve_harness_runtime() { :; }',
        'id() { test "$1" = -u; printf "1000\\n"; }',
        'getent() { test "$1" = group; printf "forge:x:1000:\\n"; }',
        'DELIVERY_ROOT=/srv/coverage-upgrade-b; DELIVERY_OWNER=forge; DELIVERY_GROUP=forge',
        'REPO_ROOT=/opt/isolated-toolkit; state_root="$DELIVERY_ROOT/conversation-control-plane/state"',
        'harness_image_id=sha256:pinned', 'docker() { printf "%s\\n" "$@"; }', 'run_migration',
      ].join('\n'),
      env: { ...process.env, CONVERSATION_CONTROL_PLANE_CANONICAL_PROJECT: configured },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.trim().split(/\r?\n/u);
    assert.deepEqual(args.slice(-6), ['--delivery-root', '/srv/coverage-upgrade-b', '--target-state-root',
      '/srv/coverage-upgrade-b/conversation-control-plane/state', '--canonical-project', configured || 'forge-base']);
    assert.ok(!args.some((arg) => arg.includes('/srv/forge-delivery')));
  }
});
