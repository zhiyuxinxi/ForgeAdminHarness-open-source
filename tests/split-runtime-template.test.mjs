import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function text(relative) {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

function renderProjectCompose(composeFile, projectName, extraEnv = {}) {
  const composeSource = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (composeSource.error?.code === 'ENOENT' || composeSource.status !== 0) return null;

  const source = spawnSync('docker', [
    'compose', '--file', composeFile, 'config', '--format', 'json',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: projectName,
      CONVERSATION_MANAGER_TOKEN_FILE: '/srv/forge-delivery/projects/test/ops/conversation-manager.token',
      DEEPSEEK_KEY_FILE: '/tmp/deepseek-key',
      DELIVERY_GROUP: 'forge-delivery',
      DELIVERY_OWNER: 'forge-delivery',
      DELIVERY_ROOT: '/srv/forge-delivery',
      DOCKER_GID: '984',
      FORGE_SKILL_BUNDLE_ROOT: '/srv/forge-delivery/skill-bundles',
      FORGE_ADMIN_REF: 'test-ref',
      FORGE_UI_PORT: '18080',
      GLM_KEY_FILE: '/tmp/glm-key',
      HARNESS_IMAGE: 'example.invalid/forge-harness:test',
      HARNESS_PORT: '13080',
      HARNESS_UPLOAD_TOKEN: 'test-token',
      HOST_GID: '1000',
      HOST_UID: '1000',
      KIMI_KEY_FILE: '/tmp/kimi-key',
      PLATFORM_CONVERSATION_AUTH_ROOT: '/srv/forge-delivery/conversation-control-plane/auth',
      PLATFORM_CONVERSATION_PROJECT_ROOT: '/srv/forge-delivery/conversation-control-plane',
      PLATFORM_PROJECT_REGISTRY_FILE: '/srv/forge-delivery/registry/projects.tsv',
      PLATFORM_ROOT: '/opt/forge-delivery',
      PROJECT_ACCEPTANCE_CONFIG: '/srv/forge-delivery/projects/test/acceptance/service.json',
      PROJECT_ACCEPTANCE_CONTROL_IPC_ROOT: '/srv/forge-delivery/projects/test/acceptance/ipc-control',
      PROJECT_ACCEPTANCE_ISSUER_IPC_ROOT: '/srv/forge-delivery/projects/test/acceptance/ipc-issuer',
      PROJECT_ACCEPTANCE_RESOLVER_IPC_ROOT: '/srv/forge-delivery/projects/test/acceptance/ipc-resolver',
      PROJECT_ACCEPTANCE_SECRET_ROOT: '/srv/forge-delivery/projects/test/acceptance/secrets',
      PROJECT_ACCEPTANCE_STATE_ROOT: '/srv/forge-delivery/projects/test/acceptance/state',
      PROJECT_ACCEPTANCE_ROOT: '/srv/forge-delivery/projects/test/acceptance',
      PROJECT_GIT_SSH_ROOT: '/srv/forge-delivery/git-remotes/test',
      PROJECT_RELEASE_IPC_ROOT: '/srv/forge-delivery/projects/test/ops/release-ipc',
      PROJECT_ROOT: '/srv/forge-delivery/projects/test',
      PROJECT_SHARED_INPUT_ROOT: '/srv/forge-delivery/projects/test/shared-inputs/accepted',
      PROJECT_SLUG: 'test',
      PROJECT_UPLOAD_ROOT: '/srv/forge-delivery/projects/test/uploads',
      PROJECT_VERIFICATION_CONTRACT: '/srv/forge-delivery/projects/test/verification/contract.json',
      PROJECT_VERIFY_IPC_ROOT: '/srv/forge-delivery/projects/test/verification/ipc',
      PROJECT_VERIFY_ROOT: '/srv/forge-delivery/projects/test/verification',
      PROJECT_VERIFY_SOURCE_IPC_ROOT: '/srv/forge-delivery/projects/test/verification/source-ipc',
      PROJECT_VERIFICATION_MODE: 'container-toolchain',
      REDIS_DATABASE: '1',
      RELEASE_RUNNER_IMAGE: 'example.invalid/forge-harness:test',
      SHARED_SERVICES_ENV_FILE: path.join(repoRoot, 'templates/project/project.env.tpl'),
      TASKSPACE_LOCK_FILE: '/srv/forge-delivery/projects/test/taskspaces/.lock',
      TASKSPACE_PORT_REGISTRY_FILE: '/srv/forge-delivery/registry/taskspace-ports.tsv',
      ...extraEnv,
    },
  });
  assert.equal(source.status, 0, source.stderr || source.stdout);
  return JSON.parse(source.stdout);
}

