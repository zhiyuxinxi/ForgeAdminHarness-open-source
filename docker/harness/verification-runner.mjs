import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  publicVerifyError,
  resolveFrontendLintFiles,
  resolveFrontendTypecheckFiles,
  resolveFrontendTestFilters,
  selectorDigest,
  validateVerificationContract,
  validateVerifyAction,
  verificationCommand,
  verificationIdempotencyDigest,
  verifyError,
} from './verify-policy.mjs';
import {
  MAVEN_VERIFICATION_ARGS,
  MAVEN_VERIFICATION_ENV_ARG,
  MAVEN_VERIFICATION_EXEC_PATH,
} from './maven-verification-policy.mjs';
import { readMavenVerificationPolicy } from './maven-verification-policy.mjs';
import { validateTaskspaceMetadata } from './taskspace-policy.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CACHE_MANIFEST_NAME = 'manifest.json';
const SANDBOX_ID_PATTERN = /^[0-9a-f]{64}$/u;
const SANDBOX_OWNER_LABEL = 'io.forge.verification.owner';
const SANDBOX_PROJECT_LABEL = 'io.forge.verification.project';
const SANDBOX_TASK_LABEL = 'io.forge.verification.task';
const SANDBOX_JOB_LABEL = 'io.forge.verification.job';
const SANDBOX_OWNER = 'forge-verification-runner';
const SAFETY_HOLD_FILE = 'sandbox-safety-hold.json';
const DEFAULT_ADMISSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ADMISSION_REFRESH_MARGIN_MS = 10 * 1000;
const DEFAULT_ADMISSION_MIN_USABLE_MS = 5 * 1000;
const DEFAULT_MAX_ADMISSIONS = 1024;
const DEFAULT_MAX_ADMISSION_CAPABILITIES = 256;
const ACCEPTANCE_CONTRACT_ID_PATTERN = /^[0-9a-f]{64}$/u;
// Only reviewed rejection codes cross the issuer boundary. Schema failures may
// additionally expose a bounded field-label reason, never raw private state.
const ISSUER_REJECTIONS = new Map([
  ['ACCEPTANCE_RUNNER_RECEIPT_INVALID', ['验收端拒绝了执行回执的格式、执行事实或绑定。', '保留原job和receipt，核对拒绝原因；修复后复核已有结果，不要为签发失败重跑检查。']],
  ['ACCEPTANCE_CANDIDATE_BINDING_MISMATCH', ['当前候选与受保护执行授权不匹配。', '核对同一任务的当前授权与源码绑定，沿已有续接路径取得当前admission后再复核；不要重复确认或重跑检查。']],
  ['ACCEPTANCE_CANDIDATE_CONTRACT_EXPIRED', ['当前候选验收合同已过期。', '沿同一任务的已有授权续接路径更新当前合同和admission，再复核原回执。']],
  ['ACCEPTANCE_CANDIDATE_ADMISSION_STALE', ['验证准入早于当前候选绑定。', '取得当前候选的admission，再正式复核原回执。']],
  ['ACCEPTANCE_CANDIDATE_ADMISSION_INVALID', ['当前验证准入未通过受保护校验。', '核对当前任务的真实admission；不能自行修改准入或重跑检查代替修复。']],
  ['ACCEPTANCE_CANDIDATE_BINDING_FORBIDDEN', ['当前执行权限不允许绑定候选。', '保留原任务并核对实际用户权限；重试不能扩大授权。']],
  ['ACCEPTANCE_CONTRACT_MISMATCH', ['执行证据与当前验收合同不匹配。', '核对原任务、当前合同和回执绑定，只沿受保护复核路径复用匹配的证据。']],
  ['ACCEPTANCE_SOURCE_MISMATCH', ['执行回执与当前源码不匹配。', '核对当前源码与原回执，只能复核仍满足源码绑定条件的证据。']],
  ['ACCEPTANCE_RECORD_NOT_FOUND', ['当前任务缺少受保护验收记录。', '核对同一任务的准备状态；保留已有结果，不自行创建验收记录。']],
  ['ACCEPTANCE_SCHEMA_INVALID', ['受保护验收请求格式无效。', '保留原任务和结果，修复平台请求格式后再继续；不要重跑业务检查。']],
  ['ACCEPTANCE_STATE_INVALID', ['受保护验收状态未通过完整性校验。', '保留已有证据，由平台修复具体状态问题；不要修改授权或重复执行检查。']],
]);
const CACHE_COMPATIBILITY_SCHEMA_VERSION = 'forge-verification-cache-compatibility/v2';
const CACHE_MANIFEST_SCHEMA_VERSION = 3;
const IMMUTABLE_TOOLCHAIN_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/u;
const CACHE_WARM_COMMANDS = Object.freeze([
  Object.freeze(['env', MAVEN_VERIFICATION_ENV_ARG, MAVEN_VERIFICATION_EXEC_PATH, 'mvn', ...MAVEN_VERIFICATION_ARGS, '--no-transfer-progress', '-f', '/workspace/forge-server/pom.xml', '-Dmaven.repo.local=/warm/m2/repository', '-Penable-tests', '-DskipTests', 'dependency:go-offline']),
  Object.freeze(['pnpm', '--dir', '/workspace/forge-admin-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-admin-virtual-store', '--modules-dir', '/warm/scratch/forge-admin-node_modules']),
  Object.freeze(['pnpm', '--dir', '/workspace/forge-h5-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-h5-virtual-store', '--modules-dir', '/warm/scratch/forge-h5-node_modules']),
]);
const CACHE_PRODUCER_TOPOLOGY = Object.freeze({
  schemaVersion: 'forge-verification-cache-producer-topology/v8',
  executorUser: '1000:1000',
  rootFilesystem: 'read-only',
  networkPolicy: 'enabled-only-for-fixed-warm-commands',
  pnpmLifecyclePolicy: Object.freeze({ argv: '--ignore-scripts', logGate: 'no-lifecycle-execution-lines' }),
  sourceMount: Object.freeze({ destination: '/workspace', access: 'read-only' }),
  warmWorkspaceMount: Object.freeze({
    destination: '/warm',
    access: 'read-write',
    publishAllowlist: Object.freeze(['m2/repository/', 'pnpm/store/']),
    disposablePaths: Object.freeze(['scratch/']),
    resumableBinding: 'compatibility-digest+dependency-fingerprint+acquisition-policy+source-head+base-images',
    scratchRemovedBeforePublish: true,
    scratchLifecycle: 'fresh-per-warm-attempt',
  }),
  pnpmStoreSanitization: Object.freeze({
    removedPaths: Object.freeze(['pnpm/store/v11/projects/']),
    afterRemovalNodePolicy: 'ordinary-files-and-directories-only',
  }),
  stageMaterialization: Object.freeze({
    include: Object.freeze(['m2/', 'pnpm/']),
    symlinkDereference: false,
    hardLinkPreservation: false,
    warmRetainedUntilFinalVerify: true,
  }),
  ephemeralTmpfs: Object.freeze([
    Object.freeze({ destination: '/tmp', options: 'rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700' }),
  ]),
  ephemeralEnvironment: Object.freeze({
    XDG_CACHE_HOME: '/warm/scratch/xdg-cache',
    MAVEN_OPTS: '-Djansi.tmpdir=/tmp/forge-maven-jansi',
  }),
  mavenEphemeralState: Object.freeze({
    path: '/tmp/forge-maven-jansi',
    mode: '0700',
    lifecycle: 'fresh-per-command-and-container-ephemeral',
    sourceAndHomeWrites: 'forbidden',
  }),
  hardening: Object.freeze({ capDrop: 'ALL', noNewPrivileges: true }),
});
const CACHE_COMPATIBILITY_IMPLEMENTATION_FILES = Object.freeze([
  'verification-cache-tool.mjs',
  'verification-runner.mjs',
  'verify-policy.mjs',
  'maven-verification-policy.mjs',
  'maven-verification-settings.xml',
  'maven-verification-exec.sh',
]);
function compareCanonicalCachePath(left, right) {
  return left.localeCompare(right, 'en');
}

export async function defaultProtectedAcceptanceIssuerClient(socketPath, route, body, options = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const attempts = options.attempts ?? 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const request = http.request({
          socketPath,
          path: route,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) request.destroy(new Error('acceptance issuer response too large'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (response.statusCode !== 200 || value?.ok !== true || !value.result) {
                const issuerCode = value?.error?.code;
                const rejection = ISSUER_REJECTIONS.get(issuerCode);
                const schemaMessage = issuerCode === 'ACCEPTANCE_SCHEMA_INVALID'
                  && typeof value?.error?.message === 'string'
                  ? value.error.message.replace(/[ \t\r\n]+/gu, ' ').trim() : '';
                // These are the service's label-only schema error templates.
                // Exclude values, paths, JSON, and extra diagnostic sentences.
                const schemaReason = /^[A-Za-z][A-Za-z0-9_. -]{0,159} (?:is invalid|has unsupported or missing fields)\.$/u.test(schemaMessage)
                  ? schemaMessage : undefined;
                const error = verifyError(
                  issuerCode === 'ACCEPTANCE_SOURCE_MISMATCH'
                    ? 'VERIFY_ACCEPTANCE_SOURCE_MISMATCH'
                    : rejection ? issuerCode : 'VERIFY_ACCEPTANCE_ISSUER_REJECTED',
                  schemaReason ? `${rejection[0]} 受保护验收字段原因：${schemaReason}`
                    : rejection?.[0] ?? 'Protected acceptance issuer rejected the controlled receipt.',
                  { retryable: false,
                    recommendedAction: rejection?.[1] ?? '保留原job和receipt，由平台核对具体签发拒绝；不要重跑检查或扩大授权。' },
                );
                reject(error);
                return;
              }
              resolve(value.result);
            } catch {
              const error = verifyError('VERIFY_ACCEPTANCE_ISSUER_INVALID', 'Protected acceptance issuer returned an invalid response.', {
                retryable: false, recommendedAction: '保留原job和receipt，由平台核对签发服务响应；不要重新执行检查。',
              });
              reject(error);
            }
          });
        });
        const abort = () => request.destroy(verifyError('VERIFY_REQUEST_CANCELLED', 'Verification request was cancelled.', { retryable: true }));
        options.signal?.addEventListener('abort', abort, { once: true });
        request.setTimeout(5_000, () => request.destroy(new Error('acceptance issuer timeout')));
        request.on('error', (error) => {
          options.signal?.removeEventListener('abort', abort);
          if (error?.code?.startsWith?.('VERIFY_')) reject(error);
          else {
            const unavailable = verifyError('VERIFY_ACCEPTANCE_ISSUER_UNAVAILABLE', 'Protected acceptance issuer is unavailable.', {
              retryable: true,
              recommendedAction: '服务恢复后核对同一job和receipt，沿现有幂等或正式复核路径续接；不要重新执行业务检查。',
            });
            unavailable.retryIssuer = true;
            reject(unavailable);
          }
        });
        request.on('close', () => options.signal?.removeEventListener('abort', abort));
        request.end(payload);
      });
    } catch (error) {
      lastError = error;
      if (error.retryIssuer !== true || attempt === attempts) break;
    }
  }
  throw lastError;
}

