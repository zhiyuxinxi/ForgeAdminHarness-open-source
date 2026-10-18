import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectCapabilityInventoryIssues } from './forge-capability-inventory.mjs';

export const SIDE_EFFECT_CLASSES = Object.freeze([
  'read-only',
  'bounded-derived-write',
  'workspace-write',
  'git-write',
  'brokered-state-change',
  'controlled-release',
]);

export const EVAL_ACTOR_ROLES = Object.freeze([
  'product',
  'business-analyst',
  'developer',
  'reviewer',
  'release-operator',
  'platform-operator',
]);

const MATURITY_VALUES = new Set(['pilot', 'stable', 'deprecated']);
const SIDE_EFFECT_VALUES = new Set(SIDE_EFFECT_CLASSES);
const ACTOR_ROLE_VALUES = new Set(EVAL_ACTOR_ROLES);
const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_BUNDLE_FILES = 512;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.csv', '.html', '.js', '.json', '.jsx', '.log', '.md', '.mjs',
  '.ps1', '.py', '.sh', '.sql', '.svg', '.text', '.toml', '.ts', '.tsx', '.txt',
  '.vue', '.xml', '.yaml', '.yml',
]);
const FORBIDDEN_FILE_EXTENSIONS = new Set([
  '.der', '.jks', '.key', '.keystore', '.p12', '.pfx', '.pem', '.pyc',
]);

const SECRET_RULES = [
  {
    id: 'private-key',
    expression: /-----BEGIN (?:DSA |EC |OPENSSH |RSA )?PRIVATE KEY-----/g,
  },
  {
    id: 'openai-token',
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'github-token',
    expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'slack-token',
    expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: 'aws-access-key',
    expression: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'google-api-key',
    expression: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'bearer-credential',
    expression: /\b(?:authorization\s*[:=]\s*)?bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi,
    capture: 1,
  },
  {
    id: 'credential-assignment',
    expression: /\b(?:api[_-]?key|access[_-]?token|password|private[_-]?key|secret)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{12,})/gi,
    capture: 1,
  },
  {
    id: 'url-userinfo',
    expression: /https?:\/\/[^/\s:@]+:([^/\s@]+)@/gi,
    capture: 1,
  },
];

export class SkillBundleValidationError extends Error {
  constructor(issues) {
    super(`Skill bundle validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}.`);
    this.name = 'SkillBundleValidationError';
    this.issues = issues;
  }
}

function issue(code, file, message) {
  return { code, file: normalizeDisplayPath(file), message };
}

function normalizeDisplayPath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function looksLikePlaceholder(value) {
  const normalized = String(value ?? '').toLowerCase();
  return normalized.length === 0
    || normalized.includes('<')
    || normalized.includes('>')
    || normalized.includes('${')
    || normalized.includes('__')
    || normalized.includes('changeme')
    || normalized.includes('dummy')
    || normalized.includes('example')
    || normalized.includes('not-a-secret')
    || normalized.includes('placeholder')
    || normalized.includes('redacted')
    || normalized.includes('sample')
    || normalized.includes('test-only');
}

function scanSecretText(text, file) {
  const issues = [];
  for (const rule of SECRET_RULES) {
    const expression = new RegExp(rule.expression.source, rule.expression.flags);
    for (const match of text.matchAll(expression)) {
      const candidate = rule.capture ? match[rule.capture] : match[0];
      if (rule.capture && looksLikePlaceholder(candidate)) continue;
      issues.push(issue(
        'secret-material',
        file,
        `Credential-shaped material matched rule "${rule.id}" at line ${lineNumberAt(text, match.index ?? 0)}; the matched value is intentionally not displayed.`,
      ));
    }
  }
  return issues;
}

function stripFencedCode(text) {
  return text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, '$1');
}

