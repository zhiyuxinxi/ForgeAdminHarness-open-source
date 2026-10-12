import crypto from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dependencySeedInputs, dependencySeedToolchains } from './host-dependency-seed.mjs';
import { FRONTEND_HOST_TOOL_NAMES } from './forge-host-verification-receipt.mjs';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const jsonDigest = (value) => digest(JSON.stringify(value));
const PROJECTS = ['forge-admin-ui', 'forge-h5-ui'];
const SHA256 = /^[0-9a-f]{64}$/u;
const SCHEMA = 'forge-host-prepared-dependencies/v1';

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'HOST_PREPARED_DEPENDENCIES_INVALID' });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function frontendDependencyInputs(inventory, project, isolated = false) {
  if (project !== undefined && !PROJECTS.includes(project)) invalid('Prepared dependency project is invalid.');
  const inputs = dependencySeedInputs(inventory).filter((entry) => !entry.path.startsWith('forge-server/')
    && (/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs)$/u.test(entry.path)
      || /(?:^|\/)patches\//u.test(entry.path)));
  // These frontend roots have independent pnpm installations. Keep root and
  // shared-package inputs; a repository workspace couples its member projects.
  if (!project || !isolated || inputs.some((entry) => entry.path === 'pnpm-workspace.yaml' && !entry.deleted)) return inputs;
  const independentRoots = [...PROJECTS, 'forge-report-ui'];
  return inputs.filter((entry) => !independentRoots.some((other) => other !== project && entry.path.startsWith(`${other}/`)));
}

// Inventory hashes alone cannot prove that a lockfile has no cross-root links.
// Unknown layouts or bytes conservatively keep the complete frontend input set.
export async function isFrontendProjectIsolated({ inventory, project, workspace }) {
  if (!workspace || !path.isAbsolute(workspace) || !PROJECTS.includes(project)) return false;
  try {
    const inputs = frontendDependencyInputs(inventory);
    if (inputs.some((entry) => !entry.deleted && (entry.path === 'pnpm-workspace.yaml'
      || /(?:^|\/)(?:\.npmrc|\.pnpmfile\.cjs)$/u.test(entry.path)))) return false;
    const selected = frontendDependencyInputs(inventory, project, true).filter((entry) => !entry.deleted
      && (entry.path.startsWith(`${project}/`) || !entry.path.includes('/')));
    if (!['package.json', 'pnpm-lock.yaml'].every((name) => selected.some((entry) => entry.path === `${project}/${name}`))) return false;
    const local = /(?:^|[\s"':])(?:(?:file|link|workspace|git|https?):|\.\.?\/|\/|[a-z]:[\\/])/iu;
    for (const entry of selected) {
      if (!/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(entry.path)) continue;
      const file = path.join(workspace, entry.path), info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 ** 2 || !inside(workspace, await realpath(file))) return false;
      const bytes = await readFile(file);
      if (digest(bytes) !== entry.sha256) return false;
      const content = bytes.toString('utf8');
      if (entry.path.endsWith('package.json')) {
        const pkg = JSON.parse(content);
        if (pkg.workspaces) return false;
        const dependencies = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies, pkg.pnpm];
        if (local.test(JSON.stringify(dependencies))) return false;
      } else {
        // A registry package's one-line deprecation notice is not a source.
        // Keep syntax checks on the original bytes, including those notices.
        const sources = entry.path.endsWith('pnpm-lock.yaml')
          ? content.replace(/^    deprecated: [^\r\n]*\r?$/gmu, '') : content;
        if (local.test(sources) || /\\|(?:^|\s)[&*!][^\s]+/mu.test(content)) return false;
      }
    }
    return true;
  } catch { return false; }
}

// This is done once for a protected version, not once for every task. Internal
// pnpm links are allowed; links out of the installed tree and shared files are not.
export async function preparedDependencyDigest(root, { readOnly = false, metadataOnly = false } = {}) {
  const hash = crypto.createHash('sha256');
  let files = 0, bytes = 0;
  const check = (info) => {
    if (readOnly && process.platform !== 'win32' && !info.isSymbolicLink() && (info.mode & 0o222)) invalid('Prepared dependencies must be read-only.');
  };
  // ctime catches changed bytes even when their size and mtime are restored.
  // This fingerprint is useful only alongside a previously verified content
  // digest held in the Host's private state, never as a content checksum itself.
  const metadata = async (file) => {
    const info = await lstat(file, { bigint: true });
    hash.update(JSON.stringify([path.relative(root, file), ...[
      'dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    ].map((key) => String(info[key]))])).update('\0');
  };
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), info = await lstat(file);
      if (++files > 250_000 || (bytes += info.size) > 4 * 1024 ** 3) invalid('Prepared dependencies exceed limits.');
      check(info);
      if (metadataOnly) await metadata(file);
      hash.update(path.relative(root, file)).update('\0').update(String(info.mode & 0o777)).update('\0');
      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        if (path.isAbsolute(target) || !inside(root, await realpath(file))) invalid('Prepared dependency link escapes its tree.');
        hash.update('link').update(target);
      } else if (info.isDirectory()) {
        hash.update('dir'); await visit(file);
      } else if (info.isFile() && info.nlink === 1 && info.size <= 128 * 1024 * 1024) {
        hash.update('file');
        if (!metadataOnly) hash.update(await readFile(file));
      } else invalid('Unsupported prepared dependency entry.');
      hash.update('\0');
    }
  };
  const info = await lstat(root);
  if (!info.isDirectory() || await realpath(root) !== root) invalid('Prepared dependency root must be ordinary.');
  check(info);
  if (metadataOnly) await metadata(root);
  await visit(root);
  if (!files) invalid('Prepared dependency tree is empty.');
  return hash.digest('hex');
}

export async function createPreparedDependencyManifest({ root, projectSlug, inventory, toolchain, projects = PROJECTS }) {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/u.test(projectSlug) || !projects.length
    || new Set(projects).size !== projects.length || projects.some((project) => !PROJECTS.includes(project))) invalid('Prepared dependency project is invalid.');
  const inputs = frontendDependencyInputs(inventory);
  const entries = [];
  for (const project of projects) {
    const directory = path.join(root, project, 'node_modules');
    for (const name of ['.vite', '.vite-temp', '.cache']) {
      const target = path.join(directory, name);
      if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) invalid('Prepared tool cache mount target must be ordinary.');
    }
    entries.push({ project, sha256: await preparedDependencyDigest(directory, { readOnly: true }) });
  }
  return { schemaVersion: SCHEMA, projectSlug, inputs, inputsDigest: jsonDigest(inputs),
    toolchains: dependencySeedToolchains(toolchain), projects: entries };
}

