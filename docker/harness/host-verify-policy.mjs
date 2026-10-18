import crypto from 'node:crypto';
import { validateVerificationInputScopes } from './verification-inputs.mjs';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCE_QUALITY_PROFILE, sourceQualitySelectors } from './forge-backend-source-quality.mjs';

import { VERIFY_PROFILE_NAMES, FRONTEND_LINT_EMPTY_SCRIPT, FRONTEND_LINT_FORMAT_ARGS, MAVEN_TEST_PROFILE_ARG, frontendLintBatches, frontendTestScopeFilters, governanceTaskScopeArguments, governanceRoleGrantArguments, governanceSourceProvenanceArguments, governanceAcceptedApiContractArguments } from './verify-policy.mjs';

import { H5_TEST_FILE_PATTERN } from './forge-task-execution-contract.mjs';
import { frontendTypecheckArguments } from './verify-policy.mjs';

export const HOST_FRONTEND_TYPECHECK_PATH = fileURLToPath(new URL('./frontend-typecheck.mjs', import.meta.url));
export const HOST_BACKEND_SOURCE_QUALITY_PATH = fileURLToPath(new URL('./forge-backend-source-quality-runner.mjs', import.meta.url));

const PROFILE_CATALOG_PATTERN = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+(?:-[a-z0-9.-]+)?$/u;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MODULE_PATTERN = /^forge-server\/[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const TEST_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.]{0,199}(?:#[A-Za-z_$][A-Za-z0-9_$]{0,99})?$/u;
const FRONTEND_TEST_FILE_PATTERN = /^forge-admin-ui\/(?:src|tests?)\/[A-Za-z0-9_./@+-]+(?:\.spec|\.test)\.(?:js|jsx|ts|tsx)$/u;
const FRONTEND_SOURCE_FILE_PATTERN = /^forge-admin-ui\/src\/[A-Za-z0-9_./@+-]+\.(?:js|jsx|ts|tsx|vue)$/u;
const HOST_POLICY_REVISION = 'forge-host-verify-policy/v7';

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function selectedModules(selectors, exactTest) {
  exactKeys(selectors, exactTest ? ['modules', 'tests'] : ['modules'], 'host verify selectors');
  if (!Array.isArray(selectors.modules) || selectors.modules.length < 1 || selectors.modules.length > 16
    || selectors.modules.some((value) => typeof value !== 'string' || !MODULE_PATTERN.test(value))) {
    throw new Error('host verify modules are invalid.');
  }
  const modules = selectors.modules.map((value) => value.replace(/^forge-server\//u, ''));
  if (!exactTest) return { modules };
  if (!Array.isArray(selectors.tests) || selectors.tests.length < 1 || selectors.tests.length > 32
    || selectors.tests.some((value) => typeof value !== 'string' || !TEST_PATTERN.test(value))) {
    throw new Error('host verify tests are invalid.');
  }
  return { modules, tests: [...selectors.tests] };
}

function selectedFrontendFiles(selectors, key, pattern, maximum) {
  if (Object.keys(selectors).length === 0) return {};
  exactKeys(selectors, [key], 'host verify selectors');
  const values = selectors[key];
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum
    || new Set(values).size !== values.length
    || values.some((value) => typeof value !== 'string' || !pattern.test(value)
      || value.split('/').some((segment) => segment === '.' || segment === '..'))) {
    throw new Error(`host verify ${key} are invalid.`);
  }
  return { [key]: [...values] };
}

function selectorsFor(profile, selectors = {}) {
  if (profile === SOURCE_QUALITY_PROFILE) return sourceQualitySelectors(selectors);
  if (['backend-red-test', 'backend-test-class'].includes(profile)) return selectedModules(selectors, true);
  if (['backend-module-compile', 'backend-module-test'].includes(profile)) return selectedModules(selectors, false);
  if (profile === 'frontend-red-test') {
    exactKeys(selectors, ['testFiles'], 'host verify selectors');
    if (!Array.isArray(selectors.testFiles) || selectors.testFiles.length !== 1
      || typeof selectors.testFiles[0] !== 'string' || !FRONTEND_TEST_FILE_PATTERN.test(selectors.testFiles[0])) {
      throw new Error('host verify frontend test file is invalid.');
    }
    return { testFiles: [...selectors.testFiles] };
  }
  if (profile === 'frontend-admin-lint') {
    return selectedFrontendFiles(selectors, 'files', FRONTEND_SOURCE_FILE_PATTERN, 32);
  }
  if (profile === 'frontend-h5-test') {
    if (!Object.hasOwn(selectors, 'testFiles')) throw new Error('host H5 tests require explicit testFiles.');
    return selectedFrontendFiles(selectors, 'testFiles', H5_TEST_FILE_PATTERN, 32);
  }
  if (profile === 'frontend-admin-test') {
    return selectedFrontendFiles(selectors, 'testFiles', FRONTEND_TEST_FILE_PATTERN, 32);
  }
  exactKeys(selectors, [], 'host verify selectors');
  return {};
}

export function validateHostVerificationContract(value, expectedProjectSlug) {
  exactKeys(value, [
    'schemaVersion', 'executionMode', 'projectSlug', 'runnerRevision', 'profileCatalogVersion',
    'taskspacesRoot', 'stateRoot', 'toolchains', 'profiles', 'limits', 'processIsolation', 'independentReview', 'dependencySeed', 'preparedDependencies', 'testDatabase',
    'inputScopes',
  ], 'host verification contract');
  if (value.schemaVersion !== 2 || value.executionMode !== 'host-toolchain') {
    throw new Error('Unsupported host verification contract schema or execution mode.');
  }
  if (typeof value.projectSlug !== 'string' || !PROJECT_PATTERN.test(value.projectSlug)) {
    throw new Error('host verification projectSlug is invalid.');
  }
  if (expectedProjectSlug !== undefined && value.projectSlug !== expectedProjectSlug) {
    throw new Error('host verification contract project does not match the runner.');
  }
  if (typeof value.runnerRevision !== 'string' || !REVISION_PATTERN.test(value.runnerRevision)) {
    throw new Error('host verification runnerRevision is invalid.');
  }
  if (typeof value.profileCatalogVersion !== 'string' || !PROFILE_CATALOG_PATTERN.test(value.profileCatalogVersion)) {
    throw new Error('host verification profileCatalogVersion is invalid.');
  }
  exactKeys(value.toolchains, ['java', 'javaHome', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance'], 'host verification toolchains');
  const toolchains = Object.fromEntries(Object.entries(value.toolchains).map(([name, executable]) => [
    name, absolutePath(executable, `host verification toolchain ${name}`),
  ]));
  if (!Array.isArray(value.profiles) || value.profiles.length !== VERIFY_PROFILE_NAMES.length
    || value.profiles.some((name, index) => name !== VERIFY_PROFILE_NAMES[index])) {
    throw new Error('host verification profiles must equal the reviewed ordered profile catalog.');
  }
  exactKeys(value.limits, ['maxFiles', 'maxBytes', 'maxLogBytes', 'defaultTimeoutSeconds', 'maxConcurrent'], 'host verification limits');
  if (value.processIsolation !== undefined && value.processIsolation !== 'bubblewrap') {
    throw new Error('host verification processIsolation must be bubblewrap when configured.');
  }
  if (value.independentReview !== undefined
    && (value.independentReview !== 'api-error-and-auth-contract' || value.processIsolation !== 'bubblewrap')) {
    throw new Error('Independent review requires the supported scope and bubblewrap process isolation.');
  }
  let dependencySeed;
  if (value.dependencySeed != null) {
    exactKeys(value.dependencySeed, ['root', 'manifestSha256'], 'host dependency seed');
    const root = absolutePath(value.dependencySeed.root, 'host dependency seed root');
    if (!/^[0-9a-f]{64}$/u.test(value.dependencySeed.manifestSha256 ?? '')) {
      throw new Error('Host dependency seed manifest digest is invalid.');
    }
    for (const forbidden of [value.taskspacesRoot, path.join(value.stateRoot, 'taskspaces')]) {
      const relative = path.relative(absolutePath(forbidden, 'host taskspace root'), root);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('Host dependency seed must be outside writable taskspaces.');
      }
    }
    dependencySeed = { root, manifestSha256: value.dependencySeed.manifestSha256 };
  }
  let preparedDependencies;
  if (value.preparedDependencies != null) {
    exactKeys(value.preparedDependencies, ['root', 'manifestSha256'], 'host prepared dependencies');
    const root = absolutePath(value.preparedDependencies.root, 'host prepared dependencies root');
    if (value.processIsolation !== 'bubblewrap' || !/^[0-9a-f]{64}$/u.test(value.preparedDependencies.manifestSha256 ?? '')) {
      throw new Error('Host prepared dependencies require bubblewrap and a manifest digest.');
    }
    for (const forbidden of [value.taskspacesRoot, value.stateRoot]) {
      const relative = path.relative(absolutePath(forbidden, 'host writable root'), root);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('Host prepared dependencies must be outside writable taskspaces and state.');
      }
    }
    preparedDependencies = { root, manifestSha256: value.preparedDependencies.manifestSha256 };
  }
  let testDatabase;
  if (value.testDatabase !== undefined) {
    const binding = value.testDatabase;
    exactKeys(binding, ['taskId', 'port', 'database', 'username', 'passwordFile'], 'host test database');
    const projectPrefix = value.projectSlug.replaceAll('-', '_') + '_';
    if (value.processIsolation !== 'bubblewrap'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u.test(binding.taskId ?? '')
      || !/^[a-z][a-z0-9_]{0,58}_test$/u.test(binding.database ?? '')
      || !binding.database.startsWith(projectPrefix)
      || !/^[a-z][a-z0-9_]{0,31}$/u.test(binding.username ?? '')
      || !binding.username.startsWith(projectPrefix)) {
      throw new Error('Host test database requires bubblewrap, a fixed task and project-owned test database/account.');
    }
    const passwordFile = absolutePath(binding.passwordFile, 'host test database password file');
    for (const root of [value.taskspacesRoot, value.stateRoot]) {
      const relative = path.relative(absolutePath(root, 'host writable root'), passwordFile);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('Host test database password file must be outside writable taskspaces and state.');
      }
    }
    testDatabase = { taskId: binding.taskId,
      port: boundedInteger(binding.port, 1024, 65535, 'host test database loopback port'),
      database: binding.database, username: binding.username, passwordFile };
  }
  return {
    schemaVersion: 2,
    executionMode: 'host-toolchain',
    projectSlug: value.projectSlug,
    runnerRevision: value.runnerRevision,
    profileCatalogVersion: value.profileCatalogVersion,
    taskspacesRoot: absolutePath(value.taskspacesRoot, 'host verification taskspacesRoot'),
    stateRoot: absolutePath(value.stateRoot, 'host verification stateRoot'),
    toolchains,
    ...(value.processIsolation === undefined ? {} : { processIsolation: value.processIsolation }),
    ...(value.independentReview === undefined ? {} : { independentReview: value.independentReview }),
    ...(dependencySeed === undefined ? {} : { dependencySeed }),
    ...(preparedDependencies === undefined ? {} : { preparedDependencies }),
    ...(testDatabase === undefined ? {} : { testDatabase }),
    profiles: [...value.profiles],
    ...(value.inputScopes === undefined ? {} : { inputScopes: validateVerificationInputScopes(value.inputScopes, value.profiles) }),
    limits: {
      maxFiles: boundedInteger(value.limits.maxFiles, 1, 250_000, 'host verification maxFiles'),
      maxBytes: boundedInteger(value.limits.maxBytes, 1, 4 * 1024 * 1024 * 1024, 'host verification maxBytes'),
      maxLogBytes: boundedInteger(value.limits.maxLogBytes, 1024, 16 * 1024 * 1024, 'host verification maxLogBytes'),
      defaultTimeoutSeconds: boundedInteger(value.limits.defaultTimeoutSeconds, 30, 1800, 'host verification defaultTimeoutSeconds'),
      maxConcurrent: boundedInteger(value.limits.maxConcurrent, 1, 8, 'host verification maxConcurrent'),
    },
  };
}

export function hostProfilePolicyDescriptor(contract) {
  return {
    policyRevision: HOST_POLICY_REVISION,
    profileCatalogVersion: contract.profileCatalogVersion,
    profiles: contract.profiles,
    ...(contract.processIsolation === 'bubblewrap' ? { processIsolation: 'bubblewrap/v1' } : {}),
    ...(contract.preparedDependencies ? { preparedDependencies: contract.preparedDependencies.manifestSha256 } : {}),
    ...(contract.processIsolation === 'bubblewrap' && contract.dependencySeed ? { dependencySeed: contract.dependencySeed.manifestSha256 } : {}),
    ...(contract.testDatabase ? { testDatabase: { taskId: contract.testDatabase.taskId,
      port: contract.testDatabase.port, database: contract.testDatabase.database, username: contract.testDatabase.username } } : {}),
  };
}

export function hostProfilePolicyDigest(contract) {
  return crypto.createHash('sha256').update(JSON.stringify(hostProfilePolicyDescriptor(contract)), 'utf8').digest('hex');
}

export function validateH5ProfilePolicyTransition(descriptor, previousDigest, currentDigest, profile) {
  const allowed = ['policyRevision', 'profileCatalogVersion', 'profiles', 'processIsolation', 'preparedDependencies', 'dependencySeed'];
  exactKeys(descriptor, allowed, 'H5 profile addition');
  if (profile === 'frontend-h5-test' || !VERIFY_PROFILE_NAMES.includes(profile)
    || descriptor.policyRevision !== 'forge-host-verify-policy/v7'
    || !PROFILE_CATALOG_PATTERN.test(descriptor.profileCatalogVersion ?? '')
    || JSON.stringify(descriptor.profiles) !== JSON.stringify(VERIFY_PROFILE_NAMES)
    || (descriptor.processIsolation !== undefined && descriptor.processIsolation !== 'bubblewrap/v1')
    || ['preparedDependencies', 'dependencySeed'].some(key => descriptor[key] !== undefined && !/^[0-9a-f]{64}$/u.test(descriptor[key]))) {
    throw new Error('Invalid H5-only profile policy addition.');
  }
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const previous = { ...descriptor, profiles: descriptor.profiles.filter(name => name !== 'frontend-h5-test') };
  if (digest(descriptor) !== currentDigest || digest(previous) !== previousDigest || previousDigest === currentDigest) {
    throw new Error('H5 profile addition does not bind the exact prior and current policy.');
  }
  return descriptor;
}

export function validateHostProfilePolicyTransition(value, previousDigest, currentDigest, profile, projectSlug) {
  if (!Object.hasOwn(value, 'dependencySeedTransition')) {
    return validateH5ProfilePolicyTransition(value, previousDigest, currentDigest, profile);
  }
  const { dependencySeedTransition: proof, ...descriptor } = value;
  exactKeys(descriptor, ['policyRevision', 'profileCatalogVersion', 'profiles', 'processIsolation',
    'preparedDependencies', 'dependencySeed'], 'Dependency seed policy');
  exactKeys(proof, ['kind', 'projectSlug', 'previousManifestSha256', 'metadataSha256',
    'previousPackDigest', 'currentPackDigest', 'retainedFileCount', 'addedFiles'], 'Dependency seed transition');
  const sha256 = /^[0-9a-f]{64}$/u;
  if (!['backend-test-class', 'backend-module-test'].includes(profile)
      || descriptor.policyRevision !== 'forge-host-verify-policy/v7'
      || !PROFILE_CATALOG_PATTERN.test(descriptor.profileCatalogVersion ?? '')
      || JSON.stringify(descriptor.profiles) !== JSON.stringify(VERIFY_PROFILE_NAMES)
      || descriptor.processIsolation !== 'bubblewrap/v1'
      || !sha256.test(descriptor.dependencySeed ?? '')
      || (descriptor.preparedDependencies !== undefined && !sha256.test(descriptor.preparedDependencies))
      || proof.kind !== 'dependency-seed-append-only/v1' || proof.projectSlug !== projectSlug
      || !PROJECT_PATTERN.test(projectSlug ?? '')
      || ['previousManifestSha256', 'metadataSha256', 'previousPackDigest', 'currentPackDigest'].some(key => !sha256.test(proof[key] ?? ''))
      || proof.previousManifestSha256 === descriptor.dependencySeed || proof.previousPackDigest === proof.currentPackDigest
      || !Number.isSafeInteger(proof.retainedFileCount) || proof.retainedFileCount < 1
      || !Array.isArray(proof.addedFiles) || proof.addedFiles.length < 1 || proof.addedFiles.length > 1024) {
    throw new Error('Invalid append-only dependency seed transition.');
  }
  let previousPath = '';
  for (const file of proof.addedFiles) {
    exactKeys(file, ['path', 'bytes', 'sha256'], 'Appended dependency seed file');
    if (typeof file.path !== 'string' || !file.path.startsWith('m2/repository/')
        || /[\\:\x00-\x1f]/u.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..')
        || file.path <= previousPath || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !sha256.test(file.sha256 ?? '')) {
      throw new Error('Invalid appended Maven cache file.');
    }
    previousPath = file.path;
  }
  const digest = object => crypto.createHash('sha256').update(JSON.stringify(object)).digest('hex');
  if (digest(descriptor) !== currentDigest
      || digest({ ...descriptor, dependencySeed: proof.previousManifestSha256 }) !== previousDigest) {
    throw new Error('Dependency seed transition does not bind the exact prior and current policy.');
  }
  // The authenticated Host compares immutable complete manifests. Consumers
  // bind that attestation to both exact policies and retain all receipt checks.
  return value;
}

// The Runner resolves and probes these tools from its protected contract. Mount
// their installation directories, without imposing an older deployment layout.
export function hostSandboxReadOnlyRoots(toolchains, contract = {}) {
  const roots = new Set();
  const within = (value, root) => value === root || value.startsWith(`${root}/`);
  const projectsRoot = '/srv/forge-delivery/projects';
  const projectRoot = `${projectsRoot}/${contract.projectSlug}`;
  const privateRoots = ['/etc', '/run', '/root', '/home', '/srv/forge-delivery/secrets',
    `${projectRoot}/ops`, contract.taskspacesRoot, contract.stateRoot].filter(Boolean);
  for (const [name, executable] of Object.entries(toolchains)) {
    if (typeof executable !== 'string' || !path.posix.isAbsolute(executable)
      || executable.includes('\0') || path.posix.normalize(executable) !== executable) {
      throw new Error('Host sandbox tool paths must be absolute and normalized.');
    }
    if (executable.startsWith('/usr/')) continue;
    const directory = name === 'javaHome' ? executable : path.posix.dirname(executable);
    const root = name !== 'javaHome' && ['bin', 'sbin'].includes(path.posix.basename(directory))
      ? path.posix.dirname(directory) : directory;
    if (root === '/' || within(projectsRoot, root)
      || (within(root, projectsRoot) && (!PROJECT_PATTERN.test(contract.projectSlug ?? '')
        || !within(root, projectRoot) || root === projectRoot))
      || privateRoots.some((privateRoot) => within(root, privateRoot) || within(privateRoot, root))) {
      throw new Error('Host sandbox tool installation root exceeds the protected project or credential scope.');
    }
    roots.add(root);
  }
  return [...roots].sort();
}

export function hostSandboxCommand(step, paths, toolchains, readOnlyDependencies = [], contract = {}) {
  const jobRoot = path.posix.normalize(paths.jobRoot);
  const cacheRoot = path.posix.normalize(paths.cacheRoot);
  if (!/^\/.*\/taskspaces\/[a-zA-Z0-9-]+\/jobs\/[a-zA-Z0-9-]+$/u.test(jobRoot)
    || cacheRoot !== `${path.posix.dirname(path.posix.dirname(jobRoot))}/cache`
    || !step.cwd.startsWith(`${jobRoot}/workspace`)
    || (step.cwd !== `${jobRoot}/workspace` && !step.cwd.startsWith(`${jobRoot}/workspace/`))
    || !Object.values(toolchains).includes(step.executable)) {
    throw new Error('Host sandbox job, cache or command scope is invalid.');
  }
  const argv = [
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--disable-userns', '--assert-userns-disabled', '--cap-drop', 'ALL',
    '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ];
  // These are system runtime inputs, never a whole /etc or /run mount. The
  // optional paths accommodate hosts without a particular distro layout.
  for (const file of ['/etc/ld.so.cache', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf',
    '/etc/ssl/certs', '/etc/java-17-openjdk', '/etc/maven/m2.conf', '/etc/maven/logging']) {
    argv.push('--ro-bind-try', file, file);
  }
  for (const root of hostSandboxReadOnlyRoots(toolchains, contract)) argv.push('--ro-bind', root, root);
  // The running Host bundle may differ from a toolchain's pinned bundle (for
  // example forgeGovernance). Expose only this fixed scanner's runtime inputs.
  if (step.executable === toolchains.node && step.argv[0] === HOST_BACKEND_SOURCE_QUALITY_PATH) {
    for (const input of [HOST_BACKEND_SOURCE_QUALITY_PATH,
      fileURLToPath(new URL('./forge-backend-source-quality.mjs', import.meta.url)),
      fileURLToPath(new URL('./backend-source-quality', import.meta.url))]) {
      argv.push('--ro-bind', input, input);
    }
  }
  argv.push('--bind', jobRoot, jobRoot, '--bind', cacheRoot, cacheRoot);
  if (step.registryOnlyInstall) {
    if (step.executable !== toolchains.pnpm || step.argv[0] !== '--dir' || step.argv[2] !== 'install'
      || !step.argv.includes('--frozen-lockfile') || !step.argv.includes('--ignore-scripts')) throw new Error('Fresh registry store is only valid for the fixed pnpm installer.');
    const fresh = `${jobRoot}/tmp/registry-cache/pnpm/store`;
    const info = lstatSync(fresh);
    if (!info.isDirectory() || realpathSync(fresh) !== fresh
      || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o022)))) throw new Error('Fresh registry store is outside the protected job.');
    argv.push('--bind', fresh, `${cacheRoot}/pnpm/store`);
  }
  const projects = new Set();
  for (const dependency of readOnlyDependencies) {
    const { project, root } = dependency;
    if (project === 'm2') {
      if (projects.has(project) || !contract.dependencySeed
        || root !== `${contract.dependencySeed.root}/m2/repository`) throw new Error('Maven dependency mount escaped its protected binding.');
      projects.add(project);
      argv.push('--ro-bind', root, `${cacheRoot}/m2/repository`);
      continue;
    }
    const expectedParent = `${path.posix.dirname(cacheRoot)}/prepared-dependencies/${project}`;
    const shared = contract.preparedDependencies && root === `${contract.preparedDependencies.root}/${project}/node_modules`;
    const hostParent = contract.stateRoot && `${path.posix.normalize(contract.stateRoot)}/prepared-dependencies/${project}`;
    const hostShared = typeof root === 'string' && hostParent
      && path.posix.dirname(path.posix.dirname(root)) === hostParent
      && /^[0-9a-f]{64}$/u.test(path.posix.basename(path.posix.dirname(root))) && path.posix.basename(root) === 'node_modules'
      && path.posix.dirname(path.posix.dirname(path.posix.dirname(path.posix.dirname(jobRoot)))) === path.posix.normalize(contract.stateRoot);
    if (hostShared) {
      for (const directory of [contract.stateRoot, path.posix.dirname(hostParent), hostParent, path.posix.dirname(root), root]) {
        const info = lstatSync(directory);
        if (!info.isDirectory() || realpathSync(directory) !== directory
          || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o022)))) {
          throw new Error('Shared frontend dependencies escaped Host-owned state.');
        }
      }
    }
    const taskBound = typeof root === 'string' && path.posix.dirname(path.posix.dirname(root)) === expectedParent
      && /^[0-9a-f]{64}$/u.test(path.posix.basename(path.posix.dirname(root))) && path.posix.basename(root) === 'node_modules';
    if (!['forge-admin-ui', 'forge-h5-ui'].includes(project) || projects.has(project) || (!shared && !taskBound && !hostShared)) {
      throw new Error('Prepared frontend dependencies escaped the protected task cache.');
    }
    projects.add(project);
    const target = `${jobRoot}/workspace/${project}/node_modules`;
    argv.push('--ro-bind', root, target);
    for (const name of ['.vite', '.vite-temp', '.cache']) argv.push('--tmpfs', `${target}/${name}`);
  }
  argv.push('--chdir', step.cwd, '--', step.executable, ...step.argv);
  return { executable: '/usr/bin/bwrap', argv, cwd: step.cwd };
}