test('application BuildKit cache mounts render with distinct managed Compose project namespaces', (t) => {
  const composeFile = path.join(repoRoot, 'templates/project/compose.yaml');
  const first = renderProjectCompose(composeFile, 'forge-cache-alpha');
  if (first === null) {
    t.skip('Docker Compose is unavailable');
    return;
  }
  const second = renderProjectCompose(composeFile, 'forge-cache-beta');
  const services = ['forge-flow', 'forge-admin', 'forge-app', 'forge-ui'];
  for (const service of services) {
    assert.equal(first.services[service].build.args.BUILDKIT_CACHE_MOUNT_NS, 'forge-cache-alpha');
    assert.equal(second.services[service].build.args.BUILDKIT_CACHE_MOUNT_NS, 'forge-cache-beta');
  }
  assert.notEqual(
    first.services['forge-admin'].build.args.BUILDKIT_CACHE_MOUNT_NS,
    second.services['forge-admin'].build.args.BUILDKIT_CACHE_MOUNT_NS,
  );
});

test('TaskSpace mounts external current Skills read-only without replacing project instructions or DSH_HOME', async () => {
  const compose = await text('templates/taskspace/compose.yaml');
  assert.match(compose, /DSH_BUNDLED_SKILL_DIR:\s*\/opt\/forge-skill-bundles\/current\/skills/u);
  assert.match(compose, /FORGE_SKILL_BUNDLE_ROOT.*?:\/opt\/forge-skill-bundles:ro/u);
  assert.match(compose, /TASKSPACE_ROOT.*?\/dsh-home:\/home\/node\/\.dsh/u);
  assert.match(compose, /PROJECT_ROOT.*?\/governance\/PROJECT_CONTEXT\.md[\s\S]*?target:\s*\/workspace\/PROJECT_CONTEXT\.md[\s\S]*?read_only:\s*true/u);
  assert.doesNotMatch(compose, /docker\.sock/u);
});

test('Manager can validate external Skills while schema-v1 TaskSpaces keep their frozen Compose generation', async () => {
  const [projectCompose, legacyCompose, control, packager] = await Promise.all([
    text('templates/project/compose.yaml'),
    text('templates/taskspace/compose.legacy-v1.yaml'),
    text('scripts/taskspacectl.sh'),
    text('scripts/package-portable-toolkit.sh'),
  ]);

  assert.match(projectCompose, /conversation-manager:[\s\S]*?FORGE_SKILL_BUNDLE_ROOT[^\n]*:\$\{FORGE_SKILL_BUNDLE_ROOT[^\n]*:ro/u);
  assert.doesNotMatch(legacyCompose, /FORGE_SKILL_BUNDLE_ROOT|DSH_BUNDLED_SKILL_DIR|TASKSPACE_ACTOR_USER_ID|GLM_KEY_FILE|PROJECT_CONTEXT\.md/u);
  assert.match(control, /taskspace_legacy_compose=.*compose\.legacy-v1\.yaml/u);
  assert.match(control, /\.schemaVersion \| select\(\. == 1 or \. == 2\)/u);
  assert.match(control, /1\) printf '%s\\n' "\$\{taskspace_legacy_compose\}"/u);
  assert.match(control, /2\) printf '%s\\n' "\$\{taskspace_compose\}"/u);
  assert.match(packager, /templates\/taskspace\/compose\.legacy-v1\.yaml/u);
});

