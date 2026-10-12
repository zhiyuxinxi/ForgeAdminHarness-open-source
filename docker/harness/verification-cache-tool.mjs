import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inventoryWorkspace, verifyCachePack } from './verification-runner.mjs';
import { validateVerificationContract } from './verify-policy.mjs';
import {
  MAVEN_VERIFICATION_ARGS,
  MAVEN_VERIFICATION_ENV_ARG,
  MAVEN_VERIFICATION_EXEC_PATH,
  readMavenVerificationPolicy,
} from './maven-verification-policy.mjs';

const CACHE_MANIFEST_SCHEMA_VERSION = 3;
const COMPATIBILITY_SCHEMA_VERSION = 'forge-verification-cache-compatibility/v2';
const IMAGE_CACHE_TOOL_PATH = '/usr/local/lib/verification-cache-tool.mjs';
const IMMUTABLE_IMAGE_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._/-]*@)?sha256:[0-9a-f]{64}$/u;
const TOOLCHAIN_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/u;
const WARM_COMMANDS = Object.freeze([
  Object.freeze(['env', MAVEN_VERIFICATION_ENV_ARG, MAVEN_VERIFICATION_EXEC_PATH, 'mvn', ...MAVEN_VERIFICATION_ARGS, '--no-transfer-progress', '-f', '/workspace/forge-server/pom.xml', '-Dmaven.repo.local=/warm/m2/repository', '-Penable-tests', '-DskipTests', 'dependency:go-offline']),
  Object.freeze(['pnpm', '--dir', '/workspace/forge-admin-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-admin-virtual-store', '--modules-dir', '/warm/scratch/forge-admin-node_modules']),
  Object.freeze(['pnpm', '--dir', '/workspace/forge-h5-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-h5-virtual-store', '--modules-dir', '/warm/scratch/forge-h5-node_modules']),
]);
const PRODUCER_TOPOLOGY = Object.freeze({
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

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!['compatibility', 'fingerprint', 'promote', 'publish', 'verify'].includes(action)) {
    throw new Error('Expected compatibility, fingerprint, promote, publish, or verify.');
  }
  const required = new Set(action === 'fingerprint'
    ? ['--workspace', '--contract']
    : action === 'publish'
      ? ['--workspace', '--contract', '--staging', '--fingerprint', '--node-base-image', '--maven-base-image']
      : action === 'promote'
        ? ['--workspace', '--contract', '--source-pack', '--staging', '--fingerprint', '--node-base-image', '--maven-base-image']
        : action === 'compatibility'
          ? ['--workspace', '--contract', '--node-base-image', '--maven-base-image']
          : ['--workspace', '--contract', '--fingerprint']);
  const optional = new Set();
  const allowed = new Set([...required, ...optional]);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.length === 0 || values[key] !== undefined) {
      throw new Error('Verification cache arguments are invalid.');
    }
    values[key] = value;
  }
  if ([...required].some((key) => values[key] === undefined)) {
    throw new Error('Verification cache arguments are incomplete.');
  }
  return { action, values };
}

async function loadContract(contractFile) {
  if (!path.isAbsolute(contractFile)) throw new Error('Verification contract path must be absolute.');
  return validateVerificationContract(JSON.parse(await readFile(contractFile, 'utf8')));
}

async function inventoryCache(root, limits) {
  if (!path.isAbsolute(root)) throw new Error('Verification cache staging path must be absolute.');
  const files = [];
  let totalBytes = 0;
  async function visit(relative) {
    const absolute = path.join(root, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === 'manifest.json') continue;
      if (entry.isSymbolicLink()) throw new Error('Verification cache staging contains a symbolic link.');
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        if (!child.startsWith('m2/repository/') && !child.startsWith('pnpm/store/')) {
          throw new Error(`Verification cache staging contains an unsupported path: ${child}`);
        }
        const metadata = await lstat(path.join(root, child));
        if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new Error('Verification cache staging contains a linked or non-regular file.');
        }
        totalBytes += metadata.size;
        if (files.length + 1 > limits.maxFiles || totalBytes > limits.maxBytes) {
          throw new Error('Verification cache staging exceeds the reviewed contract limits.');
        }
        const content = await readFile(path.join(root, child));
        files.push({
          path: child.replaceAll('\\', '/'),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          bytes: content.length,
        });
      } else throw new Error('Verification cache staging contains an unsupported node.');
    }
  }
  await visit('');
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (files.length === 0) throw new Error('Verification cache staging is empty.');
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    digest.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\0');
  }
  return { files, packDigest: digest.digest('hex'), totalBytes };
}

