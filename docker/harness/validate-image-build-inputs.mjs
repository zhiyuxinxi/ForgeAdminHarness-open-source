#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_SPEC_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4096;

function fail(message) {
  process.stderr.write(`image-build-inputs: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') result.json = true;
    else if (argument === '--mode') result.mode = argv[++index];
    else if (argument === '--root') result.root = argv[++index];
    else if (argument === '--spec') result.spec = argv[++index];
    else fail(`unknown argument ${argument}`);
  }
  if (!['source', 'image'].includes(result.mode)) fail('--mode must be source or image');
  if (!result.root || !result.spec) fail('--root and --spec are required');
  return result;
}

function safeRelative(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    fail(`${field} must be a non-empty POSIX relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(value)) {
    fail(`${field} escapes its declared root`);
  }
  return normalized;
}

export function withinRoot(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relative.split('/'));
  const fromRoot = path.relative(resolvedRoot, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    fail(`path escapes root: ${relative}`);
  }
  return resolved;
}

async function assertNoFollowPath(root, candidate, label, leafType) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} escapes its declared root`);
  }
  const rootStat = await lstat(resolvedRoot).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${label} root is not a no-follow directory`);
  if (path.relative(resolvedRoot, await realpath(resolvedRoot)) !== '') fail(`${label} root resolves through a link`);
  let current = resolvedRoot;
  const segments = relative === '' ? [] : relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) fail(`${label} contains a missing or linked path segment`);
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !stat.isDirectory()) fail(`${label} contains a non-directory parent segment`);
    if (path.relative(current, await realpath(current)) !== '') fail(`${label} resolves through a linked path segment`);
    if (isLeaf && leafType === 'file' && !stat.isFile()) fail(`${label} is not a regular no-follow file`);
    if (isLeaf && leafType === 'directory' && !stat.isDirectory()) fail(`${label} is not a no-follow directory`);
  }
}

