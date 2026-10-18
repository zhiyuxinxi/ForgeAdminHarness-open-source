import crypto from 'node:crypto';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { mavenInputClosure } from './release-inputs.mjs';

export const INPUT_SOURCE_PROJECTION = 'verification-input-source-projection';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relative = value => typeof value === 'string' && value.length > 0 && value.length < 512
  && !value.includes('\\') && !value.startsWith('/') && !value.includes('\0')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const under = (file, root) => file === root || file.startsWith(`${root}/`);

export function validateVerificationInputScopes(scopes, profiles) {
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) throw new Error('Invalid verification input scopes.');
  for (const [profile, scope] of Object.entries(scopes)) {
    if (!profiles.includes(profile) || !scope || !['tree', 'maven'].includes(scope.kind)
      || Object.keys(scope).some(key => !['kind', 'root', 'inputs', 'rootFiles'].includes(key))
      || !relative(scope.root) || !Array.isArray(scope.inputs) || scope.inputs.some(value => !relative(value))
      || typeof scope.rootFiles !== 'boolean') throw new Error(`Invalid verification inputs for ${profile}.`);
  }
  return scopes;
}

// Host-owned definitions declare the command input boundary. Maven selectors
// expand through POM dependencies. Other layouts retain normal execution when
// no input proof is available; a model cannot supply or narrow this definition.
export async function verificationInputIdentity(source, profile, selectors, scopes) {
  const scope = scopes?.[profile];
  if (!scope || !Array.isArray(source.inventory?.files) || !source.workspace) return null;
  try {
    const files = new Map(source.inventory.files.filter(file => !file.deleted).map(file => [file.relative, file]));
    const selected = new Set();
    if (scope.kind === 'maven') {
      if (!selectors.modules?.length) return null;
      const cache = new Map();
      const read = async file => {
        if (cache.has(file)) return cache.get(file);
        const absolute = path.join(source.workspace, file), metadata = await lstat(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 2 * 1024 ** 2) throw new Error('Invalid POM input.');
        const bytes = await readFile(absolute);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== files.get(file)?.sha256) throw new Error('POM changed during observation.');
        cache.set(file, bytes.toString('utf8')); return cache.get(file);
      };
      const moduleRoots = [...files.keys()].filter(file => file.endsWith('/pom.xml')).map(file => path.posix.dirname(file));
      for (const module of selectors.modules) {
        if (!under(module, scope.root) || module === scope.root) return null;
        const closure = await mavenInputClosure(scope.root, module.slice(scope.root.length + 1), files, read, { tests: true });
        closure.files.forEach(file => selected.add(file));
        const excluded = moduleRoots.filter(root => root !== scope.root && !closure.modules.includes(root));
        for (const file of files.keys()) if (closure.modules.some(root => under(file, root))
          && !excluded.some(root => under(file, root))) selected.add(file);
      }
    } else {
      for (const file of files.keys()) if (under(file, scope.root)) selected.add(file);
    }
    for (const file of files.keys()) if (scope.inputs.some(root => under(file, root)) || scope.rootFiles && !file.includes('/')) selected.add(file);
    const entries = [...selected].sort().map(file => [file, files.get(file)?.sha256, files.get(file)?.bytes]);
    if (!entries.length || entries.some(([, sha, bytes]) => !/^[a-f0-9]{64}$/.test(sha ?? '') || !Number.isSafeInteger(bytes))) return null;
    return { schemaVersion: 1, digest: hash({ scope, profile, selectors, entries }), fileCount: entries.length };
  } catch { return null; }
}

export function validateVerificationInputIdentity(value) {
  if (!value || value.schemaVersion !== 1 || Object.keys(value).sort().join(',') !== 'digest,fileCount,schemaVersion'
    || !/^[a-f0-9]{64}$/.test(value.digest ?? '') || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1) throw new Error('Invalid verification input identity.');
  return value;
}

export function validateInputSourceProjection(projection, receipt, current) {
  validateVerificationInputIdentity(receipt.inputIdentity);
  if (!projection || projection.kind !== INPUT_SOURCE_PROJECTION || projection.schemaVersion !== 1
    || Object.keys(projection).sort().join(',') !== 'currentFingerprint,currentHead,inputDigest,kind,originalFingerprint,originalHead,schemaVersion'
    || projection.inputDigest !== receipt.inputIdentity.digest
    || projection.originalFingerprint !== receipt.source.workspaceFingerprint || projection.originalHead !== receipt.source.head
    || projection.currentFingerprint !== current.workspaceFingerprint || projection.currentHead !== current.head) throw new Error('Verification input projection does not bind this execution and admission.');
  return current;
}
