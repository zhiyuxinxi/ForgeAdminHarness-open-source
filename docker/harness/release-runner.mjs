import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import {
  findForbiddenSql,
  getRuntimeProbeCapabilities,
  parseFlywayMigrationPath,
  validateComposeModel,
  validateFlywayMigrationInventory,
  validateReleaseRequest,
  validateRuntimeContract,
  validateRuntimeIdentityScope,
} from './release-policy.mjs';
import { createForgeCandidateAuthenticatedSession } from './forge-candidate-auth-client.mjs';
import { projectRuntimeDownload } from './runtime-download-evidence.mjs';

const MAX_BODY_BYTES = 48 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_DIAGNOSTIC_BYTES = 8 * 1024;
const RELEASE_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_DATABASE_OPERATOR_TIMEOUT_MS = 8 * 60 * 1000;
const MIGRATION_ROOT_RELATIVE = 'forge-server/db/migration';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function commandEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp/release-runner-home',
    DOCKER_CONFIG: '/tmp/release-runner-docker',
    TZ: process.env.TZ ?? 'Asia/Shanghai',
    ...extra,
  };
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: commandEnvironment(options.env),
      shell: false,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) child.kill('SIGTERM');
    }, options.timeoutMs ?? RELEASE_TIMEOUT_MS);

    const collect = (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString('utf8');
      if (totalBytes > MAX_COMMAND_OUTPUT_BYTES) {
        reject(new Error(`${command} output exceeded the runner limit.`));
      } else if (code !== 0) {
        const error = new Error(`${command} failed with exit ${code ?? signal}.`);
        error.output = output.slice(-32 * 1024);
        reject(error);
      } else {
        resolve({ code, output });
      }
    });
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function listFiles(root, suffix) {
  const result = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) result.push(candidate);
    }
  };
  try {
    await visit(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return result.sort();
}

function replaceEnvValues(text, replacements) {
  const found = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const delimiter = line.indexOf('=');
    if (delimiter < 1) return line;
    const key = line.slice(0, delimiter);
    if (!replacements.has(key)) return line;
    found.add(key);
    return `${key}=${replacements.get(key)}`;
  });
  for (const [key, value] of replacements) {
    if (!found.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function atomicReplace(filePath, content, mode = 0o600) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, filePath);
}

function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error(`TCP probe timed out for ${host}:${port}.`)), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function envValue(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const delimiter = line.indexOf('=');
    if (delimiter > 0 && line.slice(0, delimiter) === name) return line.slice(delimiter + 1).trim();
  }
  return '';
}

function parseOperatorOutput(value) {
  const result = {};
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const delimiter = line.indexOf('=');
    if (delimiter < 1) continue;
    const key = line.slice(0, delimiter);
    const entry = line.slice(delimiter + 1);
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) result[key] = entry;
  }
  return result;
}

export function sanitizeDiagnosticText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(
      /(["'])([a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key))\1\s*:\s*(["'])[^"']*\3/gi,
      '$1$2$1:$3[REDACTED]$3',
    )
    .replace(
      /\b([a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key))\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/:\/\/([^\s/@:]+):([^\s/@]+)@/g, '://[REDACTED]@')
    .replace(/[\0\r]/g, '')
    .slice(-MAX_PUBLIC_DIAGNOSTIC_BYTES);
}

function releaseError(code, message, {
  stage,
  retryable = false,
  recommendedAction,
  details,
  diagnosticText,
} = {}) {
  const error = new Error(message);
  error.code = code;
  if (stage) error.stage = stage;
  error.retryable = retryable;
  if (recommendedAction) error.recommendedAction = recommendedAction;
  if (details !== undefined) error.details = details;
  const diagnosticExcerpt = sanitizeDiagnosticText(diagnosticText);
  if (diagnosticExcerpt) error.diagnosticExcerpt = diagnosticExcerpt;
  return error;
}

function migrationFailure(logs, fallback = undefined) {
  const diagnosticText = logs || fallback || '';
  const common = { stage: 'test-database-migration', diagnosticText };
  if (/more than one migration with version|multiple migrations have version|duplicate.*migration.*version/i.test(diagnosticText)) {
    return releaseError(
      'MIGRATION_VERSION_CONFLICT',
      'The candidate contains more than one Flyway migration with the same version.',
      {
        ...common,
        recommendedAction: 'Assign every new migration a unique version later than the latest released version, commit the correction, and retry.',
      },
    );
  }
  if (/contains a failed migration|failed migration to version|repair.*schema history/i.test(diagnosticText)) {
    return releaseError(
      'MIGRATION_HISTORY_FAILED',
      'The test schema contains a previously failed Flyway migration record.',
      {
        ...common,
        recommendedAction: 'Correct and commit the forward migration, then retry the normal controlled release; Runner will restore only the dedicated test schema from its verified healthy snapshot.',
      },
    );
  }
  if (/checksum mismatch|validate failed|resolved migration not applied|applied migration not resolved/i.test(diagnosticText)) {
    return releaseError(
      'MIGRATION_VALIDATION_FAILED',
      'Flyway rejected the migration history or checksum.',
      {
        ...common,
        recommendedAction: 'Do not edit an applied migration. Add a forward migration and retry the controlled release.',
      },
    );
  }
  if (/lock wait timeout|deadlock found|could not acquire.*lock|named lock/i.test(diagnosticText)) {
    return releaseError(
      'MIGRATION_LOCKED',
      'The test migration is blocked by a database lock or concurrent operation.',
      {
        ...common,
        retryable: true,
        recommendedAction: 'Wait for the owning project operation to finish, then retry the same committed release once.',
      },
    );
  }
  if (/access denied|unknown database|communications link failure|connection refused|unable to obtain connection/i.test(diagnosticText)) {
    return releaseError(
      'MIGRATION_DATABASE_UNAVAILABLE',
      'The registered test database is unavailable or the project credential is not authorized.',
      {
        ...common,
        retryable: true,
        recommendedAction: 'Verify the registered shared service, project test schema, and project-scoped grants through the controlled platform capability.',
      },
    );
  }
  return releaseError(
    'MIGRATION_EXECUTION_FAILED',
    'The candidate failed while applying or validating the test-database migration.',
    {
      ...common,
      recommendedAction: 'Inspect the bounded diagnostic excerpt, correct the forward migration, commit the change, and retry through the controlled Runner.',
    },
  );
}

function testDatabaseOperatorFailure(action, error) {
  const diagnosticText = error.output || error.message || '';
  const stage = `test-database-${action}`;
  if (/active connections|lock unavailable|could not acquire.*lock/i.test(diagnosticText)) {
    return releaseError(
      'TEST_DATABASE_BUSY',
      'The dedicated test database is in use by another operation.',
      {
        stage,
        retryable: true,
        recommendedAction: 'Wait for the owning test operation to finish, then retry the same committed release.',
        diagnosticText,
      },
    );
  }
  if (/access denied|registered test database does not exist|unknown database|connection refused|communications link failure/i.test(diagnosticText)) {
    return releaseError(
      'TEST_DATABASE_UNAVAILABLE',
      'The registered test database is unavailable or its project credential lacks the required test-schema grant.',
      {
        stage,
        retryable: true,
        recommendedAction: 'Use the platform-owned project database credential workflow; do not substitute a server-wide administrator credential in Harness.',
        diagnosticText,
      },
    );
  }
  if (/pull access denied|no such image|unable to find image|manifest unknown/i.test(diagnosticText)) {
    return releaseError(
      'TEST_DATABASE_OPERATOR_UNAVAILABLE',
      'The pinned test-database operator image is unavailable on the Runner host.',
      {
        stage,
        recommendedAction: 'Restore the reviewed digest-pinned operator image through the versioned platform upgrade, then retry.',
        diagnosticText,
      },
    );
  }
  return releaseError(
    `TEST_DATABASE_${action.toUpperCase()}_FAILED`,
    `The controlled test-database ${action} step failed.`,
    {
      stage,
      recommendedAction: 'Inspect forge-release diagnose and the project-scoped audit evidence before retrying; the main database was not changed by this step.',
      diagnosticText,
    },
  );
}

function publicError(error) {
  const result = {
    code: error.code ?? 'RELEASE_REJECTED',
    message: error.message,
  };
  if (error.stage) result.stage = error.stage;
  if (typeof error.retryable === 'boolean') result.retryable = error.retryable;
  if (error.recommendedAction) result.recommendedAction = error.recommendedAction;
  if (error.details !== undefined) result.details = error.details;
  if (error.diagnosticExcerpt) result.diagnosticExcerpt = error.diagnosticExcerpt;
  return result;
}

function boundedApproval(value) {
  return value.replace(/[\r\n\t\0]/g, ' ').slice(0, 160);
}

function preparationDigest([environment, ...files], legacy = false) {
  // These platform consumers do not change the prepared application images.
  // Preserve every other environment byte, including business image settings.
  const applicationEnvironment = legacy ? environment : Buffer.from(environment.toString('latin1')
    .replace(/^(?:HARNESS_IMAGE|CONVERSATION_MANAGER_IMAGE|PROTECTED_ACCEPTANCE_IMAGE|TASKSPACE_BROKER_IMAGE|RELEASE_RUNNER_IMAGE|FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED)=[^\n]*(?:\n|$)/gm, ''), 'latin1');
  const digest = crypto.createHash('sha256');
  for (const bytes of [applicationEnvironment, ...files]) {
    digest.update(String(bytes.length) + ':');
    digest.update(bytes);
  }
  return (legacy ? '' : 'v2:') + digest.digest('hex');
}

export class ControlledReleaseRunner {
  constructor(options) {
    this.contractPath = options.contractPath;
    this.projectRoot = options.projectRoot;
    this.workspaceRoot = `${this.projectRoot}/workspace`;
    this.opsRoot = `${this.projectRoot}/ops`;
    this.envFile = `${this.opsRoot}/project.env`;
    this.composeFile = `${this.opsRoot}/compose.yaml`;
    this.auditFile = `${this.opsRoot}/release-audit.jsonl`;
    this.jobStateFile = `${this.opsRoot}/release-state.json`;
    this.testDatabaseRecoveryStateFile = options.testDatabaseRecoveryStateFile
      ?? `${this.opsRoot}/test-database-recovery.json`;
    this.backupsRoot = `${this.projectRoot}/backups`;
    this.operatorScriptPath = options.operatorScriptPath ?? '/usr/local/lib/test-db-operator.sh';
    this.operatorScript = options.operatorScript;
    this.command = options.command ?? runCommand;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.delay = options.delay ?? delay;
    this.activeJob = null;
  }

  async loadContract() {
    const contract = validateRuntimeContract(JSON.parse(await readFile(this.contractPath, 'utf8')));
    if (contract.projectRoot !== this.projectRoot
      || contract.workspaceRoot !== this.workspaceRoot
      || contract.release.testDatabaseLifecycle.recoveryStateFile !== this.testDatabaseRecoveryStateFile) {
      throw new Error('Runner path does not match the project runtime contract.');
    }
    return contract;
  }

  composeArgs(...args) {
    return ['compose', '--env-file', this.envFile, '--file', this.composeFile, ...args];
  }

  async composeWithEnvironment(environment, ...args) {
    return this.command('docker', this.composeArgs(...args), {
      cwd: this.opsRoot,
      ...(environment ? { env: environment } : {}),
    });
  }

  async compose(...args) {
    return this.composeWithEnvironment(undefined, ...args);
  }