async function preparedManifest(binding) {
  if (!binding) return null;
  const { root, manifestSha256 } = binding;
  if (!path.isAbsolute(root) || !SHA256.test(manifestSha256)) invalid('Prepared dependency binding is invalid.');
  const info = await lstat(root), manifestPath = path.join(root, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!info.isDirectory() || await realpath(root) !== root || !manifestInfo.isFile() || manifestInfo.nlink !== 1
    || (process.platform !== 'win32' && ((info.mode | manifestInfo.mode) & 0o222))) invalid('Prepared dependency manifest must be protected.');
  const content = await readFile(manifestPath);
  if (digest(content) !== manifestSha256) invalid('Prepared dependency manifest digest mismatch.');
  const manifest = JSON.parse(content);
  if (manifest.schemaVersion !== SCHEMA || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.projects)
    || manifest.inputsDigest !== jsonDigest(manifest.inputs)
    || new Set(manifest.projects.map((entry) => entry.project)).size !== manifest.projects.length
    || manifest.projects.some((entry) => !PROJECTS.includes(entry.project) || !SHA256.test(entry.sha256))) invalid('Prepared dependency manifest is invalid.');
  return manifest;
}

// Cache failure is a miss, not a new admission gate. The Host state directory
// is operator-owned and never mounted into a business job.
async function verificationCache(cacheRoot, key) {
  if (!cacheRoot || !path.isAbsolute(cacheRoot)) return null;
  try {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(cacheRoot);
    if (!info.isDirectory() || await realpath(cacheRoot) !== cacheRoot
      || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid()))) return null;
    const file = path.join(cacheRoot, `${digest(key)}.json`);
    let value = null;
    try {
      const saved = await lstat(file);
      if (saved.isFile() && saved.nlink === 1 && saved.size < 4096
        && (process.platform === 'win32' || (!(saved.mode & 0o077) && saved.uid === process.getuid()))) {
        value = JSON.parse(await readFile(file, 'utf8'));
      }
    } catch { /* Missing or damaged cache requires content verification. */ }
    return { value, save: async (entry) => {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entry) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch { /* Valid dependencies remain usable when cache persistence fails. */ }
    } };
  } catch { return null; }
}

