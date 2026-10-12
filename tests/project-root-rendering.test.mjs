import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { renderHostVerificationUnit } from '../scripts/render-host-verification-unit.mjs';

const read = (name) => readFile(path.resolve(name), 'utf8');

test('project creation binds environment and verification paths to the same installation root', async () => {
  const source = await read('scripts/create-project.sh');
  const envStart = source.indexOf('rendered_env="$(');
  const envEnd = source.indexOf('previous_umask=', envStart);
  const contractStart = source.indexOf('verification_contract="$(');
  const contractEnd = source.indexOf('printf', contractStart);
  assert.ok(envStart >= 0 && envEnd > envStart && contractStart >= 0 && contractEnd > contractStart);
  const producer = `${source.slice(envStart, envEnd)}\n${source.slice(contractStart, contractEnd)}`;
  const variables = [...producer.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?=[:}])/gu)].map((match) => match[1]);
  const defaults = [...new Set(variables)].filter((key) => !['REPO_ROOT', 'DELIVERY_ROOT'].includes(key))
    .map((key) => `${key}=fixture`);
  for (const root of ['/srv/forge-delivery', '/srv/forge-coverage-upgrade-b-20261001']) {
    const result = spawnSync('bash', ['-s'], {
      input: ['set -eu', ...defaults, 'REPO_ROOT="$FIXTURE_REPO_ROOT"', 'DELIVERY_ROOT="$FIXTURE_DELIVERY_ROOT"',
        'slug=coverage-upgrade-b', `harness_image_id=sha256:${'a'.repeat(64)}`,
        `harness_cache_image_id=${'a'.repeat(64)}`, producer,
        'printf "%s\\n---CONTRACT---\\n%s\\n" "$rendered_env" "$verification_contract"',
      ].join('\n'),
      env: { ...process.env, FIXTURE_REPO_ROOT: path.resolve('.').replaceAll('\\', '/'), FIXTURE_DELIVERY_ROOT: root },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const [environment, contractText] = result.stdout.split('\n---CONTRACT---\n');
    const values = Object.fromEntries(environment.split(/\r?\n/u).filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const project = `${root}/projects/coverage-upgrade-b`;
    assert.equal(values.PROJECT_ROOT, project);
    assert.equal(values.DELIVERY_ROOT, root);
    assert.equal(values.PROJECT_GIT_SSH_ROOT, `${root}/git-remotes/coverage-upgrade-b`);
    assert.equal(values.FORGE_SKILL_BUNDLE_ROOT, `${root}/skill-bundles`);
    assert.equal(values.PLATFORM_PROJECT_REGISTRY_FILE, `${root}/registry/projects.tsv`);
    assert.equal(values.CONVERSATION_MANAGER_SOCKET, `${root}/conversation-control-plane/projects/coverage-upgrade-b/ipc/manager.sock`);
    for (const [key, value] of Object.entries(values)) {
      if (/^PROJECT_(?:VERIFY|VERIFICATION_CONTRACT|ACCEPTANCE|RELEASE_IPC|CONVERSATION|SHARED_INPUT)/u.test(key)) {
        assert.ok(value.startsWith(`${project}/`), `${key} escaped project: ${value}`);
      }
    }
    assert.ok(!environment.includes('__DELIVERY_ROOT__'));
    if (root !== '/srv/forge-delivery') assert.ok(!environment.includes('/srv/forge-delivery'));
    const contract = JSON.parse(contractText);
    assert.equal(contract.projectSlug, 'coverage-upgrade-b');
    assert.equal(contract.stateRoot, values.PROJECT_VERIFY_STATE_ROOT);
    assert.equal(contract.cacheRoot, `${values.PROJECT_VERIFY_CACHE_ROOT}/images/${'a'.repeat(64)}`);
    assert.equal(contract.toolchainImage, values.HARNESS_IMAGE);
  }
});

test('Host contract and service unit select the same default or isolated project directories', async () => {
  const template = await read('templates/project/host-verification-contract.json.tpl');
  for (const root of ['/srv/forge-delivery', '/srv/forge-coverage-upgrade-b-20261001']) {
    const contract = JSON.parse(template.replaceAll('__DELIVERY_ROOT__', root).replaceAll('__PROJECT_SLUG__', 'coverage-upgrade-b'));
    const unit = (await renderHostVerificationUnit({ deliveryRoot: root, deliveryOwner: 'forge', deliveryGroup: 'forge',
      hostNodePath: '/opt/node/bin/node', hostRunnerRoot: '/opt/forge-host-runner',
    })).replaceAll('%i', 'coverage-upgrade-b');
    assert.equal(contract.taskspacesRoot, `${root}/projects/coverage-upgrade-b/taskspaces`);
    assert.equal(contract.stateRoot, `${root}/projects/coverage-upgrade-b/verification/host-state`);
    assert.ok(unit.includes(`ReadOnlyPaths=${contract.taskspacesRoot}\n`));
    assert.ok(unit.includes(`WorkingDirectory=${path.posix.dirname(contract.stateRoot)}\n`));
    assert.ok(unit.includes(`ReadWritePaths=${path.posix.dirname(contract.stateRoot)}\n`));
  }
});