function cancellationError() {
  return verifyError('VERIFY_REQUEST_CANCELLED', 'Verification request was cancelled by its controlling client.', {
    retryable: true,
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw cancellationError();
}

function dockerTransportUncertain(result) {
  return result?.timedOut === true
    || (result?.signal !== null && result?.signal !== undefined)
    || result?.exitCode === null
    || /cannot connect|connection (?:refused|reset)|docker daemon|context deadline|unexpected eof/iu.test(result?.stderr ?? '');
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(cancellationError());
      return;
    }
    const childEnvironment = { ...process.env, ...(options.env ?? {}) };
    if (options.cleanGitEnvironment === true) {
      for (const name of [
        'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
      ]) delete childEnvironment[name];
      childEnvironment.GIT_OPTIONAL_LOCKS = '0';
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let truncated = false;
    const maximum = options.maxOutputBytes ?? 8 * 1024 * 1024;
    let timedOut = false;
    let cancelled = false;
    let killTimer;
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, options.timeoutMs);
    const abort = () => {
      cancelled = true;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes <= maximum) target.push(chunk);
      else truncated = true;
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        cancelled,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        bytes,
        truncated,
      });
    });
  });
}

async function atomicJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  await chmod(temporary, mode);
  await rename(temporary, filePath);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value)) {
    throw verifyError('VERIFY_SOURCE_INVALID', `${label} is not a safe repository-relative path.`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw verifyError('VERIFY_SOURCE_INVALID', `${label} escapes the TaskSpace workspace.`);
  }
  return normalized;
}

async function hashFileStable(filePath) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw verifyError('VERIFY_SOURCE_INVALID', 'Verification source contains a non-regular or linked file.');
  }
  const first = await readFile(filePath);
  const after = await lstat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || first.length !== after.size) {
    throw verifyError('VERIFY_SOURCE_CHANGED', 'Verification source changed during stable read.', { retryable: true });
  }
  return {
    bytes: first.length,
    sha256: crypto.createHash('sha256').update(first).digest('hex'),
    content: first,
  };
}

function dependencyPath(relative) {
  return relative === 'pnpm-lock.yaml'
    || relative.endsWith('/pnpm-lock.yaml')
    || relative === 'pnpm-workspace.yaml'
    || relative === '.npmrc'
    || relative.endsWith('/package.json')
    || relative === 'package.json'
    || relative.endsWith('/pom.xml')
    || relative === 'pom.xml'
    || relative.startsWith('.mvn/')
    || relative.includes('/.mvn/');
}

function compareRelativePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDependencyManifestFiles(files, errorCode = 'VERIFY_CACHE_INVALID') {
  if (!Array.isArray(files)) {
    throw verifyError(errorCode, 'Verification dependency manifest inventory is missing.');
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of files) {
    const relative = safeRelative(entry?.path, 'dependency manifest path');
    if (path.posix.normalize(relative) !== relative || seen.has(relative) || !SHA256_PATTERN.test(entry?.sha256)) {
      throw verifyError(errorCode, 'Verification dependency manifest inventory is invalid.');
    }
    seen.add(relative);
    normalized.push({ path: relative, sha256: entry.sha256 });
  }
  const sorted = [...normalized].sort((left, right) => compareRelativePath(left.path, right.path));
  if (normalized.some((entry, index) => entry.path !== sorted[index].path)) {
    throw verifyError(errorCode, 'Verification dependency manifest inventory is not deterministically sorted.');
  }
  return normalized;
}

function dependencyManifestDigest(files) {
  const digest = crypto.createHash('sha256');
  for (const entry of files) digest.update(entry.path).update('\0').update(entry.sha256).update('\0');
  return digest.digest('hex');
}

async function gitList(workspace, args, command = runProcess, options = {}) {
  throwIfAborted(options.signal);
  const result = await command('git', [
    '-C', workspace,
    '-c', `safe.directory=${workspace}`,
    ...args,
  ], {
    cleanGitEnvironment: true,
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  if (result.exitCode !== 0) {
    throw verifyError('VERIFY_SOURCE_GIT_FAILED', 'TaskSpace Git inventory could not be read.');
  }
  return result.stdout;
}

export async function inventoryWorkspace(workspace, limits, command = runProcess, options = {}) {
  const root = path.resolve(workspace);
  const head = (await gitList(root, ['rev-parse', 'HEAD'], command, options)).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw verifyError('VERIFY_SOURCE_INVALID', 'TaskSpace HEAD is invalid.');
  const output = await gitList(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], command, options);
  const entries = [...new Set(output.split('\0').filter(Boolean)
    .map((entry) => safeRelative(entry, 'source path')))]
    .sort(compareRelativePath);
  if (entries.length > limits.maxFiles) {
    throw verifyError('VERIFY_SOURCE_LIMIT', 'TaskSpace source file count exceeds the verification limit.');
  }
  const fingerprint = crypto.createHash('sha256');
  const dependencyManifestFiles = [];
  const files = [];
  let totalBytes = 0;
  for (const relative of entries) {
    throwIfAborted(options.signal);
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute)) throw verifyError('VERIFY_SOURCE_INVALID', 'TaskSpace source path escaped its workspace.');
    try {
      const item = await hashFileStable(absolute);
      totalBytes += item.bytes;
      if (totalBytes > limits.maxBytes) throw verifyError('VERIFY_SOURCE_LIMIT', 'TaskSpace source bytes exceed the verification limit.');
      fingerprint.update(relative).update('\0').update(item.sha256).update('\0').update(String(item.bytes)).update('\0');
      if (dependencyPath(relative)) dependencyManifestFiles.push({ path: relative, sha256: item.sha256 });
      files.push({ relative, absolute, bytes: item.bytes, sha256: item.sha256 });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Keep the deletion for snapshot materialization, but hash only files
        // present in the candidate so staging/committing a deletion is neutral.
        files.push({ relative, absolute, deleted: true, bytes: 0 });
      } else {
        throw error;
      }
    }
  }
  return {
    head,
    fileCount: files.length,
    bytes: totalBytes,
    files,
    workspaceFingerprint: fingerprint.digest('hex'),
    dependencyManifestFingerprint: dependencyManifestDigest(dependencyManifestFiles),
    dependencyManifestFiles,
  };
}

async function snapshotInventory(inventory, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const item of inventory.files) {
    if (item.deleted) continue;
    const target = path.resolve(destination, item.relative);
    if (!inside(destination, target)) throw verifyError('VERIFY_SOURCE_INVALID', 'Snapshot target escaped its job root.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(item.absolute, target);
    const copied = await hashFileStable(target);
    if (copied.sha256 !== item.sha256 || copied.bytes !== item.bytes) {
      throw verifyError('VERIFY_SOURCE_CHANGED', 'TaskSpace source changed while creating the verification snapshot.', { retryable: true });
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireReadOnlyDirectory(directory, label) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
    throw verifyError('VERIFY_CACHE_INVALID', `${label} must be one read-only ordinary directory.`);
  }
}

async function requireReadOnlyFile(file, label) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o222) !== 0) {
    throw verifyError('VERIFY_CACHE_INVALID', `${label} must be one read-only ordinary unlinked file.`);
  }
  return hashFileStable(file);
}

async function currentCacheCompatibilityImplementation() {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const implementation = [];
  for (const name of CACHE_COMPATIBILITY_IMPLEMENTATION_FILES) {
    const item = await hashFileStable(path.join(moduleRoot, name));
    implementation.push({ path: name, sha256: item.sha256, bytes: item.bytes });
  }
  return implementation;
}

async function validateCacheCompatibility(manifest, dependencyFingerprint, mavenAcquisitionPolicy) {
  const descriptor = manifest.cacheCompatibility;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || !SHA256_PATTERN.test(manifest.cacheCompatibilityDigest ?? '')
    || descriptor.schemaVersion !== CACHE_COMPATIBILITY_SCHEMA_VERSION
    || descriptor.cacheManifestSchemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION
    || descriptor.dependencyManifestFingerprint !== dependencyFingerprint
    || !sameJson(descriptor.mavenAcquisitionPolicy, mavenAcquisitionPolicy.descriptor)
    || descriptor.mavenAcquisitionPolicyDigest !== mavenAcquisitionPolicy.digest
    || !sameJson(descriptor.warmCommands, CACHE_WARM_COMMANDS)
    || !sameJson(descriptor.producerTopology, CACHE_PRODUCER_TOPOLOGY)) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache compatibility contract is invalid.');
  }
  const images = descriptor.executorToolchainImages;
  const versions = descriptor.packageManagerVersions;
  if (!images || typeof images !== 'object' || Array.isArray(images)
    || Object.keys(images).length !== 2
    || !IMMUTABLE_TOOLCHAIN_IMAGE_PATTERN.test(images.node ?? '')
    || !IMMUTABLE_TOOLCHAIN_IMAGE_PATTERN.test(images.maven ?? '')
    || !versions || typeof versions !== 'object' || Array.isArray(versions)
    || !sameJson(Object.keys(versions), ['node', 'corepack', 'pnpm', 'maven', 'java'])
    || Object.values(versions).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache compatibility toolchain identity is invalid.');
  }
  const expected = {
    schemaVersion: CACHE_COMPATIBILITY_SCHEMA_VERSION,
    cacheManifestSchemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    dependencyManifestFingerprint: dependencyFingerprint,
    implementation: await currentCacheCompatibilityImplementation(),
    executorToolchainImages: images,
    mavenAcquisitionPolicy: mavenAcquisitionPolicy.descriptor,
    mavenAcquisitionPolicyDigest: mavenAcquisitionPolicy.digest,
    warmCommands: CACHE_WARM_COMMANDS,
    producerTopology: CACHE_PRODUCER_TOPOLOGY,
    packageManagerVersions: versions,
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(descriptor), 'utf8').digest('hex');
  if (!sameJson(descriptor, expected) || manifest.cacheCompatibilityDigest !== digest) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache compatibility digest or implementation closure is invalid.');
  }
}