// Task-private installations are mounted read-only in every job. Retain their
// content proof in Host-private state, but recheck the complete tree metadata
// on each restore so changes (including restored mtime/size) still invalidate it.
export async function verifyPreparedDependencyContent({ root, sha256, cacheRoot, digestTree = preparedDependencyDigest }) {
  const key = JSON.stringify(['task-prepared-content/v1', root, sha256]);
  const cache = await verificationCache(cacheRoot, key);
  const metadataSha256 = cache ? await preparedDependencyDigest(root, { metadataOnly: true }) : null;
  const expected = { schemaVersion: 'forge-task-prepared-check/v1', key, sha256, metadataSha256 };
  if (cache?.value && Object.keys(expected).every(field => cache.value[field] === expected[field])) return true;
  if (await digestTree(root) !== sha256) return false;
  if (cache) {
    if (await preparedDependencyDigest(root, { metadataOnly: true }) !== metadataSha256) return false;
    await cache.save(expected);
  }
  return true;
}

// One resolver belongs to one Host boot. Across boots, reuse a content check
// only after checking the full immutable tree's metadata and protected binding.
export function createPreparedDependencyResolver({ cacheRoot, digestTree = preparedDependencyDigest } = {}) {
  const verified = new Map();
  const verifyProject = async (binding, entry) => {
    const { root, manifestSha256 } = binding, { project } = entry;
    const directory = path.join(root, project, 'node_modules');
    const key = JSON.stringify([root, manifestSha256, project]);
    if (!verified.has(key)) {
      const promise = (async () => {
        for (const name of ['.vite', '.vite-temp', '.cache']) {
          const target = path.join(directory, name);
          if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) invalid('Prepared tool cache mount target must be ordinary.');
        }
        const cache = await verificationCache(cacheRoot, key);
        const metadataSha256 = cache ? await preparedDependencyDigest(directory, { readOnly: true, metadataOnly: true }) : null;
        const expected = { schemaVersion: 'forge-prepared-dependency-check/v1', key, sha256: entry.sha256, metadataSha256 };
        const saved = cache?.value;
        if (saved && Object.keys(expected).every((field) => saved[field] === expected[field])) return;
        if (await digestTree(directory, { readOnly: true }) !== entry.sha256) invalid('Prepared dependency payload mismatch.');
        if (cache) {
          if (await preparedDependencyDigest(directory, { readOnly: true, metadataOnly: true }) !== metadataSha256) {
            invalid('Prepared dependencies changed during verification.');
          }
          await cache.save(expected);
        }
      })();
      verified.set(key, promise);
      promise.catch(() => verified.delete(key));
    }
    await verified.get(key);
    return { status: 'ready', project, root: directory, source: 'server-preinstalled' };
  };
  const resolve = async ({ binding, projectSlug, project, inventory, toolchain, workspace }) => {
    if (!binding || !PROJECTS.includes(project)) return { status: 'unavailable' };
    const manifest = await preparedManifest(binding);
    const versions = dependencySeedToolchains(toolchain);
    // The existing protected v1 artifact records Node/pnpm versions, not Git.
    // Preserve its binding and payload proof; Java/Maven do not build this tree.
    const isolated = await isFrontendProjectIsolated({ inventory, project, workspace });
    const preparedInputs = frontendDependencyInputs({ files: manifest.inputs.map(({ path: relative, ...entry }) => ({ relative, ...entry })) }, project, isolated);
    if (manifest.projectSlug !== projectSlug || jsonDigest(preparedInputs) !== jsonDigest(frontendDependencyInputs(inventory, project, isolated))
      || manifest.toolchains?.platform !== versions.platform || manifest.toolchains?.arch !== versions.arch
      || FRONTEND_HOST_TOOL_NAMES.filter((name) => name !== 'git')
        .some((name) => manifest.toolchains?.[name] !== versions[name])) return { status: 'incompatible' };
    const entry = manifest.projects.find((item) => item.project === project);
    return entry ? verifyProject(binding, entry) : { status: 'unavailable' };
  };
  // Startup validates only the protected artifact. Task compatibility remains
  // mandatory above; no task inventory or business verification is fabricated.
  resolve.prepare = async ({ binding, projectSlug }) => {
    const manifest = await preparedManifest(binding);
    if (manifest === null) return { status: 'unavailable' };
    if (manifest.projectSlug !== projectSlug) invalid('Prepared dependency project mismatch.');
    for (const entry of manifest.projects) await verifyProject(binding, entry);
    return { status: 'ready', projects: manifest.projects.map((entry) => entry.project) };
  };
  return resolve;
}