function markdownTargets(text) {
  const withoutFences = stripFencedCode(text);
  const targets = [];
  const inline = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const references = /^[ \t]*\[[^\]]+\]:[ \t]*(\S+)[ \t]*(?:["'(].*)?$/gm;
  const html = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  for (const expression of [inline, references, html]) {
    for (const match of withoutFences.matchAll(expression)) {
      let target = match[1].trim();
      if (target.startsWith('<')) {
        const close = target.indexOf('>');
        target = close >= 0 ? target.slice(1, close) : target;
      } else if (expression === inline) {
        target = target.split(/[ \t]+["']/u, 1)[0];
      }
      if (target) targets.push({ target, index: match.index ?? 0 });
    }
  }
  return targets;
}

function externalLinkProtocol(target) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  return match?.[1]?.toLowerCase() ?? null;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function validateLinks(text, file, bundleRoot) {
  const issues = [];
  for (const { target, index } of markdownTargets(text)) {
    if (target.startsWith('#')) continue;
    const protocol = externalLinkProtocol(target);
    if (protocol) {
      if (!['http', 'https', 'mailto'].includes(protocol)) {
        issues.push(issue(
          'unsafe-link-protocol',
          file,
          `Link at line ${lineNumberAt(text, index)} uses forbidden protocol "${protocol}:".`,
        ));
      }
      continue;
    }
    if (path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target) || target.startsWith('\\\\')) {
      issues.push(issue(
        'absolute-local-link',
        file,
        `Local link at line ${lineNumberAt(text, index)} must be bundle-relative.`,
      ));
      continue;
    }
    const pathPart = target.split('#', 1)[0].split('?', 1)[0];
    if (!pathPart) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      issues.push(issue('invalid-link-encoding', file, `Link at line ${lineNumberAt(text, index)} has invalid percent encoding.`));
      continue;
    }
    const resolved = path.resolve(path.dirname(file), decoded);
    if (!isInside(bundleRoot, resolved)) {
      issues.push(issue(
        'link-escapes-bundle',
        file,
        `Local link at line ${lineNumberAt(text, index)} resolves outside the Skill bundle.`,
      ));
      continue;
    }
    if (!(await pathExists(resolved))) {
      issues.push(issue(
        'broken-local-link',
        file,
        `Local link at line ${lineNumberAt(text, index)} does not resolve to an existing bundle file.`,
      ));
    }
  }
  return issues;
}

// Only explicit mandatory declarations are inputs; examples are not commands.
function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const values = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function readJson(file, issues, code) {
  let text;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BUNDLE_FILE_BYTES) {
      issues.push(issue(code, file, `JSON must be a regular file no larger than ${MAX_BUNDLE_FILE_BYTES} bytes.`));
      return null;
    }
    text = await readFile(file, 'utf8');
  } catch (error) {
    issues.push(issue(code, file, `JSON could not be read: ${error.code ?? error.name ?? 'unknown-error'}.`));
    return null;
  }
  issues.push(...scanSecretText(text, file));
  try {
    return JSON.parse(text);
  } catch {
    issues.push(issue(
      code,
      file,
      'JSON could not be parsed; raw parser diagnostics are suppressed to avoid echoing file contents.',
    ));
    return null;
  }
}

async function walk(root, current = root) {
  const results = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(current, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      results.push({ path: target, type: 'symlink' });
    } else if (metadata.isDirectory()) {
      results.push({ path: target, type: 'directory' });
      results.push(...await walk(root, target));
    } else if (metadata.isFile()) {
      results.push({ path: target, type: 'file', size: metadata.size });
    } else {
      results.push({ path: target, type: 'special' });
    }
  }
  return results;
}