async function listTree(root, relative = '') {
  const current = path.join(root, relative);
  await requireReadOnlyDirectory(current, 'Verification cache pack directory');
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (child === CACHE_MANIFEST_NAME) continue;
    const metadata = await lstat(path.join(root, child));
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache pack contains a symbolic link.');
    if (entry.isDirectory() && metadata.isDirectory()) result.push(...await listTree(root, child));
    else if (entry.isFile() && metadata.isFile()) {
      if (metadata.nlink !== 1 || (metadata.mode & 0o222) !== 0) {
        throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache pack contains a writable, linked, or non-ordinary file.');
      }
      result.push(child);
    }
    else throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache pack contains an unsupported node.');
  }
  return result;
}

export async function verifyCachePack(cacheRoot, dependencyFingerprint, contract, dependencyManifestFiles) {
  if (!SHA256_PATTERN.test(dependencyFingerprint)) throw new Error('dependency fingerprint is invalid.');
  if (!contract || typeof contract !== 'object'
    || typeof contract.projectSlug !== 'string' || contract.projectSlug.length === 0
    || typeof contract.toolchainImage !== 'string' || contract.toolchainImage.length === 0
    || typeof contract.runnerRevision !== 'string' || contract.runnerRevision.length === 0) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache identity contract is missing.');
  }
  const currentDependencyFiles = normalizeDependencyManifestFiles(dependencyManifestFiles);
  if (dependencyManifestDigest(currentDependencyFiles) !== dependencyFingerprint) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Current dependency manifest inventory does not match its fingerprint.');
  }
  const packRoot = path.resolve(cacheRoot, dependencyFingerprint);
  if (!inside(path.resolve(cacheRoot), packRoot)) throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache path escaped its root.');
  let manifest;
  try {
    await requireReadOnlyDirectory(packRoot, 'Verification cache pack root');
    const manifestFile = await requireReadOnlyFile(path.join(packRoot, CACHE_MANIFEST_NAME), 'Verification cache manifest');
    manifest = JSON.parse(manifestFile.content.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await lstat(packRoot);
      } catch (rootError) {
        if (rootError.code === 'ENOENT') return { outcome: 'cache_miss', dependencyFingerprint, packRoot };
      }
    }
    if (error.code === 'VERIFY_CACHE_INVALID') throw error;
    throw verifyError('VERIFY_CACHE_INVALID', `Verification cache manifest is invalid: ${error.message}`);
  }
  const mavenAcquisitionPolicy = await readMavenVerificationPolicy();
  if (!manifest || manifest.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION || manifest.complete !== true
    || manifest.dependencyManifestFingerprint !== dependencyFingerprint
    || manifest.projectSlug !== contract.projectSlug
    || manifest.toolchainImage !== contract.toolchainImage
    || manifest.runnerRevision !== contract.runnerRevision
    || JSON.stringify(manifest.acquisition) !== JSON.stringify({ maven: mavenAcquisitionPolicy.descriptor })
    || !Array.isArray(manifest.dependencyManifestFiles)
    || !Array.isArray(manifest.files)) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache manifest contract is invalid.');
  }
  await validateCacheCompatibility(manifest, dependencyFingerprint, mavenAcquisitionPolicy);
  const declaredDependencyFiles = normalizeDependencyManifestFiles(manifest.dependencyManifestFiles);
  if (dependencyManifestDigest(declaredDependencyFiles) !== dependencyFingerprint
    || declaredDependencyFiles.length !== currentDependencyFiles.length
    || declaredDependencyFiles.some((entry, index) => entry.path !== currentDependencyFiles[index].path
      || entry.sha256 !== currentDependencyFiles[index].sha256)) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache dependency manifest inventory differs from the current source.');
  }
  const expected = new Map();
  for (const entry of manifest.files) {
    const relative = safeRelative(entry?.path, 'cache manifest path');
    if (expected.has(relative) || !SHA256_PATTERN.test(entry?.sha256) || !Number.isInteger(entry?.bytes) || entry.bytes < 0) {
      throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache manifest inventory is invalid.');
    }
    expected.set(relative, entry);
  }
  const actual = (await listTree(packRoot)).sort(compareCanonicalCachePath);
  if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache tree differs from its manifest.');
  }
  if (manifest.files.some((entry, index) => entry.path !== actual[index])) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache manifest inventory is not in canonical path order.');
  }
  const packHash = crypto.createHash('sha256');
  for (const relative of actual) {
    const item = await hashFileStable(path.join(packRoot, relative));
    const declared = expected.get(relative);
    if (item.sha256 !== declared.sha256 || item.bytes !== declared.bytes) {
      throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache content differs from its manifest.');
    }
    packHash.update(relative).update('\0').update(item.sha256).update('\0').update(String(item.bytes)).update('\0');
  }
  const packDigest = packHash.digest('hex');
  if (manifest.packDigest !== packDigest) throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache pack digest is invalid.');
  return { outcome: 'ready', dependencyFingerprint, packRoot, packDigest, fileCount: actual.length };
}

async function copyCachePack(cache, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const relative of await listTree(cache.packRoot)) {
    const source = path.join(cache.packRoot, relative);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
  }
}

function cacheMetadataRecord(relative, metadata) {
  return {
    path: relative,
    type: metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'unsupported',
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid ?? null,
    gid: metadata.gid ?? null,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

async function appendCacheMetadataIdentity(packRoot, relative, digest, counter) {
  const absolute = path.join(packRoot, relative);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache pack metadata contains an unsupported node.');
  }
  if ((metadata.mode & 0o222) !== 0 || (metadata.isFile() && metadata.nlink !== 1)) {
    throw verifyError('VERIFY_CACHE_INVALID', 'Verification cache pack metadata is writable or linked.');
  }
  digest.update(JSON.stringify(cacheMetadataRecord(relative || '.', metadata))).update('\0');
  counter.value += 1;
  if (metadata.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      await appendCacheMetadataIdentity(packRoot, child, digest, counter);
    }
  }
}

async function cacheMetadataIdentity(packRoot) {
  const digest = crypto.createHash('sha256');
  const counter = { value: 0 };
  await appendCacheMetadataIdentity(packRoot, '', digest, counter);
  return { digest: digest.digest('hex'), nodeCount: counter.value };
}

export function nodeTestReportResults(content) {
  if (!/^<\?xml\b/u.test(content.trimStart()) || !/<testsuites>/u.test(content) || !/<\/testsuites>\s*$/u.test(content)) {
    throw verifyError('VERIFY_TEST_REPORT_INVALID', 'H5 Node test report is invalid.');
  }
  // Node emits a testcase for an empty suite. Its own report summary, not the
  // XML element count or nested suite aggregates, records actual test totals.
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...content.matchAll(new RegExp(`^\\s*<!-- ${key} (\\d+) -->\\s*$`, 'gmu'))];
    if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]))) {
      throw verifyError('VERIFY_TEST_REPORT_INVALID', 'H5 Node test summary is missing or ambiguous.');
    }
    counts[key] = Number(matches[0][1]);
  }
  const result = { executed: counts.tests, passed: counts.pass,
    failed: counts.fail + counts.cancelled, skipped: counts.skipped + counts.todo };
  if (result.executed !== result.passed + result.failed + result.skipped) {
    throw verifyError('VERIFY_TEST_REPORT_INVALID', 'H5 Node test summary totals do not match.');
  }
  return result;
}

function isVerificationTestReport(relative) {
  return /(?:^|\/)surefire-reports\/TEST-[^/]+\.xml$/u.test(relative)
    || /(?:^|\/)test-results[^/]*\.json$/u.test(relative)
    || /(?:^|\/)test-results-h5\.xml$/u.test(relative);
}

async function purgeSnapshotTestResults(snapshotRoot, relative = '') {
  const absolute = path.join(snapshotRoot, relative);
  for (const entry of await readdir(absolute, { withFileTypes: true }).catch(() => [])) {
    const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) await purgeSnapshotTestResults(snapshotRoot, child);
    else if (entry.isFile() && isVerificationTestReport(child)) {
      await rm(path.join(snapshotRoot, child), { force: true });
    }
  }
}

async function collectTestResults(snapshotRoot) {
  const result = { selected: null, executed: 0, passed: 0, failed: 0, skipped: 0, reportFiles: 0 };
  async function walk(relative = '') {
    const absolute = path.join(snapshotRoot, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true }).catch(() => [])) {
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && isVerificationTestReport(child)) {
        const content = await readFile(path.join(snapshotRoot, child), 'utf8');
        if (child.endsWith('/test-results-h5.xml') || child === 'test-results-h5.xml') {
          const counts = nodeTestReportResults(content);
          for (const key of ['executed', 'passed', 'failed', 'skipped']) result[key] += counts[key];
        } else if (child.endsWith('.json')) {
          const report = JSON.parse(content);
          const executed = Number.isInteger(report.numTotalTests) ? report.numTotalTests : 0;
          const passed = Number.isInteger(report.numPassedTests) ? report.numPassedTests : 0;
          const failed = Number.isInteger(report.numFailedTests) ? report.numFailedTests : 0;
          const skipped = Number.isInteger(report.numPendingTests) ? report.numPendingTests : 0;
          if ([executed, passed, failed, skipped].some((value) => value < 0)
            || passed + failed + skipped > executed) {
            throw verifyError('VERIFY_TEST_REPORT_INVALID', 'Frontend test result counts are invalid.');
          }
          result.executed += executed;
          result.passed += passed;
          result.failed += failed;
          result.skipped += skipped;
        } else {
          const suites = [...content.matchAll(/<testsuite\b[^>]*\btests="(\d+)"[^>]*>/gu)];
          for (const match of suites) {
            const tag = match[0];
            const tests = Number.parseInt(match[1], 10);
            const failures = Number.parseInt(/\bfailures="(\d+)"/u.exec(tag)?.[1] ?? '0', 10);
            const errors = Number.parseInt(/\berrors="(\d+)"/u.exec(tag)?.[1] ?? '0', 10);
            const skipped = Number.parseInt(/\bskipped="(\d+)"/u.exec(tag)?.[1] ?? '0', 10);
            result.executed += tests;
            result.failed += failures + errors;
            result.skipped += skipped;
            result.passed += Math.max(0, tests - failures - errors - skipped);
          }
        }
        result.reportFiles += 1;
      }
    }
  }
  await walk();
  return result;
}

