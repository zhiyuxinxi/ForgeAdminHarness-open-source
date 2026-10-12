// Root executes this only in the candidate image, with a private DB config mount.
// This program starts its own temporary Unix listener and only reads business data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';

process.umask(0o077);
const [preparationPath, configPath, imageId] = process.argv.slice(2);
assert(preparationPath && configPath && /^sha256:[a-f0-9]{64}$/.test(imageId ?? ''),
  'Require preparation manifest, private DB config, and the immutable image ID used by docker run');
const preparation = JSON.parse(await readFile(preparationPath, 'utf8'));
const changed = Object.entries(preparation.imageFiles).filter(([filename]) =>
  /delivery-center|conversation-gateway|taskspace-broker\.mjs|forge-harness-runtime\/package/.test(filename));
assert(changed.length >= 12);
for (const [filename, expected] of changed) {
  const bytes = await readFile(filename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, filename);
  const mode = (await lstat(filename)).mode & 0o777;
  assert.equal(mode & 0o022, 0, 'Installed public source cannot be group/world writable');
}
for (const name of ['config', 'http', 'service', 'store', 'projection', 'import', 'release-snapshot', 'assets', 'asset-projection', 'diagrams'])
  await import(`/usr/local/lib/delivery-center-${name}.mjs`);
await import('/usr/local/lib/taskspace-broker.mjs');
const require = createRequire('/usr/local/lib/delivery-center-store.mjs');
assert.equal(require('mysql2/package.json').version, '3.24.5');
assert.equal(typeof require('mysql2/promise').createPool, 'function');
assert.match(await readFile('/usr/local/share/conversation-gateway/index.html', 'utf8'), /\/forge-gateway\/delivery-center/);
const { readDeliveryDatabaseConfig } = await import('/usr/local/lib/delivery-center-config.mjs');
const { createDeliveryCenterPool, DeliveryCenterStore } = await import('/usr/local/lib/delivery-center-store.mjs');
const { createDeliveryReadServer, createDeliveryCenterClient } = await import('/usr/local/lib/delivery-center-service.mjs');
const pool = createDeliveryCenterPool(await readDeliveryDatabaseConfig(configPath));
let selects = 0;
const readPool = {
  execute(sql, params) { assert.match(sql.trim(), /^SELECT\s/i); selects++; return pool.execute(sql, params); },
  async getConnection() {
    const connection = await pool.getConnection();
    return {
      execute(sql, params) {
        if (sql !== 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') {
          assert.match(sql.trim(), /^SELECT\s/i); selects++;
        }
        return connection.execute(sql, params);
      },
      beginTransaction() { return connection.beginTransaction(); },
      commit() { return connection.commit(); },
      rollback() { return connection.rollback(); },
      release() { return connection.release(); },
    };
  },
};
const store = new DeliveryCenterStore({ pool: readPool });
const directory = await mkdtemp('/tmp/delivery-center-installed-');
const socketPath = path.join(directory, 'reader.sock');
const server = createDeliveryReadServer({ store, projectSlug: 'forge-base' });
try {
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  const client = createDeliveryCenterClient({ socketPath });
  assert.deepEqual((await client.listProjects()).map((project) => project.slug), ['forge-base']);
  const overview = await client.overview('forge-base');
  assert.equal(overview.project.slug, 'forge-base');
  const [menus, requirements, stages, releases, artifacts] = await Promise.all([
    client.listMenus('forge-base'), client.listRequirements('forge-base', { pageSize: 1 }),
    client.listStages('forge-base', { pageSize: 1 }), client.listReleases('forge-base', { pageSize: 1 }),
    client.listArtifacts('forge-base', { pageSize: 1 }),
  ]);
  assert(requirements.total > 0 && stages.total > 0, 'Expected real imported business evidence');
  assert(releases.total > 0, 'Expected real retained release history');
  await client.getRequirement('forge-base', requirements.items[0].id);
  const assetPage = await client.listAssets('forge-base', { kind: 'page', pageSize: 1 });
  assert(Array.isArray(assetPage.items) && Number.isInteger(assetPage.total));
  if (assetPage.items.length) {
    const asset = await client.getAsset('forge-base', assetPage.items[0].assetId);
    assert(asset && Array.isArray(asset.revisions) && Array.isArray(asset.usedByMenus));
  }
  const release = await client.getRelease('forge-base', releases.items[0].id);
  assert(release && release.id === releases.items[0].id);
  const historical = await client.listRequirements('forge-base', { releaseId: release.id, pageSize: 1 });
  if (release.scopeBinding === 'unknown') assert.equal(historical.total, 0);
  const exported = await client.exportRequirements('forge-base');
  assert.equal(exported.length, requirements.total);
  process.stdout.write(JSON.stringify({ ok: true, status: 'passed', project: 'forge-base', sourceCommit: preparation.sourceCommit,
    imageId, moduleHashes: Object.fromEntries(changed),
    installedFiles: changed.length, mysql2: '3.24.5', unixTransport: true, readOnlyStatements: selects,
    menus: menus.length, requirements: requirements.total, stages: stages.total, releases: releases.total,
    artifacts: artifacts.total, inspectedReleaseScope: release.scopeBinding, historicalRequirements: historical.total,
    exports: exported.length, assetsQueryVerified: true, pageAssets: assetPage.total,
    businessWrites: 0, modelRequests: 0 }) + '\n');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
