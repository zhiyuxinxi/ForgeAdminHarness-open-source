import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  findForbiddenSql,
  parseFlywayMigrationPath,
  validateComposeModel,
  validateFlywayMigrationInventory,
  validateReleaseRequest,
  validateRuntimeContract,
} from '../docker/harness/release-policy.mjs';
import {
  ControlledReleaseRunner,
  createReleaseRunnerServer,
  sanitizeDiagnosticText,
} from '../docker/harness/release-runner.mjs';
import { createTaskspaceBrokerServer } from '../docker/harness/taskspace-broker.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { resolveTaskspaceTransport } = require('../docker/harness/forge-release');

const protectedFiles = [
  'docker-forge-admin/Dockerfile.admin',
  'docker-forge-admin/Dockerfile.app',
  'docker-forge-admin/Dockerfile.flow',
  'docker-forge-admin/Dockerfile.ui',
  'docker-forge-admin/application-datasource.yml',
  'docker-forge-admin/docker-compose.yml',
  'docker-forge-admin/nginx.conf',
].map((relativePath, index) => ({
  relativePath,
  sha256: String(index + 1).repeat(64),
}));

const threeServiceProtectedFiles = protectedFiles.filter(
  (item) => item.relativePath !== 'docker-forge-admin/Dockerfile.app',
);

function runtimeContract() {
  const projectRoot = '/srv/forge-delivery/projects/demo-project';
  return {
    schemaVersion: 3,
    projectSlug: 'demo-project',
    composeProjectName: 'forge-demo-project',
    projectRoot,
    workspaceRoot: `${projectRoot}/workspace`,
    infrastructure: {
      mysql: {
        mode: 'shared-external',
        host: 'mysql.internal',
        port: 3306,
        database: 'forge_demo_project',
        testDatabase: 'forge_demo_project_test',
        provisioningAllowed: false,
      },
      redis: {
        mode: 'shared-external',
        host: 'redis.internal',
        port: 6379,
        database: 2,
        testDatabase: 15,
        provisioningAllowed: false,
      },
    },
    release: {
      fixedComposeFile: `${projectRoot}/ops/compose.yaml`,
      allowedComposeServices: [
        'forge-admin',
        'forge-app',
        'forge-flow',
        'forge-ui',
        'release-runner',
        'taskspace-broker',
        'conversation-manager',
        'protected-acceptance',
        'verification-runner',
      ],
      allowedReleaseServices: ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'],
      protectedFiles,
      databaseProvisioningAllowed: false,
      workspaceComposeAllowed: false,
      testDatabaseLifecycle: {
        mode: 'snapshot-restore-on-failure',
        backupRequired: true,
        restoreOnFailure: true,
        fullReplaySupported: false,
        operatorImage: `mysql:8.0@sha256:${'a'.repeat(64)}`,
        backupRoot: `${projectRoot}/backups/test-database-snapshots`,
        recoveryStateFile: `${projectRoot}/ops/test-database-recovery.json`,
      },
    },
  };
}

function composeModel() {
  return {
    services: Object.fromEntries(
      runtimeContract().release.allowedComposeServices.map((name) => [name, {
        image: `forge-demo-project/${name}:reviewed`,
      }]),
    ),
  };
}

test('protected candidate approval validates one existing pin and exact commit', () => {
  const contract = structuredClone(runtimeContract());
  const approval = {
    candidateCommit: 'a'.repeat(40),
    relativePath: 'docker-forge-admin/Dockerfile.admin',
    beforeSha256: contract.release.protectedFiles[0].sha256,
    sha256: 'f'.repeat(64),
  };
  assert.equal(validateRuntimeContract(contract), contract);
  contract.release.protectedCandidateApproval = approval;
  assert.equal(validateRuntimeContract(contract), contract);
  for (const invalid of [
    null,
    { ...approval, candidateCommit: 'a'.repeat(39) },
    { ...approval, relativePath: 'docker-forge-admin/../Dockerfile.admin' },
    { ...approval, relativePath: 'forge-server/pom.xml' },
    { ...approval, beforeSha256: 'b'.repeat(64) },
    { ...approval, sha256: 'f'.repeat(63) },
    { ...approval, files: [] },
  ]) {
    const candidate = structuredClone(contract);
    candidate.release.protectedCandidateApproval = invalid;
    assert.throws(() => validateRuntimeContract(candidate), /protected candidate approval/i);
  }
  assert.throws(() => validateReleaseRequest({
    action: 'release', services: ['forge-admin'], approvalRef: 'Owner release',
    protectedCandidateApproval: approval,
  }, contract), /field/i, 'A caller cannot put this platform-only approval in a release request.');
});

test('runtime contract requires fixed external infrastructure and isolated test stores', () => {
  assert.equal(validateRuntimeContract(runtimeContract()).projectSlug, 'demo-project');

  for (const requiredService of ['conversation-manager', 'protected-acceptance', 'verification-runner']) {
    const missingRequiredService = runtimeContract();
    missingRequiredService.release.allowedComposeServices =
      missingRequiredService.release.allowedComposeServices.filter(
        (service) => service !== requiredService,
      );
    assert.throws(
      () => validateRuntimeContract(missingRequiredService),
      /allowedComposeServices does not match/,
    );
  }

  const sameRedisDatabase = runtimeContract();
  sameRedisDatabase.infrastructure.redis.testDatabase = 2;
  assert.throws(
    () => validateRuntimeContract(sameRedisDatabase),
    /runtime and test databases must differ/,
  );

  const provisioningEnabled = runtimeContract();
  provisioningEnabled.infrastructure.mysql.provisioningAllowed = true;
  assert.throws(
    () => validateRuntimeContract(provisioningEnabled),
    /provisioning disabled/,
  );

  const unpinnedOperator = runtimeContract();
  unpinnedOperator.release.testDatabaseLifecycle.operatorImage = 'mysql:8.0';
  assert.throws(
    () => validateRuntimeContract(unpinnedOperator),
    /operator image is invalid/,
  );

  const threeService = runtimeContract();
  threeService.release.allowedReleaseServices = ['forge-admin', 'forge-flow', 'forge-ui'];
  threeService.release.protectedFiles = threeServiceProtectedFiles;
  assert.equal(validateRuntimeContract(threeService).release.protectedFiles.length, 6);

  const threeServiceWithAppDockerfile = structuredClone(threeService);
  threeServiceWithAppDockerfile.release.protectedFiles.push({
    relativePath: 'docker-forge-admin/Dockerfile.app', sha256: 'b'.repeat(64),
  });
  assert.throws(
    () => validateRuntimeContract(threeServiceWithAppDockerfile),
    /protectedFiles does not match/,
  );

  const fourServiceMissingAppDockerfile = runtimeContract();
  fourServiceMissingAppDockerfile.release.protectedFiles = fourServiceMissingAppDockerfile.release.protectedFiles
    .filter((item) => item.relativePath !== 'docker-forge-admin/Dockerfile.app');
  assert.throws(
    () => validateRuntimeContract(fourServiceMissingAppDockerfile),
    /protectedFiles does not match/,
  );

  const unsupportedReleaseSet = runtimeContract();
  unsupportedReleaseSet.release.allowedReleaseServices = ['forge-admin', 'forge-ui'];
  assert.throws(
    () => validateRuntimeContract(unsupportedReleaseSet),
    /allowedReleaseServices does not match a reviewed/,
  );
});

test('compose policy rejects infrastructure images and forbidden published host ports', () => {
  assert.deepEqual(validateComposeModel(composeModel(), runtimeContract()).services, [
    'conversation-manager',
    'forge-admin',
    'forge-app',
    'forge-flow',
    'forge-ui',
    'protected-acceptance',
    'release-runner',
    'taskspace-broker',
    'verification-runner',
  ]);

  const databaseImage = composeModel();
  databaseImage.services['forge-admin'].image = 'mysql:8.4';
  assert.throws(
    () => validateComposeModel(databaseImage, runtimeContract()),
    /Forbidden infrastructure image/,
  );

  const shortPort = composeModel();
  shortPort.services['forge-ui'].ports = ['127.0.0.1:3306:80'];
  assert.throws(
    () => validateComposeModel(shortPort, runtimeContract()),
    /Forbidden database\/cache port 3306/,
  );

  const structuredPort = composeModel();
  structuredPort.services['forge-ui'].ports = [{ target: 80, published: '6379' }];
  assert.throws(
    () => validateComposeModel(structuredPort, runtimeContract()),
    /Forbidden database\/cache port 6379/,
  );
});

test('PC-only Compose matches its three-service contract without weakening the mobile contract', () => {
  const pcOnly = runtimeContract();
  pcOnly.release.allowedReleaseServices = ['forge-admin', 'forge-flow', 'forge-ui'];
  pcOnly.release.protectedFiles = threeServiceProtectedFiles;
  assert.doesNotThrow(() => validateComposeModel(composeModel(), pcOnly), 'legacy PC releases may retain the reviewed four-service Compose');

  pcOnly.release.allowedComposeServices = pcOnly.release.allowedComposeServices.filter((service) => service !== 'forge-app');
  const pcModel = composeModel();
  delete pcModel.services['forge-app'];
  assert.deepEqual(validateComposeModel(pcModel, pcOnly).services, [...pcOnly.release.allowedComposeServices].sort());
  assert.throws(() => validateComposeModel(composeModel(), pcOnly), /Compose services differ from the contract/);

  const mobileMissingApp = runtimeContract();
  mobileMissingApp.release.allowedComposeServices = [...pcOnly.release.allowedComposeServices];
  assert.throws(() => validateRuntimeContract(mobileMissingApp), /allowedComposeServices does not match/);
  for (const service of ['conversation-manager', 'protected-acceptance', 'verification-runner']) {
    const missingControl = structuredClone(pcOnly);
    missingControl.release.allowedComposeServices = missingControl.release.allowedComposeServices.filter((name) => name !== service);
    assert.throws(() => validateRuntimeContract(missingControl), /allowedComposeServices does not match/);
  }
});