export function isTestProfile(profile) {
  return [
    'backend-red-test', 'frontend-red-test',
    'backend-module-test', 'backend-test-class', 'frontend-admin-test', 'frontend-h5-test', 'full-regression',
  ].includes(profile);
}

export class VerificationRunner {
  constructor(options) {
    this.projectSlug = options.projectSlug;
    this.taskspacesRoot = path.resolve(options.taskspacesRoot);
    this.contract = validateVerificationContract(options.contract, this.projectSlug);
    this.stateRoot = path.resolve(options.stateRoot ?? this.contract.stateRoot);
    this.cacheRoot = path.resolve(options.cacheRoot ?? this.contract.cacheRoot);
    this.command = options.command ?? runProcess;
    this.activeByTask = new Map();
    this.admissions = new Map();
    this.admissionCapabilities = new Map();
    this.admissionFlights = new Map();
    this.cacheAdmissionFlights = new Map();
    this.verifiedCachePacks = new Map();
    this.executionCacheFlights = new Map();
    this.executionCacheHolds = new Map();
    this.admissionStateSequence = 0;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.runnerBootId = options.runnerBootId ?? crypto.randomUUID();
    this.admissionTtlMs = options.admissionTtlMs ?? DEFAULT_ADMISSION_TTL_MS;
    this.admissionRefreshMarginMs = options.admissionRefreshMarginMs ?? DEFAULT_ADMISSION_REFRESH_MARGIN_MS;
    this.admissionMinUsableMs = options.admissionMinUsableMs ?? DEFAULT_ADMISSION_MIN_USABLE_MS;
    this.maxAdmissions = options.maxAdmissions ?? DEFAULT_MAX_ADMISSIONS;
    this.maxAdmissionCapabilities = options.maxAdmissionCapabilities ?? DEFAULT_MAX_ADMISSION_CAPABILITIES;
    this.acceptanceIssuerClient = options.acceptanceIssuerClient ?? null;
    this.now = options.now ?? (() => Date.now());
    this.verifyCachePack = options.verifyCachePack ?? verifyCachePack;
    this.copyCachePack = options.copyCachePack ?? copyCachePack;
    this.scanCacheMetadata = options.scanCacheMetadata ?? cacheMetadataIdentity;
    if (!Number.isSafeInteger(this.admissionTtlMs)
      || this.admissionTtlMs < 30_000 || this.admissionTtlMs > 15 * 60 * 1000) {
      throw new Error('verification admission TTL must be from 30 seconds to 15 minutes.');
    }
    if (!Number.isSafeInteger(this.admissionRefreshMarginMs) || this.admissionRefreshMarginMs < 1_000
      || this.admissionRefreshMarginMs >= this.admissionTtlMs) {
      throw new Error('verification admission refresh margin must be at least one second and shorter than the TTL.');
    }
    if (!Number.isSafeInteger(this.admissionMinUsableMs) || this.admissionMinUsableMs < 1_000
      || this.admissionMinUsableMs > this.admissionRefreshMarginMs) {
      throw new Error('verification admission minimum usable duration must be at least one second and no longer than the refresh margin.');
    }
    if (!Number.isSafeInteger(this.maxAdmissions) || this.maxAdmissions < 1
      || !Number.isSafeInteger(this.maxAdmissionCapabilities) || this.maxAdmissionCapabilities < 1) {
      throw new Error('verification admission state limits must be positive safe integers.');
    }
    this.safetyHold = null;
  }

  async submitProtectedAcceptance(taskId, contractId, receipt, options = {}) {
    if (this.acceptanceIssuerClient === null) return null;
    if (typeof contractId !== 'string' || !ACCEPTANCE_CONTRACT_ID_PATTERN.test(contractId)) {
      throw verifyError('VERIFY_ACCEPTANCE_CONTRACT_REQUIRED', 'Protected verification requires the current acceptance contract binding.');
    }
    const route = receipt.request?.profile === 'governance' ? '/v1/governance' : '/v1/verification';
    return this.acceptanceIssuerClient(route, { taskId, contractId, runnerReceipt: receipt }, options);
  }

  pruneAdmissionState(now = this.now()) {
    for (const [admissionId, admission] of this.admissions) {
      if (admission.expiresAtMs <= now) this.admissions.delete(admissionId);
    }
    for (const [taskId, capability] of this.admissionCapabilities) {
      if (capability.expiresAtMs <= now) this.admissionCapabilities.delete(taskId);
    }
    const pruneOldest = (entries, maximum, remove) => {
      if (entries.length <= maximum) return;
      entries.sort((left, right) => left[1].expiresAtMs - right[1].expiresAtMs
        || left[1].issuedAtMs - right[1].issuedAtMs
        || (left[1].stateSequence ?? 0) - (right[1].stateSequence ?? 0)
        || String(left[0]).localeCompare(String(right[0])));
      for (const [key] of entries.slice(0, entries.length - maximum)) remove(key);
    };
    pruneOldest([...this.admissions], this.maxAdmissions, (key) => this.admissions.delete(key));
    pruneOldest([...this.admissionCapabilities], this.maxAdmissionCapabilities,
      (key) => this.admissionCapabilities.delete(key));
  }