export async function sha256File(file) {
  const bytes = await readFile(file);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function unsignedLength(value) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

export async function sha256SkillTree(skillDirectory) {
  const root = path.resolve(skillDirectory);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError('Skill tree root must be a real directory.');
  }
  const tree = await walk(root);
  const unsupported = tree.find((item) => !['directory', 'file'].includes(item.type));
  if (unsupported) {
    throw new TypeError('Skill tree contains a symlink or special file.');
  }
  const files = tree
    .filter((item) => item.type === 'file')
    .map((item) => ({
      absolutePath: item.path,
      relativePath: normalizeDisplayPath(path.relative(root, item.path)),
    }))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.relativePath, 'utf8'),
      Buffer.from(right.relativePath, 'utf8'),
    ));

  if (files.length > MAX_BUNDLE_FILES) throw new TypeError('Skill tree exceeds the file-count limit.');
  let totalBytes = 0;

  const hash = createHash('sha256');
  hash.update('FORGE_SKILL_TREE_V1\0', 'utf8');
  for (const file of files) {
    const relativePath = Buffer.from(file.relativePath, 'utf8');
    const metadata = await lstat(file.absolutePath);
    if (metadata.size > MAX_BUNDLE_FILE_BYTES) throw new TypeError('Skill tree file exceeds the byte limit.');
    totalBytes += metadata.size;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new TypeError('Skill tree exceeds the total-byte limit.');
    const content = await readFile(file.absolutePath);
    hash.update(unsignedLength(relativePath.length));
    hash.update(relativePath);
    hash.update(unsignedLength(content.length));
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateCatalogEntry(entry, index, strict, schemaVersion) {
  const issues = [];
  const location = `catalog.skills[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [issue('catalog-entry-type', location, 'Skill entry must be an object.')];
  }
  if (typeof entry.name !== 'string' || !SAFE_NAME.test(entry.name)) {
    issues.push(issue('skill-name', location, 'Skill name must be lowercase kebab-case.'));
  }
  if (!MATURITY_VALUES.has(entry.maturity)) {
    issues.push(issue('skill-maturity', location, 'maturity must be pilot, stable, or deprecated.'));
  }
  if (typeof entry.role !== 'string' || !SAFE_IDENTIFIER.test(entry.role)) {
    issues.push(issue('skill-role', location, 'role must be a non-empty lowercase kebab-case capability role.'));
  }
  if (typeof entry.enforcement !== 'string' || !SAFE_IDENTIFIER.test(entry.enforcement)) {
    issues.push(issue('skill-enforcement', location, 'enforcement must be a non-empty lowercase kebab-case value.'));
  }
  if (strict || schemaVersion >= 2 || entry.sideEffectClass !== undefined) {
    if (!SIDE_EFFECT_VALUES.has(entry.sideEffectClass)) {
      issues.push(issue(
        'skill-side-effect',
        location,
        `sideEffectClass must be one of: ${SIDE_EFFECT_CLASSES.join(', ')}.`,
      ));
    }
  }
  if (entry.sideEffectClass === 'controlled-release' && entry.enforcement !== 'runner-backed') {
    issues.push(issue(
      'release-enforcement',
      location,
      'A controlled-release Skill must declare enforcement=runner-backed.',
    ));
  }
  if (strict || schemaVersion >= 2 || entry.contentSha256 !== undefined) {
    if (typeof entry.contentSha256 !== 'string' || !SHA256.test(entry.contentSha256)) {
      issues.push(issue('skill-content-hash', location, 'contentSha256 must be a lowercase sha256:<64 hex> digest.'));
    }
  }
  if (strict || schemaVersion >= 2 || entry.treeSha256 !== undefined) {
    if (typeof entry.treeSha256 !== 'string' || !SHA256.test(entry.treeSha256)) {
      issues.push(issue('skill-tree-hash', location, 'treeSha256 must be a lowercase sha256:<64 hex> digest.'));
    }
  }
  return issues;
}

function validateStringArray(value, location, field, issues) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    issues.push(issue('eval-skill-list', location, `${field} must be an array of non-empty Skill names.`));
    return [];
  }
  if (new Set(value).size !== value.length) {
    issues.push(issue('eval-skill-list-duplicate', location, `${field} must not contain duplicate Skill names.`));
  }
  return value;
}

export function collectEvalSuiteIssues({ suite, catalog, evalPath = 'evals.json', strict = true }) {
  const issues = [];
  const catalogEntries = Array.isArray(catalog?.skills) ? catalog.skills : [];
  const knownSkills = new Map(catalogEntries.map((entry) => [entry.name, entry]));
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    return [issue('eval-suite-type', evalPath, 'Eval suite must be a JSON object.')];
  }
  if (suite.schemaVersion !== 1) {
    issues.push(issue('eval-schema-version', evalPath, 'Eval suite schemaVersion must be 1.'));
  }
  if (suite.bundleVersion !== catalog?.bundleVersion) {
    issues.push(issue('eval-bundle-version', evalPath, 'Eval suite bundleVersion must exactly match the Skill catalog.'));
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    issues.push(issue('eval-cases', evalPath, 'Eval suite must contain at least one case.'));
    return issues;
  }

  const ids = new Set();
  const positiveCoverage = new Set();
  const negativeCoverage = new Set();
  for (const [index, evalCase] of suite.cases.entries()) {
    const location = `${evalPath}#cases[${index}]`;
    if (!evalCase || typeof evalCase !== 'object' || Array.isArray(evalCase)) {
      issues.push(issue('eval-case-type', location, 'Eval case must be an object.'));
      continue;
    }
    if (typeof evalCase.id !== 'string' || !SAFE_IDENTIFIER.test(evalCase.id)) {
      issues.push(issue('eval-id', location, 'Eval case id must be lowercase kebab-case.'));
    } else if (ids.has(evalCase.id)) {
      issues.push(issue('eval-id-duplicate', location, `Eval case id "${evalCase.id}" is duplicated.`));
    } else {
      ids.add(evalCase.id);
    }
    if (typeof evalCase.prompt !== 'string' || evalCase.prompt.trim().length < 4 || evalCase.prompt.length > 4000) {
      issues.push(issue('eval-prompt', location, 'prompt must contain between 4 and 4000 characters.'));
    } else {
      issues.push(...scanSecretText(evalCase.prompt, location));
    }
    if (!ACTOR_ROLE_VALUES.has(evalCase.actorRole)) {
      issues.push(issue('eval-actor-role', location, `actorRole must be one of: ${EVAL_ACTOR_ROLES.join(', ')}.`));
    }
    if (!SIDE_EFFECT_VALUES.has(evalCase.maximumAuthorizedSideEffect)) {
      issues.push(issue(
        'eval-side-effect',
        location,
        `maximumAuthorizedSideEffect must be one of: ${SIDE_EFFECT_CLASSES.join(', ')}.`,
      ));
    }
    const expected = validateStringArray(evalCase.expectedSkills, location, 'expectedSkills', issues);
    const forbidden = validateStringArray(evalCase.forbiddenSkills, location, 'forbiddenSkills', issues);
    if (expected.length === 0 && forbidden.length === 0) {
      issues.push(issue('eval-empty-expectation', location, 'At least one expected or forbidden Skill is required.'));
    }
    const overlap = expected.filter((name) => forbidden.includes(name));
    if (overlap.length > 0) {
      issues.push(issue('eval-expectation-overlap', location, 'A Skill cannot be both expected and forbidden in one case.'));
    }
    for (const name of [...expected, ...forbidden]) {
      if (!knownSkills.has(name)) {
        issues.push(issue('eval-unknown-skill', location, `Eval case references uncataloged Skill "${name}".`));
      }
    }
    const maximumIndex = SIDE_EFFECT_CLASSES.indexOf(evalCase.maximumAuthorizedSideEffect);
    if (maximumIndex >= 0) {
      for (const name of expected) {
        const declared = knownSkills.get(name)?.sideEffectClass;
        const declaredIndex = SIDE_EFFECT_CLASSES.indexOf(declared);
        if (declaredIndex > maximumIndex) {
          issues.push(issue(
            'eval-side-effect-exceeded',
            location,
            `Expected Skill "${name}" declares sideEffectClass=${declared}, which exceeds this case's maximumAuthorizedSideEffect.`,
          ));
        }
      }
    }
    expected.forEach((name) => positiveCoverage.add(name));
    forbidden.forEach((name) => negativeCoverage.add(name));
  }

  if (strict) {
    for (const name of knownSkills.keys()) {
      if (!positiveCoverage.has(name)) {
        issues.push(issue('eval-positive-coverage', evalPath, `Skill "${name}" has no positive implicit-trigger case.`));
      }
      if (!negativeCoverage.has(name)) {
        issues.push(issue('eval-negative-coverage', evalPath, `Skill "${name}" has no negative implicit-trigger case.`));
      }
    }
  }
  return issues;
}

