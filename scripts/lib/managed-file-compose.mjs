import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManagedFileTargets } from '../../docker/harness/forge-managed-files.mjs';

const begin = '      # forge-managed-file-targets: begin\n';
const end = '      # forge-managed-file-targets: end\n';

function targetBlock(config) {
  if (!config.targets.length) return '';
  return begin + config.targets.map(target => [
    '      - type: bind',
    `        source: ${JSON.stringify(target.serverDirectory)}`,
    `        target: "/run/forge-managed-files/targets/${target.targetId}"`,
    '        read_only: false',
    '        bind:',
    '          create_host_path: false',
  ].join('\n') + '\n').join('') + end;
}

// Only this renderer's exact, currently registered block may be removed when
// comparing an installed predecessor. Unrelated custom Compose remains refused.
export function managedFileCompose(source, value, slug, strip = false) {
  const config = validateManagedFileTargets(value, slug);
  const block = targetBlock(config);
  const normalized = source.replaceAll('\r\n', '\n');
  const section = normalized.match(/^  taskspace-broker:\n[\s\S]*?(?=^  [a-z][a-z0-9-]*:|^networks:|^secrets:|(?![\s\S]))/mu)?.[0];
  if (!section || !section.includes('    volumes:\n')) throw new Error('Managed Broker template is missing.');
  const occurrences = normalized.split(begin).length - 1;
  if (occurrences > 1 || (occurrences && (!block || !section.includes(block)))) {
    throw new Error('Installed managed target block differs from the protected registry.');
  }
  const base = occurrences ? normalized.replace(block, '') : normalized;
  if (strip || !block) return base;
  const baseSection = occurrences ? section.replace(block, '') : section;
  if (base.includes('/run/forge-managed-files/targets/')) throw new Error('Unregistered managed target mount exists.');
  return base.replace(baseSection, baseSection.replace('    volumes:\n', '    volumes:\n' + block));
}

function loadRegistry(file, slug) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error('Registry path must be canonical.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || before.gid !== 0
      || (before.mode & 0o022) || before.size > 64 * 1024) throw new Error('Registry must be a protected root-owned regular file.');
    const value = validateManagedFileTargets(JSON.parse(readFileSync(fd, 'utf8')), slug);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw new Error('Registry changed while reading.');
    for (const target of value.targets) {
      const directory = statSync(target.serverDirectory);
      if (realpathSync(target.serverDirectory) !== target.serverDirectory || !directory.isDirectory()
        || directory.dev !== target.expectedDevice || directory.ino !== target.expectedInode) {
        throw new Error('Registered target directory identity differs.');
      }
    }
    return value;
  } finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, slug, registry, sourceFile] = process.argv.slice(2);
    if (!['render', 'strip'].includes(mode) || !sourceFile) throw new Error('Expected render|strip, project, registry and source file.');
    const source = readFileSync(sourceFile, 'utf8');
    process.stdout.write(managedFileCompose(source, loadRegistry(registry, slug), slug, mode === 'strip'));
  } catch (error) {
    process.stderr.write(`Managed file Compose rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
