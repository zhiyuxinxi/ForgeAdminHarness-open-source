import path from 'node:path';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DATABASE_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const TASKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const FLYWAY_VERSION_PATTERN = /^\d{1,10}(?:[._-]\d{1,10}){0,15}$/;
const FORBIDDEN_SERVICE_PATTERN = /(?:^|[-_])(mysql|mariadb|postgres(?:ql)?|redis|mongodb|elastic(?:search)?)(?:$|[-_])/i;
const FORBIDDEN_IMAGE_PATTERN = /(?:^|[/:_-])(mysql|mariadb|postgres(?:ql)?|redis|mongodb|elastic(?:search)?)(?=[:/@_-]|$)/i;
const FORBIDDEN_HOST_PORTS = new Set([3306, 5432, 6379, 27017, 9200, 9300]);
const FORBIDDEN_SQL = [
  /\b(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA)\b/i,
  /\b(?:CREATE|ALTER|DROP)\s+USER\b/i,
  /\bGRANT\s+.+\s+TO\b/i,
  /\bREVOKE\s+.+\s+FROM\b/i,
  /\bSET\s+(?:GLOBAL|PERSIST)\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?/i,
  /\bDROP\s+INDEX\b/i,
  /\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN|CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY)\b/i,
];

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unexpected fields: ${actual.join(', ')}`);
  }
};

const assertString = (value, pattern, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
};

const assertInteger = (value, minimum, maximum, label) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
};

function migrationPolicyError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.stage = 'preflight';
  error.retryable = false;
  error.recommendedAction = 'Correct the migration files in the project workspace, commit the fix, and run preflight again.';
  if (details !== undefined) error.details = details;
  return error;
}

function compareVersionParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseFlywayMigrationPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length < 1 || relativePath.includes('\0')) {
    throw migrationPolicyError('MIGRATION_NAME_INVALID', 'Migration path is invalid.');
  }
  const normalized = relativePath.replaceAll('\\', '/');
  const fileName = path.posix.basename(normalized);
  const repeatable = /^R__(.+)\.sql$/i.exec(fileName);
  if (repeatable) {
    return {
      type: 'repeatable',
      fileName,
      relativePath: normalized,
      description: repeatable[1],
    };
  }
  const versioned = /^V(.+?)__(.+)\.sql$/i.exec(fileName);
  if (!versioned || !FLYWAY_VERSION_PATTERN.test(versioned[1])) {
    throw migrationPolicyError(
      'MIGRATION_NAME_INVALID',
      `Migration filename does not follow V<version>__<description>.sql or R__<description>.sql: ${fileName}`,
      { files: [normalized] },
    );
  }
  const parts = versioned[1].split(/[._-]/).map(Number);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return {
    type: 'versioned',
    fileName,
    relativePath: normalized,
    description: versioned[2],
    version: versioned[1],
    versionKey: parts.join('.'),
    versionParts: parts,
  };
}

export function validateFlywayMigrationInventory(currentPaths, releasedPaths = []) {
  if (!Array.isArray(currentPaths) || !Array.isArray(releasedPaths)) {
    throw new TypeError('Migration inventories must be arrays.');
  }
  const current = currentPaths.map(parseFlywayMigrationPath);
  const released = releasedPaths.map(parseFlywayMigrationPath);
  const versions = new Map();
  for (const migration of current.filter(({ type }) => type === 'versioned')) {
    const existing = versions.get(migration.versionKey) ?? [];
    existing.push(migration.relativePath);
    versions.set(migration.versionKey, existing);
  }
  const duplicate = [...versions.entries()].find(([, files]) => files.length > 1);
  if (duplicate) {
    throw migrationPolicyError(
      'MIGRATION_VERSION_CONFLICT',
      `Flyway migration version ${duplicate[0]} is used by more than one file.`,
      { version: duplicate[0], files: duplicate[1] },
    );
  }

  const currentPathSet = new Set(current.map(({ relativePath }) => relativePath));
  const missingReleased = released
    .filter(({ type, relativePath }) => type === 'versioned' && !currentPathSet.has(relativePath))
    .map(({ relativePath }) => relativePath);
  if (missingReleased.length > 0) {
    throw migrationPolicyError(
      'MIGRATION_HISTORY_IMMUTABLE',
      'Previously released Flyway migrations must not be deleted or renamed.',
      { files: missingReleased },
    );
  }

  const releasedVersioned = released.filter(({ type }) => type === 'versioned');
  const latestReleased = releasedVersioned.reduce(
    (latest, migration) => (!latest || compareVersionParts(migration.versionParts, latest.versionParts) > 0
      ? migration
      : latest),
    null,
  );
  const releasedPathSet = new Set(released.map(({ relativePath }) => relativePath));
  const newVersioned = current.filter(
    ({ type, relativePath }) => type === 'versioned' && !releasedPathSet.has(relativePath),
  );
  const nonForward = latestReleased && newVersioned.filter(
    (migration) => compareVersionParts(migration.versionParts, latestReleased.versionParts) <= 0,
  );
  if (nonForward && nonForward.length > 0) {
    throw migrationPolicyError(
      'MIGRATION_VERSION_NOT_FORWARD',
      `New Flyway migrations must be later than the released version ${latestReleased.versionKey}.`,
      { latestReleasedVersion: latestReleased.versionKey, files: nonForward.map(({ relativePath }) => relativePath) },
    );
  }

  const latestCurrent = current
    .filter(({ type }) => type === 'versioned')
    .reduce(
      (latest, migration) => (!latest || compareVersionParts(migration.versionParts, latest.versionParts) > 0
        ? migration
        : latest),
      null,
    );
  return {
    totalFiles: current.length,
    versionedFiles: current.filter(({ type }) => type === 'versioned').length,
    repeatableFiles: current.filter(({ type }) => type === 'repeatable').length,
    releasedVersion: latestReleased?.versionKey ?? null,
    latestVersion: latestCurrent?.versionKey ?? null,
    newVersions: newVersioned
      .sort((left, right) => compareVersionParts(left.versionParts, right.versionParts))
      .map(({ versionKey }) => versionKey),
  };
}

const normalizedAbsolutePath = (value, label) => {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute POSIX path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '/') {
    throw new Error(`${label} is not a normalized scoped path.`);
  }
  return normalized;
};

export function validateRuntimeContract(contract) {
  exactKeys(contract, [
    'schemaVersion',
    'projectSlug',
    'composeProjectName',
    'projectRoot',
    'workspaceRoot',
    'infrastructure',
    'release',
  ], 'runtime contract');
  if (contract.schemaVersion !== 3) {
    throw new Error('runtime contract schemaVersion must be 3.');
  }

  const slug = assertString(contract.projectSlug, SLUG_PATTERN, 'projectSlug');
  if (contract.composeProjectName !== `forge-${slug}`) {
    throw new Error('composeProjectName does not match the project slug.');
  }
  const projectRoot = normalizedAbsolutePath(contract.projectRoot, 'projectRoot');
  const workspaceRoot = normalizedAbsolutePath(contract.workspaceRoot, 'workspaceRoot');
  if (workspaceRoot !== `${projectRoot}/workspace`) {
    throw new Error('workspaceRoot must be the current project workspace.');
  }

  exactKeys(contract.infrastructure, ['mysql', 'redis'], 'infrastructure');
  exactKeys(contract.infrastructure.mysql, [
    'mode', 'host', 'port', 'database', 'testDatabase', 'provisioningAllowed',
  ], 'infrastructure.mysql');
  exactKeys(contract.infrastructure.redis, [
    'mode', 'host', 'port', 'database', 'testDatabase', 'provisioningAllowed',
  ], 'infrastructure.redis');

  const mysql = contract.infrastructure.mysql;
  if (mysql.mode !== 'shared-external' || mysql.provisioningAllowed !== false) {
    throw new Error('MySQL must be a shared external service with provisioning disabled.');
  }
  if (typeof mysql.host !== 'string' || mysql.host.length < 1 || mysql.host.length > 255) {
    throw new Error('MySQL host is invalid.');
  }
  assertInteger(mysql.port, 1, 65535, 'MySQL port');
  assertString(mysql.database, DATABASE_NAME_PATTERN, 'MySQL database');
  assertString(mysql.testDatabase, DATABASE_NAME_PATTERN, 'MySQL test database');
  if (mysql.database === mysql.testDatabase || mysql.testDatabase !== `${mysql.database}_test`) {
    throw new Error('MySQL test database must be the dedicated <database>_test schema.');
  }

  const redis = contract.infrastructure.redis;
  if (redis.mode !== 'shared-external' || redis.provisioningAllowed !== false) {
    throw new Error('Redis must be a shared external service with provisioning disabled.');
  }
  if (typeof redis.host !== 'string' || redis.host.length < 1 || redis.host.length > 255) {
    throw new Error('Redis host is invalid.');
  }
  assertInteger(redis.port, 1, 65535, 'Redis port');
  assertInteger(redis.database, 0, 15, 'Redis database');
  assertInteger(redis.testDatabase, 0, 15, 'Redis test database');
  if (redis.database === redis.testDatabase) {
    throw new Error('Redis runtime and test databases must differ.');
  }

  exactKeys(contract.release, [
    'fixedComposeFile',
    'allowedComposeServices',
    'allowedReleaseServices',
    'protectedFiles',
    'databaseProvisioningAllowed',
    'workspaceComposeAllowed',
    'testDatabaseLifecycle',
    ...(Object.hasOwn(contract.release, 'protectedCandidateApproval') ? ['protectedCandidateApproval'] : []),
  ], 'release');
  if (contract.release.fixedComposeFile !== `${projectRoot}/ops/compose.yaml`) {
    throw new Error('fixedComposeFile must be the platform-managed project Compose file.');
  }
  if (contract.release.databaseProvisioningAllowed !== false || contract.release.workspaceComposeAllowed !== false) {
    throw new Error('database provisioning and workspace Compose execution must remain disabled.');
  }
  exactKeys(contract.release.testDatabaseLifecycle, [
    'mode',
    'backupRequired',
    'restoreOnFailure',
    'fullReplaySupported',
    'operatorImage',
    'backupRoot',
    'recoveryStateFile',
  ], 'release.testDatabaseLifecycle');
  const testLifecycle = contract.release.testDatabaseLifecycle;
  if (testLifecycle.mode !== 'snapshot-restore-on-failure'
    || testLifecycle.backupRequired !== true
    || testLifecycle.restoreOnFailure !== true
    || testLifecycle.fullReplaySupported !== false) {
    throw new Error('test database lifecycle must use reviewed snapshot-and-restore incremental migration mode.');
  }
  assertString(testLifecycle.operatorImage, DIGEST_IMAGE_PATTERN, 'test database operator image');
  if (testLifecycle.backupRoot !== `${projectRoot}/backups/test-database-snapshots`) {
    throw new Error('test database backupRoot must be the current project snapshot directory.');
  }
  if (testLifecycle.recoveryStateFile !== `${projectRoot}/ops/test-database-recovery.json`) {
    throw new Error('test database recoveryStateFile must be the current project recovery state file.');
  }

  const composeServices = contract.release.allowedComposeServices;
  const releaseServices = contract.release.allowedReleaseServices;
  if (!Array.isArray(composeServices) || !Array.isArray(releaseServices)) {
    throw new Error('release service allowlists must be arrays.');
  }
  const expectedCompose = [
    'forge-admin',
    'forge-app',
    'forge-flow',
    'forge-ui',
    'release-runner',
    'taskspace-broker',
    'conversation-manager',
    'protected-acceptance',
    'verification-runner',
  ];
  const expectedThreeServiceRelease = ['forge-admin', 'forge-flow', 'forge-ui'];
  const expectedFourServiceRelease = ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'];
  const normalizedReleaseServices = [...releaseServices].sort();
  const isThreeServiceRelease = JSON.stringify(normalizedReleaseServices)
    === JSON.stringify(expectedThreeServiceRelease);
  const isFourServiceRelease = JSON.stringify(normalizedReleaseServices)
    === JSON.stringify(expectedFourServiceRelease);
  if (!isThreeServiceRelease && !isFourServiceRelease) {
    throw new Error('allowedReleaseServices does not match a reviewed application service set.');
  }
  const normalizedComposeServices = JSON.stringify([...composeServices].sort());
  const isFourServiceCompose = normalizedComposeServices === JSON.stringify(expectedCompose.sort());
  const isThreeServiceCompose = normalizedComposeServices
    === JSON.stringify(expectedCompose.filter((service) => service !== 'forge-app').sort());
  if (!isFourServiceCompose && !(isThreeServiceRelease && isThreeServiceCompose)) {
    throw new Error('allowedComposeServices does not match the reviewed project stack.');
  }

  if (!Array.isArray(contract.release.protectedFiles)) {
    throw new Error('protectedFiles must contain the reviewed deployment inputs.');
  }
  const seenPaths = new Set();
  for (const item of contract.release.protectedFiles) {
    exactKeys(item, ['relativePath', 'sha256'], 'protected file');
    if (typeof item.relativePath !== 'string' || path.posix.isAbsolute(item.relativePath)) {
      throw new Error('protected file path must be workspace-relative.');
    }
    const normalized = path.posix.normalize(item.relativePath);
    if (normalized !== item.relativePath || normalized.startsWith('../') || normalized === '..') {
      throw new Error('protected file path escapes the workspace.');
    }
    assertString(item.sha256, SHA256_PATTERN, `protected file hash for ${item.relativePath}`);
    if (seenPaths.has(item.relativePath)) {
      throw new Error(`protected file is duplicated: ${item.relativePath}`);
    }
    seenPaths.add(item.relativePath);
  }
  const expectedProtectedPaths = [
    'docker-forge-admin/Dockerfile.admin',
    'docker-forge-admin/Dockerfile.flow',
    'docker-forge-admin/Dockerfile.ui',
    'docker-forge-admin/application-datasource.yml',
    'docker-forge-admin/docker-compose.yml',
    'docker-forge-admin/nginx.conf',
    ...(isFourServiceRelease ? ['docker-forge-admin/Dockerfile.app'] : []),
  ].sort();
  if (JSON.stringify([...seenPaths].sort()) !== JSON.stringify(expectedProtectedPaths)) {
    throw new Error('protectedFiles does not match the reviewed release service set.');
  }
  if (Object.hasOwn(contract.release, 'protectedCandidateApproval')) {
    const approval = contract.release.protectedCandidateApproval;
    exactKeys(approval, ['candidateCommit', 'relativePath', 'beforeSha256', 'sha256'], 'protected candidate approval');
    assertString(approval.candidateCommit, COMMIT_PATTERN, 'protected candidate approval commit');
    assertString(approval.beforeSha256, SHA256_PATTERN, 'protected candidate approval original hash');
    assertString(approval.sha256, SHA256_PATTERN, 'protected candidate approval hash');
    const original = contract.release.protectedFiles.find(item => item.relativePath === approval.relativePath);
    if (original === undefined || original.sha256 !== approval.beforeSha256) {
      throw new Error('protected candidate approval must match an existing protected path and its original hash.');
    }
  }
  return contract;
}

function publishedHostPort(portEntry) {
  if (typeof portEntry === 'number') return portEntry;
  if (typeof portEntry === 'string') {
    const withoutProtocol = portEntry.split('/', 1)[0];
    const segments = withoutProtocol.split(':');
    if (segments.length < 2) return null;
    const published = segments.at(-2);
    return /^\d+$/.test(published) ? Number(published) : null;
  }
  if (portEntry && typeof portEntry === 'object') {
    const value = portEntry.published;
    return value === undefined ? null : Number(value);
  }
  return null;
}

export function validateComposeModel(model, contractInput) {
  const contract = validateRuntimeContract(contractInput);
  const services = model?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error('Compose model does not contain services.');
  }
  const names = Object.keys(services).sort();
  const expected = [...contract.release.allowedComposeServices].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Compose services differ from the contract: ${names.join(', ')}`);
  }
  for (const [name, service] of Object.entries(services)) {
    if (FORBIDDEN_SERVICE_PATTERN.test(name)) {
      throw new Error(`Forbidden infrastructure service: ${name}`);
    }
    if (typeof service?.image === 'string' && FORBIDDEN_IMAGE_PATTERN.test(service.image)) {
      throw new Error(`Forbidden infrastructure image in ${name}.`);
    }
    for (const port of service?.ports ?? []) {
      const published = publishedHostPort(port);
      if (published !== null && FORBIDDEN_HOST_PORTS.has(published)) {
        throw new Error(`Forbidden database/cache port ${published} in ${name}.`);
      }
    }
  }
  return { services: names };
}

