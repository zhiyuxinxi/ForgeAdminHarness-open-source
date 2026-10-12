#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function envMap(values, label) {
  const result = {};
  for (const item of values ?? []) {
    if (typeof item !== 'string' || !item.includes('=')) throw new Error(`${label} contains an invalid environment entry.`);
    const split = item.indexOf('=');
    const key = item.slice(0, split);
    if (!key || Object.hasOwn(result, key)) throw new Error(`${label} contains a duplicate environment key: ${key}`);
    result[key] = item.slice(split + 1);
  }
  return result;
}

function withoutReviewedFields(config, platform = 'unknown') {
  const copy = structuredClone(config ?? {});
  for (const key of ['Cmd', 'Entrypoint', 'Env', 'Labels', 'User', 'WorkingDir']) delete copy[key];
  if (platform === 'linux' && Object.hasOwn(copy, 'ArgsEscaped')) {
    if (typeof copy.ArgsEscaped !== 'boolean') {
      throw new Error('Linux Docker legacy ArgsEscaped metadata must be boolean when present.');
    }
    // OCI defines ArgsEscaped as a deprecated Docker compatibility field for
    // Windows command-line processing. Docker Desktop/BuildKit may still add
    // it to a Linux image; normalize only this platform-irrelevant boolean.
    delete copy.ArgsEscaped;
  }
  return stable(copy);
}

function foundationEnvironment(skillBundle) {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'en_US.UTF-8',
    LANGUAGE: 'en_US:en',
    LC_ALL: 'en_US.UTF-8',
    HOME: '/home/node',
    DSH_HOME: '/home/node/.dsh',
    DSH_BUNDLED_SKILL_DIR: '/opt/forge-skill-bundles/current/skills',
    NODE_PATH: '/opt/forge-harness-runtime/node_modules',
    DSH_TELEMETRY_DISABLED: '1',
    FORGE_HARNESS_SKILL_BUNDLE_VERSION: skillBundle,
    HARNESS_DOCUMENT_INPUT_ROOT: '/project-inputs',
    HARNESS_DOCUMENT_MAX_OUTPUT_BYTES: '1048576',
    HARNESS_DOCUMENT_MAX_PDF_PAGES: '200',
    HARNESS_DOCUMENT_MAX_SOURCE_BYTES: '26214400',
    HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS: '100',
    HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS: '2000',
    HARNESS_PROTOTYPE_MAX_ARCHIVE_BYTES: '52428800',
    HARNESS_PROTOTYPE_MAX_COMPRESSION_RATIO: '100',
    HARNESS_PROTOTYPE_MAX_DEPTH: '24',
    HARNESS_PROTOTYPE_MAX_ENTRIES: '5000',
    HARNESS_PROTOTYPE_MAX_FILE_BYTES: '16777216',
    HARNESS_PROTOTYPE_MAX_HTML_ANALYSIS_BYTES: '4194304',
    HARNESS_PROTOTYPE_MAX_PAGES: '200',
    HARNESS_PROTOTYPE_MAX_PATH_BYTES: '1024',
    HARNESS_PROTOTYPE_MAX_SUMMARY_BYTES: '2097152',
    HARNESS_PROTOTYPE_MAX_UNCOMPRESSED_BYTES: '268435456',
    HARNESS_HISTORY_PAGE_MESSAGES: '5',
    HARNESS_PRIVILEGED_API_MODE: 'loopback-only',
  };
}

function foundationLabels(options) {
  return {
    'org.opencontainers.image.title': 'Forge Delivery DeepSeek Harness',
    'org.opencontainers.image.description': 'Pinned DeepSeek Harness core with external Skills and host verification',
    'org.opencontainers.image.source': 'https://github.com/deepseek-ai/deepseek-harness',
    'org.opencontainers.image.version': options.dshVersion,
    'org.opencontainers.image.revision': options.revision,
    'com.forge-delivery.harness-skill-bundle': options.skillBundle,
    'com.forge-delivery.harness-runtime-profile': 'loopback-safe',
    'com.forge-delivery.harness-node-base-manifest': options.nodeBase,
    'com.forge-delivery.harness-maven-base-manifest': options.mavenBase,
  };
}