function normalizedCommandOutput(command, args) {
  // The production tool executes in Linux. The suffix only makes the same
  // fail-closed probe testable through ordinary Windows command shims.
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Verification cache toolchain probe failed for ${command}: ${String(result.stderr ?? result.error?.message ?? '').slice(0, 500)}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll('\r\n', '\n').trim();
}

function probedVersion(command, args, pattern) {
  const output = normalizedCommandOutput(command, args);
  const line = output.split('\n').map((entry) => entry.trim()).find((entry) => pattern.test(entry));
  if (line === undefined) throw new Error(`Verification cache toolchain probe returned no stable version line for ${command}.`);
  return line;
}

export async function readCacheCompatibilityImplementation() {
  const files = [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./verification-runner.mjs', import.meta.url)),
    fileURLToPath(new URL('./verify-policy.mjs', import.meta.url)),
    fileURLToPath(new URL('./maven-verification-policy.mjs', import.meta.url)),
    fileURLToPath(new URL('./maven-verification-settings.xml', import.meta.url)),
    fileURLToPath(new URL('./maven-verification-exec.sh', import.meta.url)),
  ];
  const implementation = [];
  for (const file of files) {
    const bytes = await readFile(file);
    implementation.push({
      path: path.basename(file),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  return implementation;
}

async function compatibilityDescriptor(source, values) {
  const nodeBaseImage = values['--node-base-image'];
  const mavenBaseImage = values['--maven-base-image'];
  if (!TOOLCHAIN_IMAGE_PATTERN.test(nodeBaseImage ?? '') || !TOOLCHAIN_IMAGE_PATTERN.test(mavenBaseImage ?? '')) {
    throw new Error('Cache compatibility requires immutable Node and Maven base-image manifests.');
  }
  const implementation = await readCacheCompatibilityImplementation();
  const mavenAcquisitionPolicy = await readMavenVerificationPolicy();
  const imageRuntime = fileURLToPath(import.meta.url) === IMAGE_CACHE_TOOL_PATH;
  const descriptor = {
    schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
    cacheManifestSchemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    dependencyManifestFingerprint: source.dependencyManifestFingerprint,
    implementation,
    executorToolchainImages: { node: nodeBaseImage, maven: mavenBaseImage },
    mavenAcquisitionPolicy: mavenAcquisitionPolicy.descriptor,
    mavenAcquisitionPolicyDigest: mavenAcquisitionPolicy.digest,
    warmCommands: WARM_COMMANDS,
    producerTopology: PRODUCER_TOPOLOGY,
    packageManagerVersions: {
      node: process.version,
      corepack: probedVersion('corepack', ['--version'], /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/u),
      pnpm: probedVersion('pnpm', ['--version'], /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/u),
      maven: imageRuntime
        ? probedVersion(MAVEN_VERIFICATION_EXEC_PATH, ['mvn', '--version'], /^Apache Maven [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?(?: \([0-9a-f]+\))?$/u)
        : probedVersion('mvn', ['--version'], /^Apache Maven [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?(?: \([0-9a-f]+\))?$/u),
      java: probedVersion('java', ['-version'], /^(?:openjdk|java) version "[0-9][A-Za-z0-9._+-]*"(?: [0-9-]+)?$/u),
    },
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(descriptor), 'utf8').digest('hex');
  return { descriptor, digest };
}

async function inventoryPromotablePack(root, limits) {
  if (!path.isAbsolute(root)) throw new Error('Verification cache source pack path must be absolute.');
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o222) !== 0) {
    throw new Error('Verification cache source pack must be one read-only ordinary directory.');
  }
  const manifestFile = path.join(root, 'manifest.json');
  const manifestMetadata = await lstat(manifestFile);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.nlink !== 1
    || (manifestMetadata.mode & 0o222) !== 0) {
    throw new Error('Verification cache source manifest must be one read-only ordinary file.');
  }
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const files = [];
  let totalBytes = 0;
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const directory = await lstat(absolute);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o222) !== 0) {
      throw new Error('Verification cache source pack contains a writable or non-ordinary directory.');
    }
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === 'manifest.json') continue;
      const childAbsolute = path.join(root, child);
      const metadata = await lstat(childAbsolute);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) throw new Error('Verification cache source pack contains a symbolic link.');
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        if (!child.startsWith('m2/repository/') && !child.startsWith('pnpm/store/')) {
          throw new Error(`Verification cache source pack contains an unsupported path: ${child}`);
        }
        if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o222) !== 0) {
          throw new Error('Verification cache source pack contains a writable, linked, or non-regular file.');
        }
        const bytes = await readFile(childAbsolute);
        totalBytes += bytes.length;
        if (files.length + 1 > limits.maxFiles || totalBytes > limits.maxBytes) {
          throw new Error('Verification cache source pack exceeds the reviewed contract limits.');
        }
        files.push({ path: child.replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      } else throw new Error('Verification cache source pack contains an unsupported node.');
    }
  }
  await visit('');
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const packHash = crypto.createHash('sha256');
  for (const file of files) packHash.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\0');
  return { manifest, files, packDigest: packHash.digest('hex'), totalBytes };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function main() {
  const { action, values } = parseArgs(process.argv.slice(2));
  const contract = await loadContract(values['--contract']);
  if (!IMMUTABLE_IMAGE_PATTERN.test(contract.toolchainImage)) {
    throw new Error('Verification cache contract toolchain image must use one immutable image identifier.');
  }
  if (action === 'verify') {
    const workspace = values['--workspace'];
    if (!path.isAbsolute(workspace)) throw new Error('Verification workspace path must be absolute.');
    const source = await inventoryWorkspace(workspace, contract.limits);
    if (source.dependencyManifestFingerprint !== values['--fingerprint']) {
      throw new Error('Current dependency manifests do not match the requested verification cache fingerprint.');
    }
    const result = await verifyCachePack(
      contract.cacheRoot,
      source.dependencyManifestFingerprint,
      contract,
      source.dependencyManifestFiles,
    );
    if (result.outcome !== 'ready') throw new Error(`Verification cache is not ready: ${result.reasonCode}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const workspace = values['--workspace'];
  if (!path.isAbsolute(workspace)) throw new Error('Verification workspace path must be absolute.');
  const source = await inventoryWorkspace(workspace, contract.limits);
  if (action === 'compatibility') {
    const compatibility = await compatibilityDescriptor(source, values);
    process.stdout.write(`${JSON.stringify({
      cacheCompatibilityDigest: compatibility.digest,
      cacheCompatibility: compatibility.descriptor,
    })}\n`);
    return;
  }
  if (action === 'fingerprint') {
    const mavenAcquisitionPolicy = await readMavenVerificationPolicy();
    process.stdout.write(`${JSON.stringify({
      sourceHead: source.head,
      workspaceFingerprint: source.workspaceFingerprint,
      dependencyManifestFingerprint: source.dependencyManifestFingerprint,
      dependencyManifestFiles: source.dependencyManifestFiles,
      mavenAcquisitionPolicy: mavenAcquisitionPolicy.descriptor,
      mavenAcquisitionPolicyDigest: mavenAcquisitionPolicy.digest,
    })}\n`);
    return;
  }
  const expected = values['--fingerprint'];
  if (!/^[0-9a-f]{64}$/u.test(expected) || source.dependencyManifestFingerprint !== expected) {
    throw new Error('Dependency manifests changed while the verification cache was being prepared.');
  }
  if (action === 'promote') {
    const sourcePack = values['--source-pack'];
    const staging = values['--staging'];
    if (!path.isAbsolute(sourcePack) || path.basename(path.resolve(sourcePack)) !== expected
      || !path.isAbsolute(staging) || path.resolve(sourcePack) === path.resolve(staging)) {
      throw new Error('Verification cache promotion paths are invalid.');
    }
    const promoted = await inventoryPromotablePack(sourcePack, contract.limits);
    const compatibility = await compatibilityDescriptor(source, values);
    const acquisition = { maven: compatibility.descriptor.mavenAcquisitionPolicy };
    const manifest = promoted.manifest;
    const mismatch = !manifest || manifest.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION || manifest.complete !== true
      ? 'SCHEMA'
      : manifest.projectSlug !== contract.projectSlug ? 'PROJECT'
      : manifest.dependencyManifestFingerprint !== expected ? 'DEPENDENCY_FINGERPRINT'
          : manifest.packDigest !== promoted.packDigest ? 'PACK_DIGEST'
            : manifest.cacheCompatibilityDigest !== compatibility.digest ? 'COMPATIBILITY_DIGEST'
            : !sameJson(manifest.cacheCompatibility, compatibility.descriptor) ? 'COMPATIBILITY_DESCRIPTOR'
              : !sameJson(manifest.acquisition, acquisition) ? 'ACQUISITION_POLICY'
                : !sameJson(manifest.dependencyManifestFiles, source.dependencyManifestFiles) ? 'DEPENDENCY_INVENTORY'
                  : !sameJson(manifest.files, promoted.files) ? 'PACK_INVENTORY'
                    : undefined;
    if (mismatch !== undefined) {
      throw new Error(`Verification cache source pack is not compatible with the current immutable toolchain contract: ${mismatch}`);
    }
    for (const file of promoted.files) {
      const target = path.join(staging, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(path.join(sourcePack, file.path), target, 1);
    }
    await atomicJson(path.join(staging, 'manifest.json'), {
      ...manifest,
      toolchainImage: contract.toolchainImage,
      runnerRevision: contract.runnerRevision,
      promotedFromToolchainImage: manifest.toolchainImage,
    });
    process.stdout.write(`${JSON.stringify({
      dependencyManifestFingerprint: expected,
      cacheCompatibilityDigest: compatibility.digest,
      packDigest: promoted.packDigest,
      files: promoted.files.length,
      bytes: promoted.totalBytes,
    })}\n`);
    return;
  }
  const staging = values['--staging'];
  const inventory = await inventoryCache(staging, contract.limits);
  const mavenAcquisitionPolicy = await readMavenVerificationPolicy();
  const compatibility = values['--node-base-image'] === undefined
    ? undefined
    : await compatibilityDescriptor(source, values);
  await atomicJson(path.join(staging, 'manifest.json'), {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    complete: true,
    projectSlug: contract.projectSlug,
    dependencyManifestFingerprint: expected,
    dependencyManifestFiles: source.dependencyManifestFiles,
    toolchainImage: contract.toolchainImage,
    runnerRevision: contract.runnerRevision,
    acquisition: { maven: mavenAcquisitionPolicy.descriptor },
    ...(compatibility === undefined ? {} : {
      cacheCompatibilityDigest: compatibility.digest,
      cacheCompatibility: compatibility.descriptor,
    }),
    packDigest: inventory.packDigest,
    files: inventory.files,
  });
  process.stdout.write(`${JSON.stringify({
    dependencyManifestFingerprint: expected,
    packDigest: inventory.packDigest,
    files: inventory.files.length,
    bytes: inventory.totalBytes,
  })}\n`);
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
