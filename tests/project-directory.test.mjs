import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  RegistryProjectDirectory,
  parseProjectRegistry,
} from '../docker/harness/project-directory.mjs';

const header = 'slug\tdisplay_name\tui_port\tharness_port\tforge_ref\tforge_commit\tcreated_at\tproject_kind\tmysql_database\tmysql_test_database\tredis_database\tredis_test_database';
const commit = '1'.repeat(40);

test('project registry exposes safe project catalog fields without database identities', () => {
  const projects = parseProjectRegistry(`${header}\nforge-base\tForge Base\t18080\t13080\tfoundation-a\t${commit}\t2026-08-28T10:00:00+08:00\tfoundation\tdb\tdb_test\t1\t2\nforge-client\t客户交付项目\t18081\t\tproject-b\t${commit}\t2026-08-28T11:00:00+08:00\treplica\tdb2\tdb2_test\t3\t4\n`);
  assert.deepEqual(projects.map(({ slug, displayName, uiPort, legacyHarnessPort, projectKind }) => ({ slug, displayName, uiPort, legacyHarnessPort, projectKind })), [
    { slug: 'forge-base', displayName: 'Forge Base', uiPort: 18080, legacyHarnessPort: 13080, projectKind: 'foundation' },
    { slug: 'forge-client', displayName: '客户交付项目', uiPort: 18081, legacyHarnessPort: null, projectKind: 'replica' },
  ]);
  assert.equal('mysqlDatabase' in projects[0], false);
});

test('project registry rejects duplicate identities and capability paths remain scoped', () => {
  assert.throws(() => parseProjectRegistry(`${header}\nforge-base\tA\t18080\t13080\tf\t${commit}\t2026-08-28T10:00:00Z\tfoundation\td\tdt\t1\t2\nforge-base\tB\t18081\t13081\tf\t${commit}\t2026-08-28T10:00:00Z\treplica\td2\td2t\t3\t4\n`), /invalid or duplicate slug/);
  const directory = new RegistryProjectDirectory({ registryPath: path.resolve('registry.tsv'), capabilityRoot: path.resolve('capabilities') });
  const value = directory.capabilityPaths('forge-base');
  assert.equal(value.socketPath, path.join(path.resolve('capabilities'), 'forge-base', 'ipc', 'manager.sock'));
  assert.throws(() => directory.capabilityPaths('../escape'), /slug is invalid/);
});