function targetLabels(options) {
  return {
    'org.opencontainers.image.description': 'Pinned DeepSeek Harness core with external Skills, isolated uploads and a project-scoped controlled release runner',
    'org.opencontainers.image.version': options.dshVersion,
    'org.opencontainers.image.revision': options.revision,
    'com.forge-delivery.harness-skill-bundle': options.skillBundle,
    'com.forge-delivery.harness-runtime-profile': options.runtimeProfile,
    'com.forge-delivery.harness-base-image-id': options.baseImageId,
  };
}

function targetEnvironment(skillBundle) {
  const environment = foundationEnvironment(skillBundle);
  environment.HARNESS_PRIVILEGED_API_MODE = 'trusted-host';
  return environment;
}

export function buildReviewedConfig(kind, baseConfig, options) {
  const parentConfig = structuredClone(baseConfig);
  const baseEnvironment = envMap(parentConfig.Env, 'Reviewed parent');
  const isFoundation = kind === 'foundation';
  return {
    ...(isFoundation ? {} : parentConfig),
    Env: isFoundation
      ? foundationEnvironment(options.skillBundle)
      : { ...baseEnvironment, ...targetEnvironment(options.skillBundle) },
    Labels: {
      ...(isFoundation ? {} : (parentConfig.Labels ?? {})),
      ...(isFoundation ? foundationLabels(options) : targetLabels(options)),
    },
    User: '1000:1000',
    WorkingDir: '/workspace',
    Entrypoint: null,
    Cmd: ['/usr/local/bin/start-harness'],
  };
}

export function validateConfigRelationship(kind, image, base, options) {
  if (!['foundation', 'target'].includes(kind)) throw new Error('Harness image config kind is invalid.');
  if (image.Os !== 'linux' || image.Os !== base.Os || image.Architecture !== base.Architecture) {
    throw new Error('Harness image OS or architecture differs from its reviewed parent.');
  }
  const actualConfig = image.Config ?? {};
  const baseConfig = base.Config ?? {};
  assert.deepEqual(
    withoutReviewedFields(actualConfig, image.Os),
    kind === 'foundation' ? {} : withoutReviewedFields(baseConfig, base.Os),
    'Harness image contains an unreviewed runtime Config field change.',
  );

  const expected = buildReviewedConfig(kind, baseConfig, options);
  const expectedEnvironment = expected.Env;
  const actualEnvironment = envMap(actualConfig.Env, 'Harness image');
  assert.deepEqual(stable(actualEnvironment), stable(expectedEnvironment), 'Harness image environment differs from the exact reviewed set.');

  assert.deepEqual(stable(actualConfig.Labels ?? {}), stable(expected.Labels), 'Harness image labels differ from the exact reviewed set.');
  assert.equal(actualConfig.User, expected.User, 'Harness image user is not the unprivileged runtime identity.');
  assert.equal(actualConfig.WorkingDir, expected.WorkingDir, 'Harness image working directory is invalid.');
  assert.deepEqual(actualConfig.Entrypoint ?? null, expected.Entrypoint, 'Harness image entrypoint must be empty.');
  assert.deepEqual(actualConfig.Cmd, expected.Cmd, 'Harness image command is invalid.');

  const reviewed = {
    os: image.Os,
    architecture: image.Architecture,
    user: actualConfig.User,
    workingDir: actualConfig.WorkingDir,
    entrypoint: actualConfig.Entrypoint ?? null,
    cmd: actualConfig.Cmd,
    environment: actualEnvironment,
    labels: actualConfig.Labels ?? {},
    inheritedConfig: withoutReviewedFields(actualConfig, image.Os),
  };
  return { ok: true, kind, configDigest: digest(reviewed) };
}

function requireArtifact(condition, message) {
  if (!condition) throw new Error(`Incremental Harness artifact: ${message}`);
}