test('schema-v1 Compose exposes the host maintenance fence read-only to the upgraded proxy', (t) => {
  const taskRoot = path.join(repoRoot, 'output/validation/legacy-template-fixture');
  const compose = renderProjectCompose(
    path.join(repoRoot, 'templates/taskspace/compose.legacy-v1.yaml'),
    'forge-test-task-legacy',
    {
      FORGE_BIND_ADDRESS: '127.0.0.1',
      PLATFORM_CONVERSATION_AUTH_ROOT: '/srv/forge-delivery/conversation-control-plane/auth',
      PROJECT_COMPOSE_NAME: 'forge-test',
      PROJECT_FTP_INPUT_ROOT: '/srv/forge-delivery/file-gateway/data/test',
      TASKSPACE_ACTOR_ID: 'test-owner',
      TASKSPACE_COMPOSE_PROJECT_NAME: 'forge-test-task-legacy',
      TASKSPACE_CONVERSATION_ID: 'legacy-conversation',
      TASKSPACE_HARNESS_PORT: '20001',
      TASKSPACE_ID: 'legacy',
      TASKSPACE_ROOT: taskRoot,
    },
  );
  if (compose === null) {
    t.skip('Docker Compose is unavailable');
    return;
  }
  const harness = compose.services.harness;
  assert.equal(harness.environment.HARNESS_MAINTENANCE_FENCE_FILE,
    '/run/forge-taskspace-maintenance/proxy-fence.json');
  const mounts = harness.volumes.filter((mount) => mount.target === '/run/forge-taskspace-maintenance');
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].type, 'bind');
  assert.equal(mounts[0].source.replaceAll('\\', '/'), path.join(taskRoot, 'maintenance').replaceAll('\\', '/'));
  assert.equal(mounts[0].read_only, true);
  assert.equal(mounts[0].bind?.create_host_path, false);
});