test('mobile application releases require same-origin H5 and App API smoke probes', async () => {
  const runner = new ControlledReleaseRunner({
    contractPath: '/project-runtime/contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  const requested = [];
  runner.fetch = async (url) => {
    requested.push(new URL(url).pathname);
    return { status: 200 };
  };

  const smoke = await runner.waitForUi(true);

  assert.deepEqual(requested, [
    '/forge/login',
    '/forge-api/auth/captcha',
    '/forge-h5/',
    '/forge-h5-api/auth/captcha',
  ]);
  assert.deepEqual(smoke.probes.map(({ name }) => name), [
    'ui',
    'api',
    'mobile-ui',
    'mobile-api',
  ]);
});

test('release requests expose only bounded project application actions', () => {
  assert.deepEqual(
    validateReleaseRequest({ action: 'diagnose' }, runtimeContract()),
    { action: 'diagnose', services: [] },
  );
  assert.deepEqual(
    validateReleaseRequest({ action: 'contract' }, runtimeContract()),
    { action: 'contract', services: [] },
  );
  assert.deepEqual(
    validateReleaseRequest({
      action: 'release',
      services: ['forge-admin', 'forge-ui'],
      approvalRef: 'Owner approved release in the active conversation.',
    }, runtimeContract()),
    {
      action: 'release',
      services: ['forge-admin', 'forge-ui'],
      approvalRef: 'Owner approved release in the active conversation.',
      version: undefined,
    },
  );
  for (const controlService of ['release-runner', 'protected-acceptance', 'verification-runner']) {
    assert.throws(
      () => validateReleaseRequest({
        action: 'release',
        services: [controlService],
        approvalRef: 'Owner approved release.',
      }, runtimeContract()),
      /service is not allowed/,
    );
  }
  assert.throws(
    () => validateReleaseRequest({ action: 'preflight', command: 'docker ps' }, runtimeContract()),
    /unexpected fields/,
  );
  const provenance = {
    source: 'taskspace',
    taskId: 'task-alpha',
    actorId: 'developer.one',
    conversationId: 'conversation:2026-08-27',
    candidateCommit: 'a'.repeat(40),
  };
  assert.deepEqual(
    validateReleaseRequest({
      action: 'release',
      services: ['forge-admin'],
      approvalRef: 'Owner approved the TaskSpace candidate.',
      provenance,
    }, runtimeContract()).provenance,
    provenance,
  );
  assert.throws(
    () => validateReleaseRequest({
      action: 'release',
      services: ['forge-admin'],
      approvalRef: 'Owner approved the TaskSpace candidate.',
      provenance: { ...provenance, candidateCommit: 'not-a-commit' },
    }, runtimeContract()),
    /candidateCommit is invalid/,
  );
  assert.throws(
    () => validateReleaseRequest({
      action: 'release',
      services: ['forge-admin'],
      approvalRef: 'Owner approved the TaskSpace candidate.',
      provenance: { ...provenance, operator: 'root' },
    }, runtimeContract()),
    /unexpected fields/,
  );
});

test('Flyway inventory enforces unique forward-only immutable versions', () => {
  const released = [
    'forge-server/db/migration/V1.0.142__released.sql',
    'forge-server/db/migration/V1.0.143__released.sql',
    'forge-server/db/migration/R__refresh_view.sql',
  ];
  const current = [
    ...released,
    'forge-server/db/migration/V1.0.144__menu_hierarchy.sql',
  ];
  assert.deepEqual(validateFlywayMigrationInventory(current, released), {
    totalFiles: 4,
    versionedFiles: 3,
    repeatableFiles: 1,
    releasedVersion: '1.0.143',
    latestVersion: '1.0.144',
    newVersions: ['1.0.144'],
  });
  assert.equal(parseFlywayMigrationPath('db/V1_0_144__menu.sql').versionKey, '1.0.144');

  const tenDigitMigration = 'forge-server/db/migration/V1.0.2026100903__secure_message_management_resources.sql';
  const tenDigitReleased = ['forge-server/db/migration/V1.0.2026100902__previous.sql'];
  const tenDigitCurrent = [...tenDigitReleased, tenDigitMigration];
  assert.deepEqual(parseFlywayMigrationPath(tenDigitMigration).versionParts, [1, 0, 2026100903]);
  const maximumPart = parseFlywayMigrationPath('db/V9999999999__maximum_supported_part.sql').versionParts[0];
  assert.equal(maximumPart, 9999999999);
  assert.ok(Number.isSafeInteger(maximumPart));
  assert.deepEqual(validateFlywayMigrationInventory(tenDigitCurrent, tenDigitReleased), {
    totalFiles: 2,
    versionedFiles: 2,
    repeatableFiles: 0,
    releasedVersion: '1.0.2026100902',
    latestVersion: '1.0.2026100903',
    newVersions: ['1.0.2026100903'],
  });
  for (const invalid of [
    'db/V10000000000__eleven_digit_part.sql',
    'db/V1.0.10000000000__eleven_digit_later_part.sql',
    'db/V1.0.202610090x__non_numeric_part.sql',
  ]) {
    assert.throws(() => parseFlywayMigrationPath(invalid),
      (error) => error.code === 'MIGRATION_NAME_INVALID', invalid);
  }
  assert.throws(
    () => validateFlywayMigrationInventory([
      ...tenDigitCurrent,
      'forge-server/db/migration/V1_0_2026100903__duplicate.sql',
    ], tenDigitReleased),
    (error) => error.code === 'MIGRATION_VERSION_CONFLICT' && error.details.files.length === 2,
  );
  assert.throws(
    () => validateFlywayMigrationInventory([
      ...tenDigitCurrent,
      'forge-server/db/migration/V1.0.2026100901__late_backfill.sql',
    ], tenDigitReleased),
    (error) => error.code === 'MIGRATION_VERSION_NOT_FORWARD',
  );
  assert.throws(
    () => validateFlywayMigrationInventory([
      ...tenDigitReleased,
      'forge-server/db/migration/V1.0.2026100903__renamed.sql',
    ], tenDigitCurrent),
    (error) => error.code === 'MIGRATION_HISTORY_IMMUTABLE',
  );

  assert.throws(
    () => validateFlywayMigrationInventory([
      ...current,
      'forge-server/db/migration/V1_0_144__duplicate.sql',
    ], released),
    (error) => error.code === 'MIGRATION_VERSION_CONFLICT'
      && error.details.files.length === 2,
  );
  assert.throws(
    () => validateFlywayMigrationInventory([
      ...released,
      'forge-server/db/migration/V1.0.140__late_backfill.sql',
    ], released),
    (error) => error.code === 'MIGRATION_VERSION_NOT_FORWARD',
  );
  assert.throws(
    () => validateFlywayMigrationInventory(current.slice(1), released),
    (error) => error.code === 'MIGRATION_HISTORY_IMMUTABLE',
  );
});

test('Flyway ten-digit segments accept the applied date sequence without losing numeric precision', () => {
  const applied = parseFlywayMigrationPath('db/V1.0.2026100903__message.sql');
  assert.deepEqual(applied.versionParts, [1, 0, 2026100903]);
  assert.equal(applied.versionKey, '1.0.2026100903');
  const maximum = parseFlywayMigrationPath('db/V9999999999__maximum.sql');
  assert.equal(maximum.versionParts[0], 9999999999);
  assert.ok(Number.isSafeInteger(maximum.versionParts[0]));
});

test('Flyway ten-digit segments preserve eleven-digit rejection and the sixteen-part limit', () => {
  const sixteen = Array(16).fill('2026100903').join('.');
  assert.equal(parseFlywayMigrationPath(`db/V${sixteen}__allowed.sql`).versionParts.length, 16);
  for (const version of ['20261009030', '1.0.20261009030', `${sixteen}.1`]) {
    assert.throws(() => parseFlywayMigrationPath(`db/V${version}__rejected.sql`),
      error => error.code === 'MIGRATION_NAME_INVALID');
  }
});

test('Flyway ten-digit segments retain numeric forward ordering against eight-digit dates', () => {
  const original = 'db/V1.0.20261017__original.sql';
  const applied = 'db/V1.0.2026100903__message.sql';
  const next = 'db/V1.0.2026100907__resubmit.sql';
  assert.deepEqual(validateFlywayMigrationInventory([original, applied], [original]).newVersions,
    ['1.0.2026100903']);
  assert.deepEqual(validateFlywayMigrationInventory([applied, next], [applied]).newVersions,
    ['1.0.2026100907']);
  assert.throws(() => validateFlywayMigrationInventory([
    applied, 'db/V1.0.20261018__older_numeric_version.sql',
  ], [applied]), error => error.code === 'MIGRATION_VERSION_NOT_FORWARD');
});

test('Flyway ten-digit segments still reject normalized duplicate aliases', () => {
  const applied = 'db/V1.0.2026100903__message.sql';
  for (const alias of ['1_0_2026100903', '1-0-2026100903', '01.00.2026100903.0']) {
    assert.throws(() => validateFlywayMigrationInventory([
      applied, `db/V${alias}__duplicate.sql`,
    ], [applied]), error => error.code === 'MIGRATION_VERSION_CONFLICT'
      && error.details.version === '1.0.2026100903');
  }
});

test('Flyway ten-digit released migrations remain immutable by path', () => {
  const applied = 'db/V1.0.2026100903__message.sql';
  assert.deepEqual(validateFlywayMigrationInventory([applied], [applied]).newVersions, []);
  for (const current of [[], ['db/V1.0.2026100903__renamed.sql'], ['db/V1.0.20261018__message.sql']]) {
    assert.throws(() => validateFlywayMigrationInventory(current, [applied]),
      error => error.code === 'MIGRATION_HISTORY_IMMUTABLE'
        && error.details.files.includes(applied));
  }
});

test('migration policy rejects server administration and destructive schema changes', () => {
  for (const sql of [
    'CREATE DATABASE customer_shadow;',
    'DROP SCHEMA customer_shadow;',
    "CREATE USER 'operator'@'%';",
    "GRANT ALL ON *.* TO 'operator'@'%';",
    'SET GLOBAL max_connections = 2048;',
    'DROP TABLE IF EXISTS business_order;',
    'TRUNCATE TABLE business_order;',
    'DROP INDEX uk_order_code ON business_order;',
    'ALTER TABLE business_order DROP COLUMN customer_name;',
  ]) {
    assert.ok(findForbiddenSql(sql), sql);
  }
  assert.equal(findForbiddenSql('CREATE TABLE business_order (id bigint primary key);'), null);
  assert.equal(findForbiddenSql('-- Grant the publish permission to the delivery role.\nCREATE TABLE role_permission (id bigint);'), null);
  assert.equal(findForbiddenSql('/* DROP DATABASE is documented here only. */\nALTER TABLE project_ledger ADD COLUMN code varchar(64);'), null);
  assert.equal(findForbiddenSql("SELECT 'DROP TABLE business_order is forbidden';"), null);
  assert.equal(findForbiddenSql("INSERT INTO audit_log(message) VALUES ('CREATE DATABASE is forbidden');"), null);
  assert.ok(findForbiddenSql("SELECT '-- still a string'; GRANT SELECT ON *.* TO 'operator'@'%';"));
});

test('test migration readiness accumulates validation and startup evidence across log polls', async () => {
  let logPoll = 0;
  const runner = new ControlledReleaseRunner({
    contractPath: '/project-runtime/contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    delay: async () => undefined,
  });
  runner.command = async (command, args) => {
    assert.equal(command, 'docker');
    if (args[0] === 'inspect') {
      return { code: 0, output: '{"Running":true}' };
    }
    if (args[0] === 'logs') {
      logPoll += 1;
      if (logPoll === 1) {
        return { code: 0, output: 'Successfully validated 141 migrations' };
      }
      return { code: 0, output: 'Started ForgeAdminApplication in 17.729 seconds' };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  await runner.waitForTestMigration('forge-demo-release-test');
  assert.equal(logPoll, 2);
});

test('migration readiness recovers startup markers buried beyond the sampled log tail', async (t) => {
  const validation = 'Successfully validated 212 migrations';
  const startup = 'Started ForgeAdminApplication in 66.781 seconds';
  const burst = Array.from({ length: 350 }, (_, index) => `migration detail ${index}`);
  for (const [name, lines, running, expectedCode] of [
    ['validation buried before visible startup', [validation, ...burst, startup], true, null],
    ['both markers buried', [validation, startup, ...burst], true, null],
    ['buried markers cannot approve an exited container', [validation, startup, ...burst], false, 'MIGRATION_EXECUTION_FAILED'],
    ['buried failure still rejects startup', [validation, 'FlywayException: migration execution failed', startup, ...burst], true, 'MIGRATION_EXECUTION_FAILED'],
  ]) {
    await t.test(name, async () => {
      const runner = new ControlledReleaseRunner({
        contractPath: '/project-runtime/contract.json',
        projectRoot: '/srv/forge-delivery/projects/demo-project',
        delay: async () => assert.fail('History must resolve this startup result without another poll.'),
      });
      const logCalls = [];
      runner.command = async (command, args) => {
        assert.equal(command, 'docker');
        if (args[0] === 'inspect') return { code: 0, output: JSON.stringify({ Running: running, ExitCode: 0 }) };
        assert.equal(args[0], 'logs');
        assert.equal(args.at(-1), 'forge-demo-release-test');
        logCalls.push(args);
        return { code: 0, output: (args.includes('--tail') ? lines.slice(-300) : lines).join('\n') };
      };
      if (expectedCode) {
        await assert.rejects(runner.waitForTestMigration('forge-demo-release-test'),
          (error) => error.code === expectedCode && error.stage === 'test-database-migration');
      } else {
        await runner.waitForTestMigration('forge-demo-release-test');
      }
      assert.deepEqual(logCalls, [
        ['logs', '--tail', '300', 'forge-demo-release-test'],
        ['logs', 'forge-demo-release-test'],
      ]);
    });
  }
  await t.test('history is refreshed at a bounded interval if both later markers are buried', async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    let historyReads = 0;
    const runner = new ControlledReleaseRunner({
      contractPath: '/project-runtime/contract.json',
      projectRoot: '/srv/forge-delivery/projects/demo-project',
      delay: async () => { now += 2000; assert.ok(now <= 31_000); },
    });
    runner.command = async (_command, args) => {
      if (args[0] === 'inspect') return { code: 0, output: '{"Running":true}' };
      if (args.includes('--tail')) return { code: 0, output: burst.slice(-300).join('\n') };
      historyReads += 1;
      return { code: 0, output: (historyReads === 1 ? burst : [validation, startup, ...burst]).join('\n') };
    };
    await runner.waitForTestMigration('forge-demo-release-test');
    assert.equal(historyReads, 2);
    assert.equal(now, 31_000);
  });
});

test('startup success logs cannot approve a stopped or invalid candidate container', async (t) => {
  for (const [name, state, expectedCode] of [
    ['crashed after startup', JSON.stringify({ Running: false, ExitCode: 1 }), 'MIGRATION_EXECUTION_FAILED'],
    ['exited after startup', JSON.stringify({ Running: false, ExitCode: 0 }), 'MIGRATION_EXECUTION_FAILED'],
    ['invalid state', 'not-json', 'MIGRATION_CONTAINER_STATE_INVALID'],
    ['missing running state', '{}', 'MIGRATION_CONTAINER_STATE_INVALID'],
  ]) {
    await t.test(name, async () => {
      const runner = new ControlledReleaseRunner({
        contractPath: '/project-runtime/contract.json',
        projectRoot: '/srv/forge-delivery/projects/demo-project',
        delay: async () => { throw new Error('A terminal startup failure must not be polled again.'); },
      });
      runner.command = async (_command, args) => {
        if (args[0] === 'inspect') return { code: 0, output: state };
        if (args[0] === 'logs') return {
          code: 0,
          output: 'Successfully validated 141 migrations\nStarted ForgeAdminApplication in 17 seconds',
        };
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      };
      await assert.rejects(runner.waitForTestMigration('forge-demo-release-test'),
        (error) => error.code === expectedCode && error.stage === 'test-database-migration');
    });
  }
});

test('test migration failures preserve a bounded redacted diagnostic and a stable error code', async () => {
  const runner = new ControlledReleaseRunner({
    contractPath: '/project-runtime/contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    delay: async () => undefined,
  });
  runner.command = async (_command, args) => {
    if (args[0] === 'inspect') return { code: 0, output: '{"Running":false,"ExitCode":1}' };
    if (args[0] === 'logs') {
      return {
        code: 0,
        output: 'password=super-secret FlywayException: Found more than one migration with version 1.0.138',
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    runner.waitForTestMigration('forge-demo-release-test'),
    (error) => error.code === 'MIGRATION_VERSION_CONFLICT'
      && error.stage === 'test-database-migration'
      && error.diagnosticExcerpt.includes('password=[REDACTED]')
      && !error.diagnosticExcerpt.includes('super-secret'),
  );
  assert.equal(
    sanitizeDiagnosticText('mysql://operator:credential@mysql.internal/db'),
    'mysql://[REDACTED]@mysql.internal/db',
  );
  assert.equal(
    sanitizeDiagnosticText('{"MYSQL_PASSWORD":"credential","access_token":"opaque"}'),
    '{"MYSQL_PASSWORD":"[REDACTED]","access_token":"[REDACTED]"}',
  );
});

test('migration SQL cause crosses the HTTP failure boundary without credentials', async () => {
  const runner = new ControlledReleaseRunner({ contractPath: '/fixture/contract.json',
    projectRoot: '/fixture/project', delay: async () => undefined });
  runner.command = async (_command, args) => {
    if (args[0] === 'inspect') return { code: 0, output: '{"Running":false,"ExitCode":1}' };
    if (args[0] === 'logs') return { code: 0, output:
      "FlywayException: Migration failed\nSQL State: HY000\nError Code: 1267\nMessage: Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='\nMYSQL_PASSWORD=fixture-secret" };
    throw new Error('Unexpected migration fixture command');
  };
  runner.execute = async () => runner.waitForTestMigration('fixture-migration');
  const server = createReleaseRunnerServer({ runner });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MIGRATION_EXECUTION_FAILED');
    assert.equal(body.error.stage, 'test-database-migration');
    assert.match(body.error.diagnosticExcerpt, /Error Code: 1267[\s\S]*Illegal mix of collations/u);
    assert.match(body.error.diagnosticExcerpt, /MYSQL_PASSWORD=\[REDACTED\]/u);
    assert.doesNotMatch(JSON.stringify(body), /fixture-secret/u);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('failed Flyway history is classified before the generic validation pattern', async () => {
  const runner = new ControlledReleaseRunner({
    contractPath: '/project-runtime/contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    delay: async () => undefined,
  });
  runner.command = async (_command, args) => {
    if (args[0] === 'inspect') return { code: 0, output: '{"Running":false,"ExitCode":1}' };
    if (args[0] === 'logs') {
      return {
        code: 0,
        output: 'Validate failed: Detected failed migration to version 1.0.145. Please run repair on schema history.',
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    runner.waitForTestMigration('forge-demo-release-test'),
    (error) => error.code === 'MIGRATION_HISTORY_FAILED'
      && /retry the normal controlled release/.test(error.recommendedAction),
  );
});

test('successful test-database plan preserves its result and job evidence when container cleanup times out', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-plan-cleanup-'));
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    operatorScript: '# reviewed operator\n',
  });
  runner.envFile = path.join(temporaryRoot, 'project.env');
  runner.opsRoot = temporaryRoot;
  runner.auditFile = path.join(temporaryRoot, 'release-audit.jsonl');
  runner.activeJob = '44174f98-8fee-477c-a9be-9b33e7a73b7b';
  const contract = runtimeContract();
  contract.release.testDatabaseLifecycle.backupRoot = path.join(temporaryRoot, 'snapshots');
  const containerId = 'c'.repeat(64);
  const output = 'DATABASE=forge_demo_project_test\nOBJECT_COUNT=390\nFAILED_HISTORY_COUNT=0\nACTIVE_CONNECTIONS=0\n';
  const invocations = [];
  runner.command = async (_command, args) => {
    invocations.push(args[0]);
    if (args[0] === 'create') return { code: 0, output: containerId + '\n' };
    if (args[0] === 'attach') return { code: 0, output };
    if (args[0] === 'inspect') return { code: 0, output: JSON.stringify({ Status: 'exited', Running: false, ExitCode: 0 }) };
    if (args[0] === 'rm') throw Object.assign(new Error('docker failed with exit 143.'), { output: '' });
    return { code: 0, output: '' };
  };
  try {
    await writeFile(runner.envFile, 'SHARED_SERVICES_ENV_FILE=/run/secrets/shared-services.env\n', 'utf8');
    const result = await runner.runTestDatabaseOperator('plan', contract);
    assert.equal(result.code, 0);
    assert.equal(result.output, output);
    assert.deepEqual(invocations, ['create', 'start', 'attach', 'inspect', 'rm']);
    assert.equal(result.cleanupPending.containerId, containerId);
    assert.equal(result.cleanupPending.error.message, 'docker failed with exit 143.');
    assert.equal(result.cleanupPending.error.diagnosticExcerpt, 'docker failed with exit 143.');
    const audit = JSON.parse((await readFile(runner.auditFile, 'utf8')).trim());
    assert.equal(audit.type, 'test-database-operator-cleanup');
    assert.equal(audit.status, 'pending');
    assert.equal(audit.action, 'plan');
    assert.equal(audit.jobId, runner.activeJob);
    assert.equal(audit.containerId, containerId);
    assert.deepEqual(audit.error, result.cleanupPending.error);

    const updates = [];
    const snapshotReached = new Error('snapshot stage reached after successful plan');
    runner.readTestDatabaseRecoveryState = async () => null;
    runner.runTestDatabaseOperator = async action => {
      if (action === 'plan') return result;
      assert.equal(action, 'snapshot');
      throw snapshotReached;
    };
    await assert.rejects(
      runner.prepareTestDatabase(contract, runner.activeJob, 'a'.repeat(40), async update => { updates.push(update); }),
      error => error === snapshotReached,
    );
    const initialPlan = updates.find(update => update.testDatabaseSandbox)?.testDatabaseSandbox.initialPlan;
    assert.equal(initialPlan.objectCount, 390);
    assert.equal(initialPlan.failedHistoryCount, 0);
    assert.equal(initialPlan.activeConnections, 0);
    assert.deepEqual(initialPlan.cleanupPending, result.cleanupPending);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('test-database operator is digest pinned and receives only the registered test schema', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-operator-'));
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    operatorScript: '# reviewed operator\n',
  });
  runner.envFile = path.join(temporaryRoot, 'project.env');
  runner.opsRoot = temporaryRoot;
  runner.backupsRoot = '/srv/forge-delivery/projects/demo-project/backups';
  await writeFile(runner.envFile, 'SHARED_SERVICES_ENV_FILE=/run/secrets/shared-services.env\n', 'utf8');
  const containerId = 'a'.repeat(64);
  const output = 'DATABASE=forge_demo_project_test\nOBJECT_COUNT=390\nFAILED_HISTORY_COUNT=0\nACTIVE_CONNECTIONS=0\n';
  let failure;
  const invocations = [];
  runner.command = async (command, args, options) => {
    invocations.push({ command, args, options });
    if (args[0] === 'create') return { code: 0, output: containerId + '\n' };
    if (args[0] === 'attach' && failure === 'attach') throw Object.assign(new Error('docker failed with exit SIGTERM.'), { output: '' });
    if (args[0] === 'inspect') return { code: 0, output: JSON.stringify({ Status: 'exited', Running: false, ExitCode: failure === 'exit' ? 7 : 0 }) };
    if (args[0] === 'rm' && failure) throw new Error('docker failed with exit 143.');
    return { code: 0, output: ['attach', 'run'].includes(args[0]) ? output : '' };
  };

  try {
    const result = await runner.runTestDatabaseOperator('plan', runtimeContract());
    assert.equal(result.output, output);
    assert.deepEqual(invocations.map(value => value.args[0]), ['create', 'start', 'attach', 'inspect', 'rm']);
    const invocation = invocations[0];
    assert.equal(invocation.command, 'docker');
    assert.equal(invocation.args.includes('--rm'), false);
    assert.ok(invocation.args.includes('--interactive'));
    assert.ok(invocation.args.includes('never'));
    assert.ok(invocation.args.includes(runtimeContract().release.testDatabaseLifecycle.operatorImage));
    assert.equal(
      invocation.args[invocation.args.indexOf('--network') + 1],
      `${runtimeContract().composeProjectName}_application`,
      'The operator must resolve database services on the registered project application network.',
    );
    assert.ok(invocation.args.includes('FORGE_RUNTIME_DATABASE=forge_demo_project'));
    assert.ok(invocation.args.includes('FORGE_TEST_DATABASE=forge_demo_project_test'));
    assert.ok(!invocation.args.some((argument) => /FORGE_TEST_DATABASE=forge_demo_project$/.test(argument)));
    assert.ok(invocation.args.includes('--read-only'));
    for (const [option, value] of [
      ['--tmpfs', '/tmp:rw,noexec,nosuid,size=128m'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges:true'],
      ['--pids-limit', '128'], ['--memory', '512m'], ['--cpus', '1.0'], ['--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`],
    ]) {
      assert.equal(invocation.args[invocation.args.indexOf(option) + 1], value, option);
    }
    assert.equal(invocation.args[invocation.args.indexOf('--env-file') + 1], '/run/secrets/shared-services.env');
    assert.equal(invocation.args[invocation.args.indexOf('--mount') + 1], 'type=bind,src=/srv/forge-delivery/projects/demo-project/backups,dst=/project-backups');
    assert.equal(invocation.options.input, undefined);
    assert.deepEqual(invocations[1].args, ['start', containerId]);
    assert.equal(invocations[1].options.input, undefined);
    assert.deepEqual(invocations[2].args, ['attach', '--sig-proxy=false', containerId]);
    assert.equal(invocations[2].options.input, '# reviewed operator\n');
    assert.deepEqual(invocations[3].args, ['inspect', '--format', '{{json .State}}', containerId]);
    assert.deepEqual(invocations[4].args, ['rm', '--force', '--volumes', containerId]);
    assert.ok(invocations.slice(0, 4).every(value => value.options.timeoutMs > 0 && value.options.timeoutMs <= 8 * 60 * 1000));
    for (failure of ['exit', 'attach']) {
      invocations.length = 0;
      await assert.rejects(runner.runTestDatabaseOperator('plan', runtimeContract()), error => error.code === 'TEST_DATABASE_PLAN_FAILED'
        && error.diagnosticExcerpt.includes(failure === 'exit' ? 'exit code: 7' : 'SIGTERM')
        && !error.diagnosticExcerpt.includes('exit 143')
        && (failure !== 'exit' || error.diagnosticExcerpt.includes('OBJECT_COUNT=390')));
      assert.deepEqual(invocations.map(value => value.args[0]), failure === 'exit'
        ? ['create', 'start', 'attach', 'inspect', 'rm'] : ['create', 'start', 'attach', 'rm']);
      assert.deepEqual(invocations.at(-1).args, ['rm', '--force', '--volumes', containerId]);
    }
    for (const action of ['reset', 'restore']) {
      invocations.length = 0;
      await runner.runTestDatabaseOperator(action, runtimeContract());
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].args[0], 'run');
      assert.ok(invocations[0].args.includes('--rm'));
      assert.equal(invocations[0].args.at(-1), action);
      assert.equal(invocations[0].options.input, '# reviewed operator\n');
      assert.equal(invocations[0].options.timeoutMs, 8 * 60 * 1000);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('test-database snapshot uses split startup and preserves execution evidence through cleanup', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-snapshot-'));
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    operatorScript: '# reviewed snapshot operator\n',
  });
  runner.envFile = path.join(temporaryRoot, 'project.env');
  runner.opsRoot = temporaryRoot;
  runner.backupsRoot = '/srv/forge-delivery/projects/demo-project/backups';
  const contract = runtimeContract();
  const containerId = 'b'.repeat(64);
  const backupFile = '/project-backups/test-database-snapshots/current.sql.gz';
  const output = `BACKUP_FILE=${backupFile}\nBACKUP_SHA256=${'a'.repeat(64)}\nBACKUP_BYTES=12\n`;
  try {
    await writeFile(runner.envFile, 'SHARED_SERVICES_ENV_FILE=/run/secrets/shared-services.env\n', 'utf8');
    for (const outcome of ['success', 'exit-and-cleanup', 'attach-and-cleanup', 'cleanup-only']) {
      const invocations = [];
      const audits = [];
      runner.audit = async record => { audits.push(record); };
      runner.command = async (command, args, options) => {
        invocations.push({ command, args, options });
        if (args[0] === 'create') return { code: 0, output: containerId + '\n' };
        if (args[0] === 'attach') {
          if (outcome === 'attach-and-cleanup') throw Object.assign(new Error('snapshot attach failed with SIGTERM'), { output: '' });
          return { code: 0, output };
        }
        if (args[0] === 'inspect') return { code: 0, output: JSON.stringify({
          Status: 'exited', Running: false, ExitCode: outcome === 'exit-and-cleanup' ? 7 : 0,
        }) };
        if (args[0] === 'rm' && outcome !== 'success') throw new Error('cleanup failed with exit 143');
        return { code: 0, output: '' };
      };
      const execute = () => runner.runTestDatabaseOperator('snapshot', contract, { FORGE_BACKUP_FILE: backupFile });
      if (outcome.endsWith('-and-cleanup')) {
        await assert.rejects(execute(), error => error.code === 'TEST_DATABASE_SNAPSHOT_FAILED'
          && error.diagnosticExcerpt.includes(outcome === 'exit-and-cleanup' ? 'exit code: 7' : 'SIGTERM')
          && !error.diagnosticExcerpt.includes('exit 143')
          && (outcome !== 'exit-and-cleanup' || error.diagnosticExcerpt.includes(`BACKUP_FILE=${backupFile}`)));
        assert.equal(audits.length, 0, 'cleanup must not replace the failed operator outcome');
      } else {
        const result = await execute();
        assert.equal(result.code, 0);
        assert.equal(result.output, output);
        if (outcome === 'cleanup-only') {
          assert.equal(result.cleanupPending.containerId, containerId);
          assert.equal(result.cleanupPending.error.message, 'cleanup failed with exit 143');
          assert.equal(audits.length, 1);
          assert.equal(audits[0].action, 'snapshot');
          assert.equal(audits[0].status, 'pending');
        } else assert.equal(result.cleanupPending, undefined);
      }
      assert.deepEqual(invocations.map(value => value.args[0]), outcome === 'attach-and-cleanup'
        ? ['create', 'start', 'attach', 'rm'] : ['create', 'start', 'attach', 'inspect', 'rm']);
      const created = invocations[0];
      assert.equal(created.command, 'docker');
      assert.equal(created.args.includes('--rm'), false);
      assert.ok(created.args.includes('--interactive'));
      assert.ok(created.args.includes(`FORGE_BACKUP_FILE=${backupFile}`));
      assert.ok(created.args.includes('FORGE_RUNTIME_DATABASE=forge_demo_project'));
      assert.ok(created.args.includes('FORGE_TEST_DATABASE=forge_demo_project_test'));
      assert.deepEqual(created.args.slice(-4), ['sh', contract.release.testDatabaseLifecycle.operatorImage, '-s', 'snapshot']);
      assert.equal(created.options.input, undefined);
      assert.deepEqual(invocations[1].args, ['start', containerId]);
      assert.equal(invocations[1].options.input, undefined);
      assert.deepEqual(invocations[2].args, ['attach', '--sig-proxy=false', containerId]);
      assert.equal(invocations[2].options.input, '# reviewed snapshot operator\n');
      const budgets = invocations.slice(0, -1).map(value => value.options.timeoutMs);
      assert.ok(budgets.every((budget, index) => budget > 0 && budget <= (index === 0 ? 8 * 60 * 1000 : budgets[index - 1])));
      assert.deepEqual(invocations.at(-1).args, ['rm', '--force', '--volumes', containerId]);
      assert.equal(invocations.at(-1).options.timeoutMs, 30_000);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('healthy test-database preparation arms a verified snapshot without resetting the schema', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-sandbox-'));
  const contract = runtimeContract();
  contract.release.testDatabaseLifecycle.backupRoot = path.join(temporaryRoot, 'test-database-snapshots');
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.backupsRoot = temporaryRoot;
  runner.testDatabaseRecoveryStateFile = path.join(temporaryRoot, 'test-database-recovery.json');
  const stages = [];
  const calls = [];
  runner.runTestDatabaseOperator = async (action, _contract, environment = {}) => {
    calls.push(action);
    if (action === 'plan') {
      return {
        code: 0,
        output: 'DATABASE=forge_demo_project_test\nOBJECT_COUNT=142\nFAILED_HISTORY_COUNT=0\nACTIVE_CONNECTIONS=0\n',
      };
    }
    if (action === 'snapshot') {
      const backupName = path.basename(environment.FORGE_BACKUP_FILE);
      const backupPath = path.join(contract.release.testDatabaseLifecycle.backupRoot, backupName);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, 'verified logical dump', 'utf8');
      const hash = crypto.createHash('sha256').update('verified logical dump').digest('hex');
      return {
        code: 0,
        output: `BACKUP_FILE=${environment.FORGE_BACKUP_FILE}\nBACKUP_SHA256=${hash}\nBACKUP_BYTES=21\n`,
      };
    }
    throw new Error(`Unexpected operator action: ${action}`);
  };

  try {
    const sandbox = await runner.prepareTestDatabase(
      contract,
      '11111111-2222-3333-4444-555555555555',
      'a'.repeat(40),
      async (state) => {
        if (state.stage) stages.push(state.stage);
      },
    );
    assert.deepEqual(calls, ['plan', 'snapshot']);
    assert.deepEqual(stages, ['test-database-plan', 'test-database-snapshot']);
    assert.equal(sandbox.plan.failedHistoryCount, 0);
    assert.equal(sandbox.backup.verified, true);
    assert.equal(sandbox.backup.bytes, 21);
    assert.equal(sandbox.mode, 'snapshot-restore-on-failure');
    assert.equal(sandbox.restoreRequired, false);
    const recoveryState = JSON.parse(await readFile(runner.testDatabaseRecoveryStateFile, 'utf8'));
    assert.equal(recoveryState.status, 'migration-pending');
    assert.equal(recoveryState.recoveryPoint.objectCount, 142);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('failed or interrupted test migration is restored from the registered healthy snapshot before retry', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-restore-'));
  const contract = runtimeContract();
  contract.release.testDatabaseLifecycle.backupRoot = path.join(temporaryRoot, 'test-database-snapshots');
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.backupsRoot = temporaryRoot;
  runner.testDatabaseRecoveryStateFile = path.join(temporaryRoot, 'test-database-recovery.json');
  const reviewedDump = 'reviewed logical dump';
  const reviewedSha = crypto.createHash('sha256').update(reviewedDump).digest('hex');
  const reviewedName = 'reviewed.sql.gz';
  const reviewedPath = path.join(contract.release.testDatabaseLifecycle.backupRoot, reviewedName);
  await mkdir(path.dirname(reviewedPath), { recursive: true });
  await writeFile(reviewedPath, reviewedDump, 'utf8');
  await writeFile(runner.testDatabaseRecoveryStateFile, JSON.stringify({
    schemaVersion: 1,
    database: 'forge_demo_project_test',
    lifecycleMode: 'snapshot-restore-on-failure',
    status: 'restore-required',
    recoveryPoint: {
      relativePath: `backups/test-database-snapshots/${reviewedName}`,
      sha256: reviewedSha,
      bytes: reviewedDump.length,
      objectCount: 142,
      jobId: 'failed-job',
    },
    lastAttempt: { jobId: 'failed-job', status: 'failed' },
  }), 'utf8');
  const calls = [];
  let planCount = 0;
  runner.cleanupInterruptedTestMigrationContainers = async (receivedContract) => {
    assert.equal(receivedContract.projectSlug, 'demo-project');
    calls.push('cleanup');
    return ['a'.repeat(64)];
  };
  runner.runTestDatabaseOperator = async (action, _contract, environment = {}) => {
    calls.push(action);
    if (action === 'plan') {
      planCount += 1;
      return {
        code: 0,
        output: planCount === 1
          ? 'DATABASE=forge_demo_project_test\nOBJECT_COUNT=145\nFAILED_HISTORY_COUNT=1\nACTIVE_CONNECTIONS=0\n'
          : 'DATABASE=forge_demo_project_test\nOBJECT_COUNT=142\nFAILED_HISTORY_COUNT=0\nACTIVE_CONNECTIONS=0\n',
      };
    }
    if (action === 'restore') {
      assert.equal(environment.FORGE_BACKUP_SHA256, reviewedSha);
      assert.equal(environment.FORGE_EXPECTED_OBJECT_COUNT, '142');
      return {
        code: 0,
        output: `DATABASE=forge_demo_project_test\nOBJECT_COUNT_AFTER=142\nFAILED_HISTORY_COUNT_AFTER=0\nBACKUP_SHA256=${reviewedSha}\nRESTORE_MODE=verified-snapshot-import\n`,
      };
    }
    if (action === 'snapshot') {
      const backupName = path.basename(environment.FORGE_BACKUP_FILE);
      const backupPath = path.join(contract.release.testDatabaseLifecycle.backupRoot, backupName);
      await writeFile(backupPath, reviewedDump, 'utf8');
      return {
        code: 0,
        output: `BACKUP_FILE=${environment.FORGE_BACKUP_FILE}\nBACKUP_SHA256=${reviewedSha}\nBACKUP_BYTES=${reviewedDump.length}\n`,
      };
    }
    throw new Error(`Unexpected operator action: ${action}`);
  };

  try {
    const sandbox = await runner.prepareTestDatabase(
      contract,
      '22222222-3333-4444-5555-666666666666',
      'b'.repeat(40),
      async () => undefined,
    );
    assert.deepEqual(calls, ['cleanup', 'plan', 'restore', 'plan', 'snapshot']);
    assert.equal(sandbox.restoreRequired, true);
    assert.deepEqual(sandbox.removedInterruptedContainers, ['a'.repeat(64)]);
    assert.equal(sandbox.restoration.recoveredFromJobId, 'failed-job');
    assert.equal(sandbox.plan.failedHistoryCount, 0);
    const recoveryState = JSON.parse(await readFile(runner.testDatabaseRecoveryStateFile, 'utf8'));
    assert.equal(recoveryState.status, 'migration-pending');
    assert.equal(recoveryState.lastAttempt.jobId, '22222222-3333-4444-5555-666666666666');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('interrupted test migration cleanup targets only project-labelled migration containers', async () => {
  const runner = new ControlledReleaseRunner({
    contractPath: '/project-runtime/contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const calls = [];
  runner.command = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'container') return { code: 0, output: `${first}\n${second}\nnot-a-container\n` };
    return { code: 0, output: '' };
  };

  const removed = await runner.cleanupInterruptedTestMigrationContainers(runtimeContract());

  assert.deepEqual(removed, [first, second]);
  assert.deepEqual(calls[0].args, [
    'container', 'ls', '--all', '--quiet',
    '--filter', 'label=com.forge-delivery.project=demo-project',
    '--filter', 'label=com.forge-delivery.role=test-database-migration',
  ]);
  assert.deepEqual(calls.slice(1).map(({ args }) => args), [
    ['stop', '--time', '10', first],
    ['rm', '--force', first],
    ['stop', '--time', '10', second],
    ['rm', '--force', second],
  ]);
});

test('failed legacy test state is rejected when no verified recovery point exists', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-missing-recovery-'));
  const contract = runtimeContract();
  contract.release.testDatabaseLifecycle.backupRoot = path.join(temporaryRoot, 'test-database-snapshots');
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    testDatabaseRecoveryStateFile: path.join(temporaryRoot, 'test-database-recovery.json'),
  });
  runner.runTestDatabaseOperator = async (action) => {
    assert.equal(action, 'plan');
    return {
      code: 0,
      output: 'DATABASE=forge_demo_project_test\nOBJECT_COUNT=143\nFAILED_HISTORY_COUNT=1\nACTIVE_CONNECTIONS=0\n',
    };
  };

  try {
    await assert.rejects(
      runner.prepareTestDatabase(
        contract,
        '33333333-4444-5555-6666-777777777777',
        'c'.repeat(40),
        async () => undefined,
      ),
      (error) => error.code === 'TEST_DATABASE_RECOVERY_POINT_MISSING'
        && error.stage === 'test-database-restore',
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('persistent migration state distinguishes success, failure, and runner interruption', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-test-db-state-'));
  const statePath = path.join(temporaryRoot, 'test-database-recovery.json');
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
    testDatabaseRecoveryStateFile: statePath,
  });
  const pendingState = {
    schemaVersion: 1,
    database: 'forge_demo_project_test',
    lifecycleMode: 'snapshot-restore-on-failure',
    status: 'migration-pending',
    recoveryPoint: {
      relativePath: 'backups/test-database-snapshots/reviewed.sql.gz',
      sha256: 'a'.repeat(64),
      bytes: 10,
      objectCount: 142,
    },
    lastAttempt: { jobId: 'job-1', status: 'migration-pending' },
  };
  await writeFile(statePath, JSON.stringify(pendingState), 'utf8');

  try {
    await runner.markTestDatabaseRecoveryRequired('job-1', { code: 'MIGRATION_EXECUTION_FAILED' });
    const failed = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(failed.status, 'restore-required');
    assert.equal(failed.lastAttempt.errorCode, 'MIGRATION_EXECUTION_FAILED');

    await writeFile(statePath, JSON.stringify({
      ...pendingState,
      lastAttempt: { jobId: 'job-2', status: 'migration-pending' },
    }), 'utf8');
    await runner.markTestDatabaseHealthy('job-2');
    const healthy = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.lastAttempt.status, 'success');

    await writeFile(statePath, JSON.stringify({
      ...pendingState,
      lastAttempt: { jobId: 'interrupted-job', status: 'migration-pending' },
    }), 'utf8');
    const interrupted = await runner.readTestDatabaseRecoveryState();
    assert.equal(interrupted.status, 'migration-pending');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('test migration runs the candidate Admin image selected for the release', async () => {
  const composeCalls = [];
  const runner = new ControlledReleaseRunner({
    contractPath: '/project-runtime/contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.composeWithEnvironment = async (environment, ...args) => {
    composeCalls.push({ environment, args });
    return { code: 0, output: '' };
  };
  runner.waitForTestMigration = async () => undefined;
  runner.command = async () => ({ code: 0, output: '' });
  const imageEnvironment = {
    FORGE_ADMIN_IMAGE: 'forge-demo-project/forge-admin:reviewed-1.2.3',
  };

  await runner.migrateTestDatabase(runtimeContract(), imageEnvironment);

  assert.equal(composeCalls.length, 1);
  assert.deepEqual(composeCalls[0].environment, imageEnvironment);
  assert.ok(composeCalls[0].args.includes('forge-admin'));
  assert.ok(composeCalls[0].args.includes('MYSQL_DB=forge_demo_project_test'));
  assert.ok(composeCalls[0].args.includes('com.forge-delivery.project=demo-project'));
  assert.ok(composeCalls[0].args.includes('com.forge-delivery.role=test-database-migration'));
  assert.ok(!composeCalls[0].args.includes('--rm'));
});

test('release orchestration builds before candidate-image test migration, pins images and records rollback evidence', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-release-runner-'));
  const envFile = path.join(temporaryRoot, 'project.env');
  const originalEnv = [
    'FORGE_ADMIN_COMMIT=old-commit',
    'FORGE_ADMIN_IMAGE=forge-demo-project/forge-admin:old',
    'FORGE_APP_IMAGE=forge-demo-project/forge-app:old',
    'FORGE_FLOW_IMAGE=forge-demo-project/forge-flow:old',
    'FORGE_UI_IMAGE=forge-demo-project/forge-ui:old',
    '',
  ].join('\n');
  await writeFile(envFile, originalEnv, 'utf8');

  const commands = [];
  const composeCalls = [];
  const audits = [];
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.envFile = envFile;
  runner.opsRoot = temporaryRoot;
  runner.composeFile = path.join(temporaryRoot, 'compose.yaml');
  runner.jobStateFile = path.join(temporaryRoot, 'release-state.json');
  runner.preflight = async () => ({ workspaceClean: true, head: 'a'.repeat(40) });
  runner.loadContract = async () => runtimeContract();
  runner.prepareTestDatabase = async () => {
    commands.push({ command: 'prepare-test-database' });
    return {
      mode: 'snapshot-restore-on-failure',
      database: 'forge_demo_project_test',
      backup: { relativePath: 'backups/test-database-snapshots/reviewed.sql.gz', verified: true },
    };
  };
  runner.migrateTestDatabase = async (_contract, imageEnvironment) => {
    commands.push({ command: 'migrate-test', imageEnvironment });
  };
  runner.markTestDatabaseHealthy = async () => {
    commands.push({ command: 'mark-test-database-healthy' });
  };
  runner.markTestDatabasePublished = async () => undefined;
  runner.command = async (command, args, options) => {
    commands.push({ command, args, options });
    if (command === 'docker' && args[0] === 'image') {
      return { code: 0, output: `sha256:${'f'.repeat(64)}\n` };
    }
    return { code: 0, output: '' };
  };
  runner.compose = async (...args) => {
    composeCalls.push(args);
    return { code: 0, output: '' };
  };
  const mobileSmokeFlags = [];
  runner.waitForUi = async (requireMobile) => {
    mobileSmokeFlags.push(requireMobile);
    return { url: '/forge/login', status: 200 };
  };
  runner.audit = async (record) => audits.push(record);
  const provenance = {
    source: 'taskspace',
    taskId: 'task-alpha',
    actorId: 'developer.one',
    conversationId: 'conversation:2026-08-27',
    candidateCommit: 'a'.repeat(40),
  };

  try {
    const result = await runner.release({
      action: 'release',
      services: ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'],
      approvalRef: 'Owner approved release in the active conversation.',
      version: 'reviewed-1.2.3',
      provenance,
    });
    assert.equal(result.version, 'reviewed-1.2.3');
    assert.equal(result.commit, 'a'.repeat(40));
    assert.deepEqual(result.services, ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui']);
    assert.deepEqual(mobileSmokeFlags, [true]);
    assert.equal(result.testDatabase, 'forge_demo_project_test');
    assert.equal(result.testDatabaseSandbox.mode, 'snapshot-restore-on-failure');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 'success');
    assert.deepEqual(audits[0].provenance, provenance);
    assert.deepEqual(result.provenance, provenance);

    const jobState = JSON.parse(await readFile(runner.jobStateFile, 'utf8'));
    assert.equal(jobState.status, 'success');
    assert.equal(jobState.stage, 'complete');
    assert.equal(jobState.result.commit, 'a'.repeat(40));
    assert.deepEqual(jobState.result.provenance, provenance);

    const updatedEnv = await readFile(envFile, 'utf8');
    assert.match(updatedEnv, new RegExp(`FORGE_ADMIN_COMMIT=${'a'.repeat(40)}`));
    assert.match(updatedEnv, /FORGE_ADMIN_IMAGE=forge-demo-project\/forge-admin:reviewed-1\.2\.3/);
    assert.match(updatedEnv, /FORGE_APP_IMAGE=forge-demo-project\/forge-app:reviewed-1\.2\.3/);
    assert.match(updatedEnv, /FORGE_UI_IMAGE=forge-demo-project\/forge-ui:reviewed-1\.2\.3/);
    assert.match(updatedEnv, /FORGE_FLOW_IMAGE=forge-demo-project\/forge-flow:reviewed-1\.2\.3/);
    assert.ok(result.rollbackEnv.startsWith(`${envFile}.pre-controlled-release-`));

    assert.equal(commands[0].command, 'docker');
    const build = commands.find(({ command, args }) => command === 'docker' && args?.includes('build'));
    assert.ok(build);
    assert.equal(build.options.outputMode, 'tail');
    assert.equal(
      build.options.env.FORGE_ADMIN_IMAGE,
      'forge-demo-project/forge-admin:reviewed-1.2.3',
    );
    assert.equal(
      build.options.env.FORGE_APP_IMAGE,
      'forge-demo-project/forge-app:reviewed-1.2.3',
    );
    const migration = commands.find(({ command }) => command === 'migrate-test');
    const prepareTestDatabase = commands.find(({ command }) => command === 'prepare-test-database');
    assert.equal(
      migration.imageEnvironment.FORGE_ADMIN_IMAGE,
      'forge-demo-project/forge-admin:reviewed-1.2.3',
    );
    assert.ok(commands.indexOf(build) < commands.indexOf(prepareTestDatabase));
    assert.ok(commands.indexOf(prepareTestDatabase) < commands.indexOf(migration));
    assert.ok(commands.indexOf(migration) < commands.findIndex(({ command }) => command === 'mark-test-database-healthy'));
    assert.deepEqual(composeCalls, [
      ['config', '--quiet'],
      ['up', '--detach', '--no-deps', 'forge-admin', 'forge-app', 'forge-flow', 'forge-ui'],
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('retained UI upstream refresh checks configuration and leaves rebuilt UI alone', async () => {
  const runner = new ControlledReleaseRunner({
    contractPath: '/unused/runtime-contract.json',
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  const calls = [];
  runner.compose = async (...args) => { calls.push(args); };
  await runner.refreshRetainedUiUpstreams(['forge-ui']);
  await runner.refreshRetainedUiUpstreams(['forge-admin', 'forge-ui']);
  await runner.refreshRetainedUiUpstreams([]);
  assert.deepEqual(calls, []);
  for (const service of ['forge-admin', 'forge-app', 'forge-flow']) {
    calls.length = 0;
    await runner.refreshRetainedUiUpstreams([service]);
    assert.deepEqual(calls, [
      ['exec', '-T', 'forge-ui', 'nginx', '-t'],
      ['exec', '-T', 'forge-ui', 'nginx', '-s', 'reload'],
    ]);
  }
  calls.length = 0;
  runner.compose = async (...args) => { calls.push(args); throw new Error('invalid nginx configuration'); };
  await assert.rejects(runner.refreshRetainedUiUpstreams(['forge-admin']), /invalid nginx configuration/);
  assert.deepEqual(calls, [['exec', '-T', 'forge-ui', 'nginx', '-t']]);
});

test('retained UI rollback refresh failures propagate and mobile rollback keeps its health scope', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-ui-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(root, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.envFile = path.join(root, 'project.env');
  const backup = path.join(root, 'previous.env');
  await writeFile(backup, 'FORGE_APP_IMAGE=fixture/stable:1\n');
  const events = [];
  runner.compose = async (...args) => { events.push(args); };
  runner.waitForUi = async (mobile) => { events.push(['smoke', mobile]); return { verified: true }; };
  assert.deepEqual(await runner.rollbackApplicationDeployment(['forge-app'], backup), { verified: true });
  assert.deepEqual(events, [
    ['up', '--detach', '--no-deps', 'forge-app'],
    ['exec', '-T', 'forge-ui', 'nginx', '-t'],
    ['exec', '-T', 'forge-ui', 'nginx', '-s', 'reload'],
    ['smoke', true],
  ]);
  runner.compose = async (...args) => {
    if (args.at(-1) === 'reload') throw new Error('nginx reload failed');
  };
  runner.waitForUi = async () => assert.fail('Health cannot hide a failed proxy refresh');
  await assert.rejects(runner.rollbackApplicationDeployment(['forge-app'], backup), /nginx reload failed/);
});

test('failed application smoke restores the previous environment and verifies rollback health', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-release-rollback-'));
  const envFile = path.join(temporaryRoot, 'project.env');
  const originalEnv = [
    `FORGE_ADMIN_COMMIT=${'0'.repeat(40)}`,
    'FORGE_ADMIN_IMAGE=forge-demo-project/forge-admin:stable',
    'FORGE_FLOW_IMAGE=forge-demo-project/forge-flow:stable',
    'FORGE_UI_IMAGE=forge-demo-project/forge-ui:stable',
    '',
  ].join('\n');
  await writeFile(envFile, originalEnv, 'utf8');
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.envFile = envFile;
  runner.opsRoot = temporaryRoot;
  runner.jobStateFile = path.join(temporaryRoot, 'release-state.json');
  runner.preflight = async () => ({ workspaceClean: true, head: 'a'.repeat(40) });
  runner.loadContract = async () => runtimeContract();
  runner.prepareTestDatabase = async () => ({ mode: 'snapshot-restore-on-failure' });
  runner.migrateTestDatabase = async () => undefined;
  runner.markTestDatabaseHealthy = async () => undefined;
  runner.command = async () => ({ code: 0, output: '' });
  const composeCalls = [];
  runner.compose = async (...args) => {
    composeCalls.push(args);
    return { code: 0, output: '' };
  };
  let smokeAttempt = 0;
  runner.waitForUi = async () => {
    assert.deepEqual(composeCalls.at(-1), ['exec', '-T', 'forge-ui', 'nginx', '-s', 'reload']);
    smokeAttempt += 1;
    if (smokeAttempt === 1) {
      const error = new Error('candidate returned HTTP 503');
      error.output = 'api status=503';
      throw error;
    }
    return { probes: [{ name: 'api', url: '/forge-api/auth/captcha', status: 200 }] };
  };
  const audits = [];
  runner.audit = async (record) => audits.push(record);

  try {
    await assert.rejects(
      runner.release({
        action: 'release',
        services: ['forge-admin'],
        approvalRef: 'Owner approved rollback acceptance.',
        version: 'bad-candidate',
      }),
      (error) => error.code === 'APPLICATION_SMOKE_FAILED'
        && error.details.rollbackVerified === true
        && error.stage === 'application-smoke',
    );
    assert.equal(await readFile(envFile, 'utf8'), originalEnv);
    assert.equal(smokeAttempt, 2);
    assert.deepEqual(composeCalls, [
      ['config', '--quiet'],
      ['up', '--detach', '--no-deps', 'forge-admin'],
      ['exec', '-T', 'forge-ui', 'nginx', '-t'],
      ['exec', '-T', 'forge-ui', 'nginx', '-s', 'reload'],
      ['up', '--detach', '--no-deps', 'forge-admin'],
      ['exec', '-T', 'forge-ui', 'nginx', '-t'],
      ['exec', '-T', 'forge-ui', 'nginx', '-s', 'reload'],
    ]);
    const state = JSON.parse(await readFile(runner.jobStateFile, 'utf8'));
    assert.equal(state.status, 'failed');
    assert.equal(state.stage, 'application-rollback-verified');
    assert.equal(state.rollback.verified, true);
    assert.equal(state.error.code, 'APPLICATION_SMOKE_FAILED');
    assert.equal(audits.at(-1).status, 'failed');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('release rejects TaskSpace provenance when the promoted commit changes before Runner preflight', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-release-provenance-'));
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.jobStateFile = path.join(temporaryRoot, 'release-state.json');
  runner.auditFile = path.join(temporaryRoot, 'release-audit.jsonl');
  runner.preflight = async () => ({ workspaceClean: true, head: 'b'.repeat(40) });
  runner.loadContract = async () => runtimeContract();
  try {
    await assert.rejects(
      runner.release({
        action: 'release',
        services: ['forge-admin'],
        approvalRef: 'Owner approved the TaskSpace candidate.',
        provenance: {
          source: 'taskspace',
          taskId: 'task-alpha',
          actorId: 'developer.one',
          conversationId: 'conversation:2026-08-27',
          candidateCommit: 'a'.repeat(40),
        },
      }),
      (error) => error.code === 'CANDIDATE_COMMIT_MISMATCH'
        && error.details.workspaceCommit === 'b'.repeat(40),
    );
    const state = JSON.parse(await readFile(runner.jobStateFile, 'utf8'));
    assert.equal(state.status, 'failed');
    assert.equal(state.error.code, 'CANDIDATE_COMMIT_MISMATCH');
    assert.equal(state.provenance.taskId, 'task-alpha');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('diagnose returns the persisted last release state without starting a job', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-release-diagnose-'));
  const runner = new ControlledReleaseRunner({
    contractPath: path.join(temporaryRoot, 'runtime-contract.json'),
    projectRoot: '/srv/forge-delivery/projects/demo-project',
  });
  runner.jobStateFile = path.join(temporaryRoot, 'release-state.json');
  await writeFile(runner.jobStateFile, JSON.stringify({
    schemaVersion: 1,
    jobId: 'job-1',
    status: 'failed',
    stage: 'test-database-migration',
    error: { code: 'MIGRATION_VERSION_CONFLICT' },
  }), 'utf8');

  try {
    const diagnosis = await runner.diagnose();
    assert.equal(diagnosis.active, false);
    assert.equal(diagnosis.lastJob.jobId, 'job-1');
    assert.equal(diagnosis.lastJob.error.code, 'MIGRATION_VERSION_CONFLICT');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('forge-release reaches the runner through a project capability socket without a bearer token', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-release-client-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\forge-release-${process.pid}-${crypto.randomUUID()}`
    : path.join(temporaryRoot, 'runner.sock');
  const runner = {
    activeJob: null,
    async execute(request) {
      return { acceptedAction: request.action };
    },
  };
  const server = createReleaseRunnerServer({ runner });
  server.listen(socketPath);
  await once(server, 'listening');

  try {
    const clientPath = path.resolve('docker/harness/forge-release');
    const clientEnvironment = {
      PATH: process.env.PATH,
      FORGE_RELEASE_RUNNER_SOCKET: socketPath,
    };
    const capability = await execFileAsync(process.execPath, [clientPath, 'capability'], {
      env: clientEnvironment,
    });
    assert.equal(capability.stderr, '');
    assert.deepEqual(JSON.parse(capability.stdout), { ok: true, active: false });

    const contractResponse = await execFileAsync(process.execPath, [clientPath, 'contract'], {
      env: {
        ...clientEnvironment,
        FORGE_RELEASE_CONTRACT: path.join(temporaryRoot, 'stale-contract-that-must-not-be-read.json'),
      },
    });
    assert.equal(contractResponse.stderr, '');
    assert.deepEqual(JSON.parse(contractResponse.stdout), {
      ok: true,
      result: { acceptedAction: 'contract' },
    });

    const { stdout, stderr } = await execFileAsync(process.execPath, [clientPath, 'preflight'], {
      env: {
        ...clientEnvironment,
      },
    });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {
      ok: true,
      result: { acceptedAction: 'preflight' },
    });

    const diagnosis = await execFileAsync(process.execPath, [clientPath, 'diagnose'], {
      env: clientEnvironment,
    });
    assert.equal(diagnosis.stderr, '');
    assert.deepEqual(JSON.parse(diagnosis.stdout), {
      ok: true,
      result: { acceptedAction: 'diagnose' },
    });
    assert.equal(runner.activeJob, null);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('forge-release inside a TaskSpace authenticates to the Broker instead of the Runner socket', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'forge-taskspace-client-'));
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFile = path.join(temporaryRoot, 'taskspace-token');
  await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  const requests = [];
  const broker = {
    activeRelease: null,
    async executeAuthenticated(actualToken, request) {
      requests.push({ actualToken, request });
      if (actualToken !== token) {
        const error = new Error('TaskSpace token is invalid.');
        error.code = 'TASKSPACE_AUTHENTICATION_FAILED';
        throw error;
      }
      return { acceptedAction: request.action, transport: 'taskspace-broker' };
    },
  };
  const server = createTaskspaceBrokerServer({ broker });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const clientPath = path.resolve('docker/harness/forge-release');
    const environment = {
      PATH: process.env.PATH,
      FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${port}`,
      FORGE_TASKSPACE_TOKEN_FILE: tokenFile,
      FORGE_RELEASE_RUNNER_SOCKET: path.join(temporaryRoot, 'must-not-be-used.sock'),
    };
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      clientPath,
      'release',
      '--services',
      'forge-admin',
      '--approval-ref',
      'Owner approved TaskSpace release.',
    ], { env: environment });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {
      ok: true,
      result: { acceptedAction: 'release', transport: 'taskspace-broker' },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].actualToken, token);
    assert.deepEqual(requests[0].request, {
      action: 'release',
      services: ['forge-admin'],
      approvalRef: 'Owner approved TaskSpace release.',
    });

    const message = 'Checkpoint reviewed source';
    const sourcePaths = Array.from({ length: 66 }, (_, index) => `src/module/File${index}.java`);
    const checkpoint = await execFileAsync(process.execPath, [
      clientPath,
      'checkpoint',
      ...sourcePaths.flatMap(file => ['--path', file]),
      '--message-base64',
      Buffer.from(message, 'utf8').toString('base64url'),
      '--expected-head',
      'a'.repeat(40),
      '--expected-fingerprint',
      'b'.repeat(64),
    ], { env: environment });
    assert.equal(checkpoint.stderr, '');
    assert.deepEqual(JSON.parse(checkpoint.stdout), {
      ok: true,
      result: { acceptedAction: 'checkpoint', transport: 'taskspace-broker' },
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      actualToken: token,
      request: {
        action: 'checkpoint',
        paths: sourcePaths,
        message,
        expectedHead: 'a'.repeat(40),
        expectedWorkspaceFingerprint: 'b'.repeat(64),
      },
    });

    const integrateStart = await execFileAsync(process.execPath, [
      clientPath,
      'integrate',
      '--mode',
      'start',
      '--expected-head',
      'a'.repeat(40),
      '--expected-fingerprint',
      'b'.repeat(64),
      '--canonical-head',
      'c'.repeat(40),
      ...sourcePaths.flatMap(file => ['--path', file]),
    ], { env: environment });
    assert.equal(integrateStart.stderr, '');
    assert.deepEqual(JSON.parse(integrateStart.stdout), {
      ok: true,
      result: { acceptedAction: 'integrate', transport: 'taskspace-broker' },
    });
    assert.deepEqual(requests[2], {
      actualToken: token,
      request: {
        action: 'integrate',
        mode: 'start',
        expectedHead: 'a'.repeat(40),
        expectedWorkspaceFingerprint: 'b'.repeat(64),
        canonicalHead: 'c'.repeat(40),
        paths: sourcePaths,
      },
    });

    const operationId = '123e4567-e89b-42d3-a456-426614174000';
    const integrateContinue = await execFileAsync(process.execPath, [
      clientPath,
      'integrate',
      '--mode',
      'continue',
      '--operation-id',
      operationId,
      '--expected-head',
      'd'.repeat(40),
      '--expected-fingerprint',
      'e'.repeat(64),
      '--canonical-head',
      'c'.repeat(40),
      '--path',
      'src/app.mjs',
      '--path',
      'tests/app.test.mjs',
    ], { env: environment });
    assert.equal(integrateContinue.stderr, '');
    assert.deepEqual(JSON.parse(integrateContinue.stdout), {
      ok: true,
      result: { acceptedAction: 'integrate', transport: 'taskspace-broker' },
    });
    assert.deepEqual(requests[3], {
      actualToken: token,
      request: {
        action: 'integrate',
        mode: 'continue',
        expectedHead: 'd'.repeat(40),
        expectedWorkspaceFingerprint: 'e'.repeat(64),
        canonicalHead: 'c'.repeat(40),
        paths: ['src/app.mjs', 'tests/app.test.mjs'],
        operationId,
      },
    });
  } finally {
    server.close();
    await once(server, 'close');
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('forge-release checkpoint fails closed without TaskSpace transport or with invalid input', async () => {
  const clientPath = path.resolve('docker/harness/forge-release');
  const baseArguments = [
    clientPath,
    'checkpoint',
    '--path',
    'src/app.mjs',
    '--message-base64',
    Buffer.from('Checkpoint source', 'utf8').toString('base64url'),
    '--expected-head',
    'a'.repeat(40),
    '--expected-fingerprint',
    'b'.repeat(64),
  ];
  await assert.rejects(
    execFileAsync(process.execPath, baseArguments, {
      env: { PATH: process.env.PATH, FORGE_RELEASE_RUNNER_SOCKET: 'must-not-be-used.sock' },
    }),
    /checkpoint requires the TaskSpace Broker transport/u,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      ...baseArguments.slice(0, 4),
      '--path',
      'src/app.mjs',
      ...baseArguments.slice(4),
    ], { env: { PATH: process.env.PATH } }),
    /checkpoint --path values must be unique/u,
  );
  const invalidUtf8Arguments = [...baseArguments];
  invalidUtf8Arguments[invalidUtf8Arguments.indexOf('--message-base64') + 1] = Buffer.from([0xc3, 0x28]).toString('base64url');
  await assert.rejects(
    execFileAsync(process.execPath, invalidUtf8Arguments, { env: { PATH: process.env.PATH } }),
    /must contain valid UTF-8/u,
  );
  const injectedArguments = [...baseArguments];
  injectedArguments[injectedArguments.indexOf('src/app.mjs')] = 'src/app.mjs;id';
  await assert.rejects(
    execFileAsync(process.execPath, injectedArguments, { env: { PATH: process.env.PATH } }),
    /Invalid checkpoint path/u,
  );
});

test('forge-release integrate fails closed without TaskSpace transport and rejects invalid argv', async () => {
  const clientPath = path.resolve('docker/harness/forge-release');
  const baseArguments = [
    clientPath,
    'integrate',
    '--mode',
    'start',
    '--expected-head',
    'a'.repeat(40),
    '--expected-fingerprint',
    'b'.repeat(64),
    '--canonical-head',
    'c'.repeat(40),
  ];
  await assert.rejects(
    execFileAsync(process.execPath, baseArguments, {
      env: { PATH: process.env.PATH, FORGE_RELEASE_RUNNER_SOCKET: 'must-not-be-used.sock' },
    }),
    /integrate requires the TaskSpace Broker transport/u,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [...baseArguments, '--operation-id', '123e4567-e89b-42d3-a456-426614174000'], {
      env: { PATH: process.env.PATH },
    }),
    /only accepted with --mode continue/u,
  );
  const continued = [...baseArguments];
  continued[continued.indexOf('start')] = 'continue';
  await assert.rejects(
    execFileAsync(process.execPath, continued, { env: { PATH: process.env.PATH } }),
    /operation-id is required/u,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [...baseArguments, '--path', '../outside'], { env: { PATH: process.env.PATH } }),
    /Invalid integrate path/u,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [...baseArguments, '--unknown', 'value'], { env: { PATH: process.env.PATH } }),
    /Unknown option/u,
  );
});

test('forge-release uses fixed TaskSpace transport when Harness filters token-shaped environment names', () => {
  assert.deepEqual(resolveTaskspaceTransport({
    FORGE_TASKSPACE_ID: 'task-a',
  }), {
    brokerUrlValue: 'http://taskspace-broker:3100',
    tokenFile: '/run/forge-taskspace/broker-token',
  });
  assert.throws(
    () => resolveTaskspaceTransport({ FORGE_TASKSPACE_BROKER_URL: 'http://taskspace-broker:3100' }),
    /requires both FORGE_TASKSPACE_BROKER_URL and FORGE_TASKSPACE_TOKEN_FILE/,
  );
});

test('forge-release selects trusted runtime Broker aliases in a real TaskSpace environment', () => {
  for (const hostname of ['taskspace-broker', 'taskspace-broker-stable', 'taskspace-broker-enhanced']) {
    const brokerUrlValue = `http://${hostname}:3100`;
    for (const tokenEnvironment of [{}, { FORGE_TASKSPACE_TOKEN_FILE: '/run/forge-taskspace/broker-token' }]) {
      assert.deepEqual(resolveTaskspaceTransport({
        FORGE_TASKSPACE_ID: 'task-one',
        FORGE_TASKSPACE_BROKER_URL: brokerUrlValue,
        ...tokenEnvironment,
      }), { brokerUrlValue, tokenFile: '/run/forge-taskspace/broker-token' });
    }
  }
});

test('forge-release rejects untrusted TaskSpace Broker endpoints and token overrides', () => {
  for (const brokerUrlValue of [
    'http://untrusted.invalid:9999', 'http://taskspace-broker-stable.example:3100',
    'http://taskspace-broker-enhanced-other:3100', 'http://127.0.0.1:3100',
    'https://taskspace-broker-stable:3100', 'http://taskspace-broker-stable:3101',
    'http://user:password@taskspace-broker-stable:3100',
    'http://taskspace-broker-enhanced:3100/other',
    'http://taskspace-broker-stable:3100?redirect=other', 'http://taskspace-broker-stable:3100#other',
  ]) assert.throws(() => resolveTaskspaceTransport({
    FORGE_TASKSPACE_ID: 'task-a', FORGE_TASKSPACE_BROKER_URL: brokerUrlValue,
  }), /trusted TaskSpace Broker origin/u, brokerUrlValue);
  for (const tokenFile of ['/tmp/token', '/run/forge-taskspace/../other-token']) {
    assert.throws(() => resolveTaskspaceTransport({
      FORGE_TASKSPACE_ID: 'task-a', FORGE_TASKSPACE_BROKER_URL: 'http://taskspace-broker-stable:3100',
      FORGE_TASKSPACE_TOKEN_FILE: tokenFile,
    }), /protected TaskSpace token path/u);
  }
});


test('internal candidate preparation accepts only bounded provenance and prepared identifiers', () => {
  const request = { action: 'prepare', services: ['forge-admin'], approvalRef: 'Owner release', provenance: {
    source: 'taskspace', taskId: 'task-alpha', actorId: 'developer.one',
    conversationId: 'conversation:2026-08-27', candidateCommit: 'a'.repeat(40),
  } };
  assert.equal(validateReleaseRequest(request, runtimeContract()).action, 'prepare');
  assert.throws(() => validateReleaseRequest({ ...request, provenance: undefined }, runtimeContract()), /provenance/);
  assert.throws(() => validateReleaseRequest({ ...request, workspaceRoot: '/another-project' }, runtimeContract()), /field|keys/i);
  assert.throws(() => validateReleaseRequest({ ...request, action: 'release', preparedJobId: '../escape' }, runtimeContract()), /prepared candidate job/);
});

async function candidatePreparationFixture(t, { literalGitBytes = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const ops = path.join(root, 'ops');
  await mkdir(path.join(workspace, 'docker-forge-admin'), { recursive: true });
  await mkdir(path.join(workspace, 'forge-server', 'db', 'migration'), { recursive: true });
  await mkdir(ops);
  const runGit = async (...args) => (await execFileAsync('git', ['-C', workspace, ...args], { encoding: 'utf8' })).stdout.trim();
  await runGit('init');
  if (literalGitBytes) await runGit('config', 'core.autocrlf', 'false');
  await runGit('config', 'user.name', 'Candidate test');
  await runGit('config', 'user.email', 'candidate@example.invalid');
  const contract = runtimeContract();
  for (const file of contract.release.protectedFiles) {
    const content = '# fixed fixture ' + file.relativePath + '\n';
    await writeFile(path.join(workspace, file.relativePath), content);
    file.sha256 = crypto.createHash('sha256').update(content).digest('hex');
  }
  await writeFile(path.join(workspace, 'forge-server/db/migration/V1.0.1__initial.sql'), 'CREATE TABLE sample (id INT);\n');
  await writeFile(path.join(workspace, 'candidate.txt'), 'base\n');
  await runGit('add', '.'); await runGit('commit', '-m', 'base');
  const base = await runGit('rev-parse', 'HEAD');
  await writeFile(path.join(workspace, 'candidate.txt'), 'candidate\n');
  await runGit('add', '.'); await runGit('commit', '-m', 'candidate');
  const commit = await runGit('rev-parse', 'HEAD');
  await runGit('checkout', '--detach', base);
  const env = 'FORGE_ADMIN_COMMIT=' + base + '\nFORGE_ADMIN_IMAGE=fixture/old:1\n';
  await writeFile(path.join(ops, 'project.env'), env);
  await writeFile(path.join(ops, 'compose.yaml'), 'services: {}\n');
  const contractPath = path.join(ops, 'runtime-contract.json');
  await writeFile(contractPath, JSON.stringify(contract));
  const runner = new ControlledReleaseRunner({ projectRoot: root, contractPath });
  runner.loadContract = async () => contract;
  runner.preflight = async () => ({ workspaceClean: true, head: await runGit('rev-parse', 'HEAD') });
  const events = [];
  const imageId = 'sha256:' + 'f'.repeat(64);
  runner.command = async (name, args) => {
    if (name === 'git') {
      const result = await execFileAsync(name, args, { encoding: 'utf8' });
      return { code: 0, output: result.stdout };
    }
    if (name === 'docker' && args.includes('build')) {
      const override = JSON.parse(await readFile(args[args.lastIndexOf('--file') + 1], 'utf8'));
      const source = override.services['forge-admin'].build.context;
      assert.equal(await readFile(path.join(source, 'candidate.txt'), 'utf8'), 'candidate\n');
      assert.notEqual(source, workspace);
      assert.equal(override.services['forge-admin'].volumes[1].source, path.join(source, 'forge-server', 'db', 'migration'));
      events.push('build');
    }
    return { code: 0, output: name === 'docker' && args[0] === 'image' ? imageId : '' };
  };
  runner.prepareTestDatabase = async () => { events.push('database'); return { status: 'healthy', testedCommit: commit }; };
  runner.migrateTestDatabase = async (_contract, images) => { assert.equal(images.FORGE_ADMIN_IMAGE, imageId); events.push('startup'); };
  runner.markTestDatabaseHealthy = async () => events.push('healthy');
  runner.markTestDatabaseRecoveryRequired = async () => events.push('recovery-required');
  runner.markTestDatabasePublished = async () => undefined;
  runner.audit = async () => undefined;
  runner.compose = async (...args) => { events.push(args[0]); return { code: 0, output: '' }; };
  runner.waitForUi = async () => { events.push('smoke'); return { status: 200 }; };
  const request = { action: 'prepare', services: ['forge-admin'], approvalRef: 'Owner release',
    provenance: { source: 'taskspace', taskId: 'task-alpha', actorId: 'developer.one', conversationId: 'conversation:2026-08-27', candidateCommit: commit } };
  return { runner, request, workspace, ops, events, runGit, base, commit, env, imageId };
}

test('service input planning drives preparation, exact image release and a subsequent no-op', async t => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  contract.release.inputModel = { schemaVersion: 1, services: Object.fromEntries(contract.release.allowedReleaseServices.map(service => [service, {
    kind: 'tree', roots: [service === 'forge-admin' ? 'candidate.txt' : 'docker-forge-admin/nginx.conf'], inputs: [],
    migrations: service === 'forge-admin' ? ['forge-server/db/migration'] : [],
    imageVariable: service.toUpperCase().replaceAll('-', '_') + '_IMAGE', checks: [],
  }])) };
  const model = contract.release.inputModel;
  const baseInputs = await f.runner.releaseInputSnapshot(f.base, model);
  const oldImages = Object.fromEntries(contract.release.allowedReleaseServices.map(service => [service, { id: f.imageId }]));
  await writeFile(f.runner.envFile, f.env + contract.release.allowedReleaseServices.map(service => `${model.services[service].imageVariable}=${f.imageId}\n`).join(''));
  await writeFile(f.runner.auditFile, JSON.stringify({ type: 'controlled-release', status: 'success', jobId: 'old', commit: f.base,
    services: contract.release.allowedReleaseServices, images: oldImages, inputPlan: { inputs: baseInputs } }) + '\n');
  f.runner.audit = ControlledReleaseRunner.prototype.audit;
  const request = { ...f.request, services: contract.release.allowedReleaseServices, provenance: { ...f.request.provenance, sourceBaseCommit: f.base } };
  const prepared = await f.runner.prepareCandidate(request);
  assert.deepEqual(prepared.services, ['forge-admin']);
  assert.deepEqual(prepared.inputPlan.retainedServices, ['forge-app', 'forge-flow', 'forge-ui']);
  await f.runGit('checkout', '--detach', f.commit);
  const released = await f.runner.release({ ...request, action: 'release', preparedJobId: prepared.jobId });
  assert.deepEqual(released.services, ['forge-admin']);
  assert.equal(f.events.filter(event => event === 'build').length, 1);
  const beforeNoop = [...f.events];
  const again = await f.runner.prepareCandidate(request);
  assert.equal(again.releaseRequired, false);
  const noop = await f.runner.release({ ...request, action: 'release', preparedJobId: again.jobId });
  assert.equal(noop.releaseApplied, false);
  assert.deepEqual(noop.services, []);
  assert.deepEqual(f.events, beforeNoop, 'unchanged inputs do not build, start a test DB, deploy or smoke');
  const audits = (await readFile(f.runner.auditFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audits.filter(record => record.type === 'controlled-release' && record.status === 'success').length, 2);
});

test('release planning consumes exact platform-approved Git bytes without inheriting approval for a modified candidate', async t => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  const file = 'docker-forge-admin/Dockerfile.admin';
  contract.release.inputModel = { schemaVersion: 1, services: { 'forge-admin': {
    kind: 'tree', roots: ['candidate.txt'], inputs: [file], migrations: [], imageVariable: 'FORGE_ADMIN_IMAGE', checks: [],
  } } };
  const baseInputs = await f.runner.releaseInputSnapshot(f.base, contract.release.inputModel);
  await writeFile(f.runner.envFile, `FORGE_ADMIN_IMAGE=${f.imageId}\n`);
  await writeFile(f.runner.auditFile, JSON.stringify({ type: 'controlled-release', status: 'success', jobId: 'old', commit: f.base,
    services: ['forge-admin'], images: { 'forge-admin': { id: f.imageId } }, inputPlan: { inputs: baseInputs } }) + '\n');
  const approved = '# public exec Java shutdown correction\n';
  await writeFile(path.join(f.workspace, file), approved);
  await f.runGit('add', file); await f.runGit('commit', '-m', 'public foundation update');
  const sourceBaseCommit = await f.runGit('rev-parse', 'HEAD');
  await writeFile(path.join(f.workspace, 'candidate.txt'), 'own change\n');
  await f.runGit('add', 'candidate.txt'); await f.runGit('commit', '-m', 'own candidate');
  const candidate = await f.runGit('rev-parse', 'HEAD');
  const request = { services: ['forge-admin'], provenance: { sourceBaseCommit } };
  await assert.rejects(f.runner.planReleaseInputs(request, candidate, contract), { code: 'RELEASE_CANDIDATE_SCOPE_MISMATCH' });
  contract.release.protectedFiles.find(item => item.relativePath === file).sha256 = crypto.createHash('sha256').update(approved).digest('hex');
  assert.deepEqual((await f.runner.planReleaseInputs(request, candidate, contract)).selectedServices, ['forge-admin']);
  await writeFile(path.join(f.workspace, file), approved + '# unapproved candidate delta\n');
  await f.runGit('add', file); await f.runGit('commit', '-m', 'candidate changes approved file');
  const changed = await f.runGit('rev-parse', 'HEAD');
  await writeFile(path.join(f.workspace, file), approved);
  await assert.rejects(f.runner.planReleaseInputs(request, changed, contract), { code: 'RELEASE_CANDIDATE_SCOPE_MISMATCH' },
    'approval is checked against immutable candidate Git bytes, not current workspace bytes');
});

test('release snapshot reads Maven descriptors in one lossless Git batch', async t => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  await mkdir(path.join(f.workspace, 'code', 'service'), { recursive: true });
  await writeFile(path.join(f.workspace, 'code', 'pom.xml'), '<project><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></project>\n');
  await writeFile(path.join(f.workspace, 'code', 'service', 'pom.xml'), '<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent><artifactId>service</artifactId></project>\n');
  await f.runGit('add', '.'); await f.runGit('commit', '-m', 'reactor');
  const calls = [];
  const command = f.runner.command;
  f.runner.command = async (name, args, options) => {
    calls.push(args);
    if (name === 'git' && args.includes('--batch')) {
      // execFile does not stream stdin; use a process for the same real Git API.
      const child = spawn(name, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
      child.stdin.end(options.input);
      await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Git batch failed'))); });
      return { code: 0, output };
    }
    return command(name, args, options);
  };
  const model = { services: { alpha: { kind: 'maven', mavenRoot: 'code', module: 'service', roots: [], inputs: [], migrations: [], checks: [] } } };
  const inputs = await f.runner.releaseInputSnapshot(await f.runGit('rev-parse', 'HEAD'), model);
  assert.deepEqual(inputs.alpha.files, ['code/pom.xml', 'code/service/pom.xml']);
  assert.equal(calls.filter(args => args.includes('--batch')).length, 1);
  assert.equal(calls.filter(args => args.includes('show')).length, 0);
});

test('candidate runtime preparation records isolated probes and retains failures without release', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  await writeFile(f.runner.envFile, f.env + 'SHARED_SERVICES_ENV_FILE=/protected/shared.env\n');
  const originalCommand = f.runner.command;
  const commands = [];
  let redirect = false;
  f.runner.migrateTestDatabase = ControlledReleaseRunner.prototype.migrateTestDatabase;
  f.runner.command = async (name, args, options) => {
    commands.push({ name, args, input: options?.input });
    if (name === 'docker' && args[0] === 'inspect') return { code: 0, output: JSON.stringify(
      args[2] === '{{json .State}}' ? { Running: true } : {
        running: true, image: f.imageId, address: '172.28.0.7', ports: { '8580/tcp': {} },
      }) };
    if (name === 'docker' && args[0] === 'logs') return { code: 0, output: 'Successfully validated 1 migrations\nStarted FixtureApplication\n' };
    if (name === 'docker' && args[0] === 'run') {
      assert.ok(args.includes('--read-only'));
      assert.ok(args.includes('--cap-drop'));
      assert.equal(args.some((v) => v === '--mount' || v === '-v'), false);
      assert.ok(args.includes(`FORGE_TEST_DATABASE=${contract.infrastructure.mysql.testDatabase}`));
      assert.match(options.input, /START TRANSACTION READ ONLY/);
      assert.match(options.input, /JSON_OBJECT/);
      return { code: 0, output: '{"id":1}\n' };
    }
    return originalCommand(name, args, options);
  };
  f.runner.fetch = async (url, options) => {
    assert.equal(url, 'http://172.28.0.7:8580/fixture/items');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    if (redirect) throw new TypeError('redirect refused secret-not-for-evidence');
    return new Response(JSON.stringify({ data: { available: true }, token: 'secret-not-for-evidence' }), { status: 200 });
  };
  const plan = { schemaVersion: 1,
    api: [{ id: 'read-items', method: 'GET', path: '/fixture/items', expectedStatus: 200,
      jsonAssertions: [{ path: ['data', 'available'], equals: true }] }],
    database: [{ id: 'read-row', table: 'sample', columns: ['id'], where: [{ column: 'id', equals: 1 }], limit: 2, expectedRows: 1 }],
    browser: { status: 'not-executed', reason: 'owner-excluded' } };
  const request = { ...f.request, runtimePreparation: {
    taskId: f.request.provenance.taskId, executionId: crypto.randomUUID(), stateDigest: '1'.repeat(64),
    baseSourceCommit: f.base, workspaceFingerprint: '2'.repeat(64), acceptedPatchSha256: '3'.repeat(64),
    candidateTree: await f.runGit('rev-parse', f.commit + '^{tree}'), probePlan: plan,
  } };
  const prepared = await f.runner.execute(request);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.runtimeEvidence.status, 'passed');
  const documents = {};
  for (const [kind, ref] of Object.entries(prepared.runtimeEvidence.evidence)) {
    const bytes = await readFile(ref.path);
    assert.deepEqual(Buffer.from(ref.bytesBase64, 'base64'), bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), ref.sha256);
    assert.equal(bytes.includes(Buffer.from('secret-not-for-evidence')), false);
    documents[kind] = JSON.parse(bytes);
    assert.equal(documents[kind].sourceCommit, f.commit);
  }
  assert.equal(documents.deployment.status, 'success');
  assert.equal(documents.deployment.releaseApplied, false);
  assert.equal(documents.api.authentication, 'anonymous');
  assert.equal(documents.api.roleAuthorizationVerified, false);
  assert.equal(documents.database.checks[0].rowCount, 1);
  assert.equal(documents.browser.status, 'not-executed');
  assert.ok(commands.some((v) => v.args[0] === 'stop'));
  assert.ok(commands.some((v) => v.args[0] === 'rm'));
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
  assert.equal(f.events.includes('up'), false);
  assert.equal(f.events.filter((v) => v === 'build').length, 1);
  redirect = true;
  const failed = await f.runner.execute(request);
  assert.equal(failed.status, 'prepared');
  assert.equal(failed.runtimeEvidence.status, 'failed');
  assert.notEqual(failed.runtimeEvidence.root, prepared.runtimeEvidence.root);
  assert.equal(f.events.filter((v) => v === 'build').length, 1, 'retain candidate build on probe failure');
  assert.deepEqual(JSON.parse(await readFile(prepared.runtimeEvidence.evidence.api.path, 'utf8')), documents.api);
  assert.equal((await readFile(failed.runtimeEvidence.evidence.api.path, 'utf8')).includes('secret-not-for-evidence'), false);
  const beforeRejected = commands.length;
  for (const mutation of [
    (p) => { p.api[0].path = 'http://outside.invalid/'; },
    (p) => { p.api[0].path = '//outside.invalid/'; },
    (p) => { p.api[0].method = 'POST'; },
    (p) => { p.api[0].headers = { Authorization: 'secret' }; },
    (p) => { p.database[0].table = 'sample; DROP TABLE sample'; },
    (p) => { p.database[0].sql = 'SELECT 1 INTO OUTFILE'; },
    (p) => { p.database[0].database = 'production'; },
  ]) {
    const invalid = structuredClone(request); mutation(invalid.runtimePreparation.probePlan);
    await assert.rejects(f.runner.execute(invalid));
  }
  assert.equal(commands.length, beforeRejected, 'invalid targets cannot reach Docker or source');
  const noProbes = structuredClone(request); noProbes.runtimePreparation.probePlan.api = [];
  noProbes.runtimePreparation.probePlan.database = [];
  const blocked = await f.runner.execute(noProbes);
  assert.equal(blocked.runtimeEvidence.status, 'blocked');
  assert.equal(f.events.filter((v) => v === 'build').length, 1);
});

test('prepared runtime recheck keeps the same images and healthy database without rebuilding or remigrating', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  const commands = [];
  const originalCommand = f.runner.command;
  let rechecking = false;
  let failedHistoryCount = 0;
  f.runner.command = async (name, args, options) => {
    commands.push({ name, args });
    if (name === 'docker' && args[0] === 'inspect') return { code: 0, output: JSON.stringify(
      args[2] === '{{json .State}}' ? { Running: true } : {
        running: true, image: f.imageId, address: '172.28.0.7', ports: { '8580/tcp': {} },
      }) };
    if (name === 'docker' && args[0] === 'logs') return { code: 0, output:
      (rechecking ? '' : 'Successfully validated 1 migrations\n') + 'Started FixtureApplication\n' };
    return originalCommand(name, args, options);
  };
  f.runner.prepareTestDatabase = async (_contract, jobId, commit) => {
    assert.equal(rechecking, false, 'recheck cannot snapshot or restore the test database');
    f.events.push('database');
    await f.runner.recordTestDatabaseRecoveryState({ schemaVersion: 1, lifecycleMode: 'snapshot-restore-on-failure',
      database: contract.infrastructure.mysql.testDatabase, status: 'migration-pending', recoveryPoint: { jobId, commit },
      lastAttempt: { jobId, commit, status: 'migration-pending', published: false } });
    return { mode: 'snapshot-restore-on-failure' };
  };
  f.runner.markTestDatabaseHealthy = ControlledReleaseRunner.prototype.markTestDatabaseHealthy;
  f.runner.migrateTestDatabase = async (...args) => {
    assert.equal(rechecking, false, 'recheck cannot invoke migration');
    f.events.push('migration');
    return ControlledReleaseRunner.prototype.migrateTestDatabase.apply(f.runner, args);
  };
  f.runner.runTestDatabaseOperator = async (action) => {
    assert.equal(action, 'plan', 'recheck permits only the existing read-only database plan');
    return { code: 0, output: `DATABASE=${contract.infrastructure.mysql.testDatabase}\nOBJECT_COUNT=1\nFAILED_HISTORY_COUNT=${failedHistoryCount}\nACTIVE_CONNECTIONS=0\n` };
  };
  f.runner.readCandidateDatabaseProbe = async () => ({ rowCount: 0, resultSha256: 'a'.repeat(64) });
  f.runner.fetch = async (url, options) => {
    assert.equal(url, 'http://172.28.0.7:8580/fixture/items');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    return new Response('{"code":"NOT_AUTHENTICATED"}', { status: 200 });
  };
  const request = { ...f.request, runtimePreparation: {
    taskId: f.request.provenance.taskId, executionId: crypto.randomUUID(), stateDigest: '1'.repeat(64),
    baseSourceCommit: f.base, workspaceFingerprint: '2'.repeat(64), acceptedPatchSha256: '3'.repeat(64),
    candidateTree: await f.runGit('rev-parse', f.commit + '^{tree}'), probePlan: { schemaVersion: 1,
      api: [{ id: 'anonymous-read', method: 'GET', path: '/fixture/items', expectedStatus: 401, jsonAssertions: [] }],
      database: [{ id: 'read-row', table: 'sample', columns: ['id'], where: [], limit: 1, expectedRows: 0 }],
      browser: { status: 'not-executed', reason: 'owner-excluded' } },
  } };
  const prepared = await f.runner.execute(request);
  assert.equal(prepared.runtimeEvidence.status, 'failed');
  const preparedFile = path.join(f.runner.preparedCandidatePath(prepared.jobId), 'prepared.json');
  const oldPrepared = await readFile(preparedFile);
  const oldApi = await readFile(prepared.runtimeEvidence.evidence.api.path);
  const oldJob = await readFile(f.runner.jobStateFile);
  const oldRecovery = await readFile(f.runner.testDatabaseRecoveryStateFile);
  const recheck = structuredClone(request);
  recheck.preparedJobId = prepared.jobId;
  recheck.runtimePreparation.executionId = crypto.randomUUID();
  recheck.runtimePreparation.stateDigest = '4'.repeat(64);
  recheck.runtimePreparation.recheck = { previousObservationId: prepared.runtimeEvidence.observationId,
    previousStateDigest: request.runtimePreparation.stateDigest };
  recheck.runtimePreparation.probePlan.api[0].expectedStatus = 200;
  recheck.runtimePreparation.probePlan.api[0].jsonAssertions = [{ path: ['code'], equals: 'NOT_AUTHENTICATED' }];
  rechecking = true;
  const startCount = () => commands.filter(v => v.name === 'docker' && v.args.includes('run') && v.args.includes('--detach')).length;
  const before = startCount();
  const observed = await f.runner.execute(recheck);
  assert.equal(observed.jobId, prepared.jobId); assert.equal(observed.commit, prepared.commit);
  assert.deepEqual(observed.images, prepared.images); assert.equal(observed.runtimeEvidence.status, 'passed');
  assert.equal(startCount(), before + 1);
  assert.deepEqual(f.events, ['build', 'database', 'migration']);
  const start = commands.filter(v => v.args.includes('--detach')).at(-1);
  assert.ok(start.args.includes('SPRING_FLYWAY_ENABLED=false'));
  assert.ok(start.args.includes(`MYSQL_DB=${contract.infrastructure.mysql.testDatabase}`));
  const containerName = start.args[start.args.indexOf('--name') + 1];
  assert.ok(commands.some(v => v.args[0] === 'stop' && v.args.at(-1) === containerName));
  assert.ok(commands.some(v => v.args[0] === 'rm' && v.args.at(-1) === containerName));
  assert.notEqual(observed.runtimeEvidence.observationId, prepared.runtimeEvidence.observationId);
  for (const ref of Object.values(observed.runtimeEvidence.evidence)) {
    const bytes = await readFile(ref.path); assert.deepEqual(Buffer.from(ref.bytesBase64, 'base64'), bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), ref.sha256);
    const document = JSON.parse(bytes);
    assert.equal(document.executionId, recheck.runtimePreparation.executionId);
    assert.equal(document.stateDigest, recheck.runtimePreparation.stateDigest);
    assert.deepEqual(document.recheck, recheck.runtimePreparation.recheck);
  }
  const deployment = JSON.parse(await readFile(observed.runtimeEvidence.evidence.deployment.path, 'utf8'));
  assert.equal(deployment.startup.migrationValidationReusedFrom, prepared.jobId);
  assert.equal(deployment.releaseApplied, false);
  assert.equal(JSON.parse(await readFile(observed.runtimeEvidence.evidence.browser.path, 'utf8')).status, 'not-executed');
  const rejects = [
    v => { v.preparedJobId = crypto.randomUUID(); },
    v => { v.provenance.candidateCommit = 'e'.repeat(40); },
    v => { v.provenance.actorId = 'someone.else'; },
    v => { v.runtimePreparation.workspaceFingerprint = 'f'.repeat(64); },
    v => { v.runtimePreparation.recheck.previousStateDigest = 'f'.repeat(64); },
    v => { v.runtimePreparation.recheck.previousObservationId = crypto.randomUUID(); },
    v => { delete v.runtimePreparation.recheck; },
  ];
  for (const mutate of rejects) {
    const invalid = structuredClone(recheck); mutate(invalid);
    await assert.rejects(f.runner.execute(invalid));
  }
  failedHistoryCount = 1;
  await assert.rejects(f.runner.execute(recheck), { code: 'PREPARED_DATABASE_NOT_HEALTHY' });
  failedHistoryCount = 0;
  const recovery = JSON.parse(oldRecovery); recovery.status = 'restore-required';
  await f.runner.recordTestDatabaseRecoveryState(recovery);
  await assert.rejects(f.runner.execute(recheck), { code: 'PREPARED_DATABASE_NOT_HEALTHY' });
  await writeFile(f.runner.testDatabaseRecoveryStateFile, oldRecovery);
  assert.equal(startCount(), before + 1, 'rejected rechecks cannot start a candidate or fall back to build');
  assert.deepEqual(await readFile(preparedFile), oldPrepared);
  assert.deepEqual(await readFile(prepared.runtimeEvidence.evidence.api.path), oldApi);
  assert.deepEqual(await readFile(f.runner.jobStateFile), oldJob);
  assert.deepEqual(await readFile(f.runner.testDatabaseRecoveryStateFile), oldRecovery);
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
  assert.equal(f.runner.activeJob, null);
});

test('protected runtime QA identities are prepared only for referenced aliases without granting roles or rebuilding', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  await writeFile(f.runner.envFile, f.env + 'SHARED_SERVICES_ENV_FILE=/protected/shared.env\n');
  const registry = { schemaVersion: 1, projectSlug: contract.projectSlug, testDatabase: contract.infrastructure.mysql.testDatabase,
    identities: [76, 77, 78].map((userId) => ({ alias: `qa${userId}`, userId, tenantId: 1,
      username: `fixture-qa-${userId}`, password: `credential-secret-${userId}`, userClient: 'pc', appId: 'pc' })) };
  await writeFile(path.join(f.ops, 'runtime-test-identities.json'), JSON.stringify(registry), { mode: 0o600 });
  const source = new Map(registry.identities.map((v) => [v.userId, { ...v, userClient: null, userType: 2, status: 1, memberType: 2,
    hash: `database-only-hash-${v.userId}` }]));
  const target = new Map(); const roles = []; const commands = []; const projections = []; const logins = [];
  const originalCommand = f.runner.command;
  let rechecking = false;
  f.runner.command = async (name, args, options) => {
    commands.push({ name, args });
    if (name === 'docker' && args[0] === 'inspect') return { code: 0, output: JSON.stringify(
      args[2] === '{{json .State}}' ? { Running: true } : {
        running: true, image: f.imageId, address: '172.28.0.7', ports: { '8580/tcp': {} },
      }) };
    if (name === 'docker' && args[0] === 'logs') return { code: 0, output:
      (rechecking ? '' : 'Successfully validated 1 migrations\n') + 'Started FixtureApplication\n' };
    if (name === 'docker' && args.includes('--interactive') && options?.input?.includes('FORGE_QA_IDENTITY_TRANSACTION')) {
      // The MySQL process is the only simulated boundary; real database semantics are verified separately.
      const sql = options.input;
      const ids = [...sql.matchAll(/SET @forge_identity_user_id = (\d+);/gu)].map((match) => Number(match[1]));
      projections.push(ids);
      assert.deepEqual(ids, [76, 77]);
      assert.ok(args.includes(`FORGE_TEST_DATABASE=${contract.infrastructure.mysql.testDatabase}`));
      assert.ok(args.includes(contract.release.testDatabaseLifecycle.operatorImage));
      assert.ok(sql.includes('START TRANSACTION;'));
      assert.ok(sql.includes('COMMIT;'));
      assert.ok(sql.includes('GET_LOCK('));
      assert.ok(sql.includes('user_type = 2'));
      assert.ok(sql.includes('member_type = 2'));
      assert.ok(sql.includes('BINARY dst.password <=> BINARY src.password'));
      assert.ok(sql.includes('(src.user_client IS NULL OR BINARY src.user_client = BINARY '));
      assert.equal(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+`forge_demo_project`\./iu.test(sql), false);
      for (const table of ['sys_role', 'sys_user_org', 'sys_role_resource', 'sys_resource']) {
        assert.equal(sql.includes('`' + table + '`'), false);
      }
      for (const value of registry.identities.flatMap((v) => [v.password, source.get(v.userId).hash])) {
        assert.equal(sql.includes(value), false);
      }
      const staged = new Map(target);
      for (const id of ids) {
        const item = source.get(id);
        if (item.userType !== 2 || item.status !== 1 || item.memberType !== 2
          || (item.userClient !== null && item.userClient !== registry.identities.find((v) => v.userId === id).userClient)
          || target.has(id) && JSON.stringify(target.get(id)) !== JSON.stringify(item)) {
          throw Object.assign(new Error('database-only-hash-76 credential-secret-76'), { output: 'sensitive database diagnostic' });
        }
        if (!staged.has(id)) staged.set(id, structuredClone(item));
      }
      target.clear(); for (const [id, item] of staged) target.set(id, item);
      return { code: 0, output: 'QA_IDENTITIES_READY=2\n' };
    }
    return originalCommand(name, args, options);
  };
  f.runner.prepareTestDatabase = async (_contract, jobId, commit) => {
    assert.equal(rechecking, false);
    f.events.push('database');
    await f.runner.recordTestDatabaseRecoveryState({ schemaVersion: 1, lifecycleMode: 'snapshot-restore-on-failure',
      database: contract.infrastructure.mysql.testDatabase, status: 'migration-pending', recoveryPoint: { jobId, commit },
      lastAttempt: { jobId, commit, status: 'migration-pending' } });
    return { mode: 'snapshot-restore-on-failure' };
  };
  f.runner.markTestDatabaseHealthy = ControlledReleaseRunner.prototype.markTestDatabaseHealthy;
  f.runner.migrateTestDatabase = async (...args) => {
    assert.equal(rechecking, false); f.events.push('migration');
    return ControlledReleaseRunner.prototype.migrateTestDatabase.apply(f.runner, args);
  };
  f.runner.runTestDatabaseOperator = async (action) => {
    assert.equal(action, 'plan');
    return { code: 0, output: `DATABASE=${contract.infrastructure.mysql.testDatabase}\nOBJECT_COUNT=1\nFAILED_HISTORY_COUNT=0\nACTIVE_CONNECTIONS=0\n` };
  };
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  f.runner.fetch = async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/auth/loginConfig') return json({ code: 200, data: { enableCaptcha: false, enablePasswordEncryption: false } });
    if (route === '/crypto/config') return json({ code: 200, data: { enabled: false } });
    if (route === '/auth/login') {
      const input = JSON.parse(options.body); const item = registry.identities.find((v) => v.username === input.username);
      logins.push(item.userId);
      if (!target.has(item.userId)) return json({ code: 401, msg: 'user not found' });
      return json({ code: 200, data: { accessToken: `session-secret-${item.userId}`, userInfo: {
        userId: item.userId, tenantId: item.tenantId, username: item.username, roleKeys: [], orgIds: [],
      } } });
    }
    return json({ code: 200 });
  };
  const probe = (id, identity) => ({ id, method: 'GET', path: '/fixture/identity', ...(identity ? { identity } : {}),
    expectedStatus: 200, jsonAssertions: [{ path: ['code'], equals: 200 }] });
  const request = { ...f.request, runtimePreparation: { taskId: f.request.provenance.taskId,
    executionId: crypto.randomUUID(), stateDigest: '1'.repeat(64), baseSourceCommit: f.base,
    workspaceFingerprint: '2'.repeat(64), acceptedPatchSha256: '3'.repeat(64),
    candidateTree: await f.runGit('rev-parse', f.commit + '^{tree}'),
    apiScope: { artifactSha256: 'a'.repeat(64), endpoints: [{ method: 'GET', path: '/fixture/identity' }] },
    probePlan: { schemaVersion: 2, api: [probe('first', 'qa76'), probe('second', 'qa77')], database: [],
      browser: { status: 'not-executed', reason: 'owner-excluded' } } } };
  const initial = await f.runner.execute(request);
  const api = async (result) => JSON.parse(await readFile(result.runtimeEvidence.evidence.api.path, 'utf8'));
  assert.equal((await api(initial)).status, 'passed', 'missing registered QA identities must be prepared before real login');
  assert.deepEqual([...target.keys()], [76, 77]); assert.equal(target.has(78), false); assert.deepEqual(roles, []);
  assert.equal(target.get(76).userClient, null); assert.equal(target.get(77).userClient, null);
  assert.deepEqual(logins, [76, 77]); assert.equal(projections.length, 1);
  const initialBytes = await readFile(initial.runtimeEvidence.evidence.api.path);
  const preparedFile = path.join(f.runner.preparedCandidatePath(initial.jobId), 'prepared.json');
  const preparedBytes = await readFile(preparedFile);
  rechecking = true;
  let latest = initial;
  const recheck = async (plan = request.runtimePreparation.probePlan) => {
    const next = structuredClone(request); next.preparedJobId = initial.jobId;
    Object.assign(next.runtimePreparation, { executionId: crypto.randomUUID(), probePlan: plan,
      recheck: { previousObservationId: latest.runtimeEvidence.observationId, previousStateDigest: request.runtimePreparation.stateDigest } });
    latest = await f.runner.execute(next); return latest;
  };
  const before = JSON.stringify([...target]);
  const repeated = await recheck();
  assert.equal((await api(repeated)).status, 'passed'); assert.equal(JSON.stringify([...target]), before);
  const noIdentity = { ...request.runtimePreparation.probePlan, api: [probe('anonymous')] };
  const writes = projections.length; await recheck(noIdentity); assert.equal(projections.length, writes);
  source.get(77).userType = 0;
  const sourceRejected = await recheck();
  assert.equal((await api(sourceRejected)).status, 'blocked'); assert.equal(JSON.stringify([...target]), before);
  assert.equal(projections.length, writes + 1, 'a failed preparation is not retried once per alias');
  source.get(77).userType = 2;
  source.get(77).userClient = 'wrong-client';
  const clientRejected = await recheck();
  assert.equal((await api(clientRejected)).status, 'blocked'); assert.equal(JSON.stringify([...target]), before);
  source.get(77).userClient = null;
  target.get(77).hash = 'conflicting-target-hash';
  const conflicting = JSON.stringify([...target]);
  const targetRejected = await recheck();
  assert.equal((await api(targetRejected)).status, 'blocked'); assert.equal(JSON.stringify([...target]), conflicting);
  for (const result of [initial, repeated, sourceRejected, clientRejected, targetRejected]) {
    const evidence = await api(result);
    assert.equal(evidence.roleAuthorizationVerified, false);
    const serialized = JSON.stringify(evidence);
    for (const secret of ['database-only-hash', 'credential-secret', 'session-secret', 'sensitive database diagnostic']) {
      assert.equal(serialized.includes(secret), false);
    }
  }
  assert.deepEqual(await readFile(preparedFile), preparedBytes);
  assert.deepEqual(await readFile(initial.runtimeEvidence.evidence.api.path), initialBytes);
  assert.deepEqual(f.events, ['build', 'database', 'migration']);
  assert.equal(f.runner.activeJob, null); assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
});

test('runtime identity fixtures require protected roles and a referenced registered QA identity before database preparation', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'forge-role-fixture-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const envFile = path.join(work, 'project.env');
  await writeFile(envFile, 'SHARED_SERVICES_ENV_FILE=/protected/shared.env\n');
  const runner = Object.create(ControlledReleaseRunner.prototype);
  Object.assign(runner, { activeJob: {}, opsRoot: work, envFile });
  const jobId = crypto.randomUUID(); const candidateCommit = 'a'.repeat(40);
  const identity = { userId: '77', tenantId: '1', username: 'fixture-qa', userClient: 'pc', appId: 'pc' };
  runner.readRuntimeTestIdentities = async () => new Map([['qa', identity]]);
  runner.readTestDatabaseRecoveryState = async () => ({ database: 'forge_fixture_test', status: 'healthy',
    lastAttempt: { jobId, commit: candidateCommit, status: 'success' } });
  const scripts = [];
  runner.command = async (command, args, options) => {
    assert.equal(command, 'docker');
    if (args[0] === 'run') {
      scripts.push(options.input);
      assert.ok(args.includes('FORGE_TEST_DATABASE=forge_fixture_test'));
      return { output: 'QA_IDENTITIES_READY=1\n' };
    }
    assert.deepEqual(args.slice(0, 2), ['rm', '--force']); return { output: '' };
  };
  const contract = { projectSlug: 'fixture', composeProjectName: 'fixture',
    infrastructure: { mysql: { database: 'forge_fixture', testDatabase: 'forge_fixture_test' } },
    release: { testDatabaseLifecycle: { operatorImage: 'fixture-operator' } } };
  const request = { preparedJobId: jobId, provenance: { candidateCommit }, runtimePreparation: {
    identityScope: { artifactSha256: 'b'.repeat(64), roleKeys: ['FIXTURE_READER'] },
    probePlan: { schemaVersion: 2, api: [{ id: 'read', method: 'GET', path: '/fixture/items', identity: 'qa',
      expectedStatus: 200, jsonAssertions: [{ path: ['code'], equals: 200 }] }], database: [],
      browser: { status: 'not-executed', reason: 'owner-excluded' },
      identityFixtures: [{ identity: 'qa', orgId: '101', roleKeys: ['FIXTURE_READER'] }] } } };
  const selected = await runner.prepareRuntimeTestIdentities(request, contract, jobId);
  assert.deepEqual([...selected.keys()], ['qa']);
  assert.ok(scripts[0].includes('`sys_user_org_role`'), 'the current organization role must be prepared before login');
  assert.ok(scripts[0].includes('`sys_user_org`'));
  assert.equal(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+`forge_fixture`\./iu.test(scripts[0]), false);
  const denied = [
    value => { delete value.runtimePreparation.identityScope; },
    value => { value.runtimePreparation.probePlan.identityFixtures[0].roleKeys = ['OUTSIDE_ACCEPTED_CONTRACT']; },
    value => { value.runtimePreparation.probePlan.identityFixtures[0].orgId = '101 OR 1=1'; },
    value => { value.runtimePreparation.probePlan.identityFixtures[0].identity = 'not_referenced'; },
    value => { value.runtimePreparation.probePlan.api[0].identity = 'unknown'; value.runtimePreparation.probePlan.identityFixtures[0].identity = 'unknown'; },
  ];
  for (const mutate of denied) {
    const changed = structuredClone(request); mutate(changed);
    await assert.rejects(runner.prepareRuntimeTestIdentities(changed, contract, jobId));
  }
  assert.equal(scripts.length, 1, 'untrusted fixture requests cannot reach MySQL');
  const ordinary = structuredClone(request); delete ordinary.runtimePreparation.probePlan.identityFixtures;
  delete ordinary.runtimePreparation.identityScope;
  await runner.prepareRuntimeTestIdentities(ordinary, contract, jobId);
  assert.equal(scripts[1].includes('`sys_user_org_role`'), false, 'no fixture must preserve existing identity behavior');
});

test('authenticated candidate runtime probes isolate identities and retain captured CRUD evidence without rebuilding', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  // This authentication case keeps its original non-database identity fixture boundary.
  f.runner.prepareRuntimeTestIdentities = async (_request, currentContract) => f.runner.readRuntimeTestIdentities(currentContract);
  const commands = [];
  const originalCommand = f.runner.command;
  let rechecking = false;
  let failedHistoryCount = 0;
  f.runner.command = async (name, args, options) => {
    commands.push({ name, args });
    if (name === 'docker' && args[0] === 'inspect') return { code: 0, output: JSON.stringify(
      args[2] === '{{json .State}}' ? { Running: true } : {
        running: true, image: f.imageId, address: '172.28.0.7', ports: { '8580/tcp': {} },
      }) };
    if (name === 'docker' && args[0] === 'logs') return { code: 0, output:
      (rechecking ? '' : 'Successfully validated 1 migrations\n') + 'Started FixtureApplication\n' };
    return originalCommand(name, args, options);
  };
  f.runner.prepareTestDatabase = async (_contract, jobId, commit) => {
    assert.equal(rechecking, false, 'recheck cannot snapshot or restore the test database');
    f.events.push('database');
    await f.runner.recordTestDatabaseRecoveryState({ schemaVersion: 1, lifecycleMode: 'snapshot-restore-on-failure',
      database: contract.infrastructure.mysql.testDatabase, status: 'migration-pending', recoveryPoint: { jobId, commit },
      lastAttempt: { jobId, commit, status: 'migration-pending' } });
    return { mode: 'snapshot-restore-on-failure' };
  };
  f.runner.markTestDatabaseHealthy = ControlledReleaseRunner.prototype.markTestDatabaseHealthy;
  f.runner.migrateTestDatabase = async (...args) => {
    assert.equal(rechecking, false, 'recheck cannot invoke migration');
    f.events.push('migration');
    return ControlledReleaseRunner.prototype.migrateTestDatabase.apply(f.runner, args);
  };
  f.runner.runTestDatabaseOperator = async (action) => {
    assert.equal(action, 'plan', 'recheck permits only the existing read-only database plan');
    return { code: 0, output: `DATABASE=${contract.infrastructure.mysql.testDatabase}\nOBJECT_COUNT=1\nFAILED_HISTORY_COUNT=${failedHistoryCount}\nACTIVE_CONNECTIONS=0\n` };
  };

  const unavailable = await f.runner.execute({ action: 'contract' });
  assert.equal(unavailable.runtimeProbeCapabilities.identities.status, 'unavailable');
  assert.deepEqual(unavailable.runtimeProbeCapabilities.identities.items, []);
  const registryPath = path.join(f.ops, 'runtime-test-identities.json');
  const registry = { schemaVersion: 1, projectSlug: contract.projectSlug, testDatabase: contract.infrastructure.mysql.testDatabase,
    identities: [
      { alias: 'owner', username: 'fixture-owner', password: 'secret-password-A', userId: 'user-A', tenantId: 'tenant-one', userClient: 'web', appId: 'fixture-app' },
      { alias: 'reader', username: 'fixture-reader', password: 'secret-password-B', userId: 'user-B', tenantId: 'tenant-one', userClient: 'web', appId: 'fixture-app' },
      { alias: 'mismatch', username: 'fixture-mismatch', password: 'secret-password-C', userId: 'expected-C', tenantId: 'tenant-one', userClient: 'web', appId: 'fixture-app' },
    ] };
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  const discovery = await f.runner.execute({ action: 'contract' });
  assert.equal(discovery.runtimeProbeCapabilities.identities.status, 'available');
  assert.deepEqual(discovery.runtimeProbeCapabilities.identities.items, registry.identities.map(({ alias, userId, tenantId }) => ({ alias, userId, tenantId })));
  const requests = []; const dbValues = []; const tokens = { 'fixture-owner': 'secret-token-A', 'fixture-reader': 'secret-token-B', 'fixture-mismatch': 'secret-token-C' };
  const uploadBytes = Buffer.from([0, 1, 128, 255, 65, 10]);
  const downloadText = 'id,label\n41,fixture attachment\n';
  const downloadBytes = Buffer.from(downloadText);
  const downloadSha256 = crypto.createHash('sha256').update(downloadBytes).digest('hex');
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  f.runner.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'http://172.28.0.7:8580');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    const route = new URL(url).pathname; const method = options.method;
    const token = options.headers?.Authorization;
    if (route === '/auth/loginConfig') return json({ code: 200, data: { enableCaptcha: false, enablePasswordEncryption: false } });
    if (route === '/crypto/config') return json({ code: 200, data: { enabled: false } });
    if (route === '/auth/login') {
      const login = JSON.parse(options.body); const entry = registry.identities.find(v => v.username === login.username);
      assert.equal(login.password, entry.password);
      requests.push({ route, alias: entry.alias });
      return json({ code: 200, data: { accessToken: tokens[entry.username], userInfo: {
        userId: entry.alias === 'mismatch' ? 'unexpected-C' : entry.userId, username: entry.username, tenantId: entry.tenantId,
        roleKeys: entry.alias === 'owner' ? ['fixture-writer'] : ['fixture-role-reader'], orgIds: ['org-one'] } } });
    }
    requests.push({ route, method, token, query: new URL(url).search, body: options.body });
    if (!rechecking) return json({ code: 'NOT_AUTHENTICATED' });
    if (route === '/fixture/items' && method === 'POST') {
      assert.equal(token, 'Bearer secret-token-A'); return json({ code: 200, data: { id: '41' }, token: 'do-not-export-response-secret' });
    }
    if (route === '/fixture/items/41' && token === 'Bearer secret-token-B') return json({ code: 403 }, 403);
    if (route === '/fixture/items/41') {
      assert.equal(token, 'Bearer secret-token-A');
      if (method === 'GET') assert.equal(new URL(url).searchParams.get('selected'), '41');
      if (method === 'PUT') assert.deepEqual(JSON.parse(options.body), { id: '41', label: 'updated' });
      return json({ code: 200, data: { id: '41' } });
    }
    if (route === '/fixture/failure') return json({ code: 500, data: { id: 'must-not-capture' } }, 500);
    if (route === '/fixture/business-failure') return json({ code: 409,
      msg: 'Fixture request rejected; password=secret-password-A; Authorization: Bearer response-bearer-secret; token=unregistered-token-secret',
      data: { id: 'must-not-capture-business', privateValue: 'private-assertion-value' },
      headers: { cookie: 'response-cookie-secret' }, accessToken: 'response-body-token-secret' });
    if (route === '/fixture/unsafe') return json({ code: 200, data: { id: Number.MAX_SAFE_INTEGER + 1 } });
    if (route === '/fixture/files' && method === 'POST') {
      assert.equal(token, 'Bearer secret-token-A');
      assert.ok(options.body instanceof FormData);
      assert.equal(options.headers['Content-Type'], undefined, 'FormData sets its own multipart boundary');
      assert.equal(options.body.get('businessType'), 'fixture');
      assert.equal(options.body.get('businessId'), '41', 'the prior JSON capture is resolved into a form field');
      assert.equal(options.body.get('isPrivate'), 'true');
      assert.equal(options.body.get('storageType'), 'local');
      const file = options.body.get('file');
      assert.ok(file instanceof Blob); assert.equal(file.name, 'fixture.bin');
      assert.equal(file.type, 'application/octet-stream');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), uploadBytes);
      return json({ code: 200, data: { fileId: 'file-73' }, token: 'do-not-export-upload-secret' });
    }
    if (route === '/fixture/files/export' && method === 'POST') {
      assert.equal(token, 'Bearer secret-token-A');
      assert.deepEqual(JSON.parse(options.body), { id: '41' });
      return new Response(downloadBytes, { headers: {
        'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="fixture.csv"',
      } });
    }
    if (route === '/fixture/items/41/file' && method === 'POST') {
      assert.equal(token, 'Bearer secret-token-A');
      assert.deepEqual(JSON.parse(options.body), { fileId: 'file-73', downloadSha256 });
      return json({ code: 200, data: { fileId: 'file-73' } });
    }
    assert.fail('An unavailable identity or failed capture dependency must never send a request.');
  };
  f.runner.readCandidateDatabaseProbe = async (_contract, probe) => { dbValues.push(probe.where); return { rowCount: 1, resultSha256: 'a'.repeat(64) }; };
  const request = { ...f.request, runtimePreparation: {
    taskId: f.request.provenance.taskId, executionId: crypto.randomUUID(), stateDigest: '1'.repeat(64),
    baseSourceCommit: f.base, workspaceFingerprint: '2'.repeat(64), acceptedPatchSha256: '3'.repeat(64),
    candidateTree: await f.runGit('rev-parse', f.commit + '^{tree}'), probePlan: { schemaVersion: 1,
      api: [{ id: 'anonymous', method: 'GET', path: '/fixture/items', expectedStatus: 401, jsonAssertions: [] }],
      database: [], browser: { status: 'not-executed', reason: 'owner-excluded' } },
  } };
  const original = await f.runner.execute(request);
  assert.equal(original.runtimeEvidence.status, 'failed');
  const preparedFile = path.join(f.runner.preparedCandidatePath(original.jobId), 'prepared.json');
  const preparedBytes = await readFile(preparedFile); const oldApiBytes = await readFile(original.runtimeEvidence.evidence.api.path);
  const probe = (id, method, route, identity = 'owner', extra = {}) => ({ id, method, path: route, identity, expectedStatus: 200,
    jsonAssertions: [{ path: ['code'], equals: 200 }], ...extra });
  const ref = { $capture: 'createdId' }; const params = { id: ref };
  const plan = { schemaVersion: 2, api: [
    probe('create', 'POST', '/fixture/items', 'owner', { body: { label: 'created' }, captures: [{ name: 'createdId', path: ['data', 'id'] }] }),
    probe('read', 'GET', '/fixture/items/{id}', 'owner', { pathParameters: params, query: { selected: ref }, jsonAssertions: [{ path: ['data', 'id'], equals: ref }] }),
    probe('deny', 'GET', '/fixture/items/{id}', 'reader', { pathParameters: params, expectedStatus: 403, jsonAssertions: [{ path: ['code'], equals: 403 }] }),
    probe('update', 'PUT', '/fixture/items/{id}', 'owner', { pathParameters: params, body: { id: ref, label: 'updated' } }),
    probe('delete', 'DELETE', '/fixture/items/{id}', 'owner', { pathParameters: params }),
    probe('fail', 'GET', '/fixture/failure', 'owner', { captures: [{ name: 'failedId', path: ['data', 'id'] }] }),
    probe('dependent', 'DELETE', '/fixture/items/{id}', 'owner', { pathParameters: { id: { $capture: 'failedId' } } }),
    probe('missing', 'GET', '/fixture/items/{id}', 'missing', { pathParameters: params }),
    probe('mismatch', 'GET', '/fixture/items/{id}', 'mismatch', { pathParameters: params }),
    { id: 'dot-path', method: 'GET', path: '/fixture/items/{item-id}', pathParameters: { 'item-id': '..' }, expectedStatus: 200, jsonAssertions: [] },
    probe('unsafe-number', 'GET', '/fixture/unsafe', 'owner', { captures: [{ name: 'unsafeId', path: ['data', 'id'] }] }),
    probe('unsafe-write', 'PUT', '/fixture/items/{id}', 'owner', { pathParameters: { id: { $capture: 'unsafeId' } }, body: { label: 'never-written' } }),
    probe('business-fail', 'POST', '/fixture/business-failure', 'owner', {
      jsonAssertions: [{ path: ['code'], equals: 200 }, { path: ['data', 'privateValue'], equals: 'private-expected-value' },
        { path: ['missing'], equals: true }], captures: [{ name: 'businessId', path: ['data', 'id'] }] }),
    probe('business-dependent', 'DELETE', '/fixture/items/{id}', 'owner', { pathParameters: { id: { $capture: 'businessId' } } }),
    probe('upload-file', 'POST', '/fixture/files', 'owner', {
      multipart: { fields: { businessType: 'fixture', businessId: ref, storageType: 'local', isPrivate: true },
        file: { fieldName: 'file', fileName: 'fixture.bin', contentType: 'application/octet-stream', bytesBase64: uploadBytes.toString('base64') } },
      captures: [{ name: 'uploadedFileId', path: ['data', 'fileId'] }],
    }),
    probe('download-csv', 'POST', '/fixture/files/export', 'owner', {
      body: { id: ref }, download: { format: 'text' },
      jsonAssertions: [{ path: ['text'], equals: downloadText }, { path: ['fileName'], equals: 'fixture.csv' },
        { path: ['contentType'], equals: 'text/csv; charset=utf-8' }, { path: ['byteLength'], equals: downloadBytes.length }],
      captures: [{ name: 'downloadSha256', path: ['sha256'] }],
    }),
    probe('link-file', 'POST', '/fixture/items/{id}/file', 'owner', {
      pathParameters: params, body: { fileId: { $capture: 'uploadedFileId' }, downloadSha256: { $capture: 'downloadSha256' } },
      jsonAssertions: [{ path: ['code'], equals: 200 }, { path: ['data', 'fileId'], equals: { $capture: 'uploadedFileId' } }],
    }),
  ], database: [{ id: 'stored-row', table: 'sample', columns: ['id'], where: [{ column: 'id', equals: ref }], limit: 1, expectedRows: 1 },
    { id: 'dependent-row', table: 'sample', columns: ['id'], where: [{ column: 'id', equals: { $capture: 'failedId' } }], limit: 1, expectedRows: 1 }],
    browser: { status: 'not-executed', reason: 'owner-excluded' } };
  const recheck = structuredClone(request); recheck.preparedJobId = original.jobId;
  Object.assign(recheck.runtimePreparation, { executionId: crypto.randomUUID(), stateDigest: '4'.repeat(64), probePlan: plan,
    apiScope: { artifactSha256: 'a'.repeat(64), endpoints: [...new Map(plan.api.map(v => [v.method + v.path, { method: v.method, path: v.path }])).values()] },
    recheck: { previousObservationId: original.runtimeEvidence.observationId, previousStateDigest: request.runtimePreparation.stateDigest } });
  rechecking = true;
  const actual = await f.runner.execute(recheck);
  assert.equal(actual.jobId, original.jobId); assert.equal(actual.commit, original.commit); assert.deepEqual(actual.images, original.images);
  assert.deepEqual(f.events, ['build', 'database', 'migration']);
  const evidence = Object.fromEntries(await Promise.all(Object.entries(actual.runtimeEvidence.evidence).map(async ([kind, v]) => {
    const bytes = await readFile(v.path); assert.deepEqual(Buffer.from(v.bytesBase64, 'base64'), bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), v.sha256); return [kind, JSON.parse(bytes)];
  })));
  assert.equal(actual.runtimeEvidence.status, 'failed'); assert.equal(evidence.deployment.status, 'success');
  assert.deepEqual(evidence.api.checks.map(v => v.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'failed', 'not-executed', 'not-executed', 'not-executed', 'not-executed', 'failed', 'not-executed', 'failed', 'not-executed', 'passed', 'passed', 'passed']);
  assert.equal(evidence.api.checks[9].errorCode, 'CANDIDATE_API_PATH_PARAMETER_INVALID');
  assert.equal(evidence.api.checks[11].errorCode, 'CANDIDATE_CAPTURE_UNAVAILABLE');
  const businessFailure = evidence.api.checks[12];
  assert.equal(businessFailure.httpStatus, 200);
  assert.deepEqual(businessFailure.assertionResults, [false, false, false]);
  assert.equal(businessFailure.failureDiagnostic?.code, 409, 'HTTP 200 business failure must retain the actual standard code');
  assert.match(businessFailure.failureDiagnostic.message, /^Fixture request rejected;/);
  assert.ok(businessFailure.failureDiagnostic.message.length <= 512);
  assert.deepEqual(businessFailure.failureDiagnostic.assertionMismatches, [
    { index: 0, expectedType: 'number', actualType: 'number' },
    { index: 1, expectedType: 'string', actualType: 'string' },
    { index: 2, expectedType: 'boolean', actualType: 'missing' },
  ]);
  assert.equal(evidence.api.checks[5].failureDiagnostic.code, 500);
  assert.equal(evidence.api.checks[13].errorCode, 'CANDIDATE_CAPTURE_UNAVAILABLE');
  assert.equal(evidence.api.checks[14].identity.userId, 'user-A');
  assert.equal(evidence.api.checks[15].identity.userId, 'user-A');
  assert.deepEqual(evidence.api.checks[15].download, { format: 'text', contentType: 'text/csv; charset=utf-8',
    fileName: 'fixture.csv', byteLength: downloadBytes.length, sha256: downloadSha256 });
  assert.equal(evidence.api.checks[15].responseDigestBasis, 'authenticated-binary-response');
  assert.equal(evidence.api.checks[15].responseSha256, downloadSha256);
  assert.equal(evidence.api.checks[16].identity.userId, 'user-A');
  assert.ok(evidence.api.checks.filter(v => v.status !== 'failed').every(v => !Object.hasOwn(v, 'failureDiagnostic')));
  assert.deepEqual(actual.runtimeEvidence.apiFailureDiagnostics, evidence.api.checks.filter(v => v.failureDiagnostic)
    .map(({ id, failureDiagnostic }) => ({ id, failureDiagnostic })), 'public prepare result exposes only the persisted bounded diagnostics');
  assert.equal(requests.some(v => v.route === '/fixture/' || v.route === '/fixture'), false);
  assert.equal(requests.filter(v => v.method === 'PUT').length, 1);
  assert.equal(evidence.api.roleAuthorizationVerified, false);
  assert.equal(evidence.api.checks[0].identity.userId, 'user-A'); assert.equal(evidence.api.checks[2].identity.userId, 'user-B');
  assert.deepEqual(evidence.database.checks.map(v => v.status), ['passed', 'not-executed']);
  assert.deepEqual(dbValues, [[{ column: 'id', equals: '41' }]]);
  assert.equal(requests.filter(v => v.route === '/auth/login').length, 3);
  assert.equal(requests.filter(v => v.method === 'DELETE').length, 1);
  const serialized = JSON.stringify({ discovery, evidence, publicDiagnostics: actual.runtimeEvidence.apiFailureDiagnostics });
  for (const forbidden of [...registry.identities.flatMap(v => [v.username, v.password]), ...Object.values(tokens),
    'do-not-export-response-secret', 'do-not-export-upload-secret', downloadText, uploadBytes.toString('base64'), registryPath, 'must-not-capture', 'private-assertion-value', 'private-expected-value',
    'response-bearer-secret', 'unregistered-token-secret', 'response-cookie-secret', 'response-body-token-secret']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(JSON.stringify(evidence).includes('"body":'), false);
  assert.deepEqual(await readFile(preparedFile), preparedBytes); assert.deepEqual(await readFile(original.runtimeEvidence.evidence.api.path), oldApiBytes);
  const container = commands.filter(v => v.args.includes('--detach')).at(-1).args;
  const containerName = container[container.indexOf('--name') + 1];
  assert.ok(container.includes('SPRING_FLYWAY_ENABLED=false'));
  assert.ok(commands.some(v => v.args[0] === 'rm' && v.args.at(-1) === containerName));
  assert.equal(f.runner.activeJob, null); assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
});

test('protected candidate approval preserves canonical pins and gates the clean approved commit', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const contract = await f.runner.loadContract();
  const relativePath = 'docker-forge-admin/Dockerfile.admin';
  const file = path.join(f.workspace, relativePath);
  const originalPins = structuredClone(contract.release.protectedFiles);
  await f.runGit('checkout', '--detach', f.commit);
  const approvedContent = (await readFile(file, 'utf8')) + '# reviewed packaging change\n';
  await writeFile(file, approvedContent);
  await f.runGit('add', relativePath); await f.runGit('commit', '-m', 'reviewed packaging');
  const approvedCommit = await f.runGit('rev-parse', 'HEAD');
  await assert.rejects(f.runner.validateProtectedFiles(contract), /Protected deployment input changed/);
  contract.release.protectedCandidateApproval = {
    candidateCommit: approvedCommit, relativePath,
    beforeSha256: originalPins.find(item => item.relativePath === relativePath).sha256,
    sha256: crypto.createHash('sha256').update(approvedContent).digest('hex'),
  };
  validateRuntimeContract(contract);
  await f.runner.validateProtectedFiles(contract);
  await writeFile(path.join(f.workspace, 'uncommitted.txt'), 'unreviewed\n');
  await assert.rejects(f.runner.validateProtectedFiles(contract), /clean/i);
  await rm(path.join(f.workspace, 'uncommitted.txt'));
  await f.runGit('commit', '--allow-empty', '-m', 'different commit with same protected bytes');
  await assert.rejects(f.runner.validateProtectedFiles(contract), /Protected deployment input changed/);
  await f.runGit('checkout', '--detach', approvedCommit);
  await writeFile(path.join(f.workspace, 'docker-forge-admin/nginx.conf'), '# unapproved protected input\n');
  await f.runGit('add', 'docker-forge-admin/nginx.conf'); await f.runGit('commit', '-m', 'unapproved other input');
  contract.release.protectedCandidateApproval.candidateCommit = await f.runGit('rev-parse', 'HEAD');
  await assert.rejects(f.runner.validateProtectedFiles(contract), /nginx\.conf/);
  contract.release.protectedCandidateApproval.candidateCommit = approvedCommit;
  await f.runGit('checkout', '--detach', f.base);
  await f.runner.validateProtectedFiles(contract);
  await writeFile(path.join(f.ops, 'runtime-contract.json'), JSON.stringify(contract));
  f.request.provenance.candidateCommit = approvedCommit;
  // Keep the existing Docker/DB fixture, but use the actual protected-file check
  // in both canonical preflight calls as well as detached candidate preparation.
  const checkedRoots = [];
  const validateFiles = f.runner.validateProtectedFiles.bind(f.runner);
  f.runner.validateProtectedFiles = async (value, workspace = f.workspace) => {
    checkedRoots.push(workspace);
    return validateFiles(value, workspace);
  };
  f.runner.preflight = async () => {
    await f.runner.validateProtectedFiles(contract);
    return { workspaceClean: !(await f.runGit('status', '--porcelain=v1', '--untracked-files=all')),
      head: await f.runGit('rev-parse', 'HEAD') };
  };
  const prepared = await f.runner.prepareCandidate(f.request);
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base, 'Preparation must not promote canonical.');
  assert.equal(checkedRoots[0], f.workspace);
  assert.notEqual(checkedRoots[1], f.workspace);
  await f.runGit('merge', '--ff-only', approvedCommit);
  const released = await f.runner.release({ ...f.request, action: 'release', preparedJobId: prepared.jobId });
  assert.equal(released.commit, approvedCommit);
  assert.equal(checkedRoots.at(-1), f.workspace);
  assert.deepEqual(contract.release.protectedFiles, originalPins, 'Approval must not overwrite primary pins.');
  assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy', 'config', 'up', 'exec', 'exec', 'smoke']);
  const refreshed = structuredClone(contract);
  refreshed.release.protectedFiles.find(item => item.relativePath === relativePath).sha256 = contract.release.protectedCandidateApproval.sha256;
  delete refreshed.release.protectedCandidateApproval;
  await f.runner.validateProtectedFiles(validateRuntimeContract(refreshed));
});

test('isolated candidate startup precedes branch promotion and final release reuses its exact image', async (t) => {
  const f = await candidatePreparationFixture(t);
  const prepared = await f.runner.prepareCandidate(f.request);
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.ops, 'project.env'), 'utf8'), f.env);
  assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy']);
  await f.runGit('merge', '--ff-only', f.commit);
  const result = await f.runner.release({ ...f.request, action: 'release', preparedJobId: prepared.jobId });
  assert.equal(result.commit, f.commit);
  assert.equal(result.images['forge-admin'].id, f.imageId);
  assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy', 'config', 'up', 'exec', 'exec', 'smoke']);
  assert.match(await readFile(path.join(f.ops, 'project.env'), 'utf8'), /FORGE_ADMIN_IMAGE=sha256:f{64}/);
});

test('published candidate runtime preparation retains release success and reuses its images and healthy test database', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  f.request.services = ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'];
  await writeFile(f.runner.envFile, f.env + 'FORGE_APP_IMAGE=fixture/app-before:1\nFORGE_FLOW_IMAGE=fixture/flow-before:1\nFORGE_UI_IMAGE=fixture/ui-before:1\n');
  const contract = await f.runner.loadContract();
  f.runner.prepareTestDatabase = async (_contract, jobId, commit) => {
    f.events.push('database');
    await f.runner.recordTestDatabaseRecoveryState({ schemaVersion: 1, lifecycleMode: 'snapshot-restore-on-failure',
      database: contract.infrastructure.mysql.testDatabase, status: 'migration-pending', recoveryPoint: { jobId, commit },
      lastAttempt: { jobId, commit, status: 'migration-pending', published: false } });
    return { mode: 'snapshot-restore-on-failure' };
  };
  f.runner.markTestDatabaseHealthy = ControlledReleaseRunner.prototype.markTestDatabaseHealthy;
  f.runner.markTestDatabasePublished = ControlledReleaseRunner.prototype.markTestDatabasePublished;
  const prepared = await f.runner.execute(f.request);
  assert.equal(prepared.runtimeEvidence, undefined, 'ordinary release preparation has no prior observation');
  await f.runGit('merge', '--ff-only', f.commit);
  const released = await f.runner.execute({ ...f.request, action: 'release', preparedJobId: prepared.jobId });
  assert.deepEqual(released.services, ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui']);
  const publishedEnv = await readFile(f.runner.envFile, 'utf8');
  await writeFile(f.runner.envFile, publishedEnv.replace(/^FORGE_APP_IMAGE=.*$/m, 'FORGE_APP_IMAGE=fixture/app-before:1')
    .replace(/^FORGE_FLOW_IMAGE=.*$/m, 'FORGE_FLOW_IMAGE=fixture/flow-before:1'));
  const preparedFile = path.join(f.runner.preparedCandidatePath(prepared.jobId), 'prepared.json');
  const originalPrepared = await readFile(preparedFile);
  const originalJob = await readFile(f.runner.jobStateFile);
  const originalRecovery = await readFile(f.runner.testDatabaseRecoveryStateFile);
  const originalEnv = await readFile(f.runner.envFile);
  const originalEvents = [...f.events];
  const commands = [];
  const originalCommand = f.runner.command;
  f.runner.command = async (name, args, options) => {
    commands.push({ name, args });
    assert.equal(args.includes('build'), false, 'published observations must not rebuild images');
    if (name === 'docker' && args[0] === 'inspect') return { code: 0, output: JSON.stringify(
      args[2] === '{{json .State}}' ? { Running: true } : {
        running: true, image: f.imageId, address: '172.28.0.7', ports: { '8580/tcp': {} },
      }) };
    if (name === 'docker' && args[0] === 'logs') return { code: 0, output: 'Started FixtureApplication\n' };
    return originalCommand(name, args, options);
  };
  f.runner.prepareTestDatabase = async () => assert.fail('published observation cannot restore the database');
  f.runner.migrateTestDatabase = async () => assert.fail('published observation cannot migrate the database');
  let failedHistoryCount = 0;
  f.runner.runTestDatabaseOperator = async action => {
    assert.equal(action, 'plan');
    return { code: 0, output: `DATABASE=${contract.infrastructure.mysql.testDatabase}\nOBJECT_COUNT=1\nFAILED_HISTORY_COUNT=${failedHistoryCount}\nACTIVE_CONNECTIONS=0\n` };
  };
  f.runner.fetch = async url => {
    assert.equal(url, 'http://172.28.0.7:8580/fixture/items');
    return new Response('{"code":"OK"}', { status: 200 });
  };
  f.runner.readCandidateDatabaseProbe = async () => ({ rowCount: 0, resultSha256: 'a'.repeat(64) });
  const request = { ...f.request, services: ['forge-admin', 'forge-ui'], preparedJobId: prepared.jobId, runtimePreparation: {
    taskId: f.request.provenance.taskId, executionId: crypto.randomUUID(), stateDigest: '1'.repeat(64),
    baseSourceCommit: f.base, workspaceFingerprint: '2'.repeat(64), acceptedPatchSha256: '3'.repeat(64),
    candidateTree: await f.runGit('rev-parse', f.commit + '^{tree}'), probePlan: { schemaVersion: 1,
      api: [{ id: 'published-read', method: 'GET', path: '/fixture/items', expectedStatus: 200, jsonAssertions: [] }],
      database: [{ id: 'read-row', table: 'sample', columns: ['id'], where: [], limit: 1, expectedRows: 0 }],
      browser: { status: 'not-executed', reason: 'owner-excluded' } },
  } };
  const actual = await f.runner.execute(request);
  assert.equal(actual.jobId, prepared.jobId);
  assert.deepEqual(actual.images, prepared.images);
  assert.equal(actual.runtimeEvidence.status, 'passed');
  const deployment = JSON.parse(await readFile(actual.runtimeEvidence.evidence.deployment.path, 'utf8'));
  assert.equal(deployment.startup.publicationValidationReusedFrom, released.jobId);
  assert.equal(deployment.startup.migrationValidationReusedFrom, prepared.jobId);
  assert.equal(deployment.releaseApplied, false);
  assert.equal(deployment.recheck, undefined);
  const starts = () => commands.filter(v => v.name === 'docker' && v.args.includes('--detach'));
  assert.equal(starts().length, 1);
  assert.ok(starts()[0].args.includes('--no-deps'));
  assert.equal(starts()[0].args.at(-1), 'forge-admin');
  assert.ok(starts()[0].args.includes('SPRING_FLYWAY_ENABLED=false'));
  assert.ok(starts()[0].args.includes(`MYSQL_DB=${contract.infrastructure.mysql.testDatabase}`));
  for (const mutate of [
    v => { v.preparedJobId = crypto.randomUUID(); },
    v => { v.provenance = { ...v.provenance, actorId: 'another.user' }; },
    v => { v.runtimePreparation.candidateTree = 'e'.repeat(40); },
  ]) {
    const invalid = structuredClone(request); mutate(invalid);
    await assert.rejects(f.runner.execute(invalid));
  }
  const job = JSON.parse(originalJob);
  for (const mutate of [
    v => { v.status = 'failed'; },
    v => { v.result.images['forge-admin'].id = 'sha256:' + 'e'.repeat(64); },
    v => { v.rollbackEnv = f.runner.envFile; },
  ]) {
    const invalid = structuredClone(job); mutate(invalid);
    await f.runner.recordJobState(invalid);
    await assert.rejects(f.runner.execute(request), { code: 'PREPARED_CANDIDATE_STALE' });
  }
  await writeFile(f.runner.jobStateFile, originalJob);
  for (const mutate of [
    v => { v.lastAttempt.published = false; },
    v => { v.lastAttempt.releaseJobId = crypto.randomUUID(); },
    v => { v.lastAttempt.jobId = crypto.randomUUID(); },
  ]) {
    const invalid = JSON.parse(originalRecovery); mutate(invalid);
    await f.runner.recordTestDatabaseRecoveryState(invalid);
    await assert.rejects(f.runner.execute(request), { code: 'PREPARED_DATABASE_NOT_HEALTHY' });
  }
  await writeFile(f.runner.testDatabaseRecoveryStateFile, originalRecovery);
  failedHistoryCount = 1;
  await assert.rejects(f.runner.execute(request), { code: 'PREPARED_DATABASE_NOT_HEALTHY' });
  failedHistoryCount = 0;
  await writeFile(f.runner.envFile, originalEnv.toString('utf8').replace(/^FORGE_ADMIN_IMAGE=.*$/m, 'FORGE_ADMIN_IMAGE=sha256:' + 'e'.repeat(64)));
  await assert.rejects(f.runner.execute(request), { code: 'PREPARED_CANDIDATE_STALE' });
  await writeFile(f.runner.envFile, originalEnv);
  await assert.rejects(f.runner.execute({ ...request, services: f.request.services }), { code: 'PREPARED_CANDIDATE_STALE' });
  await assert.rejects(f.runner.readPreparedCandidate({ ...request, runtimePreparation: undefined }, f.commit, job),
    { code: 'PREPARED_CANDIDATE_STALE' });
  await assert.rejects(f.runner.readPreparedCandidate({ ...request, runtimePreparation: { ...request.runtimePreparation, recheck: {} } }, f.commit, job),
    { code: 'PREPARED_CANDIDATE_STALE' });
  await writeFile(f.runner.envFile, Buffer.concat([originalEnv, Buffer.from('UNRELATED_SETTING=changed\n')]));
  await assert.rejects(f.runner.execute(request), { code: 'PREPARED_CANDIDATE_STALE' });
  await writeFile(f.runner.envFile, originalEnv);
  assert.equal(starts().length, 1, 'rejections cannot start another candidate');
  assert.deepEqual(await readFile(preparedFile), originalPrepared);
  assert.deepEqual(await readFile(f.runner.jobStateFile), originalJob);
  assert.deepEqual(await readFile(f.runner.testDatabaseRecoveryStateFile), originalRecovery);
  assert.deepEqual(await readFile(f.runner.envFile), originalEnv);
  assert.deepEqual(f.events, originalEvents);
  assert.equal(f.runner.activeJob, null);
});

test('candidate preparation reuses the completed candidate after a Broker acceptance interruption', async (t) => {
  const f = await candidatePreparationFixture(t);
  const prepared = await f.runner.prepareCandidate(f.request);
  const originalState = await readFile(f.runner.jobStateFile, 'utf8');
  const resumed = await f.runner.prepareCandidate(f.request);
  assert.equal(resumed.jobId, prepared.jobId);
  assert.equal(resumed.commit, prepared.commit);
  assert.deepEqual(resumed.images, prepared.images);
  assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy']);
  assert.equal(await readFile(f.runner.jobStateFile, 'utf8'), originalState);
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.ops, 'project.env'), 'utf8'), f.env);
});