function parseBoundJson(bytes, expectedSha256, name) {
  requireArtifact(/^[a-f0-9]{64}$/u.test(expectedSha256 ?? ''), `${name} digest is not pinned`);
  requireArtifact(createHash('sha256').update(bytes).digest('hex') === expectedSha256, `${name} digest changed`);
  return JSON.parse(bytes.toString('utf8'));
}

// The operator-owned baseline binds existing build and installed-consumer artifacts.
// Image labels alone never select this path or confer source provenance.
export function validateIncrementalArtifact({ image, parent, foundation, manifestBytes, consumerBytes,
  manifestSha256, consumerSha256, observation, expectedImageId, expectedFoundationId, expectedRuntimeUid = 1000,
  expectedRuntimeGid = 1000 }) {
  const manifest = parseBoundJson(manifestBytes, manifestSha256, 'manifest');
  const proof = parseBoundJson(consumerBytes, consumerSha256, 'consumer');
  const immutable = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? '');
  requireArtifact(immutable(expectedImageId) && image.Id === expectedImageId
    && manifest.candidateImage === image.Id && proof.candidateImage === image.Id, 'target identity differs');
  requireArtifact(manifest.buildState === 'finished' && manifest.buildExit === 0
    && proof.status === 'passed' && proof.exit === 0 && proof.actualConsumer?.status === 'passed', 'build or consumer did not pass');
  requireArtifact(/^[a-f0-9]{40}$/u.test(manifest.sourceCommit ?? '')
    && proof.sourceCommit === manifest.sourceCommit && proof.testSourceCommit === manifest.sourceCommit,
  'source is not bound to the installed consumer');
  requireArtifact(immutable(manifest.baseImage) && parent.Id === manifest.baseImage
    && proof.baseImage === parent.Id && immutable(expectedFoundationId)
    && foundation.Id === expectedFoundationId, 'parent or foundation identity differs');
  const layers = value => value.RootFS?.Layers;
  const prefix = (a, b) => Array.isArray(a) && a.length > 0 && Array.isArray(b)
    && a.length <= b.length && a.every((entry, index) => immutable(entry) && entry === b[index]);
  requireArtifact(prefix(layers(foundation), layers(parent)) && prefix(layers(parent), layers(image))
    && layers(image).length > layers(parent).length
    && JSON.stringify(manifest.parentLayers) === JSON.stringify(layers(parent)), 'layer ancestry differs');
  requireArtifact(image.Os === 'linux' && parent.Os === image.Os && foundation.Os === image.Os
    && image.Architecture === parent.Architecture && image.Architecture === foundation.Architecture, 'platform differs');
  const labels = image.Config?.Labels ?? {};
  const metadata = observation?.versions ?? {};
  requireArtifact(proof.tag === manifest.tag && proof.revision === labels['org.opencontainers.image.revision']
    && labels['com.forge-delivery.harness-base-image-id'] === parent.Id
    && labels['com.forge-delivery.production-source-commit'] === manifest.sourceCommit
    && labels['com.forge-delivery.test-source-commit'] === proof.testSourceCommit
    && labels['com.forge-delivery.versions-source-commit'] === manifest.versionsCommit
    && metadata.HARNESS_IMAGE_REVISION === proof.revision
    && labels['com.forge-delivery.harness-skill-bundle'] === metadata.HARNESS_SKILL_BUNDLE_VERSION,
  'version or source labels differ from the bound metadata');
  const expected = structuredClone(parent.Config);
  expected.Labels = { ...(expected.Labels ?? {}) };
  for (const key of ['org.opencontainers.image.revision', 'com.forge-delivery.harness-base-image-id',
    'com.forge-delivery.production-source-commit', 'com.forge-delivery.test-source-commit',
    'com.forge-delivery.versions-source-commit', 'com.forge-delivery.harness-skill-bundle']) expected.Labels[key] = labels[key];
  if (labels['io.forge.tool-worker'] !== undefined) {
    requireArtifact(labels['io.forge.tool-worker'] === 'v1', 'unsupported tool worker version');
    expected.Labels['io.forge.tool-worker'] = 'v1';
    if (parent.Config.Labels?.['io.forge.tool-worker'] !== 'v1') {
      for (const file of ['forge-tool-worker.mjs', 'forge-tool-worker-wire.mjs', 'forge-tool-worker-provider.mjs',
        'forge-tool-worker-bash.mjs', 'forge-tool-worker-start.mjs', 'forge-tool-worker-native-patch.mjs']) {
        requireArtifact(/^[a-f0-9]{64}$/u.test(proof.actualConsumer.installedBindings?.[`/usr/local/lib/${file}`] ?? ''),
          'tool worker activation is not bound to the installed consumer');
      }
      requireArtifact(/^[a-f0-9]{64}$/u.test(proof.actualConsumer.installedBindings?.['/usr/local/share/forge-tool-worker.json'] ?? ''),
        'tool worker configuration is not bound to the installed consumer');
    }
  }
  requireArtifact(digest(image.Config) === manifest.targetConfigDigest, 'complete Config digest differs');
  requireArtifact(digest(image.Config) === digest(expected), 'unreviewed Config change');
  requireArtifact(expectedRuntimeUid === 1000 && Number.isSafeInteger(expectedRuntimeGid) && expectedRuntimeGid > 0
    && image.Config.User === `${expectedRuntimeUid}:${expectedRuntimeGid}` && image.Config.WorkingDir === '/workspace'
    && (image.Config.Entrypoint ?? null) === null && JSON.stringify(image.Config.Cmd) === '["/usr/local/bin/start-harness"]'
    && envMap(image.Config.Env, 'Incremental image').HARNESS_PRIVILEGED_API_MODE === 'trusted-host', 'runtime isolation differs');
  const recorded = manifest.installedObservation;
  const boundModules = proof.actualConsumer.installedBindings;
  requireArtifact(recorded?.sourceReceipt?.ok === true && recorded.sourceReceipt.schemaVersion === 1
    && /^sha256:[a-f0-9]{64}$/u.test(recorded.sourceReceipt.digest ?? '')
    && recorded.sourceReceipt.digest === observation?.sourceReceipt?.digest
    && recorded.sourceReceipt.digest === observation?.embeddedReceipt?.digest,
  'source build digest is not bound');
  requireArtifact(recorded?.modules && boundModules && Object.keys(recorded.modules).length > 0
    && Object.keys(boundModules).length > 0, 'installed module bindings are missing');
  for (const [file, hash] of Object.entries(recorded.modules)) {
    requireArtifact(/^[a-f0-9]{64}$/u.test(hash) && observation.modules?.[file] === hash, 'installed module digest differs');
  }
  for (const [file, hash] of Object.entries(boundModules)) {
    requireArtifact(recorded.modules[file] === hash, 'consumer module is not bound to build');
  }
  requireArtifact(recorded.dependencyReceiptSha256 === observation.dependencyReceiptSha256
    && /^[a-f0-9]{64}$/u.test(recorded.dependencyReceiptSha256 ?? ''), 'dependency receipt is not bound');
  return { ok: true, registered: true, kind: 'incremental-target', imageId: image.Id,
    baseImageId: parent.Id, foundationImageId: foundation.Id, configDigest: manifest.targetConfigDigest,
    buildDigest: recorded.sourceReceipt.digest, sourceCommit: manifest.sourceCommit };
}