  async runTestDatabaseOperator(action, contract, environment = {}) {
    if (!['plan', 'snapshot', 'reset', 'restore'].includes(action)) {
      throw new Error(`Unsupported test-database operator action: ${action}`);
    }
    const lifecycle = contract.release.testDatabaseLifecycle;
    const projectEnvironment = await readFile(this.envFile, 'utf8');
    const sharedServicesEnvironment = envValue(projectEnvironment, 'SHARED_SERVICES_ENV_FILE');
    if (!path.posix.isAbsolute(sharedServicesEnvironment) || sharedServicesEnvironment.includes('\0')) {
      throw releaseError(
        'TEST_DATABASE_CONFIGURATION_INVALID',
        'The shared service environment path is invalid.',
        {
          stage: `test-database-${action}`,
          recommendedAction: 'Restore the platform-managed project environment and runtime contract.',
        },
      );
    }
    const script = this.operatorScript ?? await readFile(this.operatorScriptPath, 'utf8');
    const containerName = `${contract.projectSlug}-test-db-${action}-${crypto.randomUUID().slice(0, 12)}`;
    const dockerArguments = [
      'run', '--rm', '--interactive', '--pull', 'never', '--name', containerName,
      '--network', `${contract.composeProjectName}_application`,
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '128',
      '--memory', '512m',
      '--cpus', '1.0',
      '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--env-file', sharedServicesEnvironment,
      '--env', `FORGE_RUNTIME_DATABASE=${contract.infrastructure.mysql.database}`,
      '--env', `FORGE_TEST_DATABASE=${contract.infrastructure.mysql.testDatabase}`,
      '--env', 'HOME=/tmp',
      '--mount', `type=bind,src=${this.backupsRoot},dst=/project-backups`,
    ];
    for (const [name, value] of Object.entries(environment)) {
      if (!/^FORGE_[A-Z0-9_]+$/.test(name) || typeof value !== 'string') {
        throw new Error('Invalid test-database operator environment.');
      }
      dockerArguments.push('--env', `${name}=${value}`);
    }
    dockerArguments.push('--entrypoint', 'sh', lifecycle.operatorImage, '-s', action);
    let containerId;
    let operatorError;
    let completedOperator;
    try {
      if (action === 'plan' || action === 'snapshot') {
        // Separate startup from stdin attachment: the combined interactive run
        // can stall before startup. Keep one container and the original budget.
        const deadline = Date.now() + TEST_DATABASE_OPERATOR_TIMEOUT_MS;
        const options = () => ({ cwd: this.opsRoot, timeoutMs: Math.max(1, deadline - Date.now()) });
        const created = await this.command('docker', ['create', ...dockerArguments.slice(2)], options());
        const id = created.output.trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`The test-database ${action} container identity is invalid.`);
        containerId = id;
        await this.command('docker', ['start', containerId], options());
        const result = await this.command('docker', ['attach', '--sig-proxy=false', containerId], { ...options(), input: script });
        const state = JSON.parse((await this.command('docker', ['inspect', '--format', '{{json .State}}', containerId], options())).output);
        if (state.Status !== 'exited' || state.Running !== false || state.ExitCode !== 0) {
          const error = new Error(`The test-database ${action} container did not exit successfully (status: ${state.Status}, exit code: ${state.ExitCode}).`);
          error.output = `${result.output || ''}\n${error.message}`;
          throw error;
        }
        completedOperator = result;
        return result;
      }
      return await this.command('docker', dockerArguments, {
        cwd: this.opsRoot,
        input: script,
        timeoutMs: TEST_DATABASE_OPERATOR_TIMEOUT_MS,
      });
    } catch (error) {
      operatorError = error;
      throw testDatabaseOperatorFailure(action, error);
    } finally {
      if (containerId) {
        await this.command('docker', ['rm', '--force', '--volumes', containerId], { cwd: this.opsRoot, timeoutMs: 30_000 })
          .catch(async error => {
            if (completedOperator) {
              completedOperator.cleanupPending = {
                containerId,
                error: {
                  ...publicError(error),
                  diagnosticExcerpt: sanitizeDiagnosticText(error.output || error.message),
                },
              };
              await this.audit({
                type: 'test-database-operator-cleanup',
                status: 'pending',
                action,
                projectSlug: contract.projectSlug,
                jobId: this.activeJob ?? undefined,
                ...completedOperator.cleanupPending,
                at: new Date().toISOString(),
              }).catch(auditError => {
                completedOperator.cleanupPending.auditError = publicError(auditError);
              });
            } else if (!operatorError) {
              throw testDatabaseOperatorFailure(action, error);
            }
          });
      }
    }
  }

  parseTestDatabasePlan(output, contract) {
    const planOutput = parseOperatorOutput(output);
    if (planOutput.DATABASE !== contract.infrastructure.mysql.testDatabase
      || !/^\d+$/.test(planOutput.OBJECT_COUNT ?? '')
      || !/^\d+$/.test(planOutput.FAILED_HISTORY_COUNT ?? '')
      || !/^\d+$/.test(planOutput.ACTIVE_CONNECTIONS ?? '')) {
      throw releaseError(
        'TEST_DATABASE_PLAN_INVALID',
        'The test-database operator returned an invalid recovery plan.',
        {
          stage: 'test-database-plan',
          recommendedAction: 'Restore the reviewed Runner and pinned operator image before retrying.',
          diagnosticText: JSON.stringify(planOutput),
        },
      );
    }
    if (planOutput.ACTIVE_CONNECTIONS !== '0') {
      throw testDatabaseOperatorFailure('plan', {
        output: `registered test database has active connections: ${planOutput.ACTIVE_CONNECTIONS}`,
      });
    }
    return {
      objectCount: Number(planOutput.OBJECT_COUNT),
      failedHistoryCount: Number(planOutput.FAILED_HISTORY_COUNT),
      activeConnections: 0,
    };
  }

  async readTestDatabaseRecoveryState() {
    try {
      const state = JSON.parse(await readFile(this.testDatabaseRecoveryStateFile, 'utf8'));
      if (state?.schemaVersion !== 1
        || state.lifecycleMode !== 'snapshot-restore-on-failure'
        || !['healthy', 'migration-pending', 'restore-required'].includes(state.status)
        || typeof state.database !== 'string'
        || !state.recoveryPoint
        || typeof state.recoveryPoint !== 'object') {
        throw new Error('test-database recovery state has an invalid structure');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw releaseError(
        'TEST_DATABASE_RECOVERY_STATE_INVALID',
        'The persistent test-database recovery state is invalid.',
        {
          stage: 'test-database-plan',
          recommendedAction: 'Restore the reviewed Runner state from project backup; do not repair Flyway history by hand.',
          diagnosticText: error.message,
        },
      );
    }
  }

  async recordTestDatabaseRecoveryState(state) {
    await atomicReplace(this.testDatabaseRecoveryStateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  async cleanupInterruptedTestMigrationContainers(contract) {
    const list = await this.command('docker', [
      'container', 'ls', '--all', '--quiet',
      '--filter', `label=com.forge-delivery.project=${contract.projectSlug}`,
      '--filter', 'label=com.forge-delivery.role=test-database-migration',
    ], { cwd: this.opsRoot });
    const containerIds = list.output.split(/\r?\n/).filter((value) => /^[a-f0-9]{12,64}$/.test(value));
    for (const containerId of containerIds) {
      await this.command('docker', ['stop', '--time', '10', containerId], {
        cwd: this.opsRoot,
        timeoutMs: 30_000,
      }).catch(() => undefined);
      await this.command('docker', ['rm', '--force', containerId], {
        cwd: this.opsRoot,
        timeoutMs: 30_000,
      });
    }
    return containerIds;
  }

  async verifiedTestDatabaseRecoveryPoint(contract, state) {
    const expectedDatabase = contract.infrastructure.mysql.testDatabase;
    const point = state?.recoveryPoint;
    const match = /^backups\/test-database-snapshots\/([A-Za-z0-9._-]{1,180}\.sql\.gz)$/.exec(
      point?.relativePath ?? '',
    );
    if (state?.database !== expectedDatabase
      || !match
      || !/^[a-f0-9]{64}$/.test(point?.sha256 ?? '')
      || !Number.isSafeInteger(point?.bytes)
      || point.bytes < 1
      || !Number.isSafeInteger(point?.objectCount)
      || point.objectCount < 1) {
      throw releaseError(
        'TEST_DATABASE_RECOVERY_POINT_INVALID',
        'The registered test-database recovery point is invalid.',
        {
          stage: 'test-database-restore',
          recommendedAction: 'Preserve the current evidence and restore the project-owned recovery metadata from backup.',
        },
      );
    }
    const hostPath = path.join(contract.release.testDatabaseLifecycle.backupRoot, match[1]);
    const metadata = await lstat(hostPath).catch((error) => {
      throw releaseError(
        'TEST_DATABASE_RECOVERY_POINT_MISSING',
        'The registered test-database recovery snapshot is missing.',
        {
          stage: 'test-database-restore',
          recommendedAction: 'Restore the project-owned snapshot from backup before retrying the release.',
          diagnosticText: error.message,
        },
      );
    });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== point.bytes
      || await sha256File(hostPath) !== point.sha256) {
      throw releaseError(
        'TEST_DATABASE_RECOVERY_POINT_INVALID',
        'The registered test-database recovery snapshot failed local verification.',
        {
          stage: 'test-database-restore',
          recommendedAction: 'Preserve the snapshot and restore the last verified project recovery point from backup.',
        },
      );
    }
    return {
      ...point,
      hostPath,
      operatorPath: `/project-backups/test-database-snapshots/${match[1]}`,
    };
  }

  async prepareTestDatabase(contract, jobId, commit, updateJobState) {
    await mkdir(contract.release.testDatabaseLifecycle.backupRoot, { recursive: true, mode: 0o700 });
    await chmod(contract.release.testDatabaseLifecycle.backupRoot, 0o700);

    const previousRecoveryState = await this.readTestDatabaseRecoveryState();
    const interruptedMigration = previousRecoveryState?.status === 'migration-pending'
      || previousRecoveryState?.status === 'restore-required';
    let removedInterruptedContainers = [];
    if (interruptedMigration) {
      await updateJobState({ stage: 'test-database-orphan-cleanup' });
      removedInterruptedContainers = await this.cleanupInterruptedTestMigrationContainers(contract);
    }
    await updateJobState({ stage: 'test-database-plan' });
    const initialPlanResult = await this.runTestDatabaseOperator('plan', contract);
    const initialPlan = this.parseTestDatabasePlan(
      initialPlanResult.output,
      contract,
    );
    if (initialPlanResult.cleanupPending) initialPlan.cleanupPending = initialPlanResult.cleanupPending;
    const restoreRequired = initialPlan.failedHistoryCount > 0
      || interruptedMigration
      || previousRecoveryState?.lastAttempt?.published === false;
    let restoration;
    let plan = initialPlan;
    await updateJobState({
      testDatabaseSandbox: {
        mode: 'snapshot-restore-on-failure',
        initialPlan,
        restoreRequired,
        removedInterruptedContainers,
      },
    });

    if (restoreRequired) {
      if (!previousRecoveryState) {
        throw releaseError(
          'TEST_DATABASE_RECOVERY_POINT_MISSING',
          'The test database requires recovery, but no verified automatic recovery point is registered.',
          {
            stage: 'test-database-restore',
            recommendedAction: 'Restore the last project-owned healthy test snapshot through the controlled platform recovery runbook.',
          },
        );
      }
      const recoveryPoint = await this.verifiedTestDatabaseRecoveryPoint(contract, previousRecoveryState);
      await updateJobState({ stage: 'test-database-restore' });
      const restoreOutput = parseOperatorOutput((await this.runTestDatabaseOperator('restore', contract, {
        FORGE_BACKUP_FILE: recoveryPoint.operatorPath,
        FORGE_BACKUP_SHA256: recoveryPoint.sha256,
        FORGE_EXPECTED_OBJECT_COUNT: String(recoveryPoint.objectCount),
      })).output);
      if (restoreOutput.DATABASE !== contract.infrastructure.mysql.testDatabase
        || restoreOutput.OBJECT_COUNT_AFTER !== String(recoveryPoint.objectCount)
        || restoreOutput.FAILED_HISTORY_COUNT_AFTER !== '0'
        || restoreOutput.BACKUP_SHA256 !== recoveryPoint.sha256
        || restoreOutput.RESTORE_MODE !== 'verified-snapshot-import') {
        throw releaseError(
          'TEST_DATABASE_RESTORE_INVALID',
          'The automatic test-database restore did not produce the registered healthy state.',
          {
            stage: 'test-database-restore',
            recommendedAction: 'Preserve the recovery evidence and retry only after the versioned operator is repaired.',
            diagnosticText: JSON.stringify(restoreOutput),
          },
        );
      }
      plan = this.parseTestDatabasePlan(
        (await this.runTestDatabaseOperator('plan', contract)).output,
        contract,
      );
      if (plan.objectCount !== recoveryPoint.objectCount || plan.failedHistoryCount !== 0) {
        throw releaseError(
          'TEST_DATABASE_RESTORE_INVALID',
          'The restored test database failed post-restore verification.',
          {
            stage: 'test-database-restore',
            recommendedAction: 'Preserve the recovery evidence and inspect the bounded operator result.',
          },
        );
      }
      restoration = {
        recoveredFromJobId: previousRecoveryState.lastAttempt?.jobId,
        recoveryPoint: {
          relativePath: recoveryPoint.relativePath,
          sha256: recoveryPoint.sha256,
          bytes: recoveryPoint.bytes,
          objectCount: recoveryPoint.objectCount,
        },
        restoredAt: new Date().toISOString(),
      };
    } else if (plan.failedHistoryCount !== 0) {
      throw releaseError(
        'TEST_DATABASE_RECOVERY_REQUIRED',
        'The test database is not healthy enough to create a recovery point.',
        { stage: 'test-database-plan' },
      );
    }

    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const backupName = `${timestamp}-${jobId}.sql.gz`;
    const operatorBackupPath = `/project-backups/test-database-snapshots/${backupName}`;
    const hostBackupPath = path.join(contract.release.testDatabaseLifecycle.backupRoot, backupName);
    await updateJobState({ stage: 'test-database-snapshot' });
    const snapshotOutput = parseOperatorOutput((await this.runTestDatabaseOperator('snapshot', contract, {
      FORGE_BACKUP_FILE: operatorBackupPath,
    })).output);
    if (snapshotOutput.BACKUP_FILE !== operatorBackupPath
      || !/^[a-f0-9]{64}$/.test(snapshotOutput.BACKUP_SHA256 ?? '')
      || !/^[1-9]\d*$/.test(snapshotOutput.BACKUP_BYTES ?? '')) {
      throw releaseError(
        'TEST_DATABASE_SNAPSHOT_INVALID',
        'The test-database snapshot evidence is invalid.',
        {
          stage: 'test-database-snapshot',
          recommendedAction: 'Do not start the candidate migration until a verified project-scoped snapshot is available.',
          diagnosticText: JSON.stringify(snapshotOutput),
        },
      );
    }
    const metadata = await lstat(hostBackupPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== Number(snapshotOutput.BACKUP_BYTES)) {
      throw releaseError(
        'TEST_DATABASE_SNAPSHOT_INVALID',
        'The test-database snapshot file does not match its operator evidence.',
        {
          stage: 'test-database-snapshot',
          recommendedAction: 'Inspect the project backup mount and Runner ownership before retrying.',
        },
      );
    }
    const backupSha256 = await sha256File(hostBackupPath);
    if (backupSha256 !== snapshotOutput.BACKUP_SHA256) {
      throw releaseError(
        'TEST_DATABASE_SNAPSHOT_INVALID',
        'The test-database snapshot checksum verification failed.',
        {
          stage: 'test-database-snapshot',
          recommendedAction: 'Preserve the evidence and repair the project backup path before retrying.',
        },
      );
    }
    await chmod(hostBackupPath, 0o600);
    const backup = {
      relativePath: `backups/test-database-snapshots/${backupName}`,
      sha256: backupSha256,
      bytes: metadata.size,
      objectCount: plan.objectCount,
      verified: true,
    };
    const recoveryState = {
      schemaVersion: 1,
      database: contract.infrastructure.mysql.testDatabase,
      lifecycleMode: 'snapshot-restore-on-failure',
      status: 'migration-pending',
      recoveryPoint: {
        relativePath: backup.relativePath,
        sha256: backup.sha256,
        bytes: backup.bytes,
        objectCount: backup.objectCount,
        createdAt: new Date().toISOString(),
        jobId,
        commit,
      },
      lastAttempt: {
        jobId,
        commit,
        status: 'migration-pending',
        published: false,
        startedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.recordTestDatabaseRecoveryState(recoveryState);
    const sandbox = {
      mode: 'snapshot-restore-on-failure',
      database: contract.infrastructure.mysql.testDatabase,
      initialPlan,
      plan,
      backup,
      restoreRequired,
      removedInterruptedContainers,
      restoration,
      operatorImage: contract.release.testDatabaseLifecycle.operatorImage,
      recoveryStateArmed: true,
      preparedAt: new Date().toISOString(),
    };
    await updateJobState({ testDatabaseSandbox: sandbox });
    return sandbox;
  }

  async markTestDatabaseRecoveryRequired(jobId, error) {
    const state = await this.readTestDatabaseRecoveryState();
    if (!state || state.lastAttempt?.jobId !== jobId) return;
    await this.recordTestDatabaseRecoveryState({
      ...state,
      status: 'restore-required',
      lastAttempt: {
        ...state.lastAttempt,
        status: 'failed',
        failedAt: new Date().toISOString(),
        errorCode: error.code ?? 'RELEASE_REJECTED',
      },
      updatedAt: new Date().toISOString(),
    });
  }

  async markTestDatabaseHealthy(jobId) {
    const state = await this.readTestDatabaseRecoveryState();
    if (!state || state.lastAttempt?.jobId !== jobId || state.status !== 'migration-pending') {
      throw releaseError(
        'TEST_DATABASE_RECOVERY_STATE_INVALID',
        'Runner could not finalize the test-database recovery state after migration.',
        {
          stage: 'test-database-migration',
          recommendedAction: 'Retry through the controlled Runner; it will restore the armed recovery point first.',
        },
      );
    }
    await this.recordTestDatabaseRecoveryState({
      ...state,
      status: 'healthy',
      lastAttempt: {
        ...state.lastAttempt,
        status: 'success',
        completedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  }

  async markTestDatabasePublished(jobId, commit, releaseJobId) {
    const state = await this.readTestDatabaseRecoveryState();
    if (state?.status !== 'healthy' || state.lastAttempt?.status !== 'success'
      || state.lastAttempt.jobId !== jobId || state.lastAttempt.commit !== commit) {
      throw releaseError('TEST_DATABASE_RECOVERY_STATE_INVALID',
        'Only the successfully released candidate may advance the test-database baseline.',
        { stage: 'test-database-migration' });
    }
    const publishedAt = new Date().toISOString();
    await this.recordTestDatabaseRecoveryState({ ...state,
      lastAttempt: { ...state.lastAttempt, published: true, releaseJobId, publishedAt }, updatedAt: publishedAt });
  }

  async validateProtectedFiles(contract, workspaceRoot = this.workspaceRoot) {
    let protectedFiles = contract.release.protectedFiles;
    const approval = contract.release.protectedCandidateApproval;
    if (approval !== undefined) {
      const head = (await this.command('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'])).output.trim();
      if (head === approval.candidateCommit) {
        const dirty = (await this.command('git', ['-C', workspaceRoot, 'status', '--porcelain=v1', '--untracked-files=all'])).output.trim();
        if (dirty) throw new Error('Protected candidate approval requires a clean workspace at the approved commit.');
        protectedFiles = protectedFiles.map(item => item.relativePath === approval.relativePath
          ? { ...item, sha256: approval.sha256 } : item);
      }
    }
    for (const item of protectedFiles) {
      const filePath = path.join(workspaceRoot, ...item.relativePath.split('/'));
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Protected deployment input is not a regular file: ${item.relativePath}`);
      }
      if (await sha256File(filePath) !== item.sha256) {
        throw new Error(`Protected deployment input changed without platform approval: ${item.relativePath}`);
      }
    }
  }

  async validateMigrations(workspaceRoot = this.workspaceRoot) {
    const migrationRoot = path.join(workspaceRoot, 'forge-server', 'db', 'migration');
    const migrationFiles = await listFiles(migrationRoot, '.sql');
    const currentPaths = migrationFiles.map(
      (filePath) => path.relative(workspaceRoot, filePath).split(path.sep).join('/'),
    );
    const environmentText = await readFile(this.envFile, 'utf8');
    const releasedCommit = envValue(environmentText, 'FORGE_ADMIN_COMMIT');
    if (!/^[a-f0-9]{40}$/.test(releasedCommit)) {
      throw releaseError(
        'RELEASE_BASELINE_INVALID',
        'FORGE_ADMIN_COMMIT does not identify the full previously released Git commit.',
        {
          stage: 'preflight',
          recommendedAction: 'Restore the reviewed project release metadata before attempting another release.',
        },
      );
    }
    await this.command('git', ['-C', workspaceRoot, 'cat-file', '-e', `${releasedCommit}^{commit}`])
      .catch((error) => {
        throw releaseError(
          'RELEASE_BASELINE_MISSING',
          'The previously released Git commit is not available in the project repository.',
          {
            stage: 'preflight',
            recommendedAction: 'Restore the reviewed Git history before releasing; do not replace the recorded baseline by hand.',
            diagnosticText: error.output ?? error.message,
          },
        );
      });
    const head = (await this.command('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'])).output.trim();
    await this.command('git', ['-C', workspaceRoot, 'merge-base', '--is-ancestor', releasedCommit, head])
      .catch((error) => {
        throw releaseError(
          'RELEASE_BASELINE_DIVERGED',
          'The current workspace does not descend from the previously released commit.',
          {
            stage: 'preflight',
            recommendedAction: 'Reconcile the project branch through reviewed Git history; do not force or reset the shared workspace.',
            diagnosticText: error.output ?? error.message,
          },
        );
      });
    const releasedTree = await this.command('git', [
      '-C', workspaceRoot, 'ls-tree', '-r', '--name-only', releasedCommit, '--', MIGRATION_ROOT_RELATIVE,
    ]);
    const releasedPaths = releasedTree.output.split(/\r?\n/).filter((item) => item.toLowerCase().endsWith('.sql'));
    const inventory = validateFlywayMigrationInventory(currentPaths, releasedPaths);
    const releasedVersionedPaths = new Set(
      releasedPaths.filter((item) => parseFlywayMigrationPath(item).type === 'versioned'),
    );
    const migrationDiff = await this.command('git', [
      '-C', workspaceRoot, 'diff', '--name-status', '--no-renames', `${releasedCommit}..${head}`, '--', MIGRATION_ROOT_RELATIVE,
    ]);
    const mutatedReleased = migrationDiff.output.split(/\r?\n/).flatMap((line) => {
      const [status, relativePath] = line.split('\t');
      return status && status !== 'A' && releasedVersionedPaths.has(relativePath) ? [relativePath] : [];
    });
    if (mutatedReleased.length > 0) {
      throw releaseError(
        'MIGRATION_HISTORY_IMMUTABLE',
        'Previously released Flyway migrations must not be modified, deleted, or renamed.',
        {
          stage: 'preflight',
          recommendedAction: 'Restore the released files and implement the correction as a new forward migration.',
          details: { files: mutatedReleased },
        },
      );
    }
    for (const filePath of migrationFiles) {
      const text = await readFile(filePath, 'utf8');
      const forbidden = findForbiddenSql(text);
      if (forbidden) {
        const relative = path.relative(workspaceRoot, filePath).split(path.sep).join('/');
        throw releaseError(
          'MIGRATION_SQL_FORBIDDEN',
          `Migration contains forbidden administrative or destructive SQL (${forbidden}) in ${relative}.`,
          {
            stage: 'preflight',
            recommendedAction: 'Replace the destructive or administrative operation with a reviewed forward-compatible migration.',
            details: { files: [relative] },
          },
        );
      }
    }
    return inventory;
  }

  async preflight() {
    const contract = await this.loadContract();
    const composeResult = await this.compose('config', '--format', 'json');
    validateComposeModel(JSON.parse(composeResult.output), contract);
    await this.validateProtectedFiles(contract);
    const migrations = await this.validateMigrations();
    await Promise.all([
      tcpProbe(contract.infrastructure.mysql.host, contract.infrastructure.mysql.port),
      tcpProbe(contract.infrastructure.redis.host, contract.infrastructure.redis.port),
    ]);
    const gitStatus = await this.command('git', ['-C', this.workspaceRoot, 'status', '--porcelain=v1', '--untracked-files=all']);
    const head = (await this.command('git', ['-C', this.workspaceRoot, 'rev-parse', 'HEAD'])).output.trim();
    return {
      projectSlug: contract.projectSlug,
      composeProjectName: contract.composeProjectName,
      infrastructure: {
        mysql: {
          mode: contract.infrastructure.mysql.mode,
          host: contract.infrastructure.mysql.host,
          port: contract.infrastructure.mysql.port,
          database: contract.infrastructure.mysql.database,
          testDatabase: contract.infrastructure.mysql.testDatabase,
          provisioningAllowed: false,
        },
        redis: {
          mode: contract.infrastructure.redis.mode,
          host: contract.infrastructure.redis.host,
          port: contract.infrastructure.redis.port,
          database: contract.infrastructure.redis.database,
          testDatabase: contract.infrastructure.redis.testDatabase,
          provisioningAllowed: false,
        },
      },
      allowedReleaseServices: contract.release.allowedReleaseServices,
      fixedComposeFile: contract.release.fixedComposeFile,
      testDatabaseLifecycle: contract.release.testDatabaseLifecycle,
      migrations,
      workspaceClean: gitStatus.output.trim().length === 0,
      head,
    };
  }

  async waitForTestMigration(containerName, validatedPreparedJobId = undefined) {
    const deadline = Date.now() + TEST_MIGRATION_TIMEOUT_MS;
    let lastLogs = '';
    let validationObserved = validatedPreparedJobId !== undefined;
    let applicationStartedObserved = false;
    let nextHistoryReadAt = 0;
    let startupHistoryRead = false;
    const observeLogs = (logs) => {
      if (logs) lastLogs = logs;
      if (/APPLICATION FAILED TO START|FlywayException|Migration of schema .* failed|ERROR.*Flyway/i.test(lastLogs)) {
        throw migrationFailure(lastLogs);
      }
      validationObserved ||= /Successfully validated \d+ migrations/i.test(lastLogs);
      applicationStartedObserved ||= /Started [A-Za-z0-9]+Application/i.test(lastLogs);
    };
    while (Date.now() < deadline) {
      const inspectResult = await this.command('docker', [
        'inspect', '--format', '{{json .State}}', containerName,
      ]).catch((error) => {
        throw releaseError(
          'MIGRATION_CONTAINER_UNAVAILABLE',
          'The test-migration container disappeared before Runner could inspect its result.',
          {
            stage: 'test-database-migration',
            recommendedAction: 'Use forge-release diagnose, then retry only after the Runner preserves the failed-container evidence.',
            diagnosticText: error.output ?? error.message,
          },
        );
      });
      const readLogs = (args) => this.command('docker', args)
        .catch((error) => {
          throw releaseError(
            'MIGRATION_DIAGNOSTICS_UNAVAILABLE',
            'Runner could not read the test-migration container logs.',
            {
              stage: 'test-database-migration',
              retryable: true,
              recommendedAction: 'Use forge-release diagnose and retry only after the project Runner and Docker log path are healthy.',
              diagnosticText: error.output ?? error.message,
            },
          );
        });
      const logsResult = await readLogs(['logs', '--tail', '300', containerName]);
      observeLogs(logsResult.output);
      const startupNeedsValidation = applicationStartedObserved && !validationObserved && !startupHistoryRead;
      const tailAtCapacity = (logsResult.output ?? '').split(/\r?\n/u).length >= 300;
      if ((!validationObserved || !applicationStartedObserved)
        && (startupNeedsValidation || (tailAtCapacity && Date.now() >= nextHistoryReadAt))) {
        // Tail sampling can miss startup markers between polls. Keep the
        // existing command byte limit and only reread this container's history.
        startupHistoryRead ||= startupNeedsValidation;
        nextHistoryReadAt = Date.now() + 30_000;
        const history = await readLogs(['logs', containerName]);
        observeLogs(history.output);
      }
      let state;
      try {
        state = JSON.parse(inspectResult.output);
        if (state === null || typeof state !== 'object' || typeof state.Running !== 'boolean') {
          throw new Error('Container state must declare whether the process is running.');
        }
      } catch {
        throw releaseError(
          'MIGRATION_CONTAINER_STATE_INVALID',
          'Runner received an invalid state for the test-migration container.',
          {
            stage: 'test-database-migration',
            recommendedAction: 'Use forge-release diagnose and repair the versioned Runner before retrying the release.',
            diagnosticText: inspectResult.output,
          },
        );
      }
      if (state.Running === false) {
        if (lastLogs) throw migrationFailure(lastLogs, state.Error);
        throw releaseError(
          'MIGRATION_CONTAINER_EXITED',
          'The test-migration container exited before the application became ready.',
          {
            stage: 'test-database-migration',
            recommendedAction: 'Use forge-release diagnose and correct the candidate or platform runtime before retrying.',
            details: { exitCode: state.ExitCode, oomKilled: state.OOMKilled === true },
            diagnosticText: state.Error,
          },
        );
      }
      // Startup messages survive process exit; only a currently running
      // candidate can satisfy the existing migration/startup check.
      if (validationObserved && applicationStartedObserved) {
        return { running: true, migrationValidated: true, applicationStarted: true,
          ...(validatedPreparedJobId === undefined ? {} : { migrationValidationReusedFrom: validatedPreparedJobId }) };
      }
      await this.delay(2000);
    }
    throw releaseError(
      'MIGRATION_TIMEOUT',
      'Test-database migration did not complete within the controlled timeout.',
      {
        stage: 'test-database-migration',
        retryable: true,
        recommendedAction: 'Use forge-release diagnose to distinguish database locking, connectivity, and candidate startup delays before retrying.',
        diagnosticText: lastLogs,
      },
    );
  }

  async migrateTestDatabase(contract, imageEnvironment = undefined, composeOverride = undefined, observeRuntime = undefined) {
    const run = composeOverride
      ? (environment, ...args) => this.command('docker', [...this.composeArgs(), '--file', composeOverride, ...args], { cwd: this.opsRoot, env: environment })
      : this.composeWithEnvironment.bind(this);
    const containerName = `${contract.projectSlug}-release-test-${Date.now()}`;
    try {
      await run(
        imageEnvironment,
        'run', '--detach', '--no-deps', '--name', containerName,
        '--label', `com.forge-delivery.project=${contract.projectSlug}`,
        '--label', 'com.forge-delivery.role=test-database-migration',
        '--env', `MYSQL_DB=${contract.infrastructure.mysql.testDatabase}`,
        '--env', `REDIS_DATABASE=${contract.infrastructure.redis.testDatabase}`,
        'forge-admin',
      ).catch((error) => {
        throw releaseError(
          'MIGRATION_CONTAINER_START_FAILED',
          'The controlled test-migration container could not be started.',
          {
            stage: 'test-database-migration',
            recommendedAction: 'Inspect the bounded Docker startup diagnostic and the candidate Compose configuration before retrying through the controlled Runner.',
            diagnosticText: error.output ?? error.message,
          },
        );
      });
      const startup = await this.waitForTestMigration(containerName);
      if (observeRuntime) return await observeRuntime(containerName, startup);
    } finally {
      await this.command('docker', ['stop', '--time', '10', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
      await this.command('docker', ['rm', '--force', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async recheckPreparedCandidateRuntime(request, contract, prepared, released = null) {
    const root = this.preparedCandidatePath(prepared.jobId);
    const binding = request.runtimePreparation;
    const immutable = { sourceCommit: prepared.commit, taskId: binding.taskId,
      baseSourceCommit: binding.baseSourceCommit, workspaceFingerprint: binding.workspaceFingerprint,
      acceptedPatchSha256: binding.acceptedPatchSha256, candidateTree: binding.candidateTree };
    try {
      if (!released || binding.recheck) {
        const initial = prepared.runtimeEvidence;
        const initialPath = path.join(root, 'runtime-evidence', initial.observationId, 'deployment.json');
        if (initial.evidence.deployment.path !== initialPath) throw new Error('Original deployment path mismatch.');
        const originalBytes = await readFile(initialPath);
        if (crypto.createHash('sha256').update(originalBytes).digest('hex') !== initial.evidence.deployment.sha256) throw new Error('Original deployment digest mismatch.');
        const previousPath = path.join(root, 'runtime-evidence', binding.recheck.previousObservationId, 'deployment.json');
        const original = JSON.parse(originalBytes);
        const previous = JSON.parse(await readFile(previousPath, 'utf8'));
        for (const document of [original, previous]) {
          if (Object.entries(immutable).some(([key, value]) => document[key] !== value)
            || document.status !== 'success' || document.target !== 'isolated-test-candidate' || document.releaseApplied !== false
            || document.image !== prepared.images['forge-admin'].id || document.startup?.migrationValidated !== true
            || document.startup?.applicationStarted !== true) throw new Error('Prepared deployment binding mismatch.');
        }
        if (original.observationId !== initial.observationId || previous.observationId !== binding.recheck.previousObservationId
          || previous.stateDigest !== binding.recheck.previousStateDigest) throw new Error('Previous runtime observation mismatch.');
      }
    } catch {
      throw releaseError('PREPARED_RUNTIME_EVIDENCE_MISMATCH', 'The prepared candidate and previous runtime observation do not match the protected recheck.');
    }
    const recovery = await this.readTestDatabaseRecoveryState();
    if (recovery?.status !== 'healthy' || recovery.database !== contract.infrastructure.mysql.testDatabase
      || recovery.lastAttempt?.jobId !== prepared.jobId || recovery.lastAttempt?.commit !== prepared.commit
      || recovery.lastAttempt?.status !== 'success'
      || released && (recovery.lastAttempt.published !== true || recovery.lastAttempt.releaseJobId !== released.jobId)) {
      throw releaseError('PREPARED_DATABASE_NOT_HEALTHY', 'The same prepared candidate no longer owns a healthy test database; no recheck was started.');
    }
    const plan = this.parseTestDatabasePlan((await this.runTestDatabaseOperator('plan', contract)).output, contract);
    if (plan.failedHistoryCount !== 0) throw releaseError('PREPARED_DATABASE_NOT_HEALTHY', 'The registered test database has failed migration history; recheck cannot restore or migrate it.');
    const containerName = `${contract.projectSlug}-runtime-recheck-${crypto.randomUUID().slice(0, 12)}`;
    try {
      await this.command('docker', [...this.composeArgs(), '--file', path.join(root, 'compose.candidate.json'),
        'run', '--detach', '--no-deps', '--name', containerName,
        '--label', `com.forge-delivery.project=${contract.projectSlug}`,
        '--label', 'com.forge-delivery.role=prepared-runtime-recheck',
        '--env', `MYSQL_DB=${contract.infrastructure.mysql.testDatabase}`,
        '--env', `REDIS_DATABASE=${contract.infrastructure.redis.testDatabase}`,
        '--env', 'SPRING_FLYWAY_ENABLED=false', 'forge-admin'], { cwd: this.opsRoot, env: prepared.buildEnv });
      const startup = await this.waitForTestMigration(containerName, prepared.jobId);
      if (released) startup.publicationValidationReusedFrom = released.jobId;
      return await this.captureCandidateRuntime(request, contract, prepared.jobId, prepared.images, containerName, startup);
    } finally {
      await this.command('docker', ['stop', '--time', '10', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
      await this.command('docker', ['rm', '--force', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async readCandidateDatabaseProbe(contract, probe) {
    const database = contract.infrastructure.mysql.testDatabase;
    if (!/^[a-z0-9_]{1,59}_test$/u.test(database) || database !== `${contract.infrastructure.mysql.database}_test`) {
      throw releaseError('RUNTIME_DATABASE_TARGET_INVALID', 'Only the registered test schema may be probed.');
    }
    const sharedEnvironment = envValue(await readFile(this.envFile, 'utf8'), 'SHARED_SERVICES_ENV_FILE');
    if (!path.posix.isAbsolute(sharedEnvironment) || sharedEnvironment.includes('\0')) throw releaseError('TEST_DATABASE_CONFIGURATION_INVALID', 'The protected shared environment path is invalid.');
    // All identifiers/values were validated by release-policy; no plan text is
    // interpreted as SQL or a shell command. Read-only transaction is additional defense.
    const literal = (value) => typeof value === 'string'
      ? (value.length ? `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)` : "''")
      : value === null ? 'NULL' : JSON.stringify(value);
    const predicate = probe.where.map((v) => `\`${v.column}\` ${v.equals === null ? 'IS NULL' : '= ' + literal(v.equals)}`).join(' AND ');
    const sql = `START TRANSACTION READ ONLY;\nSELECT JSON_OBJECT(${probe.columns.map((v) => `'${v}',\`${v}\``).join(',')}) FROM \`${database}\`.\`${probe.table}\`${predicate ? ' WHERE ' + predicate : ''} LIMIT ${probe.limit};\nROLLBACK;\n`;
    const script = `set -eu
unquote() { printf '%s' "$1" | sed "s/^['\\\"]//;s/['\\\"]$//"; }
MYSQL_HOST="$(unquote "$MYSQL_HOST")"
MYSQL_PORT="$(unquote "$MYSQL_PORT")"
MYSQL_USER="$(unquote "$MYSQL_USER")"
MYSQL_PWD="$(unquote "$MYSQL_PASSWORD")"
export MYSQL_PWD
mysql --batch --raw --skip-column-names --connect-timeout=10 --protocol=TCP --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" --database="$FORGE_TEST_DATABASE" <<'FORGE_READ_ONLY_PROBE'
${sql}FORGE_READ_ONLY_PROBE
`;
    const containerName = `${contract.projectSlug}-runtime-read-${crypto.randomUUID().slice(0, 12)}`;
    try {
      const result = await this.command('docker', [
        'run', '--rm', '--interactive', '--pull', 'never', '--name', containerName,
        '--network', `${contract.composeProjectName}_application`, '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m', '--cpus', '1.0',
        '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--env-file', sharedEnvironment, '--env', `FORGE_TEST_DATABASE=${database}`,
        '--env', 'HOME=/tmp', '--entrypoint', 'sh', contract.release.testDatabaseLifecycle.operatorImage, '-s',
      ], { cwd: this.opsRoot, input: script, timeoutMs: 60_000 });
      const rows = result.output.trim() ? result.output.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
      if (rows.length > probe.limit || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid bounded database response.');
      return { rowCount: rows.length, resultSha256: crypto.createHash('sha256').update(result.output).digest('hex') };
    } finally {
      await this.command('docker', ['rm', '--force', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async prepareRuntimeTestIdentities(request, contract, jobId) {
    const plan = request.runtimePreparation?.probePlan;
    const fixtures = new Map();
    if (plan?.identityFixtures?.length) {
      validateRuntimeIdentityScope(request.runtimePreparation.identityScope, plan);
      for (const fixture of plan.identityFixtures) fixtures.set(fixture.identity, fixture);
    }
    const aliases = plan?.schemaVersion === 2 ? [...new Set(plan.api.flatMap((probe) => probe.identity === undefined ? [] : [probe.identity]))] : [];
    if (!aliases.length) return new Map();
    const denied = () => releaseError('CANDIDATE_TEST_IDENTITY_PREPARATION_FAILED', 'Protected QA identities could not be prepared in the registered test database.');
    const database = contract.infrastructure.mysql.testDatabase;
    const sourceDatabase = contract.infrastructure.mysql.database;
    if (this.activeJob === null || !/^[a-z0-9_]{1,59}$/u.test(sourceDatabase)
      || database !== `${sourceDatabase}_test`) throw denied();
    const recovery = await this.readTestDatabaseRecoveryState();
    const expectedStatus = request.preparedJobId === undefined ? 'migration-pending' : 'healthy';
    if (recovery?.database !== database || recovery.status !== expectedStatus
      || recovery.lastAttempt?.jobId !== jobId || recovery.lastAttempt?.commit !== request.provenance.candidateCommit
      || recovery.lastAttempt?.status !== (expectedStatus === 'healthy' ? 'success' : 'migration-pending')) throw denied();
    const registered = await this.readRuntimeTestIdentities(contract);
    const selected = new Map();
    const numericId = (value) => /^[1-9][0-9]{0,18}$/u.test(String(value)) && BigInt(value) <= 9223372036854775807n;
    for (const alias of aliases) {
      const identity = registered.get(alias);
      if (!identity || !numericId(identity.userId) || !numericId(identity.tenantId)) throw denied();
      selected.set(alias, identity);
    }
    const sharedEnvironment = envValue(await readFile(this.envFile, 'utf8'), 'SHARED_SERVICES_ENV_FILE');
    if (!path.posix.isAbsolute(sharedEnvironment) || sharedEnvironment.includes('\0')) throw denied();
    const literal = (value) => `CONVERT(0x${Buffer.from(String(value)).toString('hex')} USING utf8mb4)`;
    const source = `\`${sourceDatabase}\``;
    const target = `\`${database}\``;
    const lock = `forge:test-reset:${crypto.createHash('sha256').update(database).digest('hex').slice(0, 32)}`;
    const guard = (condition) => `INSERT INTO forge_qa_identity_guard (ok) SELECT IF(${condition}, 1, 0);`;
    const columns = ['id', 'tenant_id', 'username', 'user_type', 'user_client', 'password', 'salt', 'user_status', 'force_password_change', 'del_flag'];
    const equalUser = columns.map((column) => `${['username', 'password', 'salt', 'user_client'].includes(column) ? 'BINARY ' : ''}dst.${column} <=> ${['username', 'password', 'salt', 'user_client'].includes(column) ? 'BINARY ' : ''}src.${column}`).join(' AND ');
    const statements = [
      'CREATE TEMPORARY TABLE forge_qa_identity_guard (ok TINYINT NOT NULL CHECK (ok = 1)) ENGINE=InnoDB;',
      'SET SESSION innodb_lock_wait_timeout = 10;',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
      'START TRANSACTION;',
      guard(`GET_LOCK('${lock}', 10) = 1`),
    ];
    for (const [alias, item] of selected) {
      const userId = String(item.userId); const tenantId = String(item.tenantId);
      const username = literal(item.username); const client = literal(item.userClient); const appId = literal(item.appId);
      statements.push(`SET @forge_identity_user_id = ${userId};`);
      for (const schema of [source, target]) {
        statements.push(guard(`(SELECT COUNT(*) FROM ${schema}.\`sys_tenant\` WHERE id = ${tenantId} AND tenant_status = 1 AND del_flag = 0 AND (expire_time IS NULL OR expire_time >= NOW())) = 1`));
        statements.push(guard(`(SELECT COUNT(*) FROM ${schema}.\`sys_client\` WHERE BINARY client_code = BINARY ${client} AND BINARY app_id = BINARY ${appId} AND status = 1 AND client_auth_method = 'none') = 1`));
      }
      const sourceIdentity = `src.id = ${userId} AND src.tenant_id = ${tenantId} AND BINARY src.username = BINARY ${username} AND src.user_type = 2 AND (src.user_client IS NULL OR BINARY src.user_client = BINARY ${client}) AND src.user_status = 1 AND src.del_flag = 0 AND src.force_password_change = 0 AND CHAR_LENGTH(src.password) > 0`;
      statements.push(guard(`(SELECT COUNT(*) FROM ${source}.\`sys_user\` src WHERE ${sourceIdentity}) = 1`));
      statements.push(guard(`(SELECT COUNT(*) FROM ${source}.\`sys_user_tenant\` WHERE user_id = ${userId} AND tenant_id = ${tenantId} AND member_type = 2 AND status = 1) = 1`));
      statements.push(guard(`NOT EXISTS (SELECT 1 FROM ${target}.\`sys_user\` dst JOIN ${source}.\`sys_user\` src ON src.id = ${userId} WHERE (dst.id = ${userId} OR (dst.tenant_id = ${tenantId} AND dst.username = ${username} AND dst.del_flag = 0)) AND NOT (${equalUser}))`));
      const equalMembership = 'dst.user_id = src.user_id AND dst.tenant_id = src.tenant_id AND dst.member_type = src.member_type AND dst.status = src.status AND dst.is_default = src.is_default';
      statements.push(guard(`NOT EXISTS (SELECT 1 FROM ${target}.\`sys_user_tenant\` dst JOIN ${source}.\`sys_user_tenant\` src ON src.user_id = ${userId} AND src.tenant_id = ${tenantId} WHERE dst.user_id = ${userId} AND dst.tenant_id = ${tenantId} AND NOT (${equalMembership}))`));
      statements.push(`INSERT INTO ${target}.\`sys_user\` (${columns.join(', ')}) SELECT ${columns.map((column) => 'src.' + column).join(', ')} FROM ${source}.\`sys_user\` src WHERE ${sourceIdentity} AND NOT EXISTS (SELECT 1 FROM ${target}.\`sys_user\` dst WHERE dst.id = src.id);`);
      statements.push(`INSERT INTO ${target}.\`sys_user_tenant\` (tenant_id, user_id, member_type, is_default, status) SELECT src.tenant_id, src.user_id, src.member_type, src.is_default, src.status FROM ${source}.\`sys_user_tenant\` src WHERE src.user_id = ${userId} AND src.tenant_id = ${tenantId} AND src.member_type = 2 AND src.status = 1 AND NOT EXISTS (SELECT 1 FROM ${target}.\`sys_user_tenant\` dst WHERE dst.user_id = src.user_id AND dst.tenant_id = src.tenant_id);`);
      statements.push(guard(`(SELECT COUNT(*) FROM ${target}.\`sys_user\` dst JOIN ${source}.\`sys_user\` src ON src.id = ${userId} WHERE dst.id = src.id AND (${equalUser})) = 1`));
      statements.push(guard(`(SELECT COUNT(*) FROM ${target}.\`sys_user_tenant\` dst JOIN ${source}.\`sys_user_tenant\` src ON src.user_id = ${userId} AND src.tenant_id = ${tenantId} WHERE ${equalMembership}) = 1`));
      const fixture = fixtures.get(alias);
      if (fixture) {
        const orgId = fixture.orgId;
        statements.push(guard(`(SELECT COUNT(*) FROM ${target}.\`sys_org\` WHERE id = ${orgId} AND tenant_id = ${tenantId} AND org_status = 1 AND del_flag = 0) = 1`));
        const roleKeys = fixture.roleKeys.map(literal).join(', ');
        const roles = `SELECT r.id FROM ${target}.\`sys_role\` r WHERE r.tenant_id = ${tenantId} AND r.id > 0 AND r.role_status = 1 AND r.del_flag = 0 AND r.role_type IN (2, 3, 4) AND LOWER(r.role_key) NOT IN ('admin', 'super_admin', 'superadmin', 'tenant_admin', 'tenantadmin', 'root') AND r.data_scope IN (3, 4, 5) AND BINARY r.role_key IN (${roleKeys || 'NULL'}) AND (r.org_scope_type = 1 OR (r.org_scope_type = 2 AND EXISTS (SELECT 1 FROM ${target}.\`sys_role_org\` ro WHERE ro.tenant_id = ${tenantId} AND ro.role_id = r.id AND ro.org_id = ${orgId})))`;
        statements.push(guard(`(SELECT COUNT(*) FROM (${roles}) approved_roles) = ${fixture.roleKeys.length}`));
        // A fixture describes one exact organization and role set for this registered QA alias.
        // Replace only its isolated test relations so previous probes cannot leak extra authority.
        statements.push(`DELETE FROM ${target}.\`sys_user_org_role\` WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND (org_id <> ${orgId} OR role_id NOT IN (${roles}));`);
        statements.push(`DELETE FROM ${target}.\`sys_user_org\` WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND org_id <> ${orgId};`);
        statements.push(`UPDATE ${target}.\`sys_user_org\` SET is_main = 1 WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND org_id = ${orgId};`);
        statements.push(`INSERT INTO ${target}.\`sys_user_org\` (tenant_id, user_id, org_id, is_main) SELECT ${tenantId}, ${userId}, ${orgId}, 1 WHERE NOT EXISTS (SELECT 1 FROM ${target}.\`sys_user_org\` WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND org_id = ${orgId});`);
        statements.push(`INSERT INTO ${target}.\`sys_user_org_role\` (tenant_id, user_id, org_id, role_id) SELECT ${tenantId}, ${userId}, ${orgId}, approved_roles.id FROM (${roles}) approved_roles WHERE NOT EXISTS (SELECT 1 FROM ${target}.\`sys_user_org_role\` current_role WHERE current_role.tenant_id = ${tenantId} AND current_role.user_id = ${userId} AND current_role.org_id = ${orgId} AND current_role.role_id = approved_roles.id);`);
        statements.push(guard(`(SELECT COUNT(*) FROM ${target}.\`sys_user_org\` WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND org_id = ${orgId} AND is_main = 1) = 1`));
        statements.push(guard(`(SELECT COUNT(*) FROM ${target}.\`sys_user_org_role\` WHERE tenant_id = ${tenantId} AND user_id = ${userId}) = ${fixture.roleKeys.length}`));
      }
    }
    statements.push('COMMIT;', `DO RELEASE_LOCK('${lock}');`, `SELECT 'QA_IDENTITIES_READY=${selected.size}';`);
    // Fixed credentials stay inside MySQL; optional QA relations affect only the bound test database.
    // A statement error closes the non-interactive connection without COMMIT, rolling back all aliases.
    const script = `set -eu
unquote() { printf '%s' "$1" | sed "s/^['\\\"]//;s/['\\\"]$//"; }
MYSQL_HOST="$(unquote "$MYSQL_HOST")"
MYSQL_PORT="$(unquote "$MYSQL_PORT")"
MYSQL_USER="$(unquote "$MYSQL_USER")"
MYSQL_PWD="$(unquote "$MYSQL_PASSWORD")"
export MYSQL_PWD
mysql --batch --raw --skip-column-names --connect-timeout=10 --protocol=TCP --host="$MYSQL_HOST" --port="$MYSQL_PORT" --user="$MYSQL_USER" --database="$FORGE_TEST_DATABASE" <<'FORGE_QA_IDENTITY_TRANSACTION'
${statements.join('\n')}
FORGE_QA_IDENTITY_TRANSACTION
`;
    const containerName = `${contract.projectSlug}-runtime-identities-${crypto.randomUUID().slice(0, 12)}`;
    try {
      const result = await this.command('docker', [
        'run', '--rm', '--interactive', '--pull', 'never', '--name', containerName,
        '--network', `${contract.composeProjectName}_application`, '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m', '--cpus', '1.0',
        '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--env-file', sharedEnvironment, '--env', `FORGE_TEST_DATABASE=${database}`,
        '--env', 'HOME=/tmp', '--entrypoint', 'sh', contract.release.testDatabaseLifecycle.operatorImage, '-s',
      ], { cwd: this.opsRoot, input: script, timeoutMs: 60_000 });
      if (result.output.trim() !== `QA_IDENTITIES_READY=${selected.size}`) throw denied();
      return selected;
    } catch {
      selected.clear(); throw denied();
    } finally {
      await this.command('docker', ['rm', '--force', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async readRuntimeTestIdentities(contract) {
    const unavailable = () => releaseError('CANDIDATE_TEST_IDENTITY_UNAVAILABLE', 'Protected test identities are unavailable.');
    let file;
    try {
      const target = path.join(this.opsRoot, 'runtime-test-identities.json');
      const before = await lstat(target);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024
        || (process.platform !== 'win32' && (before.mode & 0o777) !== 0o600)) throw unavailable();
      file = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw unavailable();
      const bytes = await file.readFile();
      if (bytes.length > 64 * 1024) throw unavailable();
      const value = JSON.parse(bytes.toString('utf8'));
      const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
        && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
      const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 || Number.isSafeInteger(value);
      if (!exact(value, ['schemaVersion', 'projectSlug', 'testDatabase', 'identities']) || value.schemaVersion !== 1
        || value.projectSlug !== contract.projectSlug || value.testDatabase !== contract.infrastructure.mysql.testDatabase
        || !Array.isArray(value.identities) || value.identities.length < 1 || value.identities.length > 64) throw unavailable();
      const identities = new Map();
      for (const item of value.identities) {
        if (!exact(item, ['alias', 'username', 'password', 'userId', 'tenantId', 'userClient', 'appId'])
          || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(item.alias) || ['__proto__', 'prototype', 'constructor'].includes(item.alias)
          || identities.has(item.alias) || !id(item.userId) || !id(item.tenantId)
          || !['username', 'userClient', 'appId'].every(key => typeof item[key] === 'string' && item[key].length > 0 && item[key].length <= 256)
          || typeof item.password !== 'string' || !item.password || item.password.length > 4096) throw unavailable();
        identities.set(item.alias, item);
      }
      return identities;
    } catch { throw unavailable(); }
    finally { await file?.close(); }
  }

  async captureCandidateRuntime(request, contract, jobId, images, containerName, startup) {
    const observationId = crypto.randomUUID();
    const root = path.join(this.preparedCandidatePath(jobId), 'runtime-evidence', observationId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const { probePlan, ...binding } = request.runtimePreparation;
    const common = { sourceCommit: request.provenance.candidateCommit, ...binding,
      probePlanSha256: crypto.createHash('sha256').update(JSON.stringify(probePlan)).digest('hex'),
      observationId, observedAt: new Date().toISOString() };
    const deployment = { ...common, status: 'failed', target: 'isolated-test-candidate', releaseApplied: false,
      containerName, image: images['forge-admin'].id, startup };
    const api = { ...common, status: 'blocked', authentication: 'anonymous', roleAuthorizationVerified: false, checks: [] };
    const database = { ...common, status: 'blocked', database: contract.infrastructure.mysql.testDatabase, checks: [] };
    const browser = { ...common, ...probePlan.browser };
    try {
      const network = `${contract.composeProjectName}_application`;
      const format = '{"running":{{json .State.Running}},"image":{{json .Image}},"address":{{json (index .NetworkSettings.Networks "' + network + '").IPAddress}},"ports":{{json .Config.ExposedPorts}}}';
      const candidate = JSON.parse((await this.command('docker', ['inspect', '--format', format, containerName])).output);
      if (candidate.running !== true || candidate.image !== images['forge-admin'].id
        || net.isIP(candidate.address) !== 4 || !Object.hasOwn(candidate.ports ?? {}, '8580/tcp')
        || startup?.migrationValidated !== true || startup?.applicationStarted !== true) throw new Error('Candidate identity or startup mismatch.');
      deployment.status = 'success';
      const captures = new Map();
      const sessions = new Map();
      const failedIdentities = new Set();
      let identities; let identityPreparation;
      const scalar = value => value === null || typeof value === 'boolean'
        || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
        || typeof value === 'string' && value.length <= 4096;
      const blocked = code => Object.assign(new Error(code), { code, notExecuted: true });
      const resolve = value => {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$capture')) {
          if (!captures.has(value.$capture)) throw blocked('CANDIDATE_CAPTURE_UNAVAILABLE');
          return captures.get(value.$capture);
        }
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
        return value;
      };
      const select = (value, parts) => {
        for (const key of parts) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
          value = value[key];
        }
        return value;
      };
      const origin = `http://${candidate.address}:8580`;
      const fetchCandidate = (relative, init) => {
        const target = new URL(relative, origin);
        if (!relative.startsWith('/') || relative.startsWith('//') || target.origin !== origin || relative.includes('\\')) {
          throw blocked('CANDIDATE_API_TARGET_INVALID');
        }
        return this.fetch(target.href, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      };
      try {
        for (const probe of probePlan.api) {
          const check = { id: probe.id, method: probe.method, path: probe.path, status: 'failed' };
          try {
            const parameters = resolve(probe.pathParameters ?? {});
            let route = probe.path.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/gu, (_, key) => {
              const value = String(parameters[key]);
              if (!value || value === '.' || value === '..' || /[/\\%?#\s\u0000-\u001f\u007f]/u.test(value)) {
                throw blocked('CANDIDATE_API_PATH_PARAMETER_INVALID');
              }
              return encodeURIComponent(value);
            });
            const query = new URLSearchParams(Object.entries(resolve(probe.query ?? {})).map(([key, value]) => [key, String(value)]));
            if (query.size) route += `?${query}`;
            const body = resolve(probe.body);
            const assertions = resolve(probe.jsonAssertions);
            let httpStatus; let json; let bytes;
            if (probe.identity !== undefined) {
              check.identityAlias = probe.identity;
              if (failedIdentities.has(probe.identity)) throw blocked('CANDIDATE_TEST_IDENTITY_UNAVAILABLE');
              if (!sessions.has(probe.identity)) {
                let session;
                try {
                  identities ??= await (identityPreparation ??= this.prepareRuntimeTestIdentities(request, contract, jobId));
                  const registered = identities.get(probe.identity);
                  if (!registered) throw blocked('CANDIDATE_TEST_IDENTITY_UNAVAILABLE');
                  session = await createForgeCandidateAuthenticatedSession({ fetchCandidate,
                    credential: { username: registered.username, password: registered.password },
                    loginContext: { tenantId: registered.tenantId, userClient: registered.userClient, appId: registered.appId } });
                  if (String(session.identity.userId) !== String(registered.userId)
                    || String(session.identity.tenantId) !== String(registered.tenantId)) throw blocked('CANDIDATE_TEST_IDENTITY_MISMATCH');
                  sessions.set(probe.identity, session);
                } catch (error) {
                  session?.close(); failedIdentities.add(probe.identity);
                  throw blocked(/^CANDIDATE_AUTH_[A-Z_]+$/u.test(error?.code ?? '') || error?.code === 'CANDIDATE_TEST_IDENTITY_PREPARATION_FAILED' ? error.code
                    : error?.code === 'CANDIDATE_TEST_IDENTITY_MISMATCH' ? error.code : 'CANDIDATE_TEST_IDENTITY_UNAVAILABLE');
                }
              }
              const session = sessions.get(probe.identity);
              check.identity = session.identity;
              const multipart = probe.multipart === undefined ? undefined : {
                ...probe.multipart,
                fields: Object.fromEntries(Object.entries(resolve(probe.multipart.fields)).map(([key, value]) => [key, String(value)])),
              };
              const response = await session.request({ method: probe.method, path: route,
                ...(body === undefined ? {} : { body }), ...(multipart === undefined ? {} : { multipart }),
                ...(probe.download === undefined ? {} : { responseType: 'binary' }) });
              httpStatus = response.httpStatus;
              if (probe.download !== undefined) {
                bytes = Buffer.from(response.bodyBytes);
                json = await projectRuntimeDownload({ bytes, contentType: response.contentType,
                  contentDisposition: response.contentDisposition, format: probe.download.format });
                const { contentType, fileName, byteLength, sha256 } = json;
                check.download = { format: probe.download.format, contentType, fileName, byteLength, sha256 };
                check.responseDigestBasis = 'authenticated-binary-response';
              } else {
                json = response.body; bytes = Buffer.from(JSON.stringify(json));
                check.responseDigestBasis = 'authenticated-decoded-redacted-json';
              }
              api.authentication = 'protected-test-identities';
            } else {
              const response = await fetchCandidate(route, { method: probe.method });
              httpStatus = response.status;
              const chunks = []; let length = 0;
              if (response.body) {
                const reader = response.body.getReader();
                try {
                  for (;;) {
                    const item = await reader.read(); if (item.done) break;
                    length += item.value.length;
                    if (length > 1024 * 1024) throw new Error('Bounded API response exceeded.');
                    chunks.push(Buffer.from(item.value));
                  }
                } finally { await reader.cancel().catch(() => undefined); }
              }
              bytes = Buffer.concat(chunks);
              json = assertions.length || probe.captures?.length ? JSON.parse(bytes.toString('utf8')) : null;
              check.responseDigestBasis = 'response-bytes';
            }
            const assertionResults = assertions.map(assertion => select(json, assertion.path) === assertion.equals);
            const assertionsPassed = assertionResults.every(Boolean);
            const passed = httpStatus === probe.expectedStatus && assertionsPassed;
            Object.assign(check, { status: passed ? 'passed' : 'failed', httpStatus, assertionsPassed, assertionResults,
              responseSha256: crypto.createHash('sha256').update(bytes).digest('hex') });
            if (!passed) {
              const valueType = value => value === undefined ? 'missing' : value === null ? 'null'
                : Array.isArray(value) ? 'array' : typeof value;
              const diagnostic = { assertionMismatches: assertions.flatMap((assertion, index) => assertionResults[index] ? []
                : [{ index, expectedType: valueType(assertion.equals), actualType: valueType(select(json, assertion.path)) }]) };
              // Only standard envelope fields may expose values; arbitrary assertion paths expose types only.
              if (Number.isSafeInteger(json?.code) || typeof json?.code === 'string' && /^[A-Z][A-Z0-9_.-]{0,63}$/u.test(json.code)) {
                diagnostic.code = json.code;
              }
              const message = typeof json?.msg === 'string' ? json.msg : json?.message;
              if (typeof message === 'string' && message.length <= 4096) {
                let redacted = message;
                for (const identity of identities?.values() ?? []) {
                  for (const secret of [identity.username, identity.password]) {
                    if (typeof secret === 'string' && secret) redacted = redacted.split(secret).join('[REDACTED]');
                  }
                }
                diagnostic.message = sanitizeDiagnosticText(redacted
                  .replace(/\b(?:authorization|(?:set-)?cookie)\s*[:=]\s*[^;\r\n]*/gi, '[REDACTED]')
                  .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]'))
                  .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
              }
              check.failureDiagnostic = diagnostic;
            }
            if (passed) {
              const values = (probe.captures ?? []).map(capture => [capture.name, select(json, capture.path)]);
              if (values.some(([, value]) => !scalar(value))) throw new Error('Capture must be a bounded scalar.');
              for (const [name, value] of values) captures.set(name, value);
            }
          } catch (error) {
            check.status = error?.notExecuted ? 'not-executed' : 'failed';
            check.errorCode = error?.notExecuted ? error.code : 'CANDIDATE_API_PROBE_FAILED';
          }
          api.checks.push(check);
        }
        for (const probe of probePlan.database) {
          const check = { id: probe.id, status: 'failed' };
          try {
            const result = await this.readCandidateDatabaseProbe(contract, { ...probe, where: resolve(probe.where) });
            Object.assign(check, result, { status: result.rowCount === probe.expectedRows ? 'passed' : 'failed' });
          } catch (error) {
            check.status = error?.notExecuted ? 'not-executed' : 'failed';
            check.errorCode = error?.notExecuted ? error.code : 'CANDIDATE_DATABASE_PROBE_FAILED';
          }
          database.checks.push(check);
        }
      } finally {
        for (const session of sessions.values()) session.close();
        captures.clear(); identities?.clear();
      }
      for (const document of [api, database]) document.status = document.checks.length === 0 ? 'blocked'
        : document.checks.every((v) => v.status === 'passed') ? 'passed'
          : document.checks.some((v) => v.status === 'failed') ? 'failed' : 'blocked';
    } catch { deployment.errorCode = 'CANDIDATE_RUNTIME_IDENTITY_INVALID'; }
    const evidence = {};
    for (const [kind, document] of Object.entries({ deployment, api, database, browser })) {
      const bytes = Buffer.from(JSON.stringify(document) + '\n');
      const file = path.join(root, `${kind}.json`);
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      evidence[kind] = { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
    }
    const status = deployment.status !== 'success' || [api, database].some((v) => v.status === 'failed') ? 'failed'
      : [api, database].some((v) => v.status === 'blocked') ? 'blocked' : 'passed';
    const apiFailureDiagnostics = api.checks.filter(check => check.failureDiagnostic)
      .map(({ id, failureDiagnostic }) => ({ id, failureDiagnostic }));
    return { status, observationId, root, evidence,
      ...(apiFailureDiagnostics.length ? { apiFailureDiagnostics } : {}) };
  }

  async waitForUi(requireMobile = false) {
    const deadline = Date.now() + 90_000;
    const probes = [
      { name: 'ui', url: 'http://forge-ui/forge/login' },
      { name: 'api', url: 'http://forge-ui/forge-api/auth/captcha' },
      ...(requireMobile ? [
        { name: 'mobile-ui', url: 'http://forge-ui/forge-h5/' },
        { name: 'mobile-api', url: 'http://forge-ui/forge-h5-api/auth/captcha' },
      ] : []),
    ];
    let results = [];
    while (Date.now() < deadline) {
      try {
        results = await Promise.all(probes.map(async (probe) => {
          const response = await this.fetch(probe.url, { redirect: 'manual' });
          return { name: probe.name, url: new URL(probe.url).pathname, status: response.status };
        }));
        if (results.every(({ status }) => status >= 200 && status < 400)) return { probes: results };
      } catch {
        // The fixed application network may need a few seconds to publish DNS/readiness.
      }
      await delay(2000);
    }
    const error = new Error('Forge UI and API did not become reachable from the project application network.');
    error.output = JSON.stringify(results);
    throw error;
  }

  async refreshRetainedUiUpstreams(services) {
    if (services.includes('forge-ui')
      || !services.some((service) => ['forge-admin', 'forge-app', 'forge-flow'].includes(service))) return;
    // A retained Nginx process keeps the old upstream container addresses.
    // Resolve the current project service addresses after either deployment or rollback.
    await this.compose('exec', '-T', 'forge-ui', 'nginx', '-t');
    await this.compose('exec', '-T', 'forge-ui', 'nginx', '-s', 'reload');
  }

  async rollbackApplicationDeployment(services, backupEnv) {
    await copyFile(backupEnv, this.envFile);
    await chmod(this.envFile, 0o600);
    await this.compose('up', '--detach', '--no-deps', ...services);
    await this.refreshRetainedUiUpstreams(services);
    return this.waitForUi(services.includes('forge-app'));
  }

  async audit(record) {
    const line = `${JSON.stringify(record)}\n`;
    const handle = await open(this.auditFile, 'a', 0o600);
    try {
      await handle.appendFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(this.auditFile, 0o600);
  }

  async readJobState() {
    try {
      const state = JSON.parse(await readFile(this.jobStateFile, 'utf8'));
      return state?.schemaVersion === 1 ? state : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async recordJobState(state) {
    await atomicReplace(this.jobStateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  async diagnose() {
    const stored = await this.readJobState();
    const testDatabaseRecovery = await this.readTestDatabaseRecoveryState();
    const lastJob = stored?.status === 'running' && this.activeJob === null
      ? {
          ...stored,
          status: 'interrupted',
          stage: 'runner-restart-recovery',
          retryable: true,
          recommendedAction: 'Confirm the workspace and project Runner are healthy, then retry the same committed release through the controlled capability.',
        }
      : stored;
    return {
      active: this.activeJob !== null,
      activeJobId: this.activeJob,
      lastJob,
      testDatabaseRecovery,
    };
  }

  async preparationBinding() {
    return preparationDigest(await Promise.all([this.envFile, this.composeFile, this.contractPath].map(file => readFile(file))));
  }

  async preparedBindingMatches(prepared, released = null, request = null) {
    const current = await Promise.all([this.envFile, this.composeFile, this.contractPath].map(file => readFile(file)));
    const currentBinding = preparationDigest(current);
    if (released) {
      if (released.status !== 'success' || released.stage !== 'complete' || released.preparedJobId !== prepared.jobId
        || released.result?.commit !== prepared.commit || released.result.version !== prepared.version
        || JSON.stringify(released.provenance) !== JSON.stringify(prepared.provenance)
        || JSON.stringify(released.result.provenance) !== JSON.stringify(prepared.provenance)
        || JSON.stringify(released.services) !== JSON.stringify(prepared.services)
        || JSON.stringify(released.result.services) !== JSON.stringify(prepared.services)) return false;
      const variables = { 'forge-admin': 'FORGE_ADMIN_IMAGE', 'forge-app': 'FORGE_APP_IMAGE',
        'forge-flow': 'FORGE_FLOW_IMAGE', 'forge-ui': 'FORGE_UI_IMAGE' };
      const observedServices = request?.runtimePreparation && !request.runtimePreparation.recheck ? request.services : null;
      if (observedServices && (!Array.isArray(observedServices) || observedServices.length === 0
        || observedServices.some(service => !prepared.services.includes(service) || !variables[service]))) return false;
      const replacements = new Map([['FORGE_ADMIN_COMMIT', prepared.commit]]);
      for (const service of prepared.services) {
        const image = prepared.images?.[service]?.id;
        if (!/^sha256:[a-f0-9]{64}$/u.test(image ?? '') || released.result.images?.[service]?.id !== image
          || prepared.buildEnv?.[variables[service]] !== image) return false;
        replacements.set(variables[service], image);
      }
      const prefix = `${this.envFile}.pre-controlled-release-`;
      if (typeof released.rollbackEnv !== 'string' || !released.rollbackEnv.startsWith(prefix)
        || !/^\d{17}-[a-f0-9]{12}$/u.test(released.rollbackEnv.slice(prefix.length))
        || !released.rollbackEnv.endsWith(`-${prepared.commit.slice(0, 12)}`)) return false;
      try {
        const info = await lstat(released.rollbackEnv);
        if (!info.isFile() || info.nlink !== 1) return false;
        const environment = await readFile(released.rollbackEnv);
        const previous = [environment, ...current.slice(1)];
        if (![preparationDigest(previous), preparationDigest(previous, true)].includes(prepared.binding)) return false;
        const expected = Buffer.from(replaceEnvValues(environment.toString('utf8'), replacements));
        if (!observedServices) return preparationDigest([expected, ...current.slice(1)]) === currentBinding;
        // A published observation runs only its selected images, with --no-deps.
        // Keep the original release proof, but do not bind unrelated service image values.
        const unobserved = new Set(Object.entries(variables).filter(([service]) => !observedServices.includes(service)).map(([, variable]) => variable));
        const observationEnvironment = bytes => Buffer.from(bytes.toString('latin1')
          .replace(/^(FORGE_ADMIN_IMAGE|FORGE_APP_IMAGE|FORGE_FLOW_IMAGE|FORGE_UI_IMAGE)=[^\r\n]*/gm,
            (line, variable) => unobserved.has(variable) ? `${variable}=<unobserved-image>` : line), 'latin1');
        return preparationDigest([observationEnvironment(expected), ...current.slice(1)])
          === preparationDigest([observationEnvironment(current[0]), ...current.slice(1)]);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    if (prepared.binding === currentBinding) return true;
    if (!/^[a-f0-9]{64}$/u.test(prepared.binding ?? '')) return false;
    if (prepared.binding === preparationDigest(current, true)) return true;
    // A legacy digest is compatible only with its actual protected env preimage.
    // No caller-supplied path or scan of unrelated deployment backups is used.
    const preimageFile = path.join(this.preparedCandidatePath(prepared.jobId), 'project.env.before');
    let environment;
    try {
      const info = await lstat(preimageFile);
      if (!info.isFile() || info.nlink !== 1) return false;
      environment = await readFile(preimageFile);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const previous = [environment, ...current.slice(1)];
    return prepared.binding === preparationDigest(previous, true)
      && preparationDigest(previous) === currentBinding;
  }

  preparedCandidatePath(jobId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(jobId ?? '')) {
      throw releaseError('PREPARED_CANDIDATE_INVALID', 'The prepared candidate identifier is invalid.');
    }
    return path.join(this.opsRoot, 'release-candidates', jobId);
  }

  async uiOnlyDatabaseSkip(request, commit, previous) {
    if (request.services.length !== 1 || request.services[0] !== 'forge-ui'
      || request.runtimePreparation) return null;
    try {
      const environment = await readFile(this.envFile, 'utf8');
      const baseline = envValue(environment, 'FORGE_ADMIN_COMMIT');
      // The env moves before application startup. A matching successful job is
      // required so interrupted or failed publication cannot grant this skip.
      if (!/^[a-f0-9]{40}$/u.test(baseline)) return null;
      if (previous?.status === 'success' && previous.stage === 'complete') {
        if (previous.result?.commit !== baseline) return null;
      } else {
        // A failed read-only snapshot must not erase proof of the still-running
        // published baseline. Never turn that failed job into a prepared one.
        if (previous?.status !== 'failed' || previous.stage !== 'failed'
          || previous.failedStage !== 'test-database-snapshot'
          || previous.testDatabaseSandbox?.restoreRequired !== false) return null;
        const records = (await readFile(this.auditFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        const released = records.findLast(record => record.type === 'controlled-release'
          && record.status === 'success' && record.commit === baseline);
        if (!released || !(Date.parse(released.completedAt) <= Date.parse(previous.startedAt))) return null;
        const preparation = records.findLast(record => record.type === 'candidate-preparation'
          && record.status === 'prepared' && record.commit === baseline && record.version === released.version
          && JSON.stringify(record.provenance) === JSON.stringify(released.provenance)
          && JSON.stringify(record.services) === JSON.stringify(released.services)
          && Date.parse(record.completedAt) <= Date.parse(released.startedAt));
        if (!preparation) return null;
        const prepared = JSON.parse(await readFile(path.join(this.preparedCandidatePath(preparation.jobId), 'prepared.json'), 'utf8'));
        if (prepared.schemaVersion !== 1 || prepared.status !== 'prepared' || prepared.jobId !== preparation.jobId
          || prepared.commit !== baseline || prepared.version !== released.version
          || JSON.stringify(prepared.provenance) !== JSON.stringify(released.provenance)
          || JSON.stringify(prepared.services) !== JSON.stringify(released.services)) return null;
        // Admin anchors the existing successful database baseline, which may
        // have been published separately from UI. This UI-only operation does
        // not deploy any database-consuming service.
        const variables = { 'forge-admin': 'FORGE_ADMIN_IMAGE' };
        for (const [service, variable] of Object.entries(variables)) {
          const image = released.images?.[service]?.id;
          if (!/^sha256:[a-f0-9]{64}$/u.test(image ?? '') || envValue(environment, variable) !== image
            || prepared.images?.[service]?.id !== image || preparation.images?.[service]?.id !== image) return null;
        }
        const ids = (await this.compose('ps', '--quiet', ...Object.keys(variables))).output.trim().split(/\s+/u);
        if (new Set(ids).size !== 1 || ids.some(id => !/^[a-f0-9]{12,64}$/u.test(id))) return null;
        const format = '{"running":{{json .State.Running}},"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';
        const containers = (await this.command('docker', ['inspect', '--format', format, ...ids])).output.trim().split('\n').map(line => JSON.parse(line));
        const contract = await this.loadContract();
        if (containers.length !== 1 || new Set(containers.map(container => container.service)).size !== 1
          || containers.some(container => !Object.hasOwn(variables, container.service) || container.running !== true
            || container.project !== contract.composeProjectName || container.image !== released.images[container.service].id)) return null;
      }
      // Both release entrances build only request.services and deploy them with
      // --no-deps. Parallel backend changes in the shared Git candidate are not
      // deployed by this UI-only request and must not trigger a database write.
      await this.command('git', ['-C', this.workspaceRoot, 'cat-file', '-e', `${baseline}^{commit}`]);
      return { mode: 'not-required', reason: 'frontend-only-services', baselineCommit: baseline, candidateCommit: commit };
    } catch {
      return null;
    }
  }

  async prepareCandidate(request) {
    if (this.activeJob !== null) throw releaseError('RELEASE_IN_PROGRESS', 'Another controlled release is running.');
    const jobId = crypto.randomUUID();
    this.activeJob = jobId;
    const startedAt = new Date().toISOString();
    let state = { schemaVersion: 1, jobId, status: 'running', stage: 'candidate-preflight',
      services: request.services, provenance: request.provenance, startedAt };
    let retainedPreparation = null;
    let releasedPreparation = null;
    const update = async (values) => {
      state = { ...state, ...values, updatedAt: new Date().toISOString() };
      await this.recordJobState(state);
    };
    try {
      const previous = await this.readJobState();
      const commit = request.provenance.candidateCommit;
      if (previous?.status === 'prepared' && previous.commit === commit
        && JSON.stringify(previous.provenance) === JSON.stringify(request.provenance)
        && JSON.stringify(previous.services) === JSON.stringify(request.services)
        && (request.version === undefined || previous.version === request.version)) {
        retainedPreparation = previous;
      }
      if (request.preparedJobId !== undefined && request.runtimePreparation && !request.runtimePreparation.recheck
        && previous?.status === 'success' && previous.stage === 'complete'
        && previous.preparedJobId === request.preparedJobId && previous.result?.commit === commit) {
        releasedPreparation = previous;
        retainedPreparation = { ...previous, jobId: previous.preparedJobId };
      }
      if (request.preparedJobId !== undefined && (!retainedPreparation
        || retainedPreparation.jobId !== request.preparedJobId
        || !request.runtimePreparation?.recheck && !releasedPreparation)) {
        throw releaseError('PREPARED_CANDIDATE_STALE', 'The protected runtime recheck must reuse its exact prepared job; rebuilding is not allowed.');
      }
      const preflight = await this.preflight();
      if (!preflight.workspaceClean) throw releaseError('WORKSPACE_DIRTY', 'The shared workspace is not clean.');
      if (releasedPreparation && preflight.head !== commit) throw releaseError('PREPARED_CANDIDATE_STALE', 'The published candidate is no longer the current workspace commit.');
      if (retainedPreparation) {
        const prepared = await this.readPreparedCandidate({ ...request, preparedJobId: retainedPreparation.jobId }, commit, releasedPreparation);
        let runtimeEvidence;
        if (request.runtimePreparation) {
          const root = this.preparedCandidatePath(prepared.jobId);
          const tree = (await this.command('git', ['-C', path.join(root, 'workspace'), 'rev-parse', 'HEAD^{tree}'])).output.trim();
          if (tree !== request.runtimePreparation.candidateTree) throw releaseError('CANDIDATE_TREE_MISMATCH', 'The runtime candidate tree does not match its protected binding.');
          const contract = await this.loadContract();
          if (request.preparedJobId !== undefined) {
            runtimeEvidence = await this.recheckPreparedCandidateRuntime(request, contract, prepared, releasedPreparation);
          } else {
            // Ordinary preparation retains its existing migration lifecycle.
            await this.prepareTestDatabase(contract, prepared.jobId, commit, async () => {});
            try {
              runtimeEvidence = await this.migrateTestDatabase(contract, prepared.buildEnv, path.join(root, 'compose.candidate.json'),
                (name, startup) => this.captureCandidateRuntime(request, contract, prepared.jobId, prepared.images, name, startup));
            } catch (error) {
              await this.markTestDatabaseRecoveryRequired(prepared.jobId, error).catch(() => undefined);
              throw error;
            }
            await this.markTestDatabaseHealthy(prepared.jobId);
          }
          if (!await this.preparedBindingMatches(prepared, releasedPreparation, request)) throw releaseError('PREPARED_CANDIDATE_STALE', 'Project release configuration changed during runtime observation.');
        }
        await this.audit({ type: 'candidate-preparation-reuse', jobId: prepared.jobId, commit,
          services: prepared.services, provenance: prepared.provenance, ...(runtimeEvidence ? { runtimeEvidence } : {}), reusedAt: new Date().toISOString() });
        return { jobId: prepared.jobId, status: 'prepared', commit, version: prepared.version, images: prepared.images,
          ...(runtimeEvidence ? { runtimeEvidence } : {}) };
      }
      await update({});
      const contract = await this.loadContract();
      const binding = await this.preparationBinding();
      const root = this.preparedCandidatePath(jobId);
      const source = path.join(root, 'workspace');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.command('git', ['init', source]);
      await this.command('git', ['-C', source, 'fetch', '--no-tags', this.workspaceRoot, commit]);
      await this.command('git', ['-c', 'core.autocrlf=false', '-C', source, 'checkout', '--detach', commit]);
      const head = (await this.command('git', ['-C', source, 'rev-parse', 'HEAD'])).output.trim();
      const dirty = (await this.command('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all'])).output.trim();
      if (head !== commit || dirty) throw releaseError('CANDIDATE_COMMIT_MISMATCH', 'The isolated candidate is not the exact clean commit.');
      if (request.runtimePreparation) {
        const tree = (await this.command('git', ['-C', source, 'rev-parse', 'HEAD^{tree}'])).output.trim();
        if (tree !== request.runtimePreparation.candidateTree) throw releaseError('CANDIDATE_TREE_MISMATCH', 'The runtime candidate tree does not match its protected binding.');
      }
      await this.validateProtectedFiles(contract, source);
      await this.validateMigrations(source);
      const version = request.version ?? ('release-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase() + '-' + commit.slice(0, 12));
      const serviceVariables = { 'forge-admin': 'FORGE_ADMIN_IMAGE', 'forge-app': 'FORGE_APP_IMAGE',
        'forge-flow': 'FORGE_FLOW_IMAGE', 'forge-ui': 'FORGE_UI_IMAGE' };
      const buildEnv = Object.fromEntries(request.services.map((service) => [
        serviceVariables[service], contract.composeProjectName + '/' + service + ':' + version,
      ]));
      // Fixed Compose override: build the isolated source and bind its reviewed
      // configuration/migrations. The live Compose file and branch stay intact.
      const overrides = {};
      for (const service of request.services) overrides[service] = { build: { context: source } };
      overrides['forge-admin'] = { ...overrides['forge-admin'], volumes: [
        { type: 'bind', source: path.join(source, 'docker-forge-admin', 'application-datasource.yml'), target: '/app/application-prod.yml', read_only: true },
        { type: 'bind', source: path.join(source, 'forge-server', 'db', 'migration'), target: '/app/db/migration', read_only: true },
      ] };
      const candidateComposeFile = path.join(root, 'compose.candidate.json');
      await atomicReplace(candidateComposeFile, JSON.stringify({ services: overrides }) + '\n');
      await update({ stage: 'candidate-build', commit, version });
      await this.command('docker', [...this.composeArgs(), '--file', candidateComposeFile, 'build', ...request.services], { cwd: this.opsRoot, env: buildEnv });
      const images = {};
      for (const service of request.services) {
        const image = buildEnv[serviceVariables[service]];
        const id = (await this.command('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).output.trim();
        if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw releaseError('CANDIDATE_IMAGE_INVALID', 'The built image identity is invalid.');
        images[service] = { image, id };
      }
      const pinnedEnv = Object.fromEntries(request.services.map((service) => [serviceVariables[service], images[service].id]));
      let runtimeEvidence;
      let testDatabaseSandbox = request.runtimePreparation ? null : await this.uiOnlyDatabaseSkip(request, commit, previous);
      if (!testDatabaseSandbox) {
        testDatabaseSandbox = await this.prepareTestDatabase(contract, jobId, commit, update);
        await update({ stage: 'test-database-migration', testDatabaseSandbox });
        try { runtimeEvidence = await this.migrateTestDatabase(contract, pinnedEnv, candidateComposeFile,
          request.runtimePreparation ? (name, startup) => this.captureCandidateRuntime(request, contract, jobId, images, name, startup) : undefined); }
        catch (error) {
          await this.markTestDatabaseRecoveryRequired(jobId, error).catch(() => undefined);
          throw error;
        }
        await this.markTestDatabaseHealthy(jobId);
      }
      if (await this.preparationBinding() !== binding) throw releaseError('PREPARED_CANDIDATE_STALE', 'Project release configuration changed during candidate validation.');
      const prepared = { schemaVersion: 1, jobId, status: 'prepared', commit, version,
        services: request.services, provenance: request.provenance, binding, images,
        buildEnv: pinnedEnv, testDatabaseSandbox, ...(runtimeEvidence ? { runtimeEvidence } : {}), startedAt, completedAt: new Date().toISOString() };
      await atomicReplace(path.join(root, 'prepared.json'), JSON.stringify(prepared) + '\n');
      await update({ status: 'prepared', stage: 'candidate-prepared', commit, version });
      await this.audit({ type: 'candidate-preparation', ...prepared });
      return { jobId, status: 'prepared', commit, version, images, ...(runtimeEvidence ? { runtimeEvidence } : {}) };
    } catch (error) {
      if (retainedPreparation || request.preparedJobId !== undefined) {
        await this.audit({ type: 'candidate-preparation-reuse', status: 'failed', jobId: retainedPreparation?.jobId ?? request.preparedJobId,
          commit: retainedPreparation?.commit ?? request.provenance.candidateCommit, error: publicError(error), completedAt: new Date().toISOString() }).catch(() => undefined);
      } else {
        await update({ status: 'failed', failedStage: state.stage, stage: 'failed', error: publicError(error), completedAt: new Date().toISOString() }).catch(() => undefined);
        await this.audit({ type: 'candidate-preparation', ...state }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.activeJob = null;
    }
  }

  async readPreparedCandidate(request, commit, released = null) {
    const file = path.join(this.preparedCandidatePath(request.preparedJobId), 'prepared.json');
    const prepared = JSON.parse(await readFile(file, 'utf8'));
    const publishedObservation = released?.status === 'success' && released.stage === 'complete'
      && request.runtimePreparation && !request.runtimePreparation.recheck;
    const servicesMatch = publishedObservation
      ? Array.isArray(request.services) && request.services.length > 0
        && request.services.every(service => prepared.services?.includes(service))
      : JSON.stringify(prepared.services) === JSON.stringify(request.services);
    if (prepared.status !== 'prepared' || prepared.jobId !== request.preparedJobId
      || prepared.commit !== commit || prepared.commit !== request.provenance?.candidateCommit
      || JSON.stringify(prepared.provenance) !== JSON.stringify(request.provenance)
      || !servicesMatch
      || (request.version !== undefined && prepared.version !== request.version)
      || !await this.preparedBindingMatches(prepared, released, request)) {
      throw releaseError('PREPARED_CANDIDATE_STALE', 'The prepared candidate does not match the current release; no application was changed.');
    }
    for (const service of request.services) {
      const image = prepared.images?.[service];
      if (!/^sha256:[a-f0-9]{64}$/u.test(image?.id ?? '')) throw releaseError('CANDIDATE_IMAGE_INVALID', 'Prepared image identity is missing.');
      const id = (await this.command('docker', ['image', 'inspect', '--format', '{{.Id}}', image.id])).output.trim();
      if (id !== image.id) throw releaseError('CANDIDATE_IMAGE_INVALID', 'The exact verified image is unavailable.');
    }
    return prepared;
  }

  async release(validatedRequest) {
    if (this.activeJob !== null) {
      const error = new Error('Another controlled release is already running for this project.');
      error.code = 'RELEASE_IN_PROGRESS';
      throw error;
    }
    const jobId = crypto.randomUUID();
    this.activeJob = jobId;
    const startedAt = new Date().toISOString();
    let backupEnv;
    let contract;
    let testDatabaseSandbox;
    let jobState = {
      schemaVersion: 1,
      jobId,
      status: 'running',
      stage: 'preflight',
      services: validatedRequest.services,
      ...(validatedRequest.provenance === undefined ? {} : { provenance: validatedRequest.provenance }),
      startedAt,
      updatedAt: startedAt,
    };
    const updateJobState = async (values) => {
      jobState = { ...jobState, ...values, updatedAt: new Date().toISOString() };
      await this.recordJobState(jobState);
    };
    try {
      const previous = await this.readJobState();
      await this.recordJobState(jobState);
      const preflight = await this.preflight();
      contract = await this.loadContract();
      if (!preflight.workspaceClean) {
        throw new Error('Workspace is not clean; review and commit the intended release before publishing.');
      }
      if (validatedRequest.provenance
        && preflight.head !== validatedRequest.provenance.candidateCommit) {
        throw releaseError(
          'CANDIDATE_COMMIT_MISMATCH',
          'The promoted workspace commit does not match the TaskSpace release candidate.',
          {
            stage: 'preflight',
            recommendedAction: 'Do not release the changed workspace. Re-submit the TaskSpace candidate through the project Broker so it can revalidate and promote the exact commit.',
            details: {
              candidateCommit: validatedRequest.provenance.candidateCommit,
              workspaceCommit: preflight.head,
            },
          },
        );
      }
      const prepared = validatedRequest.preparedJobId
        ? await this.readPreparedCandidate(validatedRequest, preflight.head) : null;
      const shortCommit = preflight.head.slice(0, 12);
      const generatedVersion = `release-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase()}-${shortCommit}`;
      const version = prepared?.version ?? validatedRequest.version ?? generatedVersion;
      await updateJobState({ stage: 'candidate-build', commit: preflight.head, version });
      const imagePrefix = contract.composeProjectName;
      const imageVariables = new Map([
        ['FORGE_ADMIN_IMAGE', `${imagePrefix}/forge-admin:${version}`],
        ['FORGE_APP_IMAGE', `${imagePrefix}/forge-app:${version}`],
        ['FORGE_FLOW_IMAGE', `${imagePrefix}/forge-flow:${version}`],
        ['FORGE_UI_IMAGE', `${imagePrefix}/forge-ui:${version}`],
      ]);
      const serviceVariables = new Map([
        ['forge-admin', 'FORGE_ADMIN_IMAGE'],
        ['forge-app', 'FORGE_APP_IMAGE'],
        ['forge-flow', 'FORGE_FLOW_IMAGE'],
        ['forge-ui', 'FORGE_UI_IMAGE'],
      ]);
      const buildEnv = {};
      for (const service of validatedRequest.services) {
        const variable = serviceVariables.get(service);
        buildEnv[variable] = imageVariables.get(variable);
      }

      if (prepared) {
        // Reuse the immutable images and successful startup from before promotion.
        for (const [key, value] of Object.entries(prepared.buildEnv)) buildEnv[key] = value;
        for (const service of validatedRequest.services) imageVariables.set(serviceVariables.get(service), prepared.images[service].id);
        testDatabaseSandbox = prepared.testDatabaseSandbox;
        await updateJobState({ stage: 'candidate-reused', preparedJobId: prepared.jobId, testDatabaseSandbox });
      } else {
        await this.command('docker', this.composeArgs('build', ...validatedRequest.services), {
          cwd: this.opsRoot,
          env: buildEnv,
        });
        // The database gate must exercise the exact Admin image that will be
        // promoted. Testing before the build silently validated the previous
        // release image and could approve migrations absent from the candidate.
        testDatabaseSandbox = await this.uiOnlyDatabaseSkip(validatedRequest, preflight.head, previous);
        if (!testDatabaseSandbox) {
          testDatabaseSandbox = await this.prepareTestDatabase(
            contract,
            jobId,
            preflight.head,
            updateJobState,
          );
          await updateJobState({ stage: 'test-database-migration', testDatabaseSandbox });
          try {
            await this.migrateTestDatabase(contract, buildEnv);
          } catch (error) {
            await this.markTestDatabaseRecoveryRequired(jobId, error).catch(() => undefined);
            throw error;
          }
          await this.markTestDatabaseHealthy(jobId);
        }
      }

      await updateJobState({ stage: 'publish-configuration' });
      const envText = await readFile(this.envFile, 'utf8');
      const replacements = new Map([['FORGE_ADMIN_COMMIT', preflight.head]]);
      for (const service of validatedRequest.services) {
        const variable = serviceVariables.get(service);
        replacements.set(variable, imageVariables.get(variable));
      }
      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
      backupEnv = `${this.envFile}.pre-controlled-release-${timestamp}-${shortCommit}`;
      await copyFile(this.envFile, backupEnv);
      await chmod(backupEnv, 0o600);
      await atomicReplace(this.envFile, replaceEnvValues(envText, replacements));

      try {
        await this.compose('config', '--quiet');
        await updateJobState({ stage: 'application-deployment', rollbackEnv: backupEnv });
        await this.compose('up', '--detach', '--no-deps', ...validatedRequest.services);
        await this.refreshRetainedUiUpstreams(validatedRequest.services);
        await updateJobState({ stage: 'application-smoke' });
        const smoke = await this.waitForUi(validatedRequest.services.includes('forge-app'));
        const images = {};
        for (const service of validatedRequest.services) {
          const variable = serviceVariables.get(service);
          const image = imageVariables.get(variable);
          images[service] = {
            image,
            id: (await this.command('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).output.trim(),
          };
        }
        const completedAt = new Date().toISOString();
        const result = {
          jobId,
          projectSlug: contract.projectSlug,
          version,
          commit: preflight.head,
          services: validatedRequest.services,
          testDatabase: contract.infrastructure.mysql.testDatabase,
          testDatabaseSandbox,
          databaseProvisioningPerformed: false,
          infrastructureServicesCreated: [],
          images,
          smoke,
          rollbackEnv: backupEnv,
          startedAt,
          completedAt,
          ...(validatedRequest.provenance === undefined ? {} : { provenance: validatedRequest.provenance }),
        };
        await this.audit({
          type: 'controlled-release',
          status: 'success',
          approvalRef: boundedApproval(validatedRequest.approvalRef),
          ...result,
        });
        await updateJobState({
          status: 'success',
          stage: 'complete',
          completedAt,
          result: {
            commit: result.commit,
            version: result.version,
            services: result.services,
            images: result.images,
            smoke: result.smoke,
            testDatabaseSandbox: result.testDatabaseSandbox,
            ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
          },
        });
        // Migration success alone is candidate evidence. Promote the baseline
        // only after deployment, smoke and the final release records succeed.
        if (validatedRequest.services.includes('forge-admin') && testDatabaseSandbox?.mode !== 'not-required') {
          await this.markTestDatabasePublished(validatedRequest.preparedJobId ?? jobId, preflight.head, jobId);
        }
        return result;
      } catch (error) {
        const failedStage = jobState.stage;
        await updateJobState({ stage: 'application-rollback', failedStage });
        let rollbackSmoke;
        try {
          rollbackSmoke = await this.rollbackApplicationDeployment(validatedRequest.services, backupEnv);
        } catch (rollbackError) {
          await updateJobState({
            stage: 'application-rollback-failed',
            rollback: { verified: false, rollbackEnv: backupEnv },
          }).catch(() => undefined);
          throw releaseError(
            'APPLICATION_ROLLBACK_FAILED',
            'The candidate failed and the previous application version did not pass the rollback health gate.',
            {
              stage: 'application-rollback',
              recommendedAction: 'Pause further releases, inspect the deployment and rollback diagnostics, and restore application health through the reviewed recovery procedure before retrying.',
              details: { failedStage, rollbackEnv: backupEnv, rollbackVerified: false },
              diagnosticText: `${error.output ?? error.message}\nrollback: ${rollbackError.output ?? rollbackError.message}`,
            },
          );
        }
        await updateJobState({
          stage: 'application-rollback-verified',
          rollback: { verified: true, rollbackEnv: backupEnv, smoke: rollbackSmoke },
        });
        const failureCode = failedStage === 'application-smoke'
          ? 'APPLICATION_SMOKE_FAILED'
          : failedStage === 'application-deployment'
            ? 'APPLICATION_DEPLOYMENT_FAILED'
            : 'APPLICATION_CONFIGURATION_FAILED';
        throw releaseError(
          failureCode,
          'The candidate application failed its controlled deployment gate; the previous version was restored and passed health checks.',
          {
            stage: failedStage,
            recommendedAction: 'Correct and commit the candidate application, then retry through the normal controlled release.',
            details: { rollbackEnv: backupEnv, rollbackVerified: true, rollbackSmoke },
            diagnosticText: error.output ?? error.message,
          },
        );
      }
    } catch (error) {
      const completedAt = new Date().toISOString();
      const exposedError = publicError(error);
      await updateJobState({
        status: 'failed',
        completedAt,
        error: exposedError,
        retryable: exposedError.retryable === true,
        recommendedAction: exposedError.recommendedAction,
      }).catch(() => undefined);
      await this.audit({
        type: 'controlled-release',
        status: 'failed',
        jobId,
        projectSlug: contract?.projectSlug,
        approvalRef: boundedApproval(validatedRequest.approvalRef),
        startedAt,
        completedAt,
        error: exposedError,
        rollbackEnv: backupEnv,
        testDatabaseSandbox,
        ...(validatedRequest.provenance === undefined ? {} : { provenance: validatedRequest.provenance }),
      }).catch(() => undefined);
      throw error;
    } finally {
      this.activeJob = null;
    }
  }

  async execute(request) {
    const contract = await this.loadContract();
    const validated = validateReleaseRequest(request, contract);
    if (validated.action === 'contract') {
      let identities;
      try {
        const registered = await this.readRuntimeTestIdentities(contract);
        identities = { status: 'available', items: [...registered.values()].map(({ alias, userId, tenantId }) => ({ alias, userId, tenantId })) };
        registered.clear();
      } catch { identities = { status: 'unavailable', items: [], errorCode: 'CANDIDATE_TEST_IDENTITY_UNAVAILABLE' }; }
      return { ...contract, runtimeProbeCapabilities: { ...getRuntimeProbeCapabilities(), identities } };
    }
    if (validated.action === 'diagnose') return this.diagnose();
    if (validated.action === 'preflight') return this.preflight();
    if (validated.action === 'prepare') return this.prepareCandidate(validated);
    if (validated.action === 'status') {
      const preflight = await this.preflight();
      const status = await this.compose('ps', '--format', 'json');
      return { ...preflight, composeStatus: status.output.slice(0, 256 * 1024) };
    }
    return this.release(validated);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Release request is too large.');
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new Error('Release request body is required.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function createReleaseRunnerServer(options) {
  const runner = options.runner;
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        send(response, 200, { ok: true, active: runner.activeJob !== null });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/actions') {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        send(response, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON is required.' } });
        return;
      }
      const result = await runner.execute(await readJsonBody(request));
      send(response, 200, { ok: true, result });
    } catch (error) {
      send(response, error.code === 'REQUEST_TOO_LARGE' ? 413 : 422, { ok: false, error: publicError(error) });
    }
  });
}

async function main() {
  const projectRoot = process.env.RELEASE_RUNNER_PROJECT_ROOT;
  const contractPath = process.env.RELEASE_RUNNER_CONTRACT ?? '/project-runtime/contract.json';
  const socketPath = process.env.RELEASE_RUNNER_SOCKET ?? '/run/forge-release/runner.sock';
  if (!projectRoot || !path.posix.isAbsolute(projectRoot)) throw new Error('RELEASE_RUNNER_PROJECT_ROOT is required.');
  if (!path.posix.isAbsolute(socketPath)) throw new Error('RELEASE_RUNNER_SOCKET must be an absolute path.');
  await mkdir('/tmp/release-runner-home', { recursive: true, mode: 0o700 });
  await mkdir('/tmp/release-runner-docker', { recursive: true, mode: 0o700 });
  await mkdir(path.posix.dirname(socketPath), { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const runner = new ControlledReleaseRunner({ contractPath, projectRoot });
  await runner.loadContract();
  const server = createReleaseRunnerServer({ runner });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, async () => {
      try {
        await chmod(socketPath, 0o600);
        server.off('error', onError);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  process.stdout.write(`release-runner listening on project capability socket ${socketPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