const preparationPlatformEnv = [
  'HARNESS_IMAGE', 'CONVERSATION_MANAGER_IMAGE', 'PROTECTED_ACCEPTANCE_IMAGE',
  'TASKSPACE_BROKER_IMAGE', 'RELEASE_RUNNER_IMAGE',
].map(key => `${key}=platform/old:1\n`).join('');

test('prepared binding keeps the same artifact across only explicit platform environment updates', async (t) => {
  const f = await candidatePreparationFixture(t);
  await writeFile(f.runner.envFile, f.env + preparationPlatformEnv);
  const prepared = await f.runner.prepareCandidate(f.request);
  const manifest = path.join(f.runner.preparedCandidatePath(prepared.jobId), 'prepared.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(f.runner.envFile, f.env + preparationPlatformEnv.replaceAll('platform/old:1', 'platform/new:2')
    + 'FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED=true\n');
  const resumed = await f.runner.prepareCandidate(f.request);
  assert.equal(resumed.jobId, prepared.jobId);
  assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy']);
  assert.equal(await readFile(manifest, 'utf8'), original);
});

async function legacyPreparedFixture(t) {
  const f = await candidatePreparationFixture(t);
  const originalEnv = f.env + preparationPlatformEnv;
  await writeFile(f.runner.envFile, originalEnv);
  const prepared = await f.runner.prepareCandidate(f.request);
  const root = f.runner.preparedCandidatePath(prepared.jobId);
  const manifest = path.join(root, 'prepared.json');
  const record = JSON.parse(await readFile(manifest, 'utf8'));
  const hash = crypto.createHash('sha256');
  for (const file of [f.runner.envFile, f.runner.composeFile, f.runner.contractPath]) {
    const bytes = await readFile(file);
    hash.update(`${bytes.length}:`); hash.update(bytes);
  }
  record.binding = hash.digest('hex');
  const original = JSON.stringify(record) + '\n';
  await writeFile(manifest, original);
  const currentEnv = f.env + preparationPlatformEnv.replaceAll('platform/old:1', 'platform/new:2')
    + 'FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED=true\n';
  await writeFile(f.runner.envFile, currentEnv);
  return { ...f, prepared, manifest, original, originalEnv, currentEnv,
    preimage: path.join(root, 'project.env.before') };
}