function protectedBytes(file, expectedSha256) {
  const before = lstatSync(file);
  requireArtifact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && (before.mode & 0o022) === 0 && before.size <= 8 * 1024 * 1024, 'artifact file is not protected');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireArtifact(opened.ino === before.ino && opened.dev === before.dev, 'artifact file identity changed');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    requireArtifact(after.size === before.size && after.mtimeMs === before.mtimeMs, 'artifact file changed during read');
    if (expectedSha256) parseBoundJson(bytes, expectedSha256, 'file');
    return bytes;
  } finally { closeSync(fd); }
}

function inspectImage(reference) {
  const parsed = JSON.parse(execFileSync('docker', ['image', 'inspect', reference], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  }));
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`Docker image reference is not unique: ${reference}`);
  return parsed[0];
}

export function validateInstalledArtifactPaths(modulePaths) {
  requireArtifact(Array.isArray(modulePaths) && modulePaths.length > 0 && modulePaths.length <= 512
    && modulePaths.every(file => typeof file === 'string' && !file.split('/').includes('..')
      && (/^\/(?:usr\/local\/(?:bin|lib|share)|opt\/forge-harness-runtime)\/[A-Za-z0-9_@./+-]+$/u.test(file)
        || (/^\/opt\/forge-skill-bundles\/versions\/[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+\/[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*$/u.test(file)
          && !file.split('/').includes('.')))), 'module paths are outside the installed artifact');
  return true;
}

export function resolveRegisteredRuntimeGid(manifest, groupGid) {
  // The caller has already checked this manifest against the protected baseline digest.
  return manifest.parentConfig?.User === '1000:1000' ? 1000 : Number(groupGid);
}

function registeredIncremental(options) {
  const baselineBytes = protectedBytes(options.identityReceipt);
  const metadata = lstatSync(options.identityReceipt);
  requireArtifact(Number.isInteger(Number(options.ownerUid)) && Number.isInteger(Number(options.groupGid))
    && metadata.uid === Number(options.ownerUid) && metadata.gid === Number(options.groupGid)
    && (metadata.mode & 0o777) === 0o640, 'baseline ownership or mode differs');
  const pins = {};
  for (const line of baselineBytes.toString('utf8').split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue;
    const equal = line.indexOf('=');
    requireArtifact(equal > 0 && !Object.hasOwn(pins, line.slice(0, equal)), 'baseline has invalid or duplicate keys');
    pins[line.slice(0, equal)] = line.slice(equal + 1);
  }
  const roles = ['HARNESS', 'CONVERSATION_MANAGER'].filter(role =>
    [pins[`${role}_IMAGE`], pins[`${role}_IMAGE_ID`]].includes(options.image));
  requireArtifact(roles.length <= 1, 'target registration is ambiguous');
  const role = roles[0];
  const keys = ['MANIFEST_FILE', 'MANIFEST_SHA256', 'CONSUMER_FILE', 'CONSUMER_SHA256'];
  if (!role || keys.every(key => !pins[`${role}_INCREMENTAL_${key}`])) return { registered: false };
  const binding = Object.fromEntries(keys.map(key => [key, pins[`${role}_INCREMENTAL_${key}`]]));
  requireArtifact(keys.every(key => typeof binding[key] === 'string' && binding[key]), 'incremental binding is incomplete');
  requireArtifact(pins.HARNESS_FOUNDATION_IMAGE_ID === options.foundationId, 'fixed foundation differs');
  for (const file of [binding.MANIFEST_FILE, binding.CONSUMER_FILE]) {
    const st = lstatSync(file);
    requireArtifact(st.uid === 0 || st.uid === metadata.uid, 'artifact owner differs');
  }
  const manifestBytes = protectedBytes(binding.MANIFEST_FILE, binding.MANIFEST_SHA256);
  const consumerBytes = protectedBytes(binding.CONSUMER_FILE, binding.CONSUMER_SHA256);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireArtifact(manifest.consumerProofFile === binding.CONSUMER_FILE
    && manifest.consumerProofSha256 === binding.CONSUMER_SHA256, 'consumer is not frozen in the build manifest');
  requireArtifact(/^sha256:[a-f0-9]{64}$/u.test(manifest.baseImage ?? ''), 'parent identity is not immutable');
  const image = inspectImage(options.image), parent = inspectImage(manifest.baseImage), foundation = inspectImage(options.foundationId);
  const proof = JSON.parse(consumerBytes.toString('utf8'));
  requireArtifact(image.Id === pins[`${role}_IMAGE_ID`] && image.Id === manifest.candidateImage
    && image.Id === proof.candidateImage && manifest.baseImage === parent.Id && proof.baseImage === parent.Id,
  'immutable identities differ before observation');
  const modulePaths = Object.keys(manifest.installedObservation?.modules ?? {});
  validateInstalledArtifactPaths(modulePaths);
  const probe = `
    import { readFileSync, lstatSync, realpathSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { execFileSync } from 'node:child_process';
    const hash = b => createHash('sha256').update(b).digest('hex');
    const files = ${JSON.stringify(modulePaths)};
    const modules = Object.fromEntries(files.map(file => {
      if (file.startsWith('/opt/forge-skill-bundles/versions/')) {
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o022) !== 0
          || ![0, ${JSON.stringify(Number(options.ownerUid))}].includes(st.uid) || realpathSync(file) !== file) {
          throw new Error('Installed Skill bundle file is not protected: ' + file);
        }
      }
      return [file, hash(readFileSync(file))];
    }));
    const versions = Object.fromEntries(readFileSync('/usr/local/share/forge-image-build/versions.env', 'utf8')
      .split(/\\r?\\n/u).filter(line => line && !line.startsWith('#') && line.includes('='))
      .map(line => [line.slice(0,line.indexOf('=')), line.slice(line.indexOf('=')+1)]));
    const sourceReceipt = JSON.parse(execFileSync(process.execPath,
      ['/usr/local/lib/validate-image-build-inputs.mjs', '--mode','image','--root','/',
       '--spec','/usr/local/share/forge-image-build/image-build-inputs.json','--json'], {encoding:'utf8',maxBuffer:1048576}));
    const embeddedReceipt = JSON.parse(readFileSync('/usr/local/share/forge-image-build/receipt.json','utf8'));
    const dependencyReceiptSha256 = hash(readFileSync('/usr/local/share/forge-image-build/runtime-dependency-receipt.json'));
    console.log(JSON.stringify({modules,versions,sourceReceipt,embeddedReceipt,dependencyReceiptSha256}));
  `;
  const observation = JSON.parse(execFileSync('docker', ['run', '--rm', '--pull=never', '--read-only', '--network=none',
    '--entrypoint', 'node', image.Id, '--input-type=module', '-e', probe],
  { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60000, windowsHide: true }));
  const result = validateIncrementalArtifact({ image, parent, foundation, manifestBytes, consumerBytes,
    manifestSha256: binding.MANIFEST_SHA256, consumerSha256: binding.CONSUMER_SHA256, observation,
    expectedImageId: pins[`${role}_IMAGE_ID`], expectedFoundationId: pins.HARNESS_FOUNDATION_IMAGE_ID,
    expectedRuntimeUid: Number(options.ownerUid), expectedRuntimeGid: resolveRegisteredRuntimeGid(manifest, options.groupGid) });
  requireArtifact(digest(protectedBytes(options.identityReceipt).toString('utf8')) === digest(baselineBytes.toString('utf8')),
    'baseline changed during verification');
  requireArtifact(inspectImage(options.image).Id === image.Id, 'target tag changed during verification');
  return result;
}

async function main(argv) {
  const options = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument.startsWith('--')) options[argument.slice(2).replace(/-([a-z])/gu, (_, value) => value.toUpperCase())] = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.kind === 'registered-incremental') {
    for (const name of ['image', 'foundationId', 'identityReceipt', 'ownerUid', 'groupGid']) {
      if (options[name] === undefined) throw new Error(`Missing incremental option: ${name}`);
    }
    process.stdout.write(`${JSON.stringify(registeredIncremental(options))}\n`);
    return;
  }
  for (const name of ['kind', 'image', 'baseImage', 'revision', 'skillBundle']) {
    if (!options[name]) throw new Error(`Missing --${name.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)}.`);
  }
  if (options.kind === 'foundation') {
    for (const name of ['dshVersion', 'nodeBase', 'mavenBase']) if (!options[name]) throw new Error(`Missing foundation option: ${name}`);
  } else if (options.kind === 'target') {
    for (const name of ['dshVersion', 'runtimeProfile', 'baseImageId']) if (!options[name]) throw new Error(`Missing target option: ${name}`);
  }
  const receipt = validateConfigRelationship(
    options.kind,
    inspectImage(options.image),
    inspectImage(options.baseImage),
    options,
  );
  process.stdout.write(json ? `${JSON.stringify(receipt)}\n` : `PASS Harness ${receipt.kind} Config: ${receipt.configDigest}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`harness-image-config-validation: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