const RUNTIME_PROBE_ALIAS = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const RUNTIME_PROBE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const RUNTIME_UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RUNTIME_SECRET_PATH = /password|passwd|(?:^|_)pwd(?:$|_)|token|authorization|cookie|secret|credential|privatekey|encryptedkey|session(?:key|id)|apikey|accesskey|codekey/iu;
const runtimeScalar = value => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 2048;
const runtimeSafeKey = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !RUNTIME_UNSAFE_KEYS.has(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const runtimeAlias = value => typeof value === 'string' && RUNTIME_PROBE_ALIAS.test(value) && !RUNTIME_UNSAFE_KEYS.has(value);
const runtimeRoleKey = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(value) && !RUNTIME_UNSAFE_KEYS.has(value);

function runtimeObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).some(key => !runtimeSafeKey(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new Error(`${label} must be a safe JSON object.`);
  }
}

function runtimeTemplate(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) throw new Error('Runtime API endpoint template is invalid.');
  const parameters = [];
  for (const segment of value.slice(1).split('/')) {
    if (value === '/') break;
    const parameter = /^\{([A-Za-z_][A-Za-z0-9_-]{0,63})\}$/u.exec(segment);
    if (parameter && runtimeAlias(parameter[1])) { parameters.push(parameter[1]); continue; }
    if (!/^[A-Za-z0-9._~-]+$/u.test(segment) || ['.', '..'].includes(segment)) throw new Error('Runtime API endpoint must be a literal relative path without query or encoding.');
  }
  return [...new Set(parameters)];
}