export function collectBehaviorSuiteSkillIssues({
  suite,
  catalog,
  suitePath = 'behavior-suite.json',
}) {
  const issues = [];
  const knownSkills = new Set(
    (Array.isArray(catalog?.skills) ? catalog.skills : [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string'),
  );
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    return [issue('behavior-suite-type', suitePath, 'Behavior suite must be a JSON object.')];
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    return [issue('behavior-suite-cases', suitePath, 'Behavior suite must contain at least one case.')];
  }

  for (const [index, behaviorCase] of suite.cases.entries()) {
    const location = `${suitePath}#cases[${index}].expectedTrace.skillCallsAll`;
    const requiredSkills = behaviorCase?.expectedTrace?.skillCallsAll;
    if (!Array.isArray(requiredSkills)
      || requiredSkills.length === 0
      || requiredSkills.some((name) => typeof name !== 'string' || name.length === 0)) {
      issues.push(issue(
        'behavior-required-skills',
        location,
        'expectedTrace.skillCallsAll must be a non-empty array of exact Skill names.',
      ));
      continue;
    }
    if (new Set(requiredSkills).size !== requiredSkills.length) {
      issues.push(issue(
        'behavior-required-skills-duplicate',
        location,
        'expectedTrace.skillCallsAll must not contain duplicate Skill names.',
      ));
    }
    for (const name of requiredSkills) {
      if (!knownSkills.has(name)) {
        issues.push(issue(
          'behavior-unknown-required-skill',
          location,
          `Behavior case references uncataloged required Skill "${name}".`,
        ));
      }
    }
  }
  return issues;
}

export function defaultCapabilityInventoryPath() {
  return process.env.FORGE_CAPABILITY_INVENTORY_PATH
    ?? (fileURLToPath(import.meta.url) === '/usr/local/lib/validate-skill-bundle.mjs'
      ? '/usr/local/share/forge-image-build/capability-inventory.json' : undefined);
}

export async function validateSkillBundle({
  skillsRoot,
  bundleRoot,
  catalogPath,
  evalPath,
  behaviorSuitePath,
  capabilityInventoryPath = defaultCapabilityInventoryPath(),
  strict = true,
} = {}) {
  const configuredRoot = skillsRoot ?? bundleRoot;
  if (!configuredRoot || !catalogPath) {
    throw new TypeError('skillsRoot and catalogPath are required.');
  }
  const root = path.resolve(configuredRoot);
  const catalogFile = path.resolve(catalogPath);
  const evalFile = evalPath ? path.resolve(evalPath) : null;
  const behaviorSuiteFile = behaviorSuitePath ? path.resolve(behaviorSuitePath) : null;
  const issues = [];

  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    issues.push(issue('bundle-root', root, `Skill bundle root is unavailable: ${error.code ?? error.message}`));
  }
  if (rootMetadata && (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())) {
    issues.push(issue('bundle-root-type', root, 'Skill bundle root must be a real directory, not a symlink.'));
  }
  const catalog = await readJson(catalogFile, issues, 'catalog-json');
  if (!catalog) throw new SkillBundleValidationError(issues);

  if (strict && catalog.schemaVersion !== 2) {
    issues.push(issue('catalog-schema-version', catalogFile, 'Strict Skill catalogs must use schemaVersion 2.'));
  } else if (![1, 2].includes(catalog.schemaVersion)) {
    issues.push(issue('catalog-schema-version', catalogFile, 'Skill catalog schemaVersion must be 1 or 2.'));
  }
  if (typeof catalog.bundleVersion !== 'string' || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(catalog.bundleVersion)) {
    issues.push(issue('bundle-version', catalogFile, 'bundleVersion must use YYYY.MM.DD.N format.'));
  }
  if (!Array.isArray(catalog.skills) || catalog.skills.length === 0) {
    issues.push(issue('catalog-skills', catalogFile, 'Catalog must contain at least one Skill.'));
  }

  const entries = Array.isArray(catalog.skills) ? catalog.skills : [];
  entries.forEach((entry, index) => issues.push(...validateCatalogEntry(entry, index, strict, catalog.schemaVersion)));
  if (capabilityInventoryPath) {
    const inventory = await readJson(path.resolve(capabilityInventoryPath), issues, 'inventory-json');
    if (inventory) issues.push(...collectCapabilityInventoryIssues({ inventory, catalog }));
  } else if (entries.some(entry => entry.requiredTools !== undefined)) {
    issues.push(issue('inventory-required', catalogFile, 'Explicit requiredTools declarations require the generated runtime capability inventory.'));
  }
  const names = entries.map((entry) => entry?.name).filter((name) => typeof name === 'string');
  if (new Set(names).size !== names.length) {
    issues.push(issue('catalog-duplicate-skill', catalogFile, 'Catalog Skill names must be unique.'));
  }

  let tree = [];
  if (rootMetadata?.isDirectory() && !rootMetadata.isSymbolicLink()) {
    tree = await walk(root);
    const bundleFiles = tree.filter((item) => item.type === 'file');
    const bundleBytes = bundleFiles.reduce((sum, item) => sum + item.size, 0);
    if (bundleFiles.length > MAX_BUNDLE_FILES) {
      issues.push(issue('bundle-file-limit', root, `Skill bundle must contain at most ${MAX_BUNDLE_FILES} files.`));
    }
    if (bundleBytes > MAX_BUNDLE_BYTES) {
      issues.push(issue('bundle-byte-limit', root, `Skill bundle must contain at most ${MAX_BUNDLE_BYTES} bytes.`));
    }
    for (const item of tree) {
      if (item.type === 'symlink') {
        issues.push(issue('bundle-symlink', item.path, 'Symlinks are forbidden inside a Skill bundle.'));
      } else if (item.type === 'special') {
        issues.push(issue('bundle-special-file', item.path, 'Special files are forbidden inside a Skill bundle.'));
      } else if (item.type === 'file' && FORBIDDEN_FILE_EXTENSIONS.has(path.extname(item.path).toLowerCase())) {
        issues.push(issue('bundle-forbidden-file', item.path, 'Compiled artifacts and credential-container file types are forbidden.'));
      } else if (item.type === 'file' && item.size > MAX_BUNDLE_FILE_BYTES) {
        issues.push(issue('bundle-file-byte-limit', item.path, `Skill file must be no larger than ${MAX_BUNDLE_FILE_BYTES} bytes.`));
      }
    }

    const topLevel = await readdir(root, { withFileTypes: true });
    const directoryNames = topLevel.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const catalogNames = [...names].sort();
    for (const name of directoryNames.filter((name) => !catalogNames.includes(name))) {
      issues.push(issue('uncataloged-skill-directory', path.join(root, name), 'Skill directory is not present in the catalog.'));
    }
    for (const name of catalogNames.filter((name) => !directoryNames.includes(name))) {
      issues.push(issue('missing-skill-directory', path.join(root, name), 'Cataloged Skill directory is missing.'));
    }
    for (const entry of topLevel.filter((item) => !item.isDirectory())) {
      issues.push(issue('bundle-root-entry', path.join(root, entry.name), 'Only cataloged Skill directories are allowed at the bundle root.'));
    }
  }

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !SAFE_NAME.test(entry.name)) continue;
    const skillDirectory = path.resolve(root, entry.name);
    if (!isInside(root, skillDirectory)) continue;
    const skillFile = path.join(skillDirectory, 'SKILL.md');
    if (!(await pathExists(skillFile))) {
      issues.push(issue('missing-skill-file', skillFile, 'Cataloged Skill must contain SKILL.md.'));
      continue;
    }
    const skillMetadata = await lstat(skillFile);
    if (skillMetadata.size > MAX_BUNDLE_FILE_BYTES) {
      issues.push(issue('bundle-file-byte-limit', skillFile, `Skill file must be no larger than ${MAX_BUNDLE_FILE_BYTES} bytes.`));
      continue;
    }
    const bytes = await readFile(skillFile);
    const text = bytes.toString('utf8');
    if (bytes.includes(13)) {
      issues.push(issue('skill-crlf', skillFile, 'Linux image Skill files must use LF line endings.'));
    }
    const frontmatter = parseFrontmatter(text);
    if (!frontmatter) {
      issues.push(issue('skill-frontmatter', skillFile, 'SKILL.md must start with closed YAML frontmatter.'));
    } else {
      if (frontmatter.name !== entry.name) {
        issues.push(issue('skill-frontmatter-name', skillFile, 'Frontmatter name must exactly match the catalog entry and directory.'));
      }
      if (typeof frontmatter.description !== 'string' || frontmatter.description.trim().length === 0) {
        issues.push(issue('skill-frontmatter-description', skillFile, 'Frontmatter description must be a non-empty inline value.'));
      }
    }
    const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (entry.contentSha256 !== undefined && entry.contentSha256 !== actualHash) {
      issues.push(issue('skill-content-hash-mismatch', skillFile, 'SKILL.md bytes do not match catalog contentSha256.'));
    }
    if (entry.treeSha256 !== undefined) {
      try {
        const actualTreeHash = await sha256SkillTree(skillDirectory);
        if (entry.treeSha256 !== actualTreeHash) {
          issues.push(issue(
            'skill-tree-hash-mismatch',
            skillDirectory,
            'Skill directory bytes do not match catalog treeSha256.',
          ));
        }
      } catch {
        issues.push(issue(
          'skill-tree-hash-unavailable',
          skillDirectory,
          'Skill directory tree hash could not be computed from ordinary files only.',
        ));
      }
    }
  }

  for (const item of tree.filter((entry) => entry.type === 'file')) {
    const extension = path.extname(item.path).toLowerCase();
    if (item.size > MAX_BUNDLE_FILE_BYTES) continue;
    const bytes = await readFile(item.path);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      issues.push(issue('bundle-non-text-file', item.path, 'Skill bundle files must be valid UTF-8 text; opaque binary resources are forbidden.'));
      continue;
    }
    issues.push(...scanSecretText(text, item.path));
    // Prose is guidance, not executable authority. Structural paths, links,
    // secrets and runtime capabilities are validated independently of wording.
    if (['.md', '.html'].includes(extension) || path.basename(item.path) === 'SKILL.md') {
      issues.push(...await validateLinks(text, item.path, root));
    }
  }

  let suite = null;
  if (evalFile) {
    let evalMetadata;
    try {
      evalMetadata = await lstat(evalFile);
    } catch (error) {
      issues.push(issue('eval-path', evalFile, `Eval path is unavailable: ${error.code ?? error.message}`));
    }
    let evalFiles = [];
    if (evalMetadata?.isSymbolicLink()) {
      issues.push(issue('eval-symlink', evalFile, 'Eval path must not be a symlink.'));
    } else if (evalMetadata?.isFile()) {
      evalFiles = [evalFile];
    } else if (evalMetadata?.isDirectory()) {
      const evalEntries = await readdir(evalFile, { withFileTypes: true });
      for (const entry of evalEntries) {
        if (entry.isSymbolicLink()) {
          issues.push(issue('eval-symlink', path.join(evalFile, entry.name), 'Symlinks are forbidden inside an eval suite.'));
        }
      }
      evalFiles = evalEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.eval.json'))
        .map((entry) => path.join(evalFile, entry.name))
        .sort();
      if (evalFiles.length === 0) {
        issues.push(issue('eval-files', evalFile, 'Eval directory must contain at least one *.eval.json file.'));
      }
    } else if (evalMetadata) {
      issues.push(issue('eval-path-type', evalFile, 'Eval path must be a file or directory.'));
    }
    const suites = [];
    for (const file of evalFiles) {
      const value = await readJson(file, issues, 'eval-json');
      if (value) suites.push({ file, value });
    }
    if (suites.length > 0) {
      suite = {
        schemaVersion: 1,
        bundleVersion: catalog.bundleVersion,
        cases: suites.flatMap(({ value }) => Array.isArray(value.cases) ? value.cases : []),
      };
      for (const { file, value } of suites) {
        if (value.schemaVersion !== 1) {
          issues.push(issue('eval-schema-version', file, 'Eval suite schemaVersion must be 1.'));
        }
        if (value.bundleVersion !== catalog.bundleVersion) {
          issues.push(issue('eval-bundle-version', file, 'Eval suite bundleVersion must exactly match the Skill catalog.'));
        }
        if (!Array.isArray(value.cases)) {
          issues.push(issue('eval-cases', file, 'Eval suite file must contain a cases array.'));
        }
      }
      issues.push(...collectEvalSuiteIssues({ suite, catalog, evalPath: evalFile, strict }));
    }
  }

  if (behaviorSuiteFile) {
    const behaviorSuite = await readJson(behaviorSuiteFile, issues, 'behavior-suite-json');
    if (behaviorSuite) {
      issues.push(...collectBehaviorSuiteSkillIssues({
        suite: behaviorSuite,
        catalog,
        suitePath: behaviorSuiteFile,
      }));
    }
  }

  if (issues.length > 0) throw new SkillBundleValidationError(issues);
  return {
    bundleVersion: catalog.bundleVersion,
    caseCount: Array.isArray(suite?.cases) ? suite.cases.length : 0,
    schemaVersion: catalog.schemaVersion,
    skillCount: entries.length,
    strict,
  };
}