test('legacy prepared binding requires its exact original environment and retains the job until supplied', async (t) => {
  const f = await legacyPreparedFixture(t);
  const savedState = await readFile(f.runner.jobStateFile, 'utf8');
  await assert.rejects(f.runner.prepareCandidate(f.request), { code: 'PREPARED_CANDIDATE_STALE' });
  assert.equal(await readFile(f.runner.jobStateFile, 'utf8'), savedState);
  await writeFile(f.preimage, f.originalEnv, { mode: 0o600 });
  const resumed = await f.runner.prepareCandidate(f.request);
  assert.equal(resumed.jobId, f.prepared.jobId);
  assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy']);
  assert.equal(await readFile(f.manifest, 'utf8'), f.original);
});

test('prepared binding rejects business environment, Compose and runtime contract changes', async (t) => {
  for (const legacy of [false, true]) {
    for (const change of ['business', 'compose', 'contract', ...(legacy ? ['false-preimage'] : [])]) {
      await t.test(`${legacy ? 'legacy' : 'current'} ${change}`, async (t) => {
        const f = legacy ? await legacyPreparedFixture(t) : await candidatePreparationFixture(t);
        const prepared = legacy ? f.prepared : await f.runner.prepareCandidate(f.request);
        if (legacy) await writeFile(f.preimage, change === 'false-preimage' ? f.currentEnv : f.originalEnv, { mode: 0o600 });
        if (change === 'business') await writeFile(f.runner.envFile, (legacy ? f.currentEnv : f.env).replace('fixture/old:1', 'fixture/other:2'));
        if (change === 'compose') await writeFile(f.runner.composeFile, 'services: {}\n# changed business composition\n');
        if (change === 'contract') await writeFile(f.runner.contractPath, (await readFile(f.runner.contractPath, 'utf8')) + '\n');
        await assert.rejects(f.runner.readPreparedCandidate({ ...f.request, preparedJobId: prepared.jobId }, f.commit),
          { code: 'PREPARED_CANDIDATE_STALE' });
        assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy']);
      });
    }
  }
});