function runtimeValue(value, captures) {
  if (runtimeScalar(value)) return;
  runtimeObject(value, 'Runtime capture reference');
  exactKeys(value, ['$capture'], 'runtime capture reference');
  if (!runtimeAlias(value.$capture) || !captures.has(value.$capture)) throw new Error('Runtime reference requires a previously captured value.');
}

function runtimeJson(value, captures, depth = 0) {
  if (depth > 8) throw new Error('Runtime JSON body exceeds its depth limit.');
  if (runtimeScalar(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('Runtime JSON array is too large.');
    for (const item of value) runtimeJson(item, captures, depth + 1);
    return;
  }
  runtimeObject(value, 'Runtime JSON body');
  if (Object.hasOwn(value, '$capture')) { runtimeValue(value, captures); return; }
  if (Object.keys(value).length > 64) throw new Error('Runtime JSON object is too large.');
  for (const item of Object.values(value)) runtimeJson(item, captures, depth + 1);
}

function runtimeJsonPath(value, capture = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
      || !value.every(part => runtimeSafeKey(part) || Number.isInteger(part) && part >= 0 && part < 10000)
      || capture && value.some(part => typeof part === 'string' && RUNTIME_SECRET_PATH.test(part.replace(/[-_]/gu, '')))) {
    throw new Error('Runtime JSON path is invalid or captures a secret.');
  }
}