async function regularFile(file, label, { boundaryRoot } = {}) {
  if (boundaryRoot) await assertNoFollowPath(boundaryRoot, file, label, 'file');
  const stat = await lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular no-follow file`);
  if (stat.size > MAX_FILE_BYTES) fail(`${label} exceeds ${MAX_FILE_BYTES} bytes`);
  const content = await readFile(file);
  return { content, stat };
}

async function walkTree(root, relative = '') {
  const current = relative ? withinRoot(root, relative) : path.resolve(root);
  const stat = await lstat(current).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail(`tree path is not a no-follow directory: ${current}`);
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];
  const directories = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`symbolic link is forbidden in build inputs: ${child}`);
    if (entry.isDirectory()) {
      directories.push(child);
      const nested = await walkTree(root, child);
      directories.push(...nested.directories);
      files.push(...nested.files);
    }
    else if (entry.isFile()) files.push(child);
    else fail(`non-regular build input is forbidden: ${child}`);
  }
  return { files, directories };
}

async function assertImageDirectoryMode(root, relative, expectedMode, label) {
  const directory = relative ? withinRoot(root, relative) : path.resolve(root);
  await assertNoFollowPath(root, directory, label, 'directory');
  const stat = await lstat(directory);
  const actualMode = (stat.mode & 0o777).toString(8).padStart(4, '0');
  if (actualMode !== expectedMode) fail(`${label} mode ${actualMode} != ${expectedMode}`);
}

function parseEnv(content) {
  const values = new Map();
  for (const rawLine of content.toString('utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) fail('versions.env contains an invalid assignment');
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function mappingForSource(mappings, source) {
  return mappings.find((mapping) => mapping.source === source
    || (mapping.type === 'tree' && source.startsWith(`${mapping.source}/`)));
}

async function verifyDockerfileCoverage(root, dockerfiles, mappings) {
  for (const relative of dockerfiles) {
    const dockerfile = await regularFile(withinRoot(root, relative), relative, { boundaryRoot: root });
    const instructions = [];
    let pending = '';
    for (const rawLine of dockerfile.content.toString('utf8').split(/\r?\n/u)) {
      const fragment = rawLine.trim();
      pending = pending ? `${pending} ${fragment}` : fragment;
      if (pending.endsWith('\\')) {
        pending = pending.slice(0, -1).trimEnd();
        continue;
      }
      if (pending) instructions.push(pending);
      pending = '';
    }
    if (pending) fail(`${relative} ends with an incomplete Dockerfile instruction`);
    for (const line of instructions) {
      if (!line.startsWith('COPY ') || line.includes('--from=')) continue;
      const tokens = line.split(/\s+/u).filter((token) => !token.startsWith('--'));
      if (tokens.length < 3 || tokens[0] !== 'COPY' || /[\[\]"']/u.test(line)) {
        fail(`${relative} contains an unsupported COPY form: ${line}`);
      }
      const rawDestination = tokens.at(-1);
      const destination = rawDestination.replace(/^\//u, '').replace(/\/$/u, '');
      const rawSources = tokens.slice(1, -1);
      if (rawSources.length > 1 && !rawDestination.endsWith('/')) {
        fail(`${relative} multi-source COPY destination must be a directory: ${line}`);
      }
      for (const rawSource of rawSources) {
        const source = safeRelative(rawSource.replace(/\/$/u, ''), `${relative} COPY source`);
        const mapping = mappingForSource(mappings, source);
        if (!mapping) fail(`${relative} COPY source is not covered by the manifest: ${source}`);
        let expected;
        if (rawSources.length > 1) {
          if (mapping.type !== 'file') fail(`${relative} multi-source COPY only accepts manifest files: ${source}`);
          expected = `${destination}/${path.posix.basename(source)}`;
        } else {
          const suffix = source === mapping.source ? '' : source.slice(mapping.source.length + 1);
          expected = suffix ? `${mapping.destination}/${suffix}` : mapping.destination;
        }
        if ((rawSources.length > 1 ? expected : destination) !== mapping.destination) {
          fail(`${relative} COPY destination is not covered by the manifest: ${source} -> ${rawDestination}`);
        }
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const specFile = await regularFile(path.resolve(options.spec), 'manifest spec');
  if (specFile.stat.size > MAX_SPEC_BYTES) fail(`manifest spec exceeds ${MAX_SPEC_BYTES} bytes`);
  let spec;
  try { spec = JSON.parse(specFile.content.toString('utf8')); } catch { fail('manifest spec is not valid JSON'); }
  if (spec.schemaVersion !== 1 || !Array.isArray(spec.mappings) || !Array.isArray(spec.dependencies)) {
    fail('manifest spec schema is invalid');
  }
  const mappings = spec.mappings.map((mapping, index) => {
    if (!mapping || !['file', 'tree'].includes(mapping.type)) fail(`mapping ${index} has invalid type`);
    const source = safeRelative(mapping.source, `mapping ${index} source`);
    const destination = safeRelative(mapping.destination, `mapping ${index} destination`);
    if (mapping.type === 'file' && !/^(0644|0755)$/u.test(mapping.mode ?? '')) fail(`mapping ${index} has invalid mode`);
    if (mapping.type === 'tree' && (mapping.fileMode !== '0644' || mapping.directoryMode !== '0755')) {
      fail(`mapping ${index} has invalid tree modes`);
    }
    return { ...mapping, source, destination };
  });
  const uniqueSources = new Set(mappings.map(({ source }) => source));
  const uniqueDestinations = new Set(mappings.map(({ destination }) => destination));
  if (uniqueSources.size !== mappings.length || uniqueDestinations.size !== mappings.length) fail('mapping paths must be unique');

  if (options.mode === 'source') {
    if (!Array.isArray(spec.dockerfiles) || spec.dockerfiles.length === 0) fail('dockerfiles are required in source mode');
    await verifyDockerfileCoverage(options.root, spec.dockerfiles.map((item) => safeRelative(item, 'dockerfile')), mappings);
  }

  const records = [];
  let totalBytes = 0;
  for (const mapping of mappings) {
    const relativeRoot = options.mode === 'source' ? mapping.source : mapping.destination;
    const absoluteRoot = withinRoot(options.root, relativeRoot);
    await assertNoFollowPath(options.root, absoluteRoot, mapping.source, mapping.type === 'tree' ? 'directory' : 'file');
    const tree = mapping.type === 'tree' ? await walkTree(absoluteRoot) : null;
    const paths = tree ? tree.files : [''];
    if (mapping.type === 'tree' && paths.length === 0) fail(`tree build input is empty: ${mapping.source}`);
    if (options.mode === 'image' && tree) {
      await assertImageDirectoryMode(absoluteRoot, '', mapping.directoryMode, mapping.destination);
      for (const relative of tree.directories) {
        await assertImageDirectoryMode(
          absoluteRoot,
          relative,
          mapping.directoryMode,
          `${mapping.destination}/${relative}`,
        );
      }
    }
    for (const relative of paths) {
      const file = await regularFile(
        relative ? withinRoot(absoluteRoot, relative) : absoluteRoot,
        `${mapping.source}${relative ? `/${relative}` : ''}`,
        { boundaryRoot: options.root },
      );
      if (options.mode === 'image') {
        const expectedMode = mapping.type === 'tree' ? mapping.fileMode : mapping.mode;
        const actualMode = (file.stat.mode & 0o777).toString(8).padStart(4, '0');
        if (actualMode !== expectedMode) fail(`${mapping.destination}${relative ? `/${relative}` : ''} mode ${actualMode} != ${expectedMode}`);
      }
      totalBytes += file.content.length;
      if (totalBytes > MAX_TOTAL_BYTES) fail(`build inputs exceed ${MAX_TOTAL_BYTES} bytes`);
      records.push({
        path: `${mapping.source}${relative ? `/${relative}` : ''}`,
        mode: mapping.type === 'tree' ? mapping.fileMode : mapping.mode,
        bytes: file.content.length,
        sha256: createHash('sha256').update(file.content).digest('hex'),
      });
      if (records.length > MAX_FILES) fail(`build inputs exceed ${MAX_FILES} files`);
    }
  }

  let sourceVersions;
  if (options.mode === 'source') {
    const versions = await regularFile(withinRoot(options.root, 'config/versions.env'), 'config/versions.env', { boundaryRoot: options.root });
    sourceVersions = parseEnv(versions.content);
  }
  const dependencyRecords = [];
  for (const dependency of spec.dependencies) {
    if (!dependency || typeof dependency.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/u.test(dependency.versionKey ?? '')) {
      fail('dependency entry is invalid');
    }
    const packageJson = safeRelative(dependency.packageJson, `dependency ${dependency.name} packageJson`);
    let version;
    if (options.mode === 'source') {
      version = sourceVersions.get(dependency.versionKey);
      if (!version) fail(`config/versions.env is missing ${dependency.versionKey}`);
    } else {
      const packageFile = await regularFile(withinRoot(options.root, packageJson), dependency.name, { boundaryRoot: options.root });
      let packageValue;
      try { packageValue = JSON.parse(packageFile.content.toString('utf8')); } catch { fail(`${dependency.name} package.json is invalid`); }
      version = packageValue.version;
      if (typeof version !== 'string' || version.length === 0) fail(`${dependency.name} has no version`);
    }
    dependencyRecords.push({ name: dependency.name, versionKey: dependency.versionKey, version });
  }
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  dependencyRecords.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const canonical = JSON.stringify({ schemaVersion: 1, files: records, dependencies: dependencyRecords });
  const receipt = {
    ok: true,
    schemaVersion: 1,
    digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    fileCount: records.length,
    totalBytes,
    dependencyCount: dependencyRecords.length,
  };
  process.stdout.write(options.json ? `${JSON.stringify(receipt)}\n` : `PASS image build inputs ${receipt.digest}: ${receipt.fileCount} files, ${receipt.dependencyCount} dependencies.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