  taskWorkspace(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) throw verifyError('VERIFY_TASK_INVALID', 'TaskSpace id is invalid.');
    const workspace = path.resolve(this.taskspacesRoot, taskId, 'workspace');
    if (!inside(this.taskspacesRoot, workspace)) throw verifyError('VERIFY_TASK_INVALID', 'TaskSpace path escaped its root.');
    return workspace;
  }

  async source(taskId, options = {}) {
    throwIfAborted(options.signal);
    const workspace = this.taskWorkspace(taskId);
    await access(path.join(workspace, '.git'));
    throwIfAborted(options.signal);
    const source = {
      workspace,
      inventory: await inventoryWorkspace(workspace, this.contract.limits, this.command, options),
    };
    if (options.changedFrontendScope !== true) return source;
    const metadataPath = path.join(this.taskspacesRoot, taskId, 'metadata.json');
    try {
      const before = await lstat(metadataPath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
          || before.size < 2 || before.size > 64 * 1024) throw new Error('Invalid metadata file.');
      const bytes = await readFile(metadataPath);
      const after = await lstat(metadataPath);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw verifyError('VERIFY_SOURCE_CHANGED', 'TaskSpace lint base changed during source observation.', { retryable: true });
      }
      const metadata = validateTaskspaceMetadata(JSON.parse(bytes.toString('utf8')), this.projectSlug);
      if (metadata.taskId !== taskId) throw new Error('Metadata belongs to another TaskSpace.');
      source.reviewBase = metadata.baseCommit;
    } catch (error) {
      if (error?.code?.startsWith?.('VERIFY_')) throw error;
      throw verifyError('VERIFY_SOURCE_INVALID', 'The protected TaskSpace base for changed-file lint is unavailable.');
    }
    source.readGit = (argv, readOptions = {}) => this.command('git', [
      '-C', workspace, '-c', `safe.directory=${workspace}`, ...argv,
    ], { ...readOptions, cleanGitEnvironment: true, signal: options.signal });
    return source;
  }

  async capability(taskId, profile, options = {}) {
    const validated = validateVerifyAction({ action: 'capability', profile });
    const source = await this.source(taskId, options);
    let cache;
    try {
      cache = await this.admitCachePack(taskId, source.inventory);
    } catch (error) {
      return this.capabilityReceipt(validated.profile, source.inventory, {
        outcome: 'cache_invalid', reasonCode: error.code ?? 'VERIFY_CACHE_INVALID',
      });
    }
    if (cache.outcome !== 'ready') {
      return this.capabilityReceipt(validated.profile, source.inventory, {
        outcome: 'cache_miss', reasonCode: 'VERIFY_CACHE_MISS',
      });
    }
    try {
      await this.assertSandboxAvailable();
      throwIfAborted(options.signal);
      const executor = await this.probeExecutorCapability(taskId, source, cache, options);
      return this.capabilityReceipt(validated.profile, source.inventory, { outcome: 'ready', cache, executor });
    } catch (error) {
      return this.capabilityReceipt(validated.profile, source.inventory, {
        outcome: 'executor_unavailable',
        reasonCode: error.code ?? 'VERIFY_EXECUTOR_UNAVAILABLE',
        cache,
        executor: {
          proven: false,
          dockerApiProven: false,
          toolchainImageProven: false,
          samePathBindProven: false,
          stateWriteProven: false,
          cleanupProven: false,
        },
      });
    }
  }

  async admit(taskId, profiles, options = {}) {
    const validated = validateVerifyAction({ action: 'admit', profiles });
    this.taskWorkspace(taskId);
    throwIfAborted(options.signal);
    const flightKey = [
      taskId,
      validated.profiles.join(','),
      this.runnerBootId,
      this.contract.runnerRevision,
    ].join('\0');
    const existingFlight = this.admissionFlights.get(flightKey);
    if (existingFlight !== undefined) return existingFlight;
    const flight = (async () => {
      const source = await this.source(taskId, options);
      let cache;
      try {
        cache = await this.admitCachePack(taskId, source.inventory);
      } catch (error) {
        return this.admissionReceipt(taskId, validated.profiles, source.inventory, {
          outcome: 'cache_invalid', reasonCode: error.code ?? 'VERIFY_CACHE_INVALID',
        });
      }
      if (cache.outcome !== 'ready') {
        return this.admissionReceipt(taskId, validated.profiles, source.inventory, {
          outcome: 'cache_miss', reasonCode: 'VERIFY_CACHE_MISS',
        });
      }
      return this.admitReady(taskId, validated.profiles, source, cache, options);
    })().finally(() => {
      if (this.admissionFlights.get(flightKey) === flight) this.admissionFlights.delete(flightKey);
    });
    this.admissionFlights.set(flightKey, flight);
    return flight;
  }

  async admitReady(taskId, profiles, source, cache, options = {}) {
    try {
      await this.assertSandboxAvailable();
      throwIfAborted(options.signal);
      const now = this.now();
      this.pruneAdmissionState(now);
      let capability = this.admissionCapabilities.get(taskId);
      const remainingMs = capability === undefined ? 0 : capability.expiresAtMs - now;
      const reusable = capability !== undefined
        && capability.projectSlug === this.projectSlug
        && capability.taskId === taskId
        && capability.runnerBootId === this.runnerBootId
        && capability.runnerRevision === this.contract.runnerRevision
        && capability.dependencyManifestFingerprint === source.inventory.dependencyManifestFingerprint
        && capability.cachePackDigest === cache.packDigest
        && remainingMs > this.admissionRefreshMarginMs
        && remainingMs >= this.admissionMinUsableMs;
      if (!reusable) {
        this.admissionCapabilities.delete(taskId);
        const executor = await this.probeExecutorCapability(taskId, source, cache, options);
        throwIfAborted(options.signal);
        const issuedAtMs = this.now();
        capability = {
          projectSlug: this.projectSlug,
          taskId,
          runnerBootId: this.runnerBootId,
          runnerRevision: this.contract.runnerRevision,
          dependencyManifestFingerprint: source.inventory.dependencyManifestFingerprint,
          cachePackDigest: cache.packDigest,
          executor,
          executionCacheRoot: await this.prepareExecutionCache(taskId, source.inventory, cache),
          issuedAtMs,
          expiresAtMs: issuedAtMs + this.admissionTtlMs,
          stateSequence: this.admissionStateSequence += 1,
        };
        this.admissionCapabilities.set(taskId, capability);
      }
      const admissionNow = this.now();
      const admissionRemainingMs = capability.expiresAtMs - admissionNow;
      if (admissionRemainingMs <= this.admissionRefreshMarginMs
        || admissionRemainingMs < this.admissionMinUsableMs) {
        this.admissionCapabilities.delete(taskId);
        throw verifyError('VERIFY_ADMISSION_LEASE_TOO_SHORT', 'Verification execution admission could not provide the minimum usable lease.', {
          retryable: true,
        });
      }
      const admissionId = crypto.randomUUID();
      const admission = {
        admissionId,
        projectSlug: this.projectSlug,
        taskId,
        runnerBootId: this.runnerBootId,
        runnerRevision: this.contract.runnerRevision,
        profiles: [...profiles],
        dependencyManifestFingerprint: source.inventory.dependencyManifestFingerprint,
        cachePackDigest: cache.packDigest,
        executionCacheRoot: capability.executionCacheRoot,
        issuedAtMs: capability.issuedAtMs,
        expiresAtMs: capability.expiresAtMs,
        stateSequence: this.admissionStateSequence += 1,
      };
      this.admissions.set(admissionId, admission);
      this.pruneAdmissionState(admissionNow);
      if (!this.admissions.has(admissionId)) {
        throw verifyError('VERIFY_ADMISSION_STATE_LIMIT', 'Verification execution admission could not be retained within the bounded state limit.', {
          retryable: true,
        });
      }
      return this.admissionReceipt(taskId, profiles, source.inventory, {
        outcome: 'ready', cache, executor: capability.executor, admission,
      });
    } catch (error) {
      return this.admissionReceipt(taskId, profiles, source.inventory, {
        outcome: 'executor_unavailable',
        reasonCode: error.code ?? 'VERIFY_EXECUTOR_UNAVAILABLE',
        cache,
      });
    }
  }

  admissionReceipt(taskId, profiles, inventory, state) {
    const executor = state.executor ?? {
      proven: false,
      dockerApiProven: false,
      toolchainImageProven: false,
      samePathBindProven: false,
      stateWriteProven: false,
      cleanupProven: false,
    };
    return {
      schemaVersion: 1,
      receiptType: 'forge-verify/execution-admission',
      admissionId: state.admission?.admissionId ?? null,
      projectSlug: this.projectSlug,
      taskId,
      runner: { bootId: this.runnerBootId, revision: this.contract.runnerRevision },
      profiles: [...profiles],
      source: {
        head: inventory.head,
        workspaceFingerprint: inventory.workspaceFingerprint,
        dependencyManifestFingerprint: inventory.dependencyManifestFingerprint,
      },
      cache: {
        mode: 'project-scoped-immutable-pack',
        compatible: state.cache !== undefined,
        ...(state.cache === undefined ? {} : { packDigest: state.cache.packDigest }),
      },
      executor,
      issuedAt: state.admission === undefined ? null : new Date(state.admission.issuedAtMs).toISOString(),
      expiresAt: state.admission === undefined ? null : new Date(state.admission.expiresAtMs).toISOString(),
      outcome: state.outcome,
      reasonCode: state.reasonCode ?? null,
      truth: {
        executionProven: false,
        verificationProven: false,
        semanticCorrectnessProven: false,
        databaseIntegrationProven: false,
        releaseProven: false,
      },
    };
  }

  async validateExecutionAdmission(taskId, profile, admissionId, inventory, options = {}) {
    throwIfAborted(options.signal);
    const admission = this.admissions.get(admissionId);
    if (!admission) throw verifyError('VERIFY_ADMISSION_NOT_FOUND', 'Verification execution admission was not found or belongs to a prior Runner process.');
    if (admission.projectSlug !== this.projectSlug || admission.taskId !== taskId
      || admission.runnerBootId !== this.runnerBootId
      || admission.runnerRevision !== this.contract.runnerRevision) {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_IDENTITY_MISMATCH', 'Verification execution admission identity does not match this Runner and TaskSpace.');
    }
    const remainingMs = admission.expiresAtMs - this.now();
    if (remainingMs <= 0) {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_EXPIRED', 'Verification execution admission has expired.', { retryable: true });
    }
    if (remainingMs <= this.admissionRefreshMarginMs || remainingMs < this.admissionMinUsableMs) {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_REFRESH_REQUIRED', 'Verification execution admission is too close to expiry and must be refreshed.', { retryable: true });
    }
    this.pruneAdmissionState();
    if (!admission.profiles.includes(profile)) {
      throw verifyError('VERIFY_ADMISSION_PROFILE_MISMATCH', 'Verification profile is outside the admitted profile set.');
    }
    if (admission.dependencyManifestFingerprint !== inventory.dependencyManifestFingerprint) {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_DEPENDENCY_CHANGED', 'Dependency manifests changed after execution admission.');
    }
    await this.assertSandboxAvailable();
    throwIfAborted(options.signal);
    let cache;
    try {
      cache = await this.validateAdmittedCachePack(taskId, inventory, admission);
    } catch {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification cache changed after execution admission.');
    }
    if (cache.outcome !== 'ready' || cache.packDigest !== admission.cachePackDigest
      || typeof admission.executionCacheRoot !== 'string') {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification cache changed after execution admission.');
    }
    const executionCacheRoot = path.resolve(admission.executionCacheRoot);
    if (!inside(path.resolve(this.stateRoot, 'execution-caches'), executionCacheRoot)) {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification execution cache identity is invalid.');
    }
    try {
      const metadata = await lstat(executionCacheRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('execution cache is invalid');
    } catch {
      this.admissions.delete(admissionId);
      throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification execution cache is unavailable.');
    }
    return { admission, cache, executionCacheRoot };
  }

  cacheAdmissionKey(taskId, dependencyManifestFingerprint) {
    return `${taskId}\0${dependencyManifestFingerprint}`;
  }

  invalidateCacheAdmission(taskId, dependencyManifestFingerprint) {
    const key = this.cacheAdmissionKey(taskId, dependencyManifestFingerprint);
    this.verifiedCachePacks.delete(key);
    this.admissionCapabilities.delete(taskId);
    for (const [admissionId, admission] of this.admissions) {
      if (admission.taskId === taskId && admission.dependencyManifestFingerprint === dependencyManifestFingerprint) {
        this.admissions.delete(admissionId);
      }
    }
  }

  async admitCachePack(taskId, inventory) {
    const key = this.cacheAdmissionKey(taskId, inventory.dependencyManifestFingerprint);
    const existing = this.verifiedCachePacks.get(key);
    if (existing !== undefined) {
      const identity = await this.scanCacheMetadata(existing.cache.packRoot);
      if (identity.digest === existing.metadataDigest) return existing.cache;
      this.invalidateCacheAdmission(taskId, inventory.dependencyManifestFingerprint);
    }
    const existingFlight = this.cacheAdmissionFlights.get(key);
    if (existingFlight !== undefined) return existingFlight;
    const flight = this.admitCachePackReady(taskId, inventory, key)
      .finally(() => this.cacheAdmissionFlights.delete(key));
    this.cacheAdmissionFlights.set(key, flight);
    return flight;
  }

  async admitCachePackReady(taskId, inventory, key) {
    const cache = await this.verifyCachePack(
      this.cacheRoot,
      inventory.dependencyManifestFingerprint,
      this.contract,
      inventory.dependencyManifestFiles,
    );
    if (cache.outcome !== 'ready') return cache;
    const identity = await this.scanCacheMetadata(cache.packRoot);
    this.verifiedCachePacks.set(key, { cache, metadataDigest: identity.digest, nodeCount: identity.nodeCount });
    return cache;
  }

  async validateAdmittedCachePack(taskId, inventory, admission) {
    const key = this.cacheAdmissionKey(taskId, inventory.dependencyManifestFingerprint);
    const existing = this.verifiedCachePacks.get(key);
    if (existing === undefined || existing.cache.packDigest !== admission.cachePackDigest) {
      throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification cache admission is no longer available.');
    }
    const identity = await this.scanCacheMetadata(existing.cache.packRoot);
    if (identity.digest !== existing.metadataDigest) {
      this.invalidateCacheAdmission(taskId, inventory.dependencyManifestFingerprint);
      throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification cache metadata changed after execution admission.');
    }
    return existing.cache;
  }

  async prepareExecutionCache(taskId, inventory, cache) {
    const cacheIdentity = `${inventory.dependencyManifestFingerprint}-${cache.packDigest}`;
    const root = path.resolve(this.stateRoot, 'execution-caches', taskId, this.runnerBootId, cacheIdentity);
    const executionCachesRoot = path.resolve(this.stateRoot, 'execution-caches');
    if (!inside(executionCachesRoot, root)) throw verifyError('VERIFY_CACHE_INVALID', 'Verification execution cache path escaped its state root.');
    const holdKey = `${taskId}\0${cacheIdentity}`;
    if (this.executionCacheHolds.has(holdKey)) {
      throw verifyError('VERIFY_EXECUTION_CACHE_PREP_HOLD', 'Verification execution cache preparation remains in a safe hold.');
    }
    const flightKey = `${taskId}\0${this.runnerBootId}\0${cacheIdentity}`;
    const existingFlight = this.executionCacheFlights.get(flightKey);
    if (existingFlight !== undefined) return existingFlight;
    const flight = this.prepareExecutionCacheReady(taskId, inventory, cache, root, holdKey)
      .finally(() => this.executionCacheFlights.delete(flightKey));
    this.executionCacheFlights.set(flightKey, flight);
    return flight;
  }

  async prepareExecutionCacheReady(taskId, inventory, cache, root, holdKey) {
    try {
      const existing = await lstat(root);
      if (existing.isDirectory() && !existing.isSymbolicLink()) return root;
      throw verifyError('VERIFY_EXECUTION_CACHE_INVALID', 'Verification execution cache path is occupied by an unsupported node.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const incoming = `${root}.incoming-${crypto.randomUUID()}`;
    try {
      await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
      await this.copyCachePack(cache, incoming);
      const identity = await this.scanCacheMetadata(cache.packRoot);
      const admitted = this.verifiedCachePacks.get(this.cacheAdmissionKey(taskId, inventory.dependencyManifestFingerprint));
      if (admitted === undefined || identity.digest !== admitted.metadataDigest) {
        throw verifyError('VERIFY_ADMISSION_CACHE_CHANGED', 'Verification cache changed while the execution cache was being prepared.');
      }
      await rename(incoming, root);
      return root;
    } catch (error) {
      try {
        await rm(incoming, { recursive: true, force: true, maxRetries: 2 });
      } catch (cleanupError) {
        this.executionCacheHolds.set(holdKey, { incoming, cleanupError: cleanupError.code ?? cleanupError.message });
      }
      throw error;
    }
  }

  async probeExecutorCapability(taskId, source, cache, options = {}) {
    throwIfAborted(options.signal);
    const dependency = source.inventory.dependencyManifestFiles[0];
    if (!dependency) throw verifyError('VERIFY_EXECUTOR_SOURCE_UNPROVEN', 'No dependency manifest is available for the same-path execution probe.');
    const probeId = crypto.randomUUID();
    const probeRoot = path.join(this.stateRoot, 'capability-probes', `${taskId}-${probeId}`);
    const stateMarker = path.join(probeRoot, 'state-write.json');
    let preserveProbeRoot = false;
    try {
      await atomicJson(stateMarker, {
        schemaVersion: 1,
        projectSlug: this.projectSlug,
        taskId,
        probeId,
      });
      const observedState = JSON.parse(await readFile(stateMarker, 'utf8'));
      if (observedState.probeId !== probeId || observedState.taskId !== taskId) {
        throw verifyError('VERIFY_EXECUTOR_STATE_UNPROVEN', 'Runner state write/read proof did not round-trip.');
      }
      const probeScript = [
        'const fs=require("node:fs"),c=require("node:crypto");',
        'const p=`/workspace/${process.argv[1]}`;',
        'const h=c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");',
        'if(h!==process.argv[2])process.exit(42);',
      ].join('');
      const result = await this.dockerStep({
        taskId,
        jobId: probeId,
        step: { cwd: '/workspace', argv: ['node', '-e', probeScript, dependency.path, dependency.sha256] },
        snapshotRoot: source.workspace,
        cacheRoot: cache.packRoot,
        workspaceGitRoot: path.join(source.workspace, '.git'),
        jobRoot: probeRoot,
        readOnlyWorkspace: true,
        readOnlyCache: true,
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      if (result.exitCode !== 0 || result.timedOut === true || result.cleanup?.proven !== true) {
        throw verifyError('VERIFY_EXECUTOR_PROBE_FAILED', 'The fixed toolchain same-path execution probe failed.');
      }
      return {
        proven: true,
        dockerApiProven: true,
        toolchainImageProven: true,
        samePathBindProven: true,
        stateWriteProven: true,
        cleanupProven: true,
      };
    } catch (error) {
      preserveProbeRoot = error?.code === 'VERIFY_SANDBOX_CLEANUP_UNPROVEN';
      throw error;
    } finally {
      if (!preserveProbeRoot && inside(path.resolve(this.stateRoot, 'capability-probes'), path.resolve(probeRoot))) {
        await rm(probeRoot, { recursive: true, force: true, maxRetries: 2 });
      }
    }
  }

  capabilityReceipt(profile, inventory, state) {
    return {
      schemaVersion: 1,
      receiptType: 'forge-verify/capability',
      receiptId: crypto.randomUUID(),
      projectSlug: this.projectSlug,
      source: {
        head: inventory.head,
        workspaceFingerprint: inventory.workspaceFingerprint,
        dependencyManifestFingerprint: inventory.dependencyManifestFingerprint,
      },
      runner: { revision: this.contract.runnerRevision },
      profile,
      toolchain: { image: this.contract.toolchainImage },
      cache: {
        mode: 'project-scoped-immutable-pack',
        compatible: state.cache !== undefined,
        ...(state.cache === undefined ? {} : { packDigest: state.cache.packDigest }),
      },
      executor: state.executor ?? {
        proven: false,
        dockerApiProven: false,
        toolchainImageProven: false,
        samePathBindProven: false,
        stateWriteProven: false,
        cleanupProven: false,
      },
      network: { externalEgress: false, sandboxNetwork: 'none' },
      limits: this.contract.limits,
      outcome: state.outcome,
      reasonCode: state.reasonCode ?? null,
      observedAt: new Date().toISOString(),
      truth: {
        executionProven: false,
        verificationProven: false,
        semanticCorrectnessProven: false,
        databaseIntegrationProven: false,
        releaseProven: false,
      },
    };
  }

  async currentSafetyHold() {
    if (this.safetyHold !== null) return this.safetyHold;
    try {
      const hold = JSON.parse(await readFile(path.join(this.stateRoot, SAFETY_HOLD_FILE), 'utf8'));
      if (!hold || hold.schemaVersion !== 1 || hold.code !== 'VERIFY_SANDBOX_CLEANUP_UNPROVEN') {
        throw new Error('sandbox safety hold is invalid.');
      }
      this.safetyHold = hold;
      return hold;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      const hold = {
        schemaVersion: 1,
        code: 'VERIFY_SANDBOX_CLEANUP_UNPROVEN',
        reason: 'safety-hold-state-invalid',
        observedAt: new Date().toISOString(),
      };
      this.safetyHold = hold;
      return hold;
    }
  }

  async assertSandboxAvailable() {
    if (await this.currentSafetyHold() !== null) {
      throw verifyError('VERIFY_RUNNER_SAFETY_HOLD', 'Verification execution is disabled because prior sandbox cleanup is unproven.', {
        recommendedAction: 'A platform operator must reconcile the recorded container ID and safety-hold evidence before clearing the hold and restarting verification.',
      });
    }
  }

  async sandboxCleanupUnproven({ taskId, jobId, containerName, containerId = null, jobRoot, reason }) {
    const hold = {
      schemaVersion: 1,
      code: 'VERIFY_SANDBOX_CLEANUP_UNPROVEN',
      projectSlug: this.projectSlug,
      taskId,
      jobId,
      containerName,
      containerId,
      jobRoot,
      reason,
      observedAt: new Date().toISOString(),
    };
    this.safetyHold = hold;
    try {
      await atomicJson(path.join(this.stateRoot, SAFETY_HOLD_FILE), hold);
    } catch (error) {
      hold.holdPersistenceError = error.code ?? error.message;
    }
    const failure = verifyError(
      'VERIFY_SANDBOX_CLEANUP_UNPROVEN',
      'Verification sandbox cleanup could not be proven; the Runner entered a safety hold.',
      {
        recommendedAction: 'A platform operator must reconcile the recorded container ID and retained job root before clearing the safety hold.',
      },
    );
    failure.preserveJobRoot = true;
    failure.safetyHold = hold;
    return failure;
  }

  async inspectSandbox(containerId, ownership, options = {}) {
    let result;
    try {
      result = await this.command('docker', ['inspect', '--type', 'container', containerId], {
        maxOutputBytes: 256 * 1024,
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: `${options.phase ?? 'inspect'}-transport-error` });
    }
    if (result.exitCode !== 0 || result.timedOut === true || result.signal !== null) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: `${options.phase ?? 'inspect'}-unavailable` });
    }
    let inspected;
    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('expected exactly one container.');
      [inspected] = parsed;
    } catch {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: `${options.phase ?? 'inspect'}-invalid-response` });
    }
    const labels = inspected?.Config?.Labels;
    if (inspected?.Id !== containerId
      || inspected?.Name !== `/${ownership.containerName}`
      || labels?.[SANDBOX_OWNER_LABEL] !== SANDBOX_OWNER
      || labels?.[SANDBOX_PROJECT_LABEL] !== this.projectSlug
      || labels?.[SANDBOX_TASK_LABEL] !== ownership.taskId
      || labels?.[SANDBOX_JOB_LABEL] !== ownership.jobId) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: `${options.phase ?? 'inspect'}-ownership-mismatch` });
    }
    return inspected;
  }

  async removeOwnedSandbox(containerId, ownership) {
    let removal;
    try {
      removal = await this.command('docker', ['rm', '--force', containerId], {
        maxOutputBytes: 64 * 1024,
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: 'remove-transport-error' });
    }
    if (removal.exitCode !== 0 || removal.timedOut === true || removal.signal !== null) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: 'remove-failed' });
    }
    let remaining;
    try {
      remaining = await this.command('docker', [
        'ps', '--all', '--no-trunc', '--filter', `id=${containerId}`, '--format', '{{.ID}}',
      ], { maxOutputBytes: 64 * 1024, timeoutMs: 30_000 });
    } catch (error) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: 'remove-proof-transport-error' });
    }
    if (remaining.exitCode !== 0 || remaining.timedOut === true || remaining.signal !== null
      || remaining.stdout.trim().length !== 0) {
      throw await this.sandboxCleanupUnproven({ ...ownership, containerId, reason: 'remove-proof-failed' });
    }
    return {
      attempted: true,
      proven: true,
      containerId,
      exitCode: removal.exitCode,
      signal: removal.signal,
      timedOut: false,
    };
  }

  async dockerStep({
    taskId, jobId, step, snapshotRoot, cacheRoot, workspaceGitRoot,
    jobRoot: explicitJobRoot, readOnlyWorkspace = false, readOnlyCache = false, signal,
  }) {
    throwIfAborted(signal);
    const containerName = `forge-verify-${this.projectSlug}-${taskId}-${jobId.slice(0, 8)}`.slice(0, 120);
    const jobRoot = explicitJobRoot ?? path.dirname(snapshotRoot);
    const ownership = { taskId, jobId, containerName, jobRoot };
    const args = [
      'create', '--name', containerName,
      '--label', `${SANDBOX_OWNER_LABEL}=${SANDBOX_OWNER}`,
      '--label', `${SANDBOX_PROJECT_LABEL}=${this.projectSlug}`,
      '--label', `${SANDBOX_TASK_LABEL}=${taskId}`,
      '--label', `${SANDBOX_JOB_LABEL}=${jobId}`,
      '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '1024', '--memory', '8g', '--cpus', '4',
      '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g',
      '--mount', `type=bind,src=${snapshotRoot},dst=/workspace${readOnlyWorkspace ? ',readonly' : ''}`,
      '--mount', `type=bind,src=${workspaceGitRoot},dst=/workspace/.git,readonly`,
      '--mount', `type=bind,src=${cacheRoot},dst=/verify-cache${readOnlyCache ? ',readonly' : ''}`,
      '--env', MAVEN_VERIFICATION_ENV_ARG,
      '--env', 'NPM_CONFIG_CACHE=/verify-cache/npm',
      '--env', 'PNPM_HOME=/verify-cache/pnpm/home',
      '--env', 'HOME=/tmp/verify-home',
      '--env', 'GIT_OPTIONAL_LOCKS=0',
      '--env', 'CI=true',
      '--workdir', step.cwd,
      ...(step.argv[0] === 'mvn' ? ['--entrypoint', MAVEN_VERIFICATION_EXEC_PATH] : []),
      this.contract.toolchainImage,
      ...step.argv,
    ];
    let created;
    try {
      created = await this.command('docker', args, {
        maxOutputBytes: 256 * 1024,
        timeoutMs: 30_000,
        signal,
      });
    } catch (error) {
      throw await this.sandboxCleanupUnproven({ ...ownership, reason: 'create-transport-error' });
    }
    if (dockerTransportUncertain(created)) {
      throw await this.sandboxCleanupUnproven({ ...ownership, reason: 'create-daemon-unavailable' });
    }
    if (created.exitCode !== 0) {
      if (/conflict.*container name|already in use|is already in use/iu.test(created.stderr)) {
        throw verifyError('VERIFY_SANDBOX_NAME_COLLISION', 'Verification sandbox name is already occupied; no container was deleted.');
      }
      throw verifyError('VERIFY_SANDBOX_CREATE_FAILED', 'Verification sandbox could not be created.');
    }
    const containerId = created.stdout.trim();
    if (!SANDBOX_ID_PATTERN.test(containerId)) {
      throw await this.sandboxCleanupUnproven({ ...ownership, reason: 'create-id-invalid' });
    }
    await this.inspectSandbox(containerId, ownership, { phase: 'created-inspect' });
    let result;
    try {
      result = await this.command('docker', ['start', '--attach', containerId], {
        maxOutputBytes: this.contract.limits.maxLogBytes,
        timeoutMs: this.contract.limits.defaultTimeoutSeconds * 1000,
        signal,
      });
    } catch (error) {
      result = {
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: `Docker start transport error: ${error.code ?? error.message ?? 'unknown error'}`,
        bytes: 0,
        truncated: false,
        transportUncertain: true,
      };
    }
    const transportUncertain = dockerTransportUncertain(result);
    const inspected = await this.inspectSandbox(containerId, ownership, { phase: 'completed-inspect' });
    const cleanup = await this.removeOwnedSandbox(containerId, ownership);
    const terminalState = inspected?.State?.Running !== true && inspected?.State?.Status === 'exited'
      && Number.isInteger(inspected?.State?.ExitCode);
    if (!transportUncertain && !terminalState) {
      throw verifyError('VERIFY_SANDBOX_STATE_INVALID', 'Verification sandbox did not reach a trustworthy terminal state.');
    }
    return {
      ...result,
      exitCode: terminalState
        ? inspected.State.ExitCode
        : Number.isInteger(result.exitCode) ? result.exitCode : result.timedOut === true ? 124 : 1,
      cleanup,
      transportUncertain,
    };
  }

  async run(taskId, request, options = {}) {
    const validated = validateVerifyAction(request);
    if (validated.action !== 'run') throw new Error('run request is required.');
    if (validated.executionMode !== undefined) {
      throw verifyError('VERIFY_BACKGROUND_UNSUPPORTED', 'Background verification requires the upgraded Host Runner; no check was started.');
    }
    if (validated.receiptId !== undefined) {
      throw verifyError('VERIFY_RECEIPT_REUSE_UNSUPPORTED', '当前容器执行器不支持历史回执复核。请通过已升级的 Host Runner 在原对话执行复核；本请求没有启动检查。');
    }
    await this.assertSandboxAvailable();
    if (this.activeByTask.has(taskId)) throw verifyError('VERIFY_TASK_BUSY', 'This TaskSpace already has an active verification job.', { retryable: true });
    if (this.activeByTask.size >= this.maxConcurrent) throw verifyError('VERIFY_QUEUE_BUSY', 'The project verification queue is full.', { retryable: true });
    const jobId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    this.activeByTask.set(taskId, { jobId, receiptId, startedAt, phase: 'preparing' });
    let jobRoot;
    let preserveJobRoot = false;
    try {
      throwIfAborted(options.signal);
      const sourceOptions = { ...options, changedFrontendScope: ['frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck'].includes(validated.profile) };
      const source = await this.source(taskId, sourceOptions);
      const lintFiles = validated.profile === 'frontend-admin-lint' ? await resolveFrontendLintFiles(source) : undefined;
      const typecheckFiles = validated.profile === 'frontend-admin-typecheck' ? await resolveFrontendTypecheckFiles(source) : undefined;
      const testFilters = validated.profile === 'frontend-admin-test' && validated.selectors.testFiles === undefined
        ? await resolveFrontendTestFilters(source) : undefined;
      const admitted = await this.validateExecutionAdmission(
        taskId,
        validated.profile,
        validated.admissionId,
        source.inventory,
        options,
      );
      const digest = verificationIdempotencyDigest({
        projectSlug: this.projectSlug,
        taskId,
        sourceFingerprint: source.inventory.workspaceFingerprint,
        profile: validated.profile,
        selectors: validated.selectors,
        idempotencyKey: validated.idempotencyKey,
        admissionId: validated.admissionId,
      });
      const idempotencyFile = path.join(this.stateRoot, 'idempotency', `${digest}.json`);
      try {
        const existing = JSON.parse(await readFile(idempotencyFile, 'utf8'));
        if (this.acceptanceIssuerClient !== null) {
          if (existing.acceptanceContractId !== options.acceptanceContractId) {
            throw verifyError('VERIFY_ACCEPTANCE_CONTRACT_MISMATCH', 'Idempotent verification is bound to another acceptance contract.');
          }
          const persisted = JSON.parse(await readFile(path.join(this.stateRoot, 'receipts', taskId, `${existing.receiptId}.json`), 'utf8'));
          await this.submitProtectedAcceptance(taskId, options.acceptanceContractId, persisted, options);
        }
        return this.receipt(taskId, existing.receiptId);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const { cache, executionCacheRoot } = admitted;
      jobRoot = path.join(this.stateRoot, 'jobs', `${taskId}-${jobId}`);
      const snapshotRoot = path.join(jobRoot, 'workspace');
      this.activeByTask.set(taskId, { jobId, receiptId, startedAt, phase: 'running' });
      await mkdir(path.dirname(jobRoot), { recursive: true, mode: 0o700 });
      await mkdir(jobRoot, { mode: 0o700 });
      await snapshotInventory(source.inventory, snapshotRoot);
      await purgeSnapshotTestResults(snapshotRoot);
      throwIfAborted(options.signal);
      const command = verificationCommand(validated.profile, validated.selectors, source.inventory.head, lintFiles, source.reviewBase, testFilters, typecheckFiles);
      const stepResults = [];
      for (const step of command.steps) {
        const result = await this.dockerStep({
          taskId, jobId, step, snapshotRoot, cacheRoot: executionCacheRoot,
          workspaceGitRoot: path.join(source.workspace, '.git'),
          signal: options.signal,
        });
        stepResults.push({ step, ...result });
        throwIfAborted(options.signal);
        if (result.exitCode !== 0) break;
      }
      const after = sourceOptions.changedFrontendScope
        ? await this.source(taskId, sourceOptions)
        : { inventory: await inventoryWorkspace(source.workspace, this.contract.limits, this.command, options) };
      if (after.inventory.workspaceFingerprint !== source.inventory.workspaceFingerprint || after.reviewBase !== source.reviewBase) {
        throw verifyError('VERIFY_SOURCE_CHANGED', 'TaskSpace source changed while verification was running.', { retryable: true });
      }
      const finalStep = stepResults.at(-1);
      const logs = stepResults.map((item, index) => [
        `# step ${index + 1}: ${JSON.stringify(item.step.argv)}`,
        item.stdout,
        item.stderr,
      ].join('\n')).join('\n');
      const tests = await collectTestResults(snapshotRoot);
      const backendTests = ['backend-module-test', 'backend-test-class', 'backend-red-test', 'full-regression']
        .includes(validated.profile);
      const reportedBackendFailure = backendTests && tests.failed > 0;
      const changedFrontendTests = validated.profile === 'frontend-admin-test' && validated.selectors.testFiles === undefined
        && stepResults.every(step => step.exitCode === 0);
      const noExecutedTests = backendTests ? tests.passed + tests.failed === 0 : tests.executed === 0;
      const zeroTests = isTestProfile(validated.profile) && noExecutedTests && !changedFrontendTests
        && stepResults.every(step => step.exitCode === 0);
      const timedOut = stepResults.some((item) => item.timedOut === true);
      const passed = stepResults.length === command.steps.length
        && stepResults.every((item) => item.exitCode === 0)
        && stepResults.every((item) => item.transportUncertain !== true)
        && !zeroTests && !reportedBackendFailure;
      if (validated.profile === 'frontend-h5-test' && tests.failed > 0 && passed) {
        throw verifyError('VERIFY_TEST_REPORT_INVALID', 'H5 test failures cannot have a successful process result.');
      }
      const redProfile = ['backend-red-test', 'frontend-red-test'].includes(validated.profile);
      const redMatched = redProfile && !passed && !timedOut && !zeroTests
        && stepResults.length === command.steps.length
        && Number.isSafeInteger(finalStep?.exitCode) && finalStep.exitCode !== 0
        && tests.executed > 0 && tests.failed > 0 && tests.reportFiles > 0
        && stepResults.every((item) => item.transportUncertain !== true
          && item.signal === null && item.cleanup?.proven === true);
      const execution = {
        schemaVersion: 1,
        receiptType: 'forge-verify/run',
        receiptId,
        jobId,
        projectSlug: this.projectSlug,
        taskId,
        status: passed ? 'passed' : timedOut ? 'timed-out' : zeroTests ? 'failed-zero-tests' : 'failed',
        source: {
          head: source.inventory.head,
          workspaceFingerprint: source.inventory.workspaceFingerprint,
          dependencyManifestFingerprint: source.inventory.dependencyManifestFingerprint,
          snapshotSha256: source.inventory.workspaceFingerprint,
          fileCount: source.inventory.fileCount,
          bytes: source.inventory.bytes,
        },
        request: {
          profile: validated.profile,
          selectors: validated.selectors,
          selectorsSha256: selectorDigest(validated.selectors),
          idempotencyDigest: digest,
          admissionId: validated.admissionId,
        },
        execution: {
          steps: stepResults.map((item) => ({
            argv: item.step.argv, cwd: item.step.cwd, exitCode: item.exitCode,
            signal: item.signal, timedOut: item.timedOut === true,
            transportUncertain: item.transportUncertain === true,
            cleanup: item.cleanup,
          })),
          exitCode: finalStep?.exitCode ?? null,
          signal: finalStep?.signal ?? null,
          startedAt,
          finishedAt: new Date().toISOString(),
          externalEgress: false,
          toolchainImage: this.contract.toolchainImage,
          cachePackDigest: cache.packDigest,
        },
        results: { ...tests, zeroTestsRejected: zeroTests },
        ...(redProfile ? {
          redExpectation: {
            schemaVersion: 1,
            expectationType: 'selected-test-must-fail',
            profile: validated.profile,
            selectorsSha256: selectorDigest(validated.selectors),
            matched: redMatched,
            failureKind: redMatched ? 'test-report' : 'unmatched',
          },
        } : {}),
        logs: {
          sha256: crypto.createHash('sha256').update(logs, 'utf8').digest('hex'),
          bytes: Buffer.byteLength(logs),
          truncated: stepResults.some((item) => item.truncated),
          diagnosticSummary: passed ? 'The selected typed verification profile passed.'
            : timedOut ? 'The selected typed verification profile exceeded its fixed timeout.'
            : zeroTests ? 'The selected test profile has no executed, non-skipped tests.'
              : reportedBackendFailure ? 'The backend test report contains failed tests; the process exit code is retained separately.'
              : 'A typed verification step returned a nonzero exit code.',
        },
        truth: {
          executionProven: true,
          verificationProven: passed,
          semanticCorrectnessProven: false,
          databaseIntegrationProven: false,
          releaseProven: false,
        },
      };
      await atomicJson(path.join(this.stateRoot, 'receipts', taskId, `${receiptId}.json`), execution);
      await atomicJson(idempotencyFile, {
        schemaVersion: 1, taskId, receiptId, digest,
        acceptanceContractId: options.acceptanceContractId ?? null,
      });
      await this.submitProtectedAcceptance(taskId, options.acceptanceContractId, execution, options);
      return execution;
    } catch (error) {
      preserveJobRoot = error?.preserveJobRoot === true || error?.code === 'VERIFY_SANDBOX_CLEANUP_UNPROVEN';
      throw error;
    } finally {
      this.activeByTask.delete(taskId);
      if (jobRoot !== undefined && !preserveJobRoot) {
        const resolvedJobRoot = path.resolve(jobRoot);
        if (inside(path.resolve(this.stateRoot, 'jobs'), resolvedJobRoot)) {
          await rm(resolvedJobRoot, { recursive: true, force: true, maxRetries: 2 });
        }
      }
    }
  }

  async receipt(taskId, receiptId) {
    const file = path.resolve(this.stateRoot, 'receipts', taskId, `${receiptId}.json`);
    if (!inside(path.resolve(this.stateRoot, 'receipts'), file)) throw verifyError('VERIFY_RECEIPT_INVALID', 'Verification receipt path escaped its root.');
    try {
      const receipt = JSON.parse(await readFile(file, 'utf8'));
      const current = await this.source(taskId);
      return {
        ...receipt,
        freshness: current.inventory.workspaceFingerprint === receipt.source?.workspaceFingerprint ? 'current' : 'stale',
      };
    } catch (error) {
      if (error.code === 'ENOENT') throw verifyError('VERIFY_RECEIPT_NOT_FOUND', 'Verification receipt was not found.');
      throw error;
    }
  }

  async status(taskId, jobId) {
    const active = this.activeByTask.get(taskId);
    if (active?.jobId === jobId) return { active: true, ...active };
    return { active: false, jobId };
  }

  async execute(raw, options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw verifyError('VERIFY_REQUEST_INVALID', 'Verification request must be an object.');
    throwIfAborted(options.signal);
    const { taskId, acceptanceContractId, ...request } = raw;
    if (request.action === 'admit') return this.admit(taskId, request.profiles, options);
    if (request.action === 'capability') return this.capability(taskId, request.profile, options);
    if (request.action === 'run') return this.run(taskId, request, { ...options, acceptanceContractId });
    const validated = validateVerifyAction(request);
    if (validated.action === 'status') return this.status(taskId, validated.jobId);
    if (validated.action === 'receipt') return this.receipt(taskId, validated.receiptId);
    throw verifyError('VERIFY_REQUEST_INVALID', 'Verification request is invalid.');
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw verifyError('VERIFY_REQUEST_TOO_LARGE', 'Verification request is too large.');
    chunks.push(chunk);
  }
  if (bytes === 0) throw verifyError('VERIFY_REQUEST_REQUIRED', 'Verification request body is required.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

export function createVerificationRunnerServer(runner) {
  return http.createServer(async (request, response) => {
    const controller = new AbortController();
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        const safetyHold = await runner.currentSafetyHold();
        send(response, 200, {
          ok: true,
          projectSlug: runner.projectSlug,
          runnerRevision: runner.contract.runnerRevision,
          activeJobs: runner.activeByTask.size,
          acceptingJobs: safetyHold === null,
          safetyHold: safetyHold === null ? null : { code: safetyHold.code, observedAt: safetyHold.observedAt },
        });
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
      send(response, 200, {
        ok: true,
        result: await runner.execute(await readJsonBody(request), { signal: controller.signal }),
      });
    } catch (error) {
      send(response, error.code === 'VERIFY_REQUEST_TOO_LARGE' ? 413 : 422, { ok: false, error: publicVerifyError(error) });
    }
  });
}

export function createVerificationSourceObserverServer(runner) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        send(response, 200, { ok: true, capability: 'controlled-source-observer', projectSlug: runner.projectSlug });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/source') {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['taskId'])) {
        throw verifyError('VERIFY_REQUEST_INVALID', 'Source observation accepts only taskId.');
      }
      const taskId = body.taskId;
      if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) throw verifyError('VERIFY_TASK_INVALID', 'TaskSpace identity is invalid.');
      const observed = await runner.source(taskId);
      send(response, 200, {
        ok: true,
        result: {
          schemaVersion: 1,
          observationType: 'forge-verify/source',
          projectSlug: runner.projectSlug,
          taskId,
          taskActivity: { active: runner.activeByTask.has(taskId) },
          source: {
            head: observed.inventory.head,
            fingerprint: observed.inventory.workspaceFingerprint,
            snapshotSha256: observed.inventory.workspaceFingerprint,
          },
        },
      });
    } catch (error) {
      send(response, 422, { ok: false, error: publicVerifyError(error) });
    }
  });
}