function runtimeMultipart(value, captures) {
  runtimeObject(value, 'Runtime multipart');
  exactKeys(value, ['fields', 'file'], 'runtime multipart');
  runtimeObject(value.fields, 'Runtime multipart fields');
  if (Object.keys(value.fields).length > 16) throw new Error('Runtime multipart fields are too large.');
  for (const item of Object.values(value.fields)) {
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > 4096) throw new Error('Runtime multipart field value is too large.');
    } else runtimeValue(item, captures);
  }
  runtimeObject(value.file, 'Runtime multipart file');
  exactKeys(value.file, ['fieldName', 'fileName', 'contentType', 'bytesBase64'], 'runtime multipart file');
  for (const name of [value.file.fieldName, value.file.fileName]) {
    if (!runtimeSafeKey(name) || /^[.]{1,2}$/u.test(name) || /[\p{Cc}/\\:"]/u.test(name)) {
      throw new Error('Runtime multipart names must not contain paths or control characters.');
    }
  }
  if (typeof value.file.contentType !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u.test(value.file.contentType)) {
    throw new Error('Runtime multipart MIME type must be a safe type/subtype.');
  }
  const encoded = value.file.bytesBase64;
  if (typeof encoded !== 'string' || encoded.length > 21848
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error('Runtime multipart file requires canonical base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 1 || bytes.length > 16384 || bytes.toString('base64') !== encoded) {
    throw new Error('Runtime multipart file must contain 1 to 16384 bytes in canonical base64.');
  }
}

function validateRuntimeProbePlanV2(plan) {
  runtimeObject(plan, 'Runtime probe plan');
  if (Object.hasOwn(plan, 'apiScope')) {
    throw new Error('Runtime probe plan must not include apiScope; the Broker injects runtimePreparation.apiScope from the protected accepted domain artifact. Remove apiScope from the plan.');
  }
  if (Object.hasOwn(plan, 'identityScope')) throw new Error('Runtime probe plan must not include identityScope; the Broker injects runtimePreparation.identityScope from the protected accepted access artifact.');
  exactKeys(plan, ['schemaVersion', 'api', 'database', 'browser',
    ...(Object.hasOwn(plan, 'identityFixtures') ? ['identityFixtures'] : [])], 'runtime probe plan');
  runtimeObject(plan.browser, 'Browser probe');
  exactKeys(plan.browser, ['status', 'reason'], 'browser probe');
  if (plan.browser.status !== 'not-executed' || plan.browser.reason !== 'owner-excluded') throw new Error('Browser execution is not authorized.');
  if (!Array.isArray(plan.api) || plan.api.length > 64 || !Array.isArray(plan.database) || plan.database.length > 16) throw new Error('Runtime probes must be bounded arrays.');
  const ids = new Set(); const captures = new Set();
  for (const probe of [...plan.api, ...plan.database]) {
    runtimeObject(probe, 'Runtime probe');
    if (typeof probe.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(probe.id) || RUNTIME_UNSAFE_KEYS.has(probe.id) || ids.has(probe.id)) throw new Error('Runtime probe ids must be safe and unique.');
    ids.add(probe.id);
  }
  for (const probe of plan.api) {
    exactKeys(probe, ['id', 'method', 'path', 'expectedStatus', 'jsonAssertions',
      ...['identity', 'query', 'body', 'pathParameters', 'captures', 'multipart', 'download'].filter(key => Object.hasOwn(probe, key))], 'API probe');
    if (!RUNTIME_PROBE_METHODS.includes(probe.method) || probe.method !== 'GET' && !Object.hasOwn(probe, 'identity')
        || Object.hasOwn(probe, 'identity') && !runtimeAlias(probe.identity)) throw new Error('Runtime API method requires a safe identity alias.');
    const parameters = runtimeTemplate(probe.path);
    if (Object.hasOwn(probe, 'pathParameters')) runtimeObject(probe.pathParameters, 'Runtime path parameters');
    exactKeys(probe.pathParameters ?? {}, parameters, 'runtime path parameters');
    for (const value of Object.values(probe.pathParameters ?? {})) runtimeValue(value, captures);
    if (Object.hasOwn(probe, 'query')) {
      runtimeObject(probe.query, 'Runtime query');
      if (Object.keys(probe.query).length > 64) throw new Error('Runtime query is too large.');
      for (const value of Object.values(probe.query)) runtimeValue(value, captures);
    }
    if (Object.hasOwn(probe, 'body')) {
      if (probe.method === 'GET') throw new Error('GET probes cannot contain a body.');
      runtimeJson(probe.body, captures);
    }
    if (Object.hasOwn(probe, 'multipart')) {
      if (probe.method !== 'POST' || !Object.hasOwn(probe, 'identity')
          || Object.hasOwn(probe, 'body') || Object.hasOwn(probe, 'download')) {
        throw new Error('Runtime multipart requires an authenticated POST without body or download.');
      }
      runtimeMultipart(probe.multipart, captures);
    }
    if (Object.hasOwn(probe, 'download')) {
      if (!Object.hasOwn(probe, 'identity')) throw new Error('Runtime download requires an identity.');
      runtimeObject(probe.download, 'Runtime download');
      exactKeys(probe.download, ['format'], 'runtime download');
      if (!['text', 'xlsx'].includes(probe.download.format)) throw new Error('Runtime download format must be text or xlsx.');
    }
    assertInteger(probe.expectedStatus, 200, 599, 'runtime expected status');
    if (!Array.isArray(probe.jsonAssertions) || probe.jsonAssertions.length > 16) throw new Error('Runtime assertions must be bounded.');
    for (const assertion of probe.jsonAssertions) {
      runtimeObject(assertion, 'Runtime assertion'); exactKeys(assertion, ['path', 'equals'], 'runtime assertion');
      runtimeJsonPath(assertion.path); runtimeValue(assertion.equals, captures);
    }
    if (Object.hasOwn(probe, 'captures')) {
      if (!Array.isArray(probe.captures) || probe.captures.length > 16) throw new Error('Runtime captures must be bounded.');
      for (const capture of probe.captures) {
        runtimeObject(capture, 'Runtime capture'); exactKeys(capture, ['name', 'path'], 'runtime capture');
        if (!runtimeAlias(capture.name) || captures.has(capture.name)) throw new Error('Runtime capture names must be safe and globally unique.');
        runtimeJsonPath(capture.path, true); captures.add(capture.name);
      }
    }
  }
  if (Object.hasOwn(plan, 'identityFixtures')) {
    if (!Array.isArray(plan.identityFixtures) || plan.identityFixtures.length > 16) throw new Error('Runtime identity fixtures must be a bounded array.');
    const referenced = new Set(plan.api.map(probe => probe.identity));
    const identities = new Set();
    for (const fixture of plan.identityFixtures) {
      runtimeObject(fixture, 'Runtime identity fixture'); exactKeys(fixture, ['identity', 'orgId', 'roleKeys'], 'runtime identity fixture');
      if (!runtimeAlias(fixture.identity) || !referenced.has(fixture.identity) || identities.has(fixture.identity)) throw new Error('Runtime identity fixtures require unique referenced aliases.');
      if (typeof fixture.orgId !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(fixture.orgId)
        || BigInt(fixture.orgId) > 9223372036854775807n) throw new Error('Runtime identity fixture organization must be a positive decimal int64 string.');
      if (!Array.isArray(fixture.roleKeys) || fixture.roleKeys.length > 16 || !fixture.roleKeys.every(runtimeRoleKey)
        || new Set(fixture.roleKeys).size !== fixture.roleKeys.length) throw new Error('Runtime identity fixture role keys must be unique and bounded.');
      identities.add(fixture.identity);
    }
  }
  const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(value) && !RUNTIME_UNSAFE_KEYS.has(value);
  for (const probe of plan.database) {
    exactKeys(probe, ['id', 'table', 'columns', 'where', 'limit', 'expectedRows'], 'database probe');
    if (!identifier(probe.table) || !Array.isArray(probe.columns) || probe.columns.length < 1 || probe.columns.length > 16
        || !probe.columns.every(identifier) || new Set(probe.columns).size !== probe.columns.length
        || !Array.isArray(probe.where) || probe.where.length > 16
        || !Number.isInteger(probe.limit) || probe.limit < 1 || probe.limit > 100
        || !Number.isInteger(probe.expectedRows) || probe.expectedRows < 0 || probe.expectedRows > probe.limit) throw new Error('Database probe requires bounded identifiers and row counts.');
    for (const filter of probe.where) {
      runtimeObject(filter, 'Database filter'); exactKeys(filter, ['column', 'equals'], 'database filter');
      if (!identifier(filter.column)) throw new Error('Database filter is invalid.');
      runtimeValue(filter.equals, captures);
    }
  }
  if (Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024) throw new Error('Runtime probe plan is too large.');
  return structuredClone(plan);
}

export function validateRuntimeProbeScope(scope, plan = undefined) {
  runtimeObject(scope, 'Runtime API scope'); exactKeys(scope, ['artifactSha256', 'endpoints'], 'runtime API scope');
  assertString(scope.artifactSha256, SHA256_PATTERN, 'runtime domain artifact digest');
  if (!Array.isArray(scope.endpoints) || scope.endpoints.length > 2048) throw new Error('Runtime API scope endpoints must be bounded.');
  const endpoints = new Set();
  for (const endpoint of scope.endpoints) {
    runtimeObject(endpoint, 'Runtime API scope endpoint'); exactKeys(endpoint, ['method', 'path'], 'runtime API scope endpoint');
    if (!RUNTIME_PROBE_METHODS.includes(endpoint.method)) throw new Error('Runtime API scope method is invalid.');
    runtimeTemplate(endpoint.path);
    const key = `${endpoint.method} ${endpoint.path}`;
    if (endpoints.has(key)) throw new Error('Runtime API scope endpoints must be unique.');
    endpoints.add(key);
  }
  if (plan !== undefined) {
    if (plan?.schemaVersion !== 2) throw new Error('Runtime API scope applies to a v2 probe plan.');
    for (const probe of validateRuntimeProbePlanV2(plan).api) {
      if (!endpoints.has(`${probe.method} ${probe.path}`)) throw new Error('Runtime API probe is outside the protected domain contract.');
    }
  }
  return structuredClone(scope);
}

export function validateRuntimeIdentityScope(scope, plan = undefined) {
  runtimeObject(scope, 'Runtime identity scope'); exactKeys(scope, ['artifactSha256', 'roleKeys'], 'runtime identity scope');
  assertString(scope.artifactSha256, SHA256_PATTERN, 'runtime access artifact digest');
  if (!Array.isArray(scope.roleKeys) || scope.roleKeys.length > 256 || !scope.roleKeys.every(runtimeRoleKey)
    || new Set(scope.roleKeys).size !== scope.roleKeys.length) throw new Error('Runtime identity scope role keys must be unique and bounded.');
  if (plan !== undefined) {
    if (plan?.schemaVersion !== 2) throw new Error('Runtime identity scope applies only to v2 identity fixtures.');
    const fixtures = validateRuntimeProbePlanV2(plan).identityFixtures;
    if (!fixtures?.length) throw new Error('Runtime identity scope requires nonempty identity fixtures.');
    const allowed = new Set(scope.roleKeys);
    if (fixtures.some(fixture => fixture.roleKeys.some(key => !allowed.has(key)))) throw new Error('Runtime identity fixture role is outside the protected access contract.');
  }
  return structuredClone(scope);
}

export function getRuntimeProbeCapabilities() {
  return {
    planFields: ['schemaVersion', 'api', 'database', 'browser'], maxPlanBytes: 32768,
    prepareInput: { command: 'forge-release prepare', requiredSourceFlags: ['--expected-head', '--expected-fingerprint'],
      planFlags: ['--plan-base64', '--plan-json'], planFlagRule: 'exactly-one',
      planJson: "--plan-json '<single-line JSON object>': one single-quoted literal, at most maxPlanBytes of UTF-8. Use JSON \\u0027 for an apostrophe; shell composition, substitutions and encoding helpers are not needed or authorized.",
      planBase64: '--plan-base64 <canonical-base64url-utf8-json>; unchanged existing input.',
      authority: 'Both inputs use the same protected preparation context, source binding and probe-plan validation.' },
    browser: { status: 'not-executed', reason: 'owner-excluded' },
    versions: {
      1: { apiFields: ['id', 'method', 'path', 'expectedStatus', 'jsonAssertions'], methods: ['GET'], limits: { api: 16, database: 16 }, apiScopeRequired: false },
      2: {
        planOptionalFields: ['identityFixtures'],
        identityFixtures: { fields: ['identity', 'orgId', 'roleKeys'], maximum: 16, maximumRoles: 16, organizationsPerIdentity: 1,
          identity: 'A fixed registered QA alias referenced by an API probe; credentials, userId and tenantId cannot be supplied.',
          orgId: 'Positive decimal int64 string obtained from actual read-only evidence of an existing active organization in the QA tenant.',
          roleKeys: 'Unique accepted role keys, including an explicit empty list for a no-role probe; each existing non-admin role must have roleType 2/3/4 and dataScope 3/4/5 and apply to the selected organization.',
          effect: 'Replace only the selected QA organization and role relationships in the isolated candidate _test database. No organization, role or permission resource is created; production is unchanged. Without fixtures, identity preparation is unchanged.' },
        identityScopePlanFieldAllowed: false, identityScopeInjectedBy: 'Broker', identityScopeLocation: 'runtimePreparation.identityScope',
        identityScopeFields: ['artifactSha256', 'roleKeys'], identityScopeAuthority: 'Protected accepted access artifact; fixtures cannot grant undeclared roles.',
        apiRequiredFields: ['id', 'method', 'path', 'expectedStatus', 'jsonAssertions'],
        apiOptionalFields: ['identity', 'query', 'body', 'pathParameters', 'captures', 'multipart', 'download'], methods: [...RUNTIME_PROBE_METHODS],
        nonGetRequiresIdentity: true, getBodyAllowed: false, aliasPattern: RUNTIME_PROBE_ALIAS.source,
        path: 'Literal relative endpoint without query or percent encoding; parameters occupy complete /{name} segments.',
        pathParameters: 'Exact parameter keys, each scalar or reference.', query: 'Safe key to scalar or reference.',
        body: 'Bounded JSON with safe keys and optional reference objects.',
        multipart: { fields: ['fields', 'file'], method: 'POST', requiresIdentity: true, mutuallyExclusiveWith: ['body', 'download'],
          fieldValues: 'Safe keys to scalar values or earlier capture references; at most 16 fields and 4096 UTF-8 bytes per string value.',
          fileFields: ['fieldName', 'fileName', 'contentType', 'bytesBase64'], maximumFiles: 1, minimumFileBytes: 1, maximumFileBytes: 16384,
          names: 'Nonempty safe names of at most 128 characters; paths, quotes, colons and control characters are forbidden.',
          contentType: 'Safe MIME type/subtype without parameters or header controls.',
          bytesBase64: 'Canonical padded standard base64 containing the file bytes; host file paths and unknown file fields are forbidden.' },
        download: { fields: ['format'], formats: ['text', 'xlsx'], requiresIdentity: true, mutuallyExclusiveWith: ['multipart'],
          assertionProjection: ['contentType', 'fileName', 'byteLength', 'sha256'],
          textProjection: 'text', xlsxProjection: 'rows',
          assertions: 'The required jsonAssertions array and optional captures address this public download projection; default JSON response handling is unchanged.' },
        assertionFields: ['path', 'equals'], captureFields: ['name', 'path'],
        jsonPath: { format: 'component-array', appliesTo: ['jsonAssertions[].path', 'captures[].path'],
          components: 'Object keys as strings or array indices as integers from 0 to 9999; not a JSONPath string.',
          examples: { assertion: ['code'], capture: ['data', 'id'] } },
        reference: { $capture: 'previousCaptureName' }, referenceOrder: 'Only earlier API probes; database probes follow all API probes.',
        captures: 'Globally unique names, scalar values only at execution; secret and prototype paths forbidden.',
        apiScopeRequired: true, apiScopeFields: ['artifactSha256', 'endpoints'], endpointFields: ['method', 'path'],
        apiScopePlanFieldAllowed: false, apiScopeInjectedBy: 'Broker', apiScopeLocation: 'runtimePreparation.apiScope',
        apiScopeAuthority: 'Protected accepted domain artifact; model plans cannot grant endpoints.',
        limits: { api: 64, database: 16, assertionsPerApi: 16, capturesPerApi: 16, jsonPathParts: 16,
          jsonPathIndexMaximum: 9999, bodyDepth: 8, objectKeys: 64, arrayLength: 64, queryKeys: 64, scalarStringLength: 2048,
          pathLength: 2048, apiScopeEndpoints: 2048 },
      },
    },
    database: { fields: ['id', 'table', 'columns', 'where', 'limit', 'expectedRows'], filterFields: ['column', 'equals'],
      maximumColumns: 16, maximumFilters: 16, maximumRows: 100, arbitrarySql: false, v2FilterReference: true },
  };
}

export function validateRuntimeProbePlan(plan) {
  if (plan?.schemaVersion === 2) return validateRuntimeProbePlanV2(plan);
  exactKeys(plan, ['schemaVersion', 'api', 'database', 'browser'], 'runtime probe plan');
  if (plan.schemaVersion !== 1 || Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024) throw new Error('Runtime probe plan is invalid or too large.');
  exactKeys(plan.browser, ['status', 'reason'], 'browser probe');
  if (plan.browser.status !== 'not-executed' || plan.browser.reason !== 'owner-excluded') throw new Error('Browser execution is not authorized.');
  const scalar = (v) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 2048);
  const identifier = (v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(v);
  const ids = new Set();
  for (const list of [plan.api, plan.database]) {
    if (!Array.isArray(list) || list.length > 16) throw new Error('Runtime probes must be bounded arrays.');
    for (const probe of list) {
      if (!identifier(probe?.id) && !(typeof probe?.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(probe.id))) throw new Error('Runtime probe id is invalid.');
      if (ids.has(probe.id)) throw new Error('Runtime probe ids must be unique.');
      ids.add(probe.id);
    }
  }
  for (const probe of plan.api) {
    exactKeys(probe, ['id', 'method', 'path', 'expectedStatus', 'jsonAssertions'], 'API probe');
    if (probe.method !== 'GET' || typeof probe.path !== 'string' || probe.path.length > 2048
      || !probe.path.startsWith('/') || probe.path.startsWith('//') || /[\\\s#\u0000-\u001f]/u.test(probe.path)
      || new URL(probe.path, 'http://candidate.invalid').origin !== 'http://candidate.invalid') throw new Error('API probes require a relative candidate GET path.');
    if (!Number.isInteger(probe.expectedStatus) || probe.expectedStatus < 200 || probe.expectedStatus > 599) throw new Error('API probe expected status is invalid.');
    if (!Array.isArray(probe.jsonAssertions) || probe.jsonAssertions.length > 16) throw new Error('API assertions must be bounded.');
    for (const assertion of probe.jsonAssertions) {
      exactKeys(assertion, ['path', 'equals'], 'API assertion');
      if (!Array.isArray(assertion.path) || assertion.path.length < 1 || assertion.path.length > 16
        || !assertion.path.every((v) => (typeof v === 'string' && v.length > 0 && v.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(v)) || (Number.isInteger(v) && v >= 0 && v < 10000))
        || !scalar(assertion.equals)) throw new Error('API assertion is invalid.');
    }
  }
  for (const probe of plan.database) {
    exactKeys(probe, ['id', 'table', 'columns', 'where', 'limit', 'expectedRows'], 'database probe');
    if (!identifier(probe.table) || !Array.isArray(probe.columns) || probe.columns.length < 1 || probe.columns.length > 16
      || !probe.columns.every(identifier) || new Set(probe.columns).size !== probe.columns.length
      || !Array.isArray(probe.where) || probe.where.length > 16
      || !Number.isInteger(probe.limit) || probe.limit < 1 || probe.limit > 100
      || !Number.isInteger(probe.expectedRows) || probe.expectedRows < 0 || probe.expectedRows > probe.limit) throw new Error('Database probe requires bounded identifiers and row counts.');
    for (const filter of probe.where) {
      exactKeys(filter, ['column', 'equals'], 'database filter');
      if (!identifier(filter.column) || !scalar(filter.equals)) throw new Error('Database filter is invalid.');
    }
  }
  return structuredClone(plan);
}

export function validateReleaseRequest(request, contractInput) {
  const contract = validateRuntimeContract(contractInput);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Release request must be an object.');
  }
  const action = request.action;
  if (!['contract', 'diagnose', 'preflight', 'status', 'prepare', 'release'].includes(action)) {
    throw new Error('Release action is not allowed.');
  }
  const allowedFields = ['prepare', 'release'].includes(action)
    ? [
        'action',
        'services',
        'approvalRef',
        ...(Object.hasOwn(request, 'version') ? ['version'] : []),
        ...(Object.hasOwn(request, 'provenance') ? ['provenance'] : []),
        ...(action === 'prepare' && Object.hasOwn(request, 'runtimePreparation') ? ['runtimePreparation'] : []),
        ...(Object.hasOwn(request, 'preparedJobId') ? ['preparedJobId'] : []),
      ]
    : ['action'];
  exactKeys(request, allowedFields, 'release request');
  if (!['prepare', 'release'].includes(action)) {
    return { action, services: [] };
  }
  if (request.version !== undefined) {
    assertString(request.version, VERSION_PATTERN, 'release version');
  }
  if (typeof request.approvalRef !== 'string' || request.approvalRef.length < 3 || request.approvalRef.length > 160) {
    throw new Error('approvalRef is required and must be bounded.');
  }
  if (!Array.isArray(request.services) || request.services.length < 1) {
    throw new Error('At least one release service is required.');
  }
  const unique = [...new Set(request.services)];
  if (unique.length !== request.services.length) {
    throw new Error('Release services must not be duplicated.');
  }
  for (const service of unique) {
    if (!contract.release.allowedReleaseServices.includes(service)) {
      throw new Error(`Release service is not allowed: ${service}`);
    }
  }
  let provenance;
  if (request.provenance !== undefined) {
    if (!request.provenance || typeof request.provenance !== 'object' || Array.isArray(request.provenance)) {
      throw new Error('release provenance must be an object.');
    }
    exactKeys(request.provenance, [
      'source',
      'taskId',
      'actorId',
      'conversationId',
      'candidateCommit',
    ], 'release provenance');
    if (request.provenance.source !== 'taskspace') {
      throw new Error('release provenance source is invalid.');
    }
    provenance = {
      source: 'taskspace',
      taskId: assertString(request.provenance.taskId, TASKSPACE_ID_PATTERN, 'release provenance taskId'),
      actorId: assertString(request.provenance.actorId, ACTOR_ID_PATTERN, 'release provenance actorId'),
      conversationId: assertString(
        request.provenance.conversationId,
        CONVERSATION_ID_PATTERN,
        'release provenance conversationId',
      ),
      candidateCommit: assertString(
        request.provenance.candidateCommit,
        COMMIT_PATTERN,
        'release provenance candidateCommit',
      ),
    };
  }
  if (action === 'prepare' && !provenance) throw new Error('Candidate preparation requires TaskSpace provenance.');
  let runtimePreparation;
  if (request.runtimePreparation !== undefined) {
    const input = request.runtimePreparation;
    exactKeys(input, ['taskId', 'executionId', 'stateDigest', 'baseSourceCommit', 'workspaceFingerprint', 'acceptedPatchSha256', 'candidateTree', 'probePlan',
      ...(Object.hasOwn(input, 'recheck') ? ['recheck'] : []), ...(Object.hasOwn(input, 'apiScope') ? ['apiScope'] : []),
      ...(Object.hasOwn(input, 'identityScope') ? ['identityScope'] : [])], 'runtime preparation');
    if (input.taskId !== provenance?.taskId || !unique.includes('forge-admin')) throw new Error('Runtime preparation requires the bound task and candidate admin.');
    assertString(input.executionId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u, 'runtime execution');
    for (const key of ['stateDigest', 'workspaceFingerprint', 'acceptedPatchSha256']) assertString(input[key], SHA256_PATTERN, `runtime ${key}`);
    assertString(input.baseSourceCommit, COMMIT_PATTERN, 'runtime base commit');
    assertString(input.candidateTree, COMMIT_PATTERN, 'runtime candidate tree');
    if (input.recheck !== undefined) {
      exactKeys(input.recheck, ['previousObservationId', 'previousStateDigest'], 'runtime recheck');
      assertString(input.recheck.previousObservationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u, 'previous runtime observation');
      assertString(input.recheck.previousStateDigest, SHA256_PATTERN, 'previous runtime state');
      if (request.preparedJobId === undefined) throw new Error('Runtime recheck requires its prepared candidate job.');
    }
    const probePlan = validateRuntimeProbePlan(input.probePlan);
    const apiScope = input.apiScope === undefined && probePlan.schemaVersion !== 2 ? undefined
      : validateRuntimeProbeScope(input.apiScope, probePlan.schemaVersion === 2 ? probePlan : undefined);
    const identityScope = probePlan.identityFixtures?.length || Object.hasOwn(input, 'identityScope')
      ? validateRuntimeIdentityScope(input.identityScope, probePlan) : undefined;
    runtimePreparation = { ...input, probePlan, ...(apiScope === undefined ? {} : { apiScope }),
      ...(identityScope === undefined ? {} : { identityScope }) };
  }
  if (request.preparedJobId !== undefined) {
    assertString(request.preparedJobId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u, 'prepared candidate job');
    if (!provenance) throw new Error('Prepared candidate release requires TaskSpace provenance.');
    if (action === 'prepare' && !runtimePreparation) throw new Error('Prepared runtime observation requires its protected runtime binding.');
  }
  return {
    action,
    ...(request.preparedJobId === undefined ? {} : { preparedJobId: request.preparedJobId }),
    approvalRef: request.approvalRef,
    services: unique,
    version: request.version,
    ...(provenance === undefined ? {} : { provenance }),
    ...(runtimePreparation === undefined ? {} : { runtimePreparation }),
  };
}

export function findForbiddenSql(sql) {
  if (typeof sql !== 'string') return null;
  let sanitized = '';
  let state = 'normal';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') {
        state = 'normal';
        sanitized += current;
      } else {
        sanitized += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        sanitized += '  ';
        state = 'normal';
        index += 1;
      } else {
        sanitized += current === '\n' || current === '\r' ? current : ' ';
      }
      continue;
    }
    if (state !== 'normal') {
      sanitized += current === state ? current : (current === '\n' || current === '\r' ? current : ' ');
      if (current === '\\' && next !== undefined) {
        sanitized += ' ';
        index += 1;
      } else if (current === state) {
        if (next === state) {
          sanitized += ' ';
          index += 1;
        } else {
          state = 'normal';
        }
      }
      continue;
    }
    if (current === '/' && next === '*') {
      sanitized += '  ';
      state = 'block-comment';
      index += 1;
    } else if (current === '#' || (current === '-' && next === '-' && /\s/.test(sql[index + 2] ?? ''))) {
      sanitized += current === '#' ? ' ' : '  ';
      state = 'line-comment';
      if (current === '-') index += 1;
    } else {
      sanitized += current;
      if (current === "'" || current === '"' || current === '`') state = current;
    }
  }
  for (const pattern of FORBIDDEN_SQL) {
    const match = pattern.exec(sanitized);
    if (match) return match[0];
  }
  return null;
}
