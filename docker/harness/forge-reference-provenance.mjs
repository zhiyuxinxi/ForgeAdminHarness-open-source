import { createHash } from 'node:crypto';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const STATUS = new Set(['A', 'C', 'D', 'M', 'R', 'T', 'U']);
const DEPENDENCY_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle(?:\.kts)?|requirements[^/]*\.txt|pyproject\.toml|Cargo\.(?:toml|lock)|go\.(?:mod|sum))$/u;

function requireValue(condition, message) {
  if (!condition) throw new Error('Invalid reference provenance policy: ' + message);
}

function exact(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), label);
}

function text(value, limit = 1024) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0\r\n]/u.test(value);
}

function relative(value) {
  return text(value) && !/[\\:*?]/u.test(value) && !value.startsWith('-')
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

// This is a consumer of independently reviewed evidence, not a licence issuer.
// A protected caller must authenticate the policy; model-authored JSON alone is
// not authority. Hashes bind retained reviews without rescanning source archives.
export function normalizeReferenceProvenancePolicy(value) {
  exact(value, ['schemaVersion', 'contractId', 'repository', 'baseCommit', 'head',
    'sourceManifestSha256', 'reviewEvidenceSha256', 'sources', 'files',
    'prohibitedPaths', 'prohibitedIdentifiers'], 'policy fields');
  requireValue(value.schemaVersion === 1 && HASH.test(value.contractId ?? '')
    && /^[a-z0-9][a-z0-9-]{1,62}$/u.test(value.repository ?? '')
    && COMMIT.test(value.baseCommit ?? '') && COMMIT.test(value.head ?? '')
    && HASH.test(value.sourceManifestSha256 ?? '') && HASH.test(value.reviewEvidenceSha256 ?? ''), 'identity bindings');
  requireValue(Array.isArray(value.sources) && value.sources.length <= 256
    && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 2048, 'bounded inventories');
  requireValue(Array.isArray(value.prohibitedPaths) && value.prohibitedPaths.length <= 256
    && value.prohibitedPaths.every(relative)
    && Array.isArray(value.prohibitedIdentifiers) && value.prohibitedIdentifiers.length <= 128
    && value.prohibitedIdentifiers.every(item => text(item, 256) && item.length >= 3), 'prohibited source markers');
  const sources = value.sources.map(source => {
    exact(source, ['id', 'path', 'sha256', 'repository', 'commit', 'licenseExpression',
      'licenseDocumentSha256', 'licenseReviewSha256', 'permission'], 'source fields');
    requireValue(text(source.id, 128) && relative(source.path) && HASH.test(source.sha256 ?? '')
      && ['approved', 'unproven', 'denied'].includes(source.permission), 'source identity');
    requireValue(source.path.toLowerCase() !== '.cursor/mcp.json', 'excluded credential source');
    for (const key of ['repository', 'commit', 'licenseExpression', 'licenseDocumentSha256', 'licenseReviewSha256']) {
      requireValue(source[key] === null || text(source[key]), 'source evidence value');
    }
    if (source.permission === 'approved') {
      let url;
      try { url = new URL(source.repository); } catch { /* checked below */ }
      requireValue(url?.protocol === 'https:' && !url.username && !url.password
        && !url.search && !url.hash && COMMIT.test(source.commit ?? '')
        && text(source.licenseExpression, 256) && !/^(?:NONE|NOASSERTION|UNLICENSED)$/iu.test(source.licenseExpression)
        && HASH.test(source.licenseDocumentSha256 ?? '') && HASH.test(source.licenseReviewSha256 ?? ''), 'approved source requires recorded origin and licence review');
    }
    return { ...source };
  });
  requireValue(new Set(sources.map(source => source.id)).size === sources.length, 'duplicate source identities');
  const files = value.files.map(file => {
    exact(file, ['path', 'oldPath', 'status', 'sha256', 'origin', 'sourceIds',
      'reviewEvidenceSha256', 'dependencyReviewSha256'], 'file fields');
    requireValue(relative(file.path) && STATUS.has(file.status)
      && (['R', 'C'].includes(file.status) ? relative(file.oldPath) : file.oldPath === null)
      && (file.status === 'D' ? file.sha256 === null : HASH.test(file.sha256 ?? ''))
      && ['original-change', 'reference', 'deletion'].includes(file.origin)
      && HASH.test(file.reviewEvidenceSha256 ?? '')
      && (file.dependencyReviewSha256 === null || HASH.test(file.dependencyReviewSha256)), 'file identity and review bindings');
    requireValue(Array.isArray(file.sourceIds) && file.sourceIds.length <= 256
      && file.sourceIds.every(id => text(id, 128))
      && new Set(file.sourceIds).size === file.sourceIds.length, 'file source identities');
    requireValue(file.status === 'D' ? file.origin === 'deletion' && file.sourceIds.length === 0
      : file.origin === 'reference' ? file.sourceIds.length > 0
        : file.origin === 'original-change' && file.sourceIds.length === 0, 'file origin kind');
    return { ...file, sourceIds: [...file.sourceIds].sort() };
  });
  requireValue(new Set(files.map(file => file.path)).size === files.length, 'duplicate target paths');
  const result = { ...value, sources: sources.sort((a, b) => a.id.localeCompare(b.id, 'en')),
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    prohibitedPaths: [...new Set(value.prohibitedPaths)].sort(),
    prohibitedIdentifiers: [...new Set(value.prohibitedIdentifiers)].sort() };
  requireValue(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024, 'policy size');
  return result;
}

export function auditReferenceProvenance({ policy: input, repository, baseCommit, head, contractId,
  completeTaskScope, files }) {
  const policy = normalizeReferenceProvenancePolicy(input);
  const findings = [];
  const reject = (file, code, message) => findings.push({ file, code, message });
  if (!completeTaskScope || repository !== policy.repository || baseCommit !== policy.baseCommit
      || head !== policy.head || contractId !== policy.contractId) {
    reject('<source-provenance>', 'SCOPE_MISMATCH', 'Origin evidence must bind this complete protected task diff, repository, base and HEAD.');
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 2048
      || new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error('Invalid actual provenance file inventory.');
  }
  const declared = new Map(policy.files.map(file => [file.path, file]));
  const sources = new Map(policy.sources.map(source => [source.id, source]));
  const actual = new Set(files.map(file => file.path));
  for (const file of policy.files) {
    if (!actual.has(file.path)) reject(file.path, 'EXTRA_DECLARATION', 'Origin declaration is not part of this actual diff.');
  }
  for (const file of files) {
    const reviewed = declared.get(file.path);
    if (!reviewed) {
      reject(file.path, 'MISSING_ORIGIN', 'Every changed task file needs an independently reviewed origin.');
      continue;
    }
    if (file.status !== reviewed.status || (file.oldPath ?? null) !== reviewed.oldPath
        || file.sha256 !== reviewed.sha256) {
      reject(file.path, 'FILE_BINDING_MISMATCH', 'Actual file bytes, Git status or rename/copy origin differ from the reviewed record.');
    }
    if (file.status === 'D') continue;
    if (file.opaque === true || typeof file.content !== 'string') {
      reject(file.path, 'UNREVIEWED_PAYLOAD', 'An unsupported or opaque payload cannot receive a text-origin verdict.');
      continue;
    }
    if (policy.prohibitedPaths.some(prefix => [file.path, file.oldPath].some(name => name === prefix || name?.startsWith(prefix + '/')))) {
      reject(file.path, 'PROHIBITED_PATH', 'Changed content or its rename/copy source is in a prohibited reference directory.');
    }
    if (policy.prohibitedIdentifiers.some(identifier => file.content.includes(identifier))) {
      reject(file.path, 'PROHIBITED_IDENTIFIER', 'Changed file retains a prohibited reference identifier.');
    }
    if (DEPENDENCY_FILE.test(file.path) && reviewed.dependencyReviewSha256 === null) {
      reject(file.path, 'DEPENDENCY_REVIEW_MISSING', 'A changed dependency manifest requires its own dependency and licence review evidence.');
    }
    for (const id of reviewed.sourceIds) {
      const source = sources.get(id);
      if (!source || source.permission !== 'approved') {
        reject(file.path, 'SOURCE_PERMISSION_UNPROVEN', 'Referenced source has no approved, hash-bound origin and licence review.');
      }
    }
    // A known reference copied verbatim cannot be relabelled original merely
    // by omitting its ID. Modified/adapted origins still need independent review.
    for (const source of sources.values()) {
      if (file.sha256 === source.sha256 && !reviewed.sourceIds.includes(source.id)) {
        reject(file.path, 'UNDECLARED_REFERENCE_COPY', 'Actual bytes match an inventoried reference omitted from the origin declaration.');
      }
    }
  }
  return {
    schemaVersion: 1,
    evidenceType: 'task-diff-source-origin-evidence-binding',
    ok: findings.length === 0,
    policySha256: digest(policy),
    sourceManifestSha256: policy.sourceManifestSha256,
    reviewEvidenceSha256: policy.reviewEvidenceSha256,
    scope: { repository, baseCommit, head, contractId, completeTaskScope: completeTaskScope === true },
    files: files.map(file => ({ path: file.path, oldPath: file.oldPath ?? null, status: file.status, sha256: file.sha256 })),
    findings,
    licenceGrantIssued: false,
    protectedIssuerVerified: false,
    boundary: 'Checks actual diff bindings against supplied reviewed evidence. The protected caller must authenticate that evidence; this checker neither issues licence rights nor proves semantic independence of adaptations.',
  };
}