async function main() {
  const projectSlug = process.env.VERIFICATION_PROJECT_SLUG;
  const taskspacesRoot = process.env.VERIFICATION_TASKSPACES_ROOT;
  const contractFile = process.env.VERIFICATION_CONTRACT;
  const socketPath = process.env.VERIFICATION_RUNNER_SOCKET ?? '/run/forge-verify/runner.sock';
  const sourceSocketPath = process.env.VERIFICATION_SOURCE_SOCKET ?? '/run/forge-verify-source/source.sock';
  const acceptanceIssuerSocket = process.env.PROTECTED_ACCEPTANCE_ISSUER_SOCKET;
  if (!projectSlug || !taskspacesRoot || !contractFile || !path.isAbsolute(taskspacesRoot) || !path.isAbsolute(contractFile)) {
    throw new Error('Verification runner project, TaskSpace root, and contract are required.');
  }
  const contract = JSON.parse(await readFile(contractFile, 'utf8'));
  const runner = new VerificationRunner({
    projectSlug,
    taskspacesRoot,
    contract,
    ...(acceptanceIssuerSocket === undefined ? {} : {
      acceptanceIssuerClient: (route, body, options) => defaultProtectedAcceptanceIssuerClient(
        acceptanceIssuerSocket, route, body, options,
      ),
    }),
  });
  await Promise.all([path.dirname(socketPath), path.dirname(sourceSocketPath)].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await Promise.all([socketPath, sourceSocketPath].map((file) => rm(file, { force: true })));
  const server = createVerificationRunnerServer(runner);
  const sourceServer = createVerificationSourceObserverServer(runner);
  server.listen(socketPath, async () => {
    await chmod(socketPath, 0o660);
    process.stdout.write(`verification-runner listening on project capability socket ${socketPath}\n`);
  });
  sourceServer.listen(sourceSocketPath, async () => {
    await chmod(sourceSocketPath, 0o660);
    process.stdout.write(`verification-runner source observer listening on ${sourceSocketPath}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