function parseArguments(argv) {
  const result = { strict: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--strict') result.strict = true;
    else if (argument === '--json') result.json = true;
    else if (['--skills-root', '--bundle-root', '--catalog', '--evals', '--behavior-suite', '--capability-inventory'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      index += 1;
      if (argument === '--skills-root' || argument === '--bundle-root') result.skillsRoot = value;
      else if (argument === '--catalog') result.catalogPath = value;
      else if (argument === '--evals') result.evalPath = value;
      else if (argument === '--capability-inventory') result.capabilityInventoryPath = value;
      else result.behaviorSuitePath = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.skillsRoot || !result.catalogPath) {
    throw new Error('Usage: validate-skill-bundle.mjs --skills-root <dir> --catalog <file> [--capability-inventory <file>] [--evals <file-or-dir>] [--behavior-suite <file>] [--strict] [--json]');
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    const result = await validateSkillBundle(options);
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    else process.stdout.write(`PASS Skill bundle ${result.bundleVersion}: ${result.skillCount} Skills, ${result.caseCount} trigger eval cases.\n`);
  } catch (error) {
    if (error instanceof SkillBundleValidationError) {
      const payload = {
        ok: false,
        issues: error.issues,
      };
      if (options?.json) process.stderr.write(`${JSON.stringify(payload)}\n`);
      else {
        process.stderr.write(`${error.message}\n`);
        for (const item of error.issues) {
          process.stderr.write(`- [${item.code}] ${item.file}: ${item.message}\n`);
        }
      }
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