function mavenStep(paths, toolchains, args) {
  return {
    cwd: path.join(paths.snapshotRoot, 'forge-server'),
    executable: toolchains.maven,
    argv: [
      '--strict-checksums', '--settings', paths.mavenSettings,
      `-Dmaven.repo.local=${path.join(paths.cacheRoot, 'm2', 'repository')}`,
      MAVEN_TEST_PROFILE_ARG, '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false',
      ...args,
    ],
  };
}

function pnpmInstall(paths, toolchains, project) {
  return {
    cwd: paths.snapshotRoot,
    executable: toolchains.pnpm,
    argv: [
      '--dir', path.join(paths.snapshotRoot, project), 'install', '--frozen-lockfile', '--ignore-scripts',
      '--store-dir', path.join(paths.cacheRoot, 'pnpm', 'store'),
    ],
  };
}

export function hostVerificationCommand(profile, selectors, sourceHead, paths, toolchains, reviewBase, lintFiles, testFilters, governanceTaskScope, roleGrantPolicy, sourceProvenancePolicy, acceptedApiContract, typecheckFiles) {
  if ((!VERIFY_PROFILE_NAMES.includes(profile) && profile !== SOURCE_QUALITY_PROFILE) || !/^[0-9a-f]{40}$/u.test(sourceHead)) {
    throw new Error('host verification profile or source head is invalid.');
  }
  for (const [name, value] of Object.entries(paths)) absolutePath(value, `host verification path ${name}`);
  for (const [name, value] of Object.entries(toolchains)) absolutePath(value, `host verification toolchain ${name}`);
  const normalized = selectorsFor(profile, selectors);
  const modules = normalized.modules?.join(',');
  switch (profile) {
    case SOURCE_QUALITY_PROFILE: {
      if (!normalized.files && !/^[0-9a-f]{40}$/u.test(reviewBase ?? '')) {
        throw new Error('Source quality requires the protected review base or exact Java files.');
      }
      return { steps: [{ cwd: paths.snapshotRoot, executable: toolchains.node, argv: [
        HOST_BACKEND_SOURCE_QUALITY_PATH, '--root', paths.snapshotRoot,
        '--output', path.join(paths.outputRoot, SOURCE_QUALITY_PROFILE),
        ...(normalized.files ? normalized.files.flatMap(file => ['--file', file]) : ['--base', reviewBase]),
      ] }] };
    }
    case 'governance':
    case 'changed-safe': {
      if (!/^[0-9a-f]{40}$/u.test(reviewBase ?? '')) {
        throw new Error('host governance review base is invalid.');
      }
      const argv = ['audit', '--base', reviewBase];
      if (profile === 'governance' && reviewBase === sourceHead) argv.push('--expected-no-change-head', sourceHead);
      if (profile === 'governance') argv.push(...governanceTaskScopeArguments(governanceTaskScope), ...governanceRoleGrantArguments(roleGrantPolicy));
      if (profile === 'governance' && sourceProvenancePolicy !== undefined) {
        if (governanceTaskScope?.contractId !== sourceProvenancePolicy.contractId
          || sourceProvenancePolicy.head !== sourceHead || sourceProvenancePolicy.baseCommit !== reviewBase) {
          throw new Error('Protected source provenance must bind this task scope and candidate.');
        }
        argv.push(...governanceSourceProvenanceArguments(sourceProvenancePolicy));
      }
      if (profile === 'governance') argv.push(...governanceAcceptedApiContractArguments(acceptedApiContract));
      return { steps: [{ cwd: paths.snapshotRoot, executable: toolchains.forgeGovernance, argv }] };
    }
    case 'backend-red-test':
      return { steps: [mavenStep(paths, toolchains, ['-pl', modules, '-am', `-Dtest=${normalized.tests[0]}`, '-Dsurefire.failIfNoSpecifiedTests=false', 'test'])] };
    case 'backend-module-compile':
      return { steps: [mavenStep(paths, toolchains, ['-pl', modules, '-am', '-DskipTests', 'test-compile'])] };
    case 'backend-module-test':
      return { steps: [mavenStep(paths, toolchains, ['-pl', modules, '-am', 'test'])] };
    case 'backend-test-class':
      return { steps: [mavenStep(paths, toolchains, ['-pl', modules, '-am', `-Dtest=${normalized.tests.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false', 'test'])] };
    case 'frontend-red-test':
      return { steps: [
        pnpmInstall(paths, toolchains, 'forge-admin-ui'),
        {
          cwd: path.join(paths.snapshotRoot, 'forge-admin-ui'),
          executable: toolchains.pnpm,
          argv: ['test', '--', '--run', normalized.testFiles[0].replace(/^forge-admin-ui\//u, ''), '--reporter=json', `--outputFile=${path.join(paths.outputRoot, 'test-results-admin-red.json')}`],
        },
      ] };
    case 'frontend-admin-lint': {
      const batches = frontendLintBatches(normalized, lintFiles);
      if (batches.length === 0) {
        if (!/^[0-9a-f]{40}$/u.test(reviewBase ?? '')) throw new Error('host lint review base is invalid.');
        return { steps: [{ cwd: paths.snapshotRoot, executable: toolchains.node,
          argv: ['-e', FRONTEND_LINT_EMPTY_SCRIPT, toolchains.git, reviewBase, sourceHead] }] };
      }
      return { steps: [pnpmInstall(paths, toolchains, 'forge-admin-ui'), ...batches.map((files) => ({
        cwd: path.join(paths.snapshotRoot, 'forge-admin-ui'), executable: toolchains.pnpm,
        argv: ['exec', 'eslint', ...files.map((entry) => entry.replace(/^forge-admin-ui\//u, '')), '--max-warnings=0', ...FRONTEND_LINT_FORMAT_ARGS],
      }))] };
    }
    case 'frontend-admin-test':
      if (reviewBase !== undefined && !/^[0-9a-f]{40}$/u.test(reviewBase)) throw new Error('host changed-test review base is invalid.');
      return { steps: [pnpmInstall(paths, toolchains, 'forge-admin-ui'), {
        cwd: path.join(paths.snapshotRoot, 'forge-admin-ui'), executable: toolchains.pnpm,
        argv: ['test', ...(normalized.testFiles?.map((entry) => entry.replace(/^forge-admin-ui\//u, ''))
          ?? [...frontendTestScopeFilters(testFilters), `--changed=${reviewBase ?? sourceHead}`, '--passWithNoTests']), '--reporter=json', `--outputFile=${path.join(paths.outputRoot, 'test-results-admin.json')}`],
      }] };
    case 'frontend-admin-typecheck':
      return { steps: [pnpmInstall(paths, toolchains, 'forge-admin-ui'), {
        cwd: paths.snapshotRoot, executable: toolchains.node,
        argv: [HOST_FRONTEND_TYPECHECK_PATH, ...frontendTypecheckArguments(typecheckFiles)],
      }] };
    case 'frontend-admin-build':
      return { steps: [pnpmInstall(paths, toolchains, 'forge-admin-ui'), {
        cwd: paths.snapshotRoot, executable: toolchains.pnpm,
        argv: ['--dir', path.join(paths.snapshotRoot, 'forge-admin-ui'), 'build'],
      }] };
    case 'frontend-h5-test':
      return { steps: [{ cwd: path.join(paths.snapshotRoot, 'forge-h5-ui'), executable: toolchains.node,
        argv: ['--test', '--test-reporter=junit', `--test-reporter-destination=${path.join(paths.outputRoot, 'test-results-h5.xml')}`,
          ...normalized.testFiles.map(entry => entry.replace(/^forge-h5-ui\//u, ''))] }] };
    case 'frontend-h5-build':
      return { steps: [pnpmInstall(paths, toolchains, 'forge-h5-ui'), {
        cwd: paths.snapshotRoot, executable: toolchains.pnpm,
        argv: ['--dir', path.join(paths.snapshotRoot, 'forge-h5-ui'), 'build:h5'],
      }] };
    case 'full-regression':
      return { steps: [mavenStep(paths, toolchains, ['test'])] };
    default:
      throw new Error('host verification profile is not allowed.');
  }
}

export function hostExecutionEnvironment(contract, paths, resolvedToolchains) {
  const binaryDirectories = [
    path.join(resolvedToolchains.javaHome, 'bin'),
    path.dirname(resolvedToolchains.maven),
    path.dirname(resolvedToolchains.node),
    path.dirname(resolvedToolchains.pnpm),
    path.dirname(resolvedToolchains.git),
    path.dirname(resolvedToolchains.forgeGovernance),
    '/usr/bin',
    '/bin',
  ];
  const separator = process.platform === 'win32' ? ';' : ':';
  const javaTempRoot = path.resolve(paths.tempRoot);
  const javaUserHome = path.resolve(paths.homeRoot);
  if (/[\s"']/u.test(javaTempRoot)) {
    throw new Error('host verification tempRoot cannot be represented safely in JVM option environment variables.');
  }
  if (/[\s"']/u.test(javaUserHome)) {
    throw new Error('host verification homeRoot cannot be represented safely in JVM option environment variables.');
  }
  return {
    HOME: javaUserHome,
    USER: 'forge-runner',
    LOGNAME: 'forge-runner',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: [...new Set(binaryDirectories)].join(separator),
    JAVA_HOME: resolvedToolchains.javaHome,
    MAVEN_USER_HOME: path.join(paths.cacheRoot, 'm2'),
    MAVEN_CONFIG: path.join(paths.cacheRoot, 'm2'),
    TMPDIR: javaTempRoot,
    TMP: javaTempRoot,
    TEMP: javaTempRoot,
    JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${javaTempRoot} -Duser.home=${javaUserHome}`,
    MAVEN_OPTS: `-Djava.io.tmpdir=${javaTempRoot} -Djansi.tmpdir=${path.join(javaTempRoot, 'maven-jansi')}`,
    NPM_CONFIG_USERCONFIG: paths.npmConfig,
    NPM_CONFIG_CACHE: path.join(paths.cacheRoot, 'npm'),
    PNPM_HOME: path.join(paths.cacheRoot, 'pnpm', 'home'),
    PNPM_STORE_DIR: path.join(paths.cacheRoot, 'pnpm', 'store'),
    // Bound Vitest workers without changing the receipt-bound test command.
    VITEST_MAX_THREADS: '1',
    VITEST_MIN_THREADS: '1',
    VITEST_MAX_FORKS: '1',
    VITEST_MIN_FORKS: '1',
    XDG_CACHE_HOME: path.join(paths.cacheRoot, 'xdg', 'cache'),
    XDG_CONFIG_HOME: path.join(paths.cacheRoot, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(paths.cacheRoot, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(paths.cacheRoot, 'xdg', 'state'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_OPTIONAL_LOCKS: '0',
    CI: 'true',
    NO_COLOR: '1',
    FORGE_VERIFICATION_PROJECT: contract.projectSlug,
  };
}