test('candidate preparation starts a new job for a different identity, source, services or version', async (t) => {
  for (const condition of ['identity', 'source', 'services', 'version']) {
    await t.test(condition, async (t) => {
      const f = await candidatePreparationFixture(t);
      const prepared = await f.runner.prepareCandidate(f.request);
      const request = structuredClone(f.request);
      if (condition === 'identity') request.provenance.taskId = 'another-task';
      if (condition === 'services') request.services.push('forge-ui');
      if (condition === 'version') request.version = 'another-version';
      if (condition === 'source') {
        await f.runGit('checkout', '--detach', f.commit);
        await f.runGit('commit', '--allow-empty', '-m', 'another candidate');
        request.provenance.candidateCommit = await f.runGit('rev-parse', 'HEAD');
        await f.runGit('checkout', '--detach', f.base);
      }
      const next = await f.runner.prepareCandidate(request);
      assert.notEqual(next.jobId, prepared.jobId);
      assert.equal(next.commit, request.provenance.candidateCommit);
      assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy', 'build', 'database', 'startup', 'healthy']);
      assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
    });
  }
});

test('candidate preparation refuses reuse when its configuration, image or clean workspace no longer matches', async (t) => {
  for (const condition of ['configuration', 'image', 'workspace']) {
    await t.test(condition, async (t) => {
      const f = await candidatePreparationFixture(t);
      const prepared = await f.runner.prepareCandidate(f.request);
      const candidateFile = path.join(f.runner.preparedCandidatePath(prepared.jobId), 'prepared.json');
      const savedCandidate = await readFile(candidateFile, 'utf8');
      const savedState = await readFile(f.runner.jobStateFile, 'utf8');
      if (condition === 'configuration') await writeFile(path.join(f.ops, 'project.env'), f.env + 'CHANGED=true\n');
      if (condition === 'image') {
        const command = f.runner.command;
        f.runner.command = async (name, args) => name === 'docker' && args[0] === 'image'
          ? { code: 0, output: 'sha256:' + 'e'.repeat(64) } : command(name, args);
      }
      if (condition === 'workspace') f.runner.preflight = async () => ({ workspaceClean: false, head: f.base });
      const code = condition === 'configuration' ? 'PREPARED_CANDIDATE_STALE'
        : condition === 'image' ? 'CANDIDATE_IMAGE_INVALID' : 'WORKSPACE_DIRTY';
      await assert.rejects(f.runner.prepareCandidate(f.request), { code });
      assert.deepEqual(f.events, ['build', 'database', 'startup', 'healthy']);
      assert.equal(await readFile(candidateFile, 'utf8'), savedCandidate);
      assert.equal(await readFile(f.runner.jobStateFile, 'utf8'), savedState);
      assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
      assert.equal(f.runner.activeJob, null);
    });
  }
});

