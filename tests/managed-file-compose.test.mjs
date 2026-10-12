import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { managedFileCompose } from '../scripts/lib/managed-file-compose.mjs';

test('registered targets survive initial and repeated template upgrades without granting other mounts', async () => {
  const template = (await readFile(new URL('../templates/project/compose.yaml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const actor = '1cbd605d-4a7d-40f4-a9be-020b1b2a7341';
  const config = { schemaVersion: 1, projectSlug: 'forge-base', targets: [{
    targetId: 'proof', name: 'proof', transport: 'local',
    serverDirectory: '/srv/forge-delivery/file-gateway/data/forge-base/proof',
    expectedDevice: 1, expectedInode: 2, readActorIds: [actor], writeActorIds: [actor],
  }] };
  const initial = managedFileCompose(template, config, 'forge-base');
  assert.equal(initial.match(/target: "\/run\/forge-managed-files\/targets\/proof"/gu)?.length, 1);
  assert.equal(managedFileCompose(initial, config, 'forge-base'), initial);
  assert.equal(managedFileCompose(initial, config, 'forge-base', true), template);
  const upgrade = template.replace('cpus: "2.0"', 'cpus: "2.5"');
  const upgraded = managedFileCompose(upgrade, config, 'forge-base');
  assert.equal(managedFileCompose(upgraded, config, 'forge-base', true), upgrade);
  assert.ok(upgraded.includes('cpus: "2.5"'));
  const target = upgraded.indexOf('/run/forge-managed-files/targets/proof');
  assert.ok(target > upgraded.indexOf('  taskspace-broker:\n'));
  assert.equal(upgraded.match(/target: \/etc\/forge-managed-files\/targets.json\n        read_only: true/gu)?.length, 2);
  assert.equal(managedFileCompose(template, { ...config, targets: [] }, 'forge-base'), template);
  assert.throws(() => managedFileCompose(template, config, 'demoteam-phase2'), /configuration/u);
  assert.throws(() => managedFileCompose(initial.replace('file-gateway/data/forge-base/proof', 'projects/another'), config, 'forge-base', true), /differs/u);
  assert.throws(() => managedFileCompose(template, { ...config, targets: [{ ...config.targets[0], serverDirectory: '/srv/forge-delivery/projects/another' }] }, 'forge-base'), /excluded/u);
  const upgradeScript = await readFile(new URL('../scripts/upgrade-forge-delivery-toolkit.sh', import.meta.url), 'utf8');
  assert.match(upgradeScript, /if \[\[ -z "\$\{registry\}" \]\]; then\s+release_contract_render_project_compose/u);
  assert.match(upgradeScript, /project_target_compose_hash\["\$\{slug\}"\]="\$\(render_project_compose_with_managed_files/u);
  assert.match(upgradeScript, /render_project_compose_with_managed_files [\\\r\n\s]+"\$\{slug\}" "\$\{project_compose_application_services_json\[\$\{slug\}\]\}" >"\$\{staged_compose\}"/u);
});