test('Harness core contains Node only and consumes the external Skills authority', async () => {
  const [dockerfile, repack, overlay, manifest, runtimePackage, runtimeLock] = await Promise.all([
    text('docker/harness/Dockerfile'),
    text('docker/harness/Dockerfile.repack'),
    text('docker/harness/Dockerfile.overlay'),
    text('docker/harness/image-build-inputs.json').then(JSON.parse),
    text('docker/harness/runtime-dependencies/package.json').then(JSON.parse),
    text('docker/harness/runtime-dependencies/package-lock.json').then(JSON.parse),
  ]);

  assert.match(dockerfile, /FROM \$\{HARNESS_MAVEN_BASE_IMAGE\} AS runtime-root/u);
  assert.match(dockerfile, /RUN rm -rf \/opt\/java \/usr\/share\/maven \/root\/\.m2[\s\S]*?FROM scratch AS harness-core[\s\S]*?COPY --from=runtime-root \/ \//u);
  assert.match(dockerfile, /! command -v java[\s\S]*?! command -v javac[\s\S]*?! command -v mvn[\s\S]*?! command -v pnpm/u);
  assert.match(dockerfile, /com\.forge-delivery\.harness-maven-base-manifest/u);

  assert.match(repack, /FROM \$\{HARNESS_REPACK_SOURCE_IMAGE\} AS runtime-root/u);
  assert.match(repack, /RUN --network=none[\s\S]*?--mount=type=bind[\s\S]*?FROM scratch AS harness-core/u);
  assert.match(repack, /offline-repack-receipt\.json/u);
  assert.match(repack, /assemblySourceImageId/u);
  assert.match(repack, /test ! -e \/opt\/forge-harness-runtime\/node_modules\/pnpm/u);
  assert.match(repack, /test ! -e \/usr\/local\/share\/dsh-skills/u);
  assert.doesNotMatch(repack, /apt-get|npm ci|docker\.sock/u);

  for (const source of [dockerfile, repack, overlay]) {
    assert.match(source, /DSH_BUNDLED_SKILL_DIR=\/opt\/forge-skill-bundles\/current\/skills/u);
    assert.doesNotMatch(source, /COPY(?:\s+--[^\n]+)?\s+docker\/harness\/skills(?:\/|\.catalog\.json)/u);
    assert.doesNotMatch(source, /^\s*MAVEN_(?:CONFIG|OPTS)=/mu);
    assert.doesNotMatch(source, /node_modules\/pnpm\/bin\/pnpm/u);
    for (const pnpmShim of [
      '/usr/local/lib/node_modules/corepack/shims/pnpm',
      '/usr/local/lib/node_modules/corepack/shims/pnpm.cmd',
      '/usr/local/lib/node_modules/corepack/shims/pnpm.ps1',
      '/usr/local/lib/node_modules/corepack/shims/nodewin/pnpm',
      '/usr/local/lib/node_modules/corepack/shims/nodewin/pnpm.cmd',
      '/usr/local/lib/node_modules/corepack/shims/nodewin/pnpm.ps1',
      '/usr/local/lib/node_modules/corepack/dist/pnpm.js',
    ]) {
      assert.match(source, new RegExp(pnpmShim.replaceAll('/', '\\/'), 'u'));
    }
  }

  assert.equal(runtimePackage.dependencies.pnpm, undefined);
  assert.equal(runtimeLock.packages[''].dependencies.pnpm, undefined);
  assert.equal(runtimeLock.packages['node_modules/pnpm'], undefined);
  assert.equal(manifest.dependencies.some((entry) => entry.name === 'pnpm'), false);
  assert.equal(manifest.mappings.some((entry) => entry.source === 'docker/harness/skills'
    || entry.source === 'docker/harness/skills.catalog.json'), false);
});

test('TaskSpace lifecycle validates current containment and injects the external root for existing TaskSpaces', async () => {
  const control = await text('scripts/taskspacectl.sh');
  assert.match(control, /validate_external_skill_bundle_root\(\)/u);
  assert.match(control, /current_real=.*readlink -f/u);
  assert.match(control, /"\$\{versions_real\}"\/\*/u);
  assert.match(control, /FORGE_SKILL_BUNDLE_ROOT=.*env_value FORGE_SKILL_BUNDLE_ROOT[\s\S]*?docker compose --env-file/u);
  assert.match(control, /validate_external_skill_bundle_root[\s\S]*?git clone --no-hardlinks/u);
});

test('host Runner is an external rollback unit while Broker keeps only the existing Unix capability', async () => {
  const override = await text('templates/project/compose.host-verification.yaml');
  const projectCompose = await text('templates/project/compose.yaml');
  const contract = JSON.parse(await text('templates/project/host-verification-contract.json.tpl'));
  const unit = await text('templates/systemd/forge-host-verification@.service');
  assert.match(override, /verification-runner:[\s\S]*?profiles:\s*\[legacy-container-verification\]/u);
  assert.match(projectCompose, /taskspace-broker:[\s\S]*?VERIFICATION_RUNNER_SOCKET:\s*\/run\/forge-verify\/runner\.sock/u);
  assert.match(projectCompose, /PROJECT_VERIFY_IPC_ROOT.*?:\/run\/forge-verify:ro/u);
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.executionMode, 'host-toolchain');
  assert.equal(contract.runnerRevision, 'forge-host-runner-__FORGE_HOST_RUNNER_BUNDLE_VERSION__');
  assert.equal(contract.profileCatalogVersion, '__FORGE_PHASE_PROFILE_CATALOG_VERSION__');
  assert.deepEqual(contract.profiles, [
    'governance', 'backend-red-test', 'frontend-red-test',
    'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck',
    'frontend-admin-build', 'frontend-h5-test', 'frontend-h5-build',
    'changed-safe', 'full-regression',
  ]);
  assert.equal(Object.keys(contract.toolchains).sort().join(','), 'forgeGovernance,git,java,javaHome,maven,node,pnpm');
  assert.match(unit, /ExecStart=__HOST_NODE_PATH__ __HOST_RUNNER_ROOT__\/current\/lib\/host-verification-runner\.mjs/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ReadOnlyPaths=__DELIVERY_ROOT__\/projects\/%i\/taskspaces/u);
  assert.doesNotMatch(unit, /docker\.sock|\/bin\/sh|-c\s/u);
});