test('isolated startup failure preserves branch, production settings and diagnostic state', async (t) => {
  const f = await candidatePreparationFixture(t);
  f.runner.migrateTestDatabase = async () => { throw Object.assign(new Error('Process exited'), { code: 'MIGRATION_EXECUTION_FAILED' }); };
  await assert.rejects(f.runner.prepareCandidate(f.request), { code: 'MIGRATION_EXECUTION_FAILED' });
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.ops, 'project.env'), 'utf8'), f.env);
  assert.equal(f.events.includes('up'), false);
  assert.equal(f.events.includes('recovery-required'), true);
  const state = JSON.parse(await readFile(f.runner.jobStateFile, 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.failedStage, 'test-database-migration');
  assert.equal(f.runner.activeJob, null);
  assert.equal(f.runner.candidateComposeFile, undefined);
});

test('migration container launch failure persists and exposes only bounded redacted Docker diagnostics', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const command = f.runner.command;
  const cleanup = [];
  const audits = [];
  f.runner.migrateTestDatabase = ControlledReleaseRunner.prototype.migrateTestDatabase.bind(f.runner);
  f.runner.waitForTestMigration = async () => assert.fail('A failed launch must not claim container or SQL execution.');
  f.runner.audit = async (entry) => audits.push(entry);
  f.runner.command = async (name, args, options) => {
    if (name === 'docker' && args.includes('run')) {
      assert.ok(args.includes('--file'));
      assert.equal(options.env.FORGE_ADMIN_IMAGE, f.imageId);
      throw Object.assign(new Error('docker failed with exit 1.'), {
        output: 'x'.repeat(9000) + '\ninvalid reference format password=super-secret token=opaque-token '
          + 'mysql://operator:uri-secret@mysql.internal/test {"MYSQL_PASSWORD":"json-secret"}',
      });
    }
    if (name === 'docker' && ['stop', 'rm'].includes(args[0])) {
      cleanup.push(args);
      return { code: 0, output: '' };
    }
    return command(name, args, options);
  };
  const server = createReleaseRunnerServer({ runner: f.runner });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.request),
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'MIGRATION_CONTAINER_START_FAILED');
  assert.equal(body.error.stage, 'test-database-migration');
  assert.match(body.error.diagnosticExcerpt, /invalid reference format/);
  assert.match(body.error.diagnosticExcerpt, /password=\[REDACTED\]/);
  assert.match(body.error.diagnosticExcerpt, /token=\[REDACTED\]/);
  assert.match(body.error.diagnosticExcerpt, /mysql:\/\/\[REDACTED\]@/);
  assert.match(body.error.diagnosticExcerpt, /"MYSQL_PASSWORD":"\[REDACTED\]"/);
  assert.ok(body.error.diagnosticExcerpt.length <= 8192);
  const state = JSON.parse(await readFile(f.runner.jobStateFile, 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.failedStage, 'test-database-migration');
  assert.deepEqual(state.error, body.error);
  assert.deepEqual(audits.at(-1).error, body.error);
  assert.doesNotMatch(JSON.stringify({ body, state, audits }), /super-secret|opaque-token|uri-secret|json-secret/);
  assert.deepEqual(cleanup.map((args) => args[0]), ['stop', 'rm']);
  assert.equal(cleanup[0].at(-1), cleanup[1].at(-1));
  assert.deepEqual(f.events, ['build', 'database', 'recovery-required']);
  assert.equal(await f.runGit('rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.ops, 'project.env'), 'utf8'), f.env);
  assert.equal(f.runner.activeJob, null);
});

test('prepared release rejects changed identity, services, source, config and missing exact images', async (t) => {
  const f = await candidatePreparationFixture(t);
  const prepared = await f.runner.prepareCandidate(f.request);
  const request = { ...f.request, action: 'release', preparedJobId: prepared.jobId };
  for (const variant of [
    { ...request, provenance: { ...request.provenance, taskId: 'another-task' } },
    { ...request, services: ['forge-ui'] },
    { ...request, provenance: { ...request.provenance, candidateCommit: f.base } },
    { ...request, version: 'another-version' },
  ]) await assert.rejects(f.runner.readPreparedCandidate(variant, f.commit), { code: 'PREPARED_CANDIDATE_STALE' });
  await writeFile(path.join(f.ops, 'project.env'), f.env + 'CHANGED=true\n');
  await assert.rejects(f.runner.readPreparedCandidate(request, f.commit), { code: 'PREPARED_CANDIDATE_STALE' });
  await writeFile(path.join(f.ops, 'project.env'), f.env);
  const originalCommand = f.runner.command;
  f.runner.command = async (name, args) => name === 'docker' && args[0] === 'image'
    ? { code: 0, output: 'sha256:' + 'e'.repeat(64) } : originalCommand(name, args);
  await assert.rejects(f.runner.readPreparedCandidate(request, f.commit), { code: 'CANDIDATE_IMAGE_INVALID' });
  assert.equal(f.events.includes('up'), false);
});

async function uiDatabaseFixture(t, change = 'ui') {
  const f = await candidatePreparationFixture(t);
  await mkdir(path.join(f.workspace, 'forge-admin-ui/src'), { recursive: true });
  await writeFile(path.join(f.workspace, 'forge-admin-ui/src/panel.js'), 'export const label = "old";\n');
  await writeFile(path.join(f.workspace, 'forge-server/backend.java'), 'class Backend {}\n');
  await f.runGit('add', '.'); await f.runGit('commit', '-m', 'published baseline');
  const baseline = await f.runGit('rev-parse', 'HEAD');
  if (change === 'delete-ui') await f.runGit('rm', 'forge-admin-ui/src/panel.js');
  else if (change === 'rename-out') await f.runGit('mv', 'forge-admin-ui/src/panel.js', 'forge-server/panel.js');
  else await writeFile(path.join(f.workspace, 'forge-admin-ui/src/panel.js'), 'export const label = "new";\n');
  if (change === 'backend') await writeFile(path.join(f.workspace, 'forge-server/backend.java'), 'class Backend { int changed; }\n');
  if (change === 'migration') await writeFile(path.join(f.workspace, 'forge-server/db/migration/V1.0.2__new.sql'), 'CREATE TABLE other (id INT);\n');
  if (change === 'delete-backend') await f.runGit('rm', 'forge-server/backend.java');
  if (change === 'rename-in') await f.runGit('mv', 'forge-server/backend.java', 'forge-admin-ui/src/backend.java');
  await f.runGit('add', '.'); await f.runGit('commit', '-m', 'candidate changes');
  const candidate = await f.runGit('rev-parse', 'HEAD');
  const environment = f.env.replace(f.base, baseline) + 'FORGE_UI_IMAGE=fixture/ui:old\n';
  await writeFile(f.runner.envFile, environment);
  await f.runner.recordJobState({ schemaVersion: 1, status: 'success', stage: 'complete', result: { commit: baseline } });
  const previousCommand = f.runner.command;
  f.runner.command = async (name, args) => {
    if (name === 'docker' && args.includes('build')) { f.events.push('build'); return { code: 0, output: '' }; }
    return previousCommand(name, args);
  };
  f.runner.migrateTestDatabase = async () => f.events.push('startup');
  const request = { ...f.request, services: ['forge-ui'], provenance: { ...f.request.provenance, candidateCommit: candidate } };
  return { ...f, baseline, candidate, environment, request };
}

test('UI-only database validation uses the successful baseline in both release entrances', async (t) => {
  for (const action of ['prepare', 'release']) {
    for (const change of ['ui', 'delete-ui', 'backend', 'migration', 'delete-backend', 'rename-out', 'rename-in']) {
      await t.test(`${action} ${change}`, async (t) => {
        const f = await uiDatabaseFixture(t, change);
        if (action === 'prepare') await f.runGit('checkout', '--detach', f.baseline);
        const result = action === 'prepare' ? await f.runner.prepareCandidate(f.request)
          : await f.runner.release({ ...f.request, action: 'release' });
        assert.deepEqual(f.events.filter(event => ['database', 'startup', 'healthy'].includes(event)), []);
        const evidence = action === 'prepare'
          ? JSON.parse(await readFile(path.join(f.runner.preparedCandidatePath(result.jobId), 'prepared.json'), 'utf8'))
          : result;
        assert.deepEqual(evidence.testDatabaseSandbox, {
          mode: 'not-required', reason: 'frontend-only-services', baselineCommit: f.baseline, candidateCommit: f.candidate,
        });
        assert.equal(f.events.filter(event => event === 'build').length, 1);
      });
    }
  }
});

test('UI-only database validation retains the existing path without a proven successful baseline', async (t) => {
  for (const action of ['prepare', 'release']) {
    for (const condition of ['failed', 'running', 'mismatched', 'missing', 'invalid', 'unavailable']) {
      await t.test(`${action} ${condition}`, async (t) => {
        const f = await uiDatabaseFixture(t);
        const previous = { schemaVersion: 1, status: 'success', stage: 'complete', result: { commit: f.baseline } };
        if (condition === 'failed' || condition === 'running') {
          previous.status = condition;
          // Publishing may have advanced env before startup failed or was interrupted.
          previous.result.commit = f.candidate;
          await writeFile(f.runner.envFile, f.environment.replace(f.baseline, f.candidate));
        }
        if (condition === 'mismatched') previous.result.commit = f.candidate;
        if (condition === 'invalid') await writeFile(f.runner.envFile, f.environment.replace(f.baseline, 'invalid'));
        if (condition === 'unavailable') {
          previous.result.commit = 'f'.repeat(40);
          await writeFile(f.runner.envFile, f.environment.replace(f.baseline, previous.result.commit));
        }
        await f.runner.recordJobState(previous);
        if (condition === 'missing') await rm(f.runner.jobStateFile);
        if (action === 'prepare') await f.runGit('checkout', '--detach', f.baseline);
        // An unknown baseline is tested only at the optimization boundary; the
        // existing migration preflight remains independently enforced.
        if (condition === 'invalid' || condition === 'unavailable') f.runner.validateMigrations = async () => ({});
        if (action === 'prepare') await f.runner.prepareCandidate(f.request);
        else await f.runner.release({ ...f.request, action: 'release' });
        assert.deepEqual(f.events.filter(event => ['database', 'startup', 'healthy'].includes(event)), ['database', 'startup', 'healthy']);
      });
    }
  }
});

async function recordedSnapshotFailureFixture(f, { literal = false } = {}) {
  const recorded = JSON.parse(await readFile(new URL('./fixtures/frontend-ui-snapshot-failed-baseline.json', import.meta.url), 'utf8'));
  const { released, prepared, failed } = recorded;
  const contract = await f.runner.loadContract();
  const baseline = literal ? released.commit : f.baseline;
  const candidate = literal ? failed.commit : f.candidate;
  released.commit = prepared.commit = baseline;
  released.provenance.candidateCommit = prepared.provenance.candidateCommit = baseline;
  failed.commit = failed.provenance.candidateCommit = candidate;
  const environment = Object.entries({ ...recorded.currentPins, FORGE_ADMIN_COMMIT: baseline })
    .map(([key, value]) => `${key}=${value}\n`).join('');
  await writeFile(f.runner.envFile, environment);
  await f.runner.recordJobState(failed);
  const preparedFile = path.join(f.runner.preparedCandidatePath(prepared.jobId), 'prepared.json');
  await mkdir(path.dirname(preparedFile), { recursive: true });
  await writeFile(preparedFile, JSON.stringify(prepared));
  const records = [{ type: 'candidate-preparation', ...prepared }, released];
  const writeAudit = () => writeFile(f.runner.auditFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  await writeAudit();
  const containers = recorded.containers.map(container => ({ ...container, running: true, project: contract.composeProjectName }));
  const originalCompose = f.runner.compose;
  f.runner.compose = async (...args) => args[0] === 'ps' && args[1] === '--quiet'
    ? { code: 0, output: containers.filter(container => args.slice(2).includes(container.service)).map(container => container.id).join('\n') } : originalCompose(...args);
  const originalCommand = f.runner.command;
  f.runner.command = async (name, args, options) => {
    if (name === 'docker' && args[0] === 'inspect') return { code: 0, output: containers.filter(container => args.includes(container.id)).map(container => JSON.stringify(container)).join('\n') };
    if (literal && name === 'git' && args.includes('diff')) {
      assert.deepEqual(args.slice(-3), [baseline, candidate, '--']);
      return { code: 0, output: recorded.changedPaths.join('\0') + '\0' };
    }
    if (literal && name === 'git' && args.includes('cat-file')) {
      assert.equal(args.at(-1), `${baseline}^{commit}`);
      return { code: 0, output: '' };
    }
    return originalCommand(name, args, options);
  };
  return { recorded, released, prepared, failed, baseline, candidate, environment, preparedFile, records, writeAudit, containers };
}

test('UI-only database validation recovers the recorded snapshot failure without changing its state', async (t) => {
  const f = await uiDatabaseFixture(t);
  const r = await recordedSnapshotFailureFixture(f, { literal: true });
  const before = await readFile(f.runner.jobStateFile);
  const request = { ...f.request, provenance: { ...f.request.provenance, candidateCommit: r.candidate } };
  assert.equal(r.failed.jobId, '4d66ade7-eabb-41f0-a365-e907ea7258fe');
  assert.equal(r.released.jobId, 'f34ba122-5977-4a03-9fee-d8c67208ddf9');
  assert.deepEqual(await f.runner.uiOnlyDatabaseSkip(request, r.candidate, r.failed), {
    mode: 'not-required', reason: 'frontend-only-services', baselineCommit: r.baseline, candidateCommit: r.candidate,
  });
  assert.equal(await f.runner.uiOnlyDatabaseSkip({ ...request, runtimePreparation: {} }, r.candidate, r.failed), null);
  assert.deepEqual(await readFile(f.runner.jobStateFile), before);
  assert.equal(r.recorded.error.diagnosticExcerpt, 'docker failed with exit 143.');
  assert.equal(r.recorded.cleanupPending.containerId, 'f0cc0237fb1eea1852a69af7a864fa2561c098856220b66f63ffb2afecc1d773');
});

test('UI-only database validation bounds snapshot recovery in both release entrances', async (t) => {
  for (const action of ['prepare', 'release']) {
    for (const condition of ['matching', 'backend', 'migration', 'admin-service', 'env-commit', 'env-image', 'runtime-image',
      'runtime-project', 'missing-success', 'missing-prepared', 'prepared-mismatch', 'restore-required', 'applied-failure', 'running']) {
      await t.test(`${action} ${condition}`, async (t) => {
        const f = await uiDatabaseFixture(t, condition);
        const r = await recordedSnapshotFailureFixture(f);
        if (condition === 'admin-service') f.request.services = ['forge-admin', 'forge-ui'];
        if (condition === 'env-commit') await writeFile(f.runner.envFile, r.environment.replace(r.baseline, r.candidate));
        if (condition === 'env-image') await writeFile(f.runner.envFile, r.environment.replace(r.released.images['forge-admin'].id, 'sha256:' + 'e'.repeat(64)));
        if (condition === 'runtime-image') r.containers[0].image = 'sha256:' + 'e'.repeat(64);
        if (condition === 'runtime-project') r.containers[0].project = 'another-project';
        if (condition === 'missing-success') { r.records.pop(); await r.writeAudit(); }
        if (condition === 'missing-prepared') await rm(r.preparedFile);
        if (condition === 'prepared-mismatch') await writeFile(r.preparedFile, JSON.stringify({ ...r.prepared, commit: r.candidate }));
        if (condition === 'restore-required') r.failed.testDatabaseSandbox.restoreRequired = true;
        if (condition === 'applied-failure') r.failed.failedStage = 'application-smoke';
        if (condition === 'running') r.failed.status = 'running';
        await f.runner.recordJobState(r.failed);
        const auditBefore = await readFile(f.runner.auditFile);
        if (action === 'prepare') await f.runGit('checkout', '--detach', f.baseline);
        if (action === 'prepare') await f.runner.prepareCandidate(f.request);
        else await f.runner.release({ ...f.request, action: 'release' });
        assert.deepEqual(f.events.filter(event => ['database', 'startup', 'healthy'].includes(event)),
          ['matching', 'backend', 'migration'].includes(condition) ? [] : ['database', 'startup', 'healthy']);
        assert.equal(f.events.filter(event => event === 'build').length, 1);
        assert.deepEqual(await readFile(f.runner.auditFile), auditBefore, 'historical success and failure provenance is not rewritten');
      });
    }
  }
});

test('UI-only release excludes inherited backend changes after a backend-only published baseline', async (t) => {
  for (const action of ['prepare', 'release']) {
    await t.test(action, async (t) => {
      const f = await uiDatabaseFixture(t, 'backend');
      const r = await recordedSnapshotFailureFixture(f);
      // The observed successful baseline published backend services separately
      // from UI; its snapshot failure did not deploy the later mixed Git tree.
      r.released.services = r.prepared.services = ['forge-admin'];
      r.records[0].services = r.prepared.services;
      delete r.released.images['forge-ui'];
      delete r.prepared.images['forge-ui'];
      await writeFile(r.preparedFile, JSON.stringify(r.prepared));
      await r.writeAudit();
      const auditBefore = await readFile(f.runner.auditFile);
      if (action === 'prepare') await f.runGit('checkout', '--detach', f.baseline);
      if (action === 'prepare') await f.runner.prepareCandidate(f.request);
      else await f.runner.release({ ...f.request, action: 'release' });
      assert.deepEqual(f.events.filter(event => ['database', 'startup', 'healthy'].includes(event)), []);
      assert.equal(f.events.filter(event => event === 'build').length, 1);
      assert.equal((await readFile(f.runner.envFile, 'utf8')).split('\n').find(line => line.startsWith('FORGE_ADMIN_IMAGE=')),
        r.environment.split('\n').find(line => line.startsWith('FORGE_ADMIN_IMAGE=')));
      assert.deepEqual(await readFile(f.runner.auditFile), auditBefore);
      assert.equal(await f.runner.uiOnlyDatabaseSkip({ ...f.request, services: ['forge-admin', 'forge-ui'] }, f.candidate, r.failed), null);
      assert.equal(await f.runner.uiOnlyDatabaseSkip({ ...f.request, runtimePreparation: {} }, f.candidate, r.failed), null);
    });
  }
});


test('unpublished candidate migrations restore the pre-candidate baseline until real release succeeds', async (t) => {
  const f = await candidatePreparationFixture(t, { literalGitBytes: true });
  const runner = f.runner;
  const contract = await runner.loadContract();
  contract.release.testDatabaseLifecycle.backupRoot = path.join(runner.backupsRoot, 'test-database-snapshots');
  await writeFile(path.join(f.ops, 'runtime-contract.json'), JSON.stringify(contract));
  runner.prepareTestDatabase = ControlledReleaseRunner.prototype.prepareTestDatabase;
  runner.markTestDatabaseHealthy = ControlledReleaseRunner.prototype.markTestDatabaseHealthy;
  runner.markTestDatabasePublished = ControlledReleaseRunner.prototype.markTestDatabasePublished;
  runner.markTestDatabaseRecoveryRequired = ControlledReleaseRunner.prototype.markTestDatabaseRecoveryRequired;
  runner.cleanupInterruptedTestMigrationContainers = async () => [];
  let database = { candidate: 'released-baseline', objectCount: 142 };
  let nextCandidate = 'A';
  let expectedIncoming = 'released-baseline';
  const operations = [];
  const snapshots = [];
  runner.runTestDatabaseOperator = async (action, _contract, environment = {}) => {
    operations.push(action);
    if (action === 'plan') return { code: 0, output: `DATABASE=${contract.infrastructure.mysql.testDatabase}\nOBJECT_COUNT=${database.objectCount}\nFAILED_HISTORY_COUNT=0\nACTIVE_CONNECTIONS=0\n` };
    if (action === 'snapshot') {
      const bytes = Buffer.from(JSON.stringify(database));
      const name = path.basename(environment.FORGE_BACKUP_FILE);
      const file = path.join(contract.release.testDatabaseLifecycle.backupRoot, name);
      await writeFile(file, bytes);
      snapshots.push({ file, bytes });
      const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
      return { code: 0, output: `BACKUP_FILE=${environment.FORGE_BACKUP_FILE}\nBACKUP_SHA256=${checksum}\nBACKUP_BYTES=${bytes.length}\n` };
    }
    if (action === 'restore') {
      const bytes = await readFile(path.join(contract.release.testDatabaseLifecycle.backupRoot, path.basename(environment.FORGE_BACKUP_FILE)));
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), environment.FORGE_BACKUP_SHA256);
      database = JSON.parse(bytes);
      return { code: 0, output: `DATABASE=${contract.infrastructure.mysql.testDatabase}\nOBJECT_COUNT_AFTER=${database.objectCount}\nFAILED_HISTORY_COUNT_AFTER=0\nBACKUP_SHA256=${environment.FORGE_BACKUP_SHA256}\nRESTORE_MODE=verified-snapshot-import\n` };
    }
    throw new Error(`Unexpected operator action ${action}`);
  };
  runner.migrateTestDatabase = async () => {
    operations.push(`migrate-${nextCandidate}`);
    assert.equal(database.candidate, expectedIncoming, 'a different unpublished candidate must start from the retained pre-candidate database');
    database = { candidate: nextCandidate, objectCount: database.objectCount + 1 };
  };
  const preparedA = await runner.prepareCandidate(f.request);
  const recoveryA = await runner.readTestDatabaseRecoveryState();
  const originalPoint = await readFile(snapshots[0].file);
  assert.equal(database.candidate, 'A');
  const envBefore = await readFile(path.join(f.ops, 'project.env'));
  const makeCandidate = async (parent, label) => {
    const previousHead = await f.runGit('rev-parse', 'HEAD');
    await f.runGit('checkout', '--detach', parent);
    await writeFile(path.join(f.workspace, 'candidate-revision.txt'), label + '\n');
    await f.runGit('add', '.'); await f.runGit('commit', '-m', `isolated candidate ${label}`);
    const commit = await f.runGit('rev-parse', 'HEAD');
    await f.runGit('checkout', '--detach', previousHead);
    return commit;
  };
  const commitB = await makeCandidate(f.commit, 'B');
  const requestB = { ...f.request, provenance: { ...f.request.provenance, candidateCommit: commitB } };
  nextCandidate = 'B';
  const startB = operations.length;
  const preparedB = await runner.prepareCandidate(requestB);
  assert.deepEqual(operations.slice(startB), ['plan', 'restore', 'plan', 'snapshot', 'migrate-B']);
  assert.equal(recoveryA.lastAttempt.published, false);
  assert.equal((await runner.readTestDatabaseRecoveryState()).lastAttempt.published, false);
  assert.deepEqual(await readFile(snapshots[0].file), originalPoint);
  assert.deepEqual(snapshots[1].bytes, originalPoint);
  assert.equal(JSON.parse(originalPoint).candidate, 'released-baseline');
  assert.deepEqual(await readFile(path.join(f.ops, 'project.env')), envBefore);
  assert.notEqual(preparedB.jobId, preparedA.jobId);
  await f.runGit('merge', '--ff-only', commitB);
  let smokeCalls = 0;
  runner.waitForUi = async () => { if (++smokeCalls === 1) throw new Error('isolated application smoke failure'); return { status: 200 }; };
  await assert.rejects(runner.release({ ...requestB, action: 'release', preparedJobId: preparedB.jobId }), { code: 'APPLICATION_SMOKE_FAILED' });
  const afterFailure = await runner.readTestDatabaseRecoveryState();
  assert.equal(afterFailure.lastAttempt.published, false);
  assert.equal(afterFailure.lastAttempt.jobId, preparedB.jobId);
  const released = await runner.release({ ...requestB, action: 'release', preparedJobId: preparedB.jobId });
  const afterRelease = await runner.readTestDatabaseRecoveryState();
  assert.equal(afterRelease.lastAttempt.published, true);
  assert.equal(afterRelease.lastAttempt.jobId, preparedB.jobId, 'prepared ownership differs from the publication job');
  assert.equal(afterRelease.lastAttempt.commit, commitB);
  assert.equal(afterRelease.lastAttempt.releaseJobId, released.jobId);
  const commitC = await makeCandidate(commitB, 'C');
  const requestC = { ...f.request, provenance: { ...f.request.provenance, candidateCommit: commitC } };
  nextCandidate = 'C'; expectedIncoming = 'B';
  const startC = operations.length;
  await runner.prepareCandidate(requestC);
  assert.deepEqual(operations.slice(startC), ['plan', 'snapshot', 'migrate-C']);
  assert.equal(JSON.parse(snapshots.at(-1).bytes).candidate, 'B');
  // Ordinary release has the same unpublished boundary until its own deployment succeeds.
  await f.runGit('merge', '--ff-only', commitC);
  const originalCommand = runner.command;
  runner.command = async (name, args, options) => name === 'docker' && args.includes('build')
    ? { code: 0, output: '' } : originalCommand(name, args, options);
  smokeCalls = 0;
  await assert.rejects(runner.release({ ...requestC, action: 'release' }), { code: 'APPLICATION_SMOKE_FAILED' });
  const ordinaryFailure = await runner.readTestDatabaseRecoveryState();
  assert.equal(ordinaryFailure.lastAttempt.published, false);
  assert.equal(ordinaryFailure.lastAttempt.commit, commitC);
  assert.equal(ordinaryFailure.lastAttempt.releaseJobId, undefined);
  assert.equal(JSON.parse(snapshots.at(-1).bytes).candidate, 'B');
  // A UI-only publication can still have prepared a test migration. It does
  // not publish the Admin image, so that candidate must not become a baseline.
  nextCandidate = 'UI-only';
  const uiRequest = { ...requestC, services: ['forge-ui'] };
  const preparedUi = await runner.prepareCandidate(uiRequest);
  const beforeUiRelease = await runner.readTestDatabaseRecoveryState();
  assert.equal(beforeUiRelease.lastAttempt.published, false);
  assert.equal(beforeUiRelease.lastAttempt.jobId, preparedUi.jobId);
  const releasedUi = await runner.release({ ...uiRequest, action: 'release', preparedJobId: preparedUi.jobId });
  assert.deepEqual(releasedUi.services, ['forge-ui']);
  assert.deepEqual(await runner.readTestDatabaseRecoveryState(), beforeUiRelease);
  assert.equal(runner.activeJob, null);
});
