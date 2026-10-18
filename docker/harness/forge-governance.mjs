#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { auditForgeUiContract, loadForgeUiContract } from './forge-ui-contract.mjs';
import { normalizeGovernanceTaskScope, normalizeGovernanceRoleGrantPolicy, normalizeAcceptedApiContract } from './verify-policy.mjs';
import { auditReferenceProvenance, normalizeReferenceProvenancePolicy } from './forge-reference-provenance.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2048;
const POLICY_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'forge-governance-policy.json'),
  '/usr/local/share/forge-governance-policy.json',
];
const REQUIRED_TABLE_COLUMNS = [
  'id', 'tenant_id', 'create_by', 'create_time', 'create_dept', 'update_by', 'update_time', 'del_flag',
];
const RELEVANT_EXTENSIONS = new Set([
  '.java', '.xml', '.sql', '.vue', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.bpmn',
  '.json', '.yaml', '.yml', '.properties', '.gradle', '.kts', '.sh', '.bash', '.toml',
  '.md', '.html', '.css', '.scss', '.less',
]);
const IGNORED_PATH_PARTS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', 'coverage', '.pnpm-store']);
const SAFE_REF = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/u;

class GovernanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function parseArgs(argv) {
  const options = { command: argv[0], root: process.cwd(), base: 'HEAD', format: 'text', paths: [], taskOwnedPaths: [] };
  if (!['audit', 'catalog', 'explain', 'help', '--help', '-h'].includes(options.command ?? '')) {
    throw new GovernanceError('INVALID_COMMAND', 'Usage: forge-governance audit|catalog|explain [options]');
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--base') options.base = argv[++index];
    else if (argument === '--expected-no-change-head') options.expectedNoChangeHead = argv[++index];
    else if (argument === '--format') options.format = argv[++index];
    else if (argument === '--path') options.paths.push(argv[++index]);
    else if (argument === '--task-contract-id' && options.taskContractId === undefined) options.taskContractId = argv[++index];
    else if (argument === '--task-owned-path') options.taskOwnedPaths.push(argv[++index]);
    else if (argument === '--accepted-api-contract' && options.acceptedApiContract === undefined) {
      options.acceptedApiContract = normalizeAcceptedApiContract(JSON.parse(argv[++index]));
    }
    else if (argument === '--role-grant-policy' && options.roleGrantPolicy === undefined) {
      options.roleGrantPolicy = normalizeGovernanceRoleGrantPolicy(JSON.parse(argv[++index]));
    }
    else if (argument === '--source-provenance-policy' && options.sourceProvenancePolicy === undefined) {
      options.sourceProvenancePolicy = normalizeReferenceProvenancePolicy(JSON.parse(argv[++index]));
    }
    else if (argument === '--rule') options.rule = argv[++index];
    else throw new GovernanceError('INVALID_ARGUMENT', `Unknown argument: ${argument}`);
  }
  if (!['json', 'text'].includes(options.format)) throw new GovernanceError('INVALID_FORMAT', '--format must be json or text');
  if (typeof options.root !== 'string' || options.root.length === 0) throw new GovernanceError('INVALID_ROOT', '--root cannot be empty');
  if (!SAFE_REF.test(options.base)) throw new GovernanceError('INVALID_BASE', '--base is not a safe Git commit reference');
  if (Object.hasOwn(options, 'expectedNoChangeHead') && !/^[0-9a-f]{40}$/u.test(options.expectedNoChangeHead ?? '')) {
    throw new GovernanceError('INVALID_NO_CHANGE_HEAD', '--expected-no-change-head must be a full commit SHA');
  }
  if (options.taskContractId !== undefined || options.taskOwnedPaths.length > 0) {
    if (options.command !== 'audit' || options.paths.length > 0) throw new GovernanceError('INVALID_TASK_SCOPE', 'Task scope cannot be combined with diagnostic paths.');
    options.taskScope = normalizeGovernanceTaskScope({ contractId: options.taskContractId, ownedPaths: options.taskOwnedPaths });
  }
  if (options.roleGrantPolicy !== undefined && (options.command !== 'audit' || options.paths.length > 0
    || (options.taskScope !== undefined && options.taskScope.contractId !== options.roleGrantPolicy.contractId))) {
    throw new GovernanceError('INVALID_ROLE_POLICY', 'Role decisions require a complete audit of the same protected contract.');
  }
  if (options.sourceProvenancePolicy !== undefined && (options.command !== 'audit'
      || options.paths.length > 0 || options.taskScope?.contractId !== options.sourceProvenancePolicy.contractId)) {
    throw new GovernanceError('INVALID_SOURCE_PROVENANCE_POLICY', 'Source reviews require the complete matching task scope.');
  }
  return options;
}

function help() {
  return [
    'forge-governance audit [--root PATH] [--base REF] [--expected-no-change-head SHA] [--path RELATIVE]... [--format text|json]',
    'forge-governance catalog [--format text|json]',
    'forge-governance explain --rule RULE_ID [--format text|json]',
    '',
    'audit is read-only. Without --path it scans tracked changes plus untracked files relative to --base.',
    '--expected-no-change-head permits an empty audit only when base and HEAD match that SHA and the full workspace is clean.',
    'Protected Host task checks may supply --task-contract-id SHA and --task-owned-path RELATIVE; this proves that task scope, never a complete release diff.',
    'The policy is loaded only from the versioned Harness bundle; repository-authored bypasses are not accepted.',
  ].join('\n');
}

async function loadPolicy() {
  for (const candidate of POLICY_CANDIDATES) {
    const stat = await lstat(candidate).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
    let policy;
    try { policy = JSON.parse(await readFile(candidate, 'utf8')); } catch { continue; }
    validatePolicy(policy);
    return { policy, candidate };
  }
  throw new GovernanceError('POLICY_UNAVAILABLE', 'The versioned Forge governance policy is unavailable or invalid.');
}

export function validatePolicy(policy) {
  if (policy?.schemaVersion !== 1 || typeof policy.policyVersion !== 'string'
      || typeof policy.profile !== 'string' || !Array.isArray(policy.rules)
      || !Array.isArray(policy.exceptions)
      || !Array.isArray(policy.exceptionPolicy?.nonExemptibleRules)) {
    throw new GovernanceError('POLICY_INVALID', 'Forge governance policy schema is invalid.');
  }
  const ids = new Set();
  for (const rule of policy.rules) {
    if (!rule || !/^[A-Z][A-Z0-9-]{2,63}$/u.test(rule.id ?? '') || ids.has(rule.id)
        || !['block', 'review', 'advisory'].includes(rule.severity)
        || !['deterministic', 'semantic', 'runtime'].includes(rule.enforcement)
        || typeof rule.detector !== 'string' || typeof rule.summary !== 'string'
        || !Array.isArray(rule.requiredEvidence)) {
      throw new GovernanceError('POLICY_INVALID', 'Forge governance policy contains an invalid or duplicate rule.');
    }
    ids.add(rule.id);
  }
  const exceptionIds = new Set();
  for (const exception of policy.exceptions) {
    const expiry = Date.parse(exception?.expiresAt ?? '');
    if (!exception || !/^EXC-[A-Z0-9-]{3,80}$/u.test(exception.id ?? '') || exceptionIds.has(exception.id)
        || !ids.has(exception.ruleId) || policy.exceptionPolicy.nonExemptibleRules.includes(exception.ruleId)
        || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(exception.repository ?? '')
        || normalizeRelative(exception.path ?? '', 'exception path') !== exception.path
        || !/^sha256:[a-f0-9]{64}$/u.test(exception.contentSha256 ?? '')
        || typeof exception.approvalRef !== 'string' || exception.approvalRef.length < 3 || exception.approvalRef.length > 200
        || typeof exception.owner !== 'string' || exception.owner.length < 2 || exception.owner.length > 120
        || typeof exception.reason !== 'string' || exception.reason.length < 8 || exception.reason.length > 1000
        || !Number.isFinite(expiry)) {
      throw new GovernanceError('POLICY_INVALID', 'Forge governance policy contains an invalid, duplicate, or unsafe exception.');
    }
    exceptionIds.add(exception.id);
  }
}

function gitEnvironment() {
  const env = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    WINDIR: process.env.WINDIR ?? '',
    TMP: process.env.TMP ?? '',
    TEMP: process.env.TEMP ?? '',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };
  return env;
}

function runGit(root, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', [
    '-c', 'core.hooksPath=',
    '-c', 'diff.external=',
    '-c', 'pager.diff=false',
    '-c', 'core.quotepath=false',
    ...args,
  ], {
    cwd: root,
    env: gitEnvironment(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(0, 500) : '';
    throw new GovernanceError('GIT_DISCOVERY_FAILED', `Read-only Git discovery failed${detail ? `: ${detail}` : '.'}`);
  }
  return result;
}

function normalizeRelative(input, label = 'path') {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\\') || input.includes('\0')) {
    throw new GovernanceError('UNSAFE_PATH', `${label} must be a non-empty POSIX repository-relative path.`);
  }
  const normalized = path.posix.normalize(input.replace(/^\.\//u, ''));
  if (normalized !== input.replace(/^\.\//u, '') || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) {
    throw new GovernanceError('UNSAFE_PATH', `${label} escapes the repository.`);
  }
  return normalized;
}

async function resolveRoot(rootInput) {
  const resolved = path.resolve(rootInput);
  const stat = await lstat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GovernanceError('UNSAFE_ROOT', 'Audit root must be a real no-follow directory.');
  }
  const actual = await realpath(resolved);
  if (path.resolve(actual) !== resolved) throw new GovernanceError('UNSAFE_ROOT', 'Audit root resolves through a link.');
  runGit(resolved, ['rev-parse', '--is-inside-work-tree']);
  const gitRoot = runGit(resolved, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (path.resolve(gitRoot) !== resolved) throw new GovernanceError('UNSAFE_ROOT', '--root must be the Git worktree root.');
  return resolved;
}

async function resolveInputFile(root, relative) {
  const segments = normalizeRelative(relative).split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) {
      throw new GovernanceError('UNSAFE_PATH', `Audited path is missing or linked: ${relative}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new GovernanceError('UNSAFE_PATH', `Audited path contains a non-directory parent: ${relative}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new GovernanceError('UNSAFE_PATH', `Audited path is not a regular file: ${relative}`);
    }
  }
  const fromRoot = path.relative(root, current);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new GovernanceError('UNSAFE_PATH', `Audited path escaped the repository: ${relative}`);
  }
  const stat = await lstat(current);
  if (stat.size > MAX_FILE_BYTES) throw new GovernanceError('FILE_TOO_LARGE', `Audited file exceeds ${MAX_FILE_BYTES} bytes: ${relative}`);
  return { absolute: current, stat };
}

function parseNameStatus(buffer) {
  const tokens = buffer.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (!/^[ACDMRTUXB][0-9]*$/u.test(statusToken)) {
      throw new GovernanceError('GIT_DISCOVERY_FAILED', 'Git returned an unsupported name-status record.');
    }
    if (statusToken.startsWith('R') || statusToken.startsWith('C')) {
      const oldPath = normalizeRelative(tokens[index++], 'old Git path');
      const newPath = normalizeRelative(tokens[index++], 'new Git path');
      records.push({ status: statusToken[0], path: newPath, oldPath });
    } else {
      records.push({ status: statusToken[0], path: normalizeRelative(tokens[index++], 'Git path') });
    }
  }
  return records;
}

function relevantPath(relative) {
  const segments = relative.split('/');
  const javaSource = /^forge-server\/.+\/src\/(?:main|test)\/java\/.+\.java$/u.test(relative);
  const sqlResource = /^forge-server\/.+\/src\/(?:main|test)\/resources\/.+\.sql$/u.test(relative);
  if (segments.some((segment) => IGNORED_PATH_PARTS.has(segment)
    && !(segment === 'coverage' && (javaSource || sqlResource)))) return false;
  if (relative === 'AGENTS.md' || relative.endsWith('/SKILL.md')) return true;
  if (relative === 'docker-forge-admin/Dockerfile.admin'
    || /(?:^|\/)(?:Dockerfile|[^/]+\.dockerfile)$/iu.test(relative)) return true;
  if (/(?:^|\/)(?:mvnw|gradlew|forge-governance|forge-delivery|forge-release)$/u.test(relative)) return true;
  if (path.posix.extname(relative) === '' && /(?:^|\/)(?:scripts|bin|docker)\//u.test(relative)) return true;
  return RELEVANT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase());
}

function collectChangedRecords(root, base, requestedPaths) {
  runGit(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (requestedPaths.length > 0) {
    return [...new Set(requestedPaths.map((item) => normalizeRelative(item, '--path')))]
      .map((filePath) => ({ status: 'P', path: filePath }));
  }
  const diff = runGit(root, ['diff', '--no-ext-diff', '--find-renames=50%', '--name-status', '-z', '--diff-filter=ACDMRTUXB', base, '--'], { encoding: null });
  const records = parseNameStatus(diff.stdout);
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null })
    .stdout.toString('utf8').split('\0').filter(Boolean)
    .map((filePath) => ({ status: 'U', path: normalizeRelative(filePath, 'untracked Git path') }));
  const byPath = new Map();
  for (const record of [...records, ...untracked]) {
    byPath.set(record.path, record);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function parseAddedLines(diffText) {
  const additions = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    const header = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(line);
    if (header) {
      newLine = Number.parseInt(header[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+')) {
      additions.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return additions;
}

function changedLines(root, baseCommit, record, content) {
  if (['A', 'U', 'P'].includes(record.status)) {
    return content.split('\n').map((text, index) => ({ line: index + 1, text }));
  }
  const diff = runGit(root, [
    'diff', '--no-ext-diff', '--no-color', '--unified=0', baseCommit, '--', record.path,
  ]).stdout;
  return parseAddedLines(diff);
}

async function hydrateRecords(root, records, baseCommit) {
  if (records.length > MAX_FILES) throw new GovernanceError('TOO_MANY_FILES', `Audit scope exceeds ${MAX_FILES} files.`);
  const hydrated = [];
  let totalBytes = 0;
  for (const record of records) {
    if (record.status === 'D') {
      hydrated.push({ ...record, content: '', bytes: 0, sha256: null });
      continue;
    }
    const resolved = await resolveInputFile(root, record.path);
    const bytes = await readFile(resolved.absolute);
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new GovernanceError('OPAQUE_SOURCE', `Audited source is not valid UTF-8 text: ${record.path}`);
    }
    if (content.includes('\0')) throw new GovernanceError('OPAQUE_SOURCE', `Audited source contains opaque NUL bytes: ${record.path}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new GovernanceError('SCOPE_TOO_LARGE', `Audit scope exceeds ${MAX_TOTAL_BYTES} bytes.`);
    const additions = changedLines(root, baseCommit, record, content);
    // Existing frontend and Java sources can retain unchanged review-base debt.
    // Added, copied, renamed and explicit diagnostic paths stay fully checked.
    const baseContent = record.status === 'M'
      && /^(?:forge-(?:admin|h5)-ui\/src\/.+\.(?:vue|[jt]sx?)|forge-server\/.+\/src\/main\/java\/.+\.java|forge-server\/.+\/src\/main\/resources\/forge\/i18n\/business\/messages\.properties)$/u.test(record.path)
      ? runGit(root, ['show', `${baseCommit}:${record.path}`]).stdout : null;
    hydrated.push({
      ...record,
      content,
      baseContent,
      addedLines: additions,
      addedContent: additions.map((item) => item.text).join('\n'),
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return hydrated;
}

function migrationMetadata(file) {
  const match = /^forge-server\/db\/migration\/V(\d+(?:\.\d+)+)__([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u.exec(file);
  if (!match) return null;
  return { version: match[1], parts: match[1].split('.').map(Number), description: match[2] };
}

function compareVersionParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function nulPaths(result, label) {
  return result.stdout.toString('utf8').split('\0').filter(Boolean)
    .map((file) => normalizeRelative(file, label));
}

function scanMigrationInventory(root, baseCommit, records, findings) {
  const basePaths = nulPaths(runGit(root, [
    'ls-tree', '-r', '--name-only', '-z', baseCommit, '--', 'forge-server/db/migration',
  ], { encoding: null }), 'base migration path');
  const currentPaths = [
    ...nulPaths(runGit(root, ['ls-files', '-z', '--', 'forge-server/db/migration'], { encoding: null }), 'tracked migration path'),
    ...nulPaths(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'forge-server/db/migration'], { encoding: null }), 'untracked migration path'),
  ];
  const changedPaths = new Set(records.map((record) => record.path));
  for (const record of records.filter((item) => item.status === 'R' && migrationMetadata(item.oldPath ?? '') !== null)) {
    findings.push(finding('DB-MIGRATION-001', record.path, 1,
      `Applied Flyway migration cannot be renamed or moved: ${record.oldPath} -> ${record.path}.`,
      { oldPath: record.oldPath, newPath: record.path }));
  }
  const baseVersions = basePaths.map(migrationMetadata).filter(Boolean);
  const maxBase = baseVersions.map((item) => item.parts).sort(compareVersionParts).at(-1) ?? null;
  const byVersion = new Map();
  for (const file of new Set(currentPaths)) {
    const metadata = migrationMetadata(file);
    if (!metadata) continue;
    const paths = byVersion.get(metadata.version) ?? [];
    paths.push(file);
    byVersion.set(metadata.version, paths);
  }
  for (const [version, files] of byVersion) {
    if (files.length < 2 || !files.some((file) => changedPaths.has(file))) continue;
    for (const file of files.filter((item) => changedPaths.has(item))) {
      findings.push(finding('DB-MIGRATION-002', file, 1,
        `Flyway version ${version} is duplicated by: ${files.sort().join(', ')}.`, { version, files: files.sort() }));
    }
  }
  if (maxBase !== null) {
    for (const record of records.filter((item) => ['A', 'C', 'R', 'U', 'P'].includes(item.status))) {
      const metadata = migrationMetadata(record.path);
      if (metadata && compareVersionParts(metadata.parts, maxBase) <= 0) {
        findings.push(finding('DB-MIGRATION-002', record.path, 1,
          `New Flyway version ${metadata.version} does not advance beyond the reviewed base migration.`));
      }
    }
  }
}

function lineAt(content, index) {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

function lineAtAddition(record, index) {
  const ordinal = record.addedContent.slice(0, Math.max(0, index)).split('\n').length - 1;
  return record.addedLines[ordinal]?.line ?? 1;
}

function rangeTouchesAddedLine(record, content, start, end) {
  if (!Array.isArray(record.addedLines) || record.addedLines.length === 0) return false;
  const first = lineAt(content, start);
  const last = lineAt(content, Math.max(start, end - 1));
  return record.addedLines.some((item) => item.line >= first && item.line <= last);
}

function finding(ruleId, file, line, message, evidence = {}) {
  return { ruleId, file, line: Math.max(1, line || 1), message, evidence };
}

function maskComments(content) {
  let result = '';
  let index = 0;
  let state = 'code';
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (state === 'code' && ((char === '-' && next === '-') || (char === '/' && next === '/'))) {
      result += '  '; index += 2; state = 'line'; continue;
    }
    if (state === 'code' && char === '#') { result += ' '; index += 1; state = 'line'; continue; }
    if (state === 'code' && char === '/' && next === '*') { result += '  '; index += 2; state = 'block'; continue; }
    if (state === 'code' && (char === "'" || char === '"')) { result += ' '; index += 1; state = char === "'" ? 'single' : 'double'; continue; }
    if (state === 'line') { result += char === '\n' ? '\n' : ' '; index += 1; if (char === '\n') state = 'code'; continue; }
    if (state === 'block') {
      if (char === '*' && next === '/') { result += '  '; index += 2; state = 'code'; }
      else { result += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const delimiter = state === 'single' ? "'" : '"';
      result += char === '\n' ? '\n' : ' ';
      if (char === '\\' && next !== undefined) { result += next === '\n' ? '\n' : ' '; index += 2; continue; }
      if (char === delimiter && next === delimiter) { result += ' '; index += 2; continue; }
      index += 1;
      if (char === delimiter) state = 'code';
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function maskJavaComments(content) {
  let result = '';
  let index = 0;
  let state = 'code';
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (state === 'code' && char === '/' && next === '/') {
      result += '  '; index += 2; state = 'line'; continue;
    }
    if (state === 'code' && char === '/' && next === '*') {
      result += '  '; index += 2; state = 'block'; continue;
    }
    if (state === 'code' && (char === '"' || char === "'")) {
      state = char === '"' ? 'double' : 'single'; result += char; index += 1; continue;
    }
    if (state === 'line') {
      result += char === '\n' ? '\n' : ' '; index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { result += '  '; index += 2; state = 'code'; }
      else { result += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const delimiter = state === 'single' ? "'" : '"';
      result += char;
      if (char === '\\' && next !== undefined) { result += next; index += 2; continue; }
      index += 1;
      if (char === delimiter) state = 'code';
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function maskJavaScriptNonCode(content) {
  let result = '';
  let index = 0;
  let state = 'code';
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (state === 'code' && char === '/' && next === '/') {
      result += '  '; index += 2; state = 'line'; continue;
    }
    if (state === 'code' && char === '/' && next === '*') {
      result += '  '; index += 2; state = 'block'; continue;
    }
    if (state === 'code' && (char === '"' || char === "'" || char === '`')) {
      result += ' '; index += 1;
      state = char === '"' ? 'double' : char === "'" ? 'single' : 'template';
      continue;
    }
    if (state === 'line') {
      result += char === '\n' ? '\n' : ' '; index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { result += '  '; index += 2; state = 'code'; }
      else { result += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (['single', 'double', 'template'].includes(state)) {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      result += char === '\n' ? '\n' : ' ';
      if (char === '\\' && next !== undefined) {
        result += next === '\n' ? '\n' : ' '; index += 2; continue;
      }
      index += 1;
      if (char === delimiter) state = 'code';
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function maskJavaNonCode(content) {
  let result = '';
  let index = 0;
  let state = 'code';
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    const third = content[index + 2];
    if (state === 'code' && char === '/' && next === '/') {
      result += '  '; index += 2; state = 'line'; continue;
    }
    if (state === 'code' && char === '/' && next === '*') {
      result += '  '; index += 2; state = 'block'; continue;
    }
    if (state === 'code' && char === '"' && next === '"' && third === '"') {
      result += '   '; index += 3; state = 'text-block'; continue;
    }
    if (state === 'code' && (char === '"' || char === "'")) {
      result += ' '; index += 1; state = char === '"' ? 'double' : 'single'; continue;
    }
    if (state === 'line') {
      result += char === '\n' ? '\n' : ' '; index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { result += '  '; index += 2; state = 'code'; }
      else { result += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'text-block') {
      if (char === '"' && next === '"' && third === '"') { result += '   '; index += 3; state = 'code'; }
      else { result += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'single' || state === 'double') {
      const delimiter = state === 'single' ? "'" : '"';
      result += char === '\n' ? '\n' : ' ';
      if (char === '\\' && next !== undefined) {
        result += next === '\n' ? '\n' : ' '; index += 2; continue;
      }
      index += 1;
      if (char === delimiter) state = 'code';
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function persistenceReceiver(code, methodIndex) {
  const prefix = code.slice(Math.max(0, methodIndex - 180), methodIndex);
  if (!prefix.trimEnd().endsWith('.')) return { kind: 'inherited', start: methodIndex };
  const match = /\b(this|super|baseMapper|getBaseMapper\s*\(\s*\)|mapper|service|[A-Za-z_$][\w$]*(?:Mapper|Service))\s*\.\s*$/iu.exec(prefix);
  if (!match) return null;
  return { kind: 'qualified', start: methodIndex - (prefix.length - match.index), receiver: match[1] };
}

function localMapBusinessResult(content, code, receiver, methodIndex, open, close) {
  if (receiver.kind !== 'inherited' && receiver.receiver !== 'this') return false;
  // Resolve only simple methods on this single named class. Nested/anonymous
  // owners, unknown overloads and external/inherited contracts stay guarded.
  if ([...code.matchAll(/\b(?:class|interface|enum|record)\s+[A-Za-z_$][\w$]*/gu)].length !== 1
      || /\bnew\s+[\w$.]+(?:\s*<[^;{}()]*>)?\s*\([^;{}]*\)\s*\{/u.test(code)) return false;
  const argumentsCode = code.slice(open + 1, close);
  if (/[{}<>\[\]]/u.test(argumentsCode)) return false;
  const args = maskJavaComments(content.slice(open + 1, close)).trim();
  const arity = args ? splitTopLevel(args).length : 0;
  const name = code.slice(methodIndex, open).trim();
  const declarations = new RegExp(String.raw`(?:^|[;{}])\s*(?:(?:public|protected|private|static|final|synchronized|abstract)\s+)*([\w$.]+(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?)\s+${name}\s*\(([^;{}()]*)\)\s*(?:throws\s+[\w$.,\s]+)?[;{]`, 'gu');
  const matches = [];
  for (const declaration of code.matchAll(declarations)) {
    const start = declaration.index + (/[;{}]/u.test(declaration[0][0]) ? 1 : 0);
    let depth = 0;
    for (const char of code.slice(0, start)) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth !== 1) continue;
    const parameters = declaration[2].trim();
    if (/[<>@]|\.\.\./u.test(parameters)) return false;
    if ((parameters ? splitTopLevel(parameters).length : 0) === arity) matches.push(declaration[1].replace(/\s*<.*>$/u, ''));
  }
  if (matches.length !== 1) return false;
  return matches[0] === 'java.util.Map'
    || (matches[0] === 'Map' && /\bimport\s+java\.util\.(?:Map|\*)\s*;/u.test(code));
}

function unsafeJavaScriptIntegerLiterals(source, baseOffset = 0, templateExpressions) {
  const results = [];
  const numberPattern = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:\d(?:_?\d)*)?(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*)(?:n)?/u;
  const expressionKeywords = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield']);

  function skipRegex(index, end) {
    let inClass = false;
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (source[cursor] === '\\') { cursor += 1; continue; }
      if (source[cursor] === '[') inClass = true;
      else if (source[cursor] === ']') inClass = false;
      else if (source[cursor] === '/' && !inClass) {
        cursor += 1;
        while (cursor < end && /[a-z]/iu.test(source[cursor])) cursor += 1;
        return cursor;
      } else if (source[cursor] === '\n' || source[cursor] === '\r') return index + 1;
    }
    return index + 1;
  }

  function scan(start, end, stopAtTemplateBrace = false) {
    let index = start;
    let braceDepth = stopAtTemplateBrace ? 1 : 0;
    let expressionExpected = true;
    while (index < end) {
      const char = source[index];
      const next = source[index + 1];
      if (/\s/u.test(char)) { index += 1; continue; }
      if (char === '/' && next === '/') {
        index += 2;
        while (index < end && !['\n', '\r'].includes(source[index])) index += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        const close = source.indexOf('*/', index + 2);
        index = close < 0 ? end : close + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        const delimiter = char;
        index += 1;
        while (index < end) {
          if (source[index] === '\\') { index += 2; continue; }
          if (source[index++] === delimiter) break;
        }
        expressionExpected = false;
        continue;
      }
      if (char === '`') {
        index += 1;
        while (index < end) {
          if (source[index] === '\\') { index += 2; continue; }
          if (source[index] === '`') { index += 1; break; }
          if (source[index] === '$' && source[index + 1] === '{') {
            templateExpressions?.add(baseOffset + index + 1);
            index = scan(index + 2, end, true);
            continue;
          }
          index += 1;
        }
        expressionExpected = false;
        continue;
      }
      if (char === '/' && expressionExpected) {
        index = skipRegex(index, end);
        expressionExpected = false;
        continue;
      }
      if (/[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(next ?? ''))) {
        const match = numberPattern.exec(source.slice(index, end));
        if (match && match[0].length > 0) {
          const token = match[0];
          if (!token.endsWith('n')) {
            const value = Number(token.replaceAll('_', ''));
            if (Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
              results.push({ index: baseOffset + index, token });
            }
          }
          index += token.length;
          expressionExpected = false;
          continue;
        }
      }
      if (/[A-Za-z_$]/u.test(char)) {
        const match = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index, end));
        index += match[0].length;
        expressionExpected = expressionKeywords.has(match[0]);
        continue;
      }
      if (stopAtTemplateBrace && char === '{') { braceDepth += 1; index += 1; expressionExpected = true; continue; }
      if (stopAtTemplateBrace && char === '}') {
        braceDepth -= 1; index += 1;
        if (braceDepth === 0) return index;
        expressionExpected = false;
        continue;
      }
      expressionExpected = !/[\])}]/u.test(char) && !/^(?:\+\+|--)$/u.test(source.slice(index, index + 2));
      index += 1;
    }
    return index;
  }

  scan(0, source.length);
  return results;
}

function frontendJavaScriptSegments(file, content) {
  if (!file.endsWith('.vue')) return [{ source: content, offset: 0 }];
  const segments = [];
  for (const match of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)) {
    const offset = match.index + match[0].indexOf(match[1]);
    segments.push({ source: match[1], offset });
  }
  for (const match of content.matchAll(/(?:^|\s)(?::[\w-]+|@[\w-]+|v-(?:bind|on|model)(?::[\w-]+)?)\s*=\s*(["'])([\s\S]*?)\1/giu)) {
    const offset = match.index + match[0].indexOf(match[2]);
    segments.push({ source: match[2], offset });
  }
  return segments;
}

function annotationStringPath(argumentsText = '') {
  return /(?:\b(?:path|value)\s*=\s*)?(?:\{\s*)?"([^"]*)"/u.exec(argumentsText)?.[1] ?? '';
}

function javaHttpMappings(content) {
  const code = maskJavaComments(content);
  const mappings = [];
  for (const match of code.matchAll(/@(Get|Post|Put|Delete|Patch)Mapping\b\s*(?:\(([^)]*)\))?/gu)) {
    mappings.push({
      index: match.index,
      end: match.index + match[0].length,
      method: match[1],
      path: annotationStringPath(match[2]),
      code,
    });
  }
  return mappings;
}

function javaEndpointSignature(content, mapping) {
  const endpoint = javaEndpointSource(content, mapping);
  if (!endpoint) return null;
  const code = maskJavaNonCode(endpoint.source);
  const declaration = code.search(/\bpublic\b/u);
  if (declaration < 0) return null;
  const header = /^public\s+(?:(?:static|final|synchronized)\s+)*([\w$.]+(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])*)(?:\s+|(?<=[>\]]))([\w$]+)\s*\(/u.exec(code.slice(declaration));
  if (!header) return null;
  const open = declaration + header[0].length - 1;
  const close = findMatchingParenthesis(code, open);
  if (close < 0) return null;
  const signature = [endpoint.source.slice(declaration, close + 1), header[1], endpoint.source.slice(open + 1, close)];
  signature.index = endpoint.start + declaration - mapping.index;
  return signature;
}

function hasServletStreamingParameter(content, parameters) {
  const code = maskJavaNonCode(content);
  const imported = /\bimport\s+(?:jakarta|javax)\.servlet\.http\.HttpServletResponse\s*;/u.test(code);
  const params = maskJavaNonCode(parameters);
  return /(?:^|,)\s*(?:final\s+)?(?:jakarta|javax)\.servlet\.http\.HttpServletResponse\s+[\w$]+\s*(?=,|$)/u.test(params)
    || (imported && /(?:^|,)\s*(?:final\s+)?HttpServletResponse\s+[\w$]+\s*(?=,|$)/u.test(params));
}

function findMatchingParenthesis(content, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== null) {
      if (char === quote && content[index + 1] === quote) { index += 1; continue; }
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(content, separator = /^,/u) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== null) {
      if (char === quote && content[index + 1] === quote) { index += 1; continue; }
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0) {
      const delimiter = separator.exec(content.slice(index));
      if (delimiter) {
        parts.push(content.slice(start, index));
        index += delimiter[0].length - 1;
        start = index + 1;
      }
    }
  }
  parts.push(content.slice(start));
  return parts;
}

function createTables(content) {
  const masked = maskComments(content);
  const pattern = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|([A-Za-z0-9_.]+))\s*\(/giu;
  const tables = [];
  for (const match of masked.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = findMatchingParenthesis(masked, open);
    if (close < 0) {
      tables.push({ name: match[1] ?? match[2], index: match.index, malformed: true, columns: new Map(), constraints: [], tail: '' });
      continue;
    }
    const body = content.slice(open + 1, close);
    const columns = new Map();
    const constraints = [];
    for (const part of splitTopLevel(body)) {
      const trimmed = part.trim();
      const column = /^(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s+(.+)$/isu.exec(trimmed);
      const name = (column?.[1] ?? column?.[2] ?? '').toLowerCase();
      if (name && !['primary', 'unique', 'key', 'constraint', 'index', 'foreign', 'check'].includes(name)) {
        columns.set(name, { definition: column[3], offset: body.indexOf(part) });
      } else constraints.push(trimmed);
    }
    const semicolon = content.indexOf(';', close);
    const tail = content.slice(close + 1, semicolon >= 0 ? semicolon : Math.min(content.length, close + 1000));
    tables.push({ name: match[1] ?? match[2], index: match.index, open, close, columns, constraints, tail, malformed: false });
  }
  return tables;
}

function insertUsesTenantZero(statement) {
  const columnOpen = statement.indexOf('(');
  if (columnOpen < 0) return false;
  const columnClose = findMatchingParenthesis(statement, columnOpen);
  if (columnClose < 0) return false;
  const columns = splitTopLevel(statement.slice(columnOpen + 1, columnClose))
    .map((item) => item.trim().replace(/`/gu, '').split('.').at(-1)?.toLowerCase());
  const tenantIndex = columns.indexOf('tenant_id');
  if (tenantIndex < 0) return false;
  const remainder = statement.slice(columnClose + 1);
  const valuesMatch = /\bVALUES\b/iu.exec(remainder);
  if (!valuesMatch) return false;
  let cursor = columnClose + 1 + valuesMatch.index + valuesMatch[0].length;
  while (cursor < statement.length) {
    while (/[\s,]/u.test(statement[cursor] ?? '')) cursor += 1;
    if (statement[cursor] !== '(') break;
    const tupleClose = findMatchingParenthesis(statement, cursor);
    if (tupleClose < 0) break;
    const values = splitTopLevel(statement.slice(cursor + 1, tupleClose));
    const tenantValue = values[tenantIndex]?.trim() ?? '';
    if (/^(?:0|'0'|"0")$/u.test(tenantValue)) return true;
    cursor = tupleClose + 1;
  }
  return false;
}

function insertColumnsAndRows(statement) {
  const insert = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+(?:`([^`]+)`|([A-Za-z0-9_.]+))\s*/iu.exec(statement);
  if (!insert) return null;
  const table = (insert[1] ?? insert[2]).split('.').at(-1).replace(/`/gu, '').toLowerCase();
  const columnOpen = statement.indexOf('(', insert.index + insert[0].length);
  if (columnOpen < 0) return { table, columns: [], rows: [] };
  const columnClose = findMatchingParenthesis(statement, columnOpen);
  if (columnClose < 0) return { table, columns: [], rows: [] };
  const columns = splitTopLevel(statement.slice(columnOpen + 1, columnClose))
    .map((item) => item.trim().replace(/`/gu, '').split('.').at(-1)?.toLowerCase());
  const remainder = statement.slice(columnClose + 1);
  const valuesMatch = /\bVALUES\b/iu.exec(remainder);
  if (valuesMatch) {
    const rows = [];
    let cursor = columnClose + 1 + valuesMatch.index + valuesMatch[0].length;
    while (cursor < statement.length) {
      while (/[\s,]/u.test(statement[cursor] ?? '')) cursor += 1;
      if (statement[cursor] !== '(') break;
      const tupleClose = findMatchingParenthesis(statement, cursor);
      if (tupleClose < 0) break;
      rows.push(splitTopLevel(statement.slice(cursor + 1, tupleClose)));
      cursor = tupleClose + 1;
    }
    return { table, columns, rows };
  }

  if (table === 'sys_resource') {
    const branches = splitTopLevel(remainder, /^UNION\b/iu);
    if (branches.length > 1) {
      const rows = [];
      for (const [index, branch] of branches.entries()) {
        const select = (index === 0 ? /^\s*SELECT\b/iu : /^\s*ALL\s+SELECT\b/iu).exec(branch);
        if (!select) return { table, columns, rows: [], unresolvedResourceUnion: true };
        // Reuse the existing projection parser, without evaluating a seed JOIN
        // or treating the first branch as evidence for the remaining routes.
        const parsed = insertColumnsAndRows(`${statement.slice(0, columnClose + 1)} SELECT${branch.slice(select[0].length)}`);
        const row = parsed?.rows[0];
        if (parsed?.rows.length !== 1 || row.length !== columns.length
          || sqlInteger(rowValue(parsed, row, 'resource_type')) === null) {
          return { table, columns, rows: [], unresolvedResourceUnion: true };
        }
        rows.push(row);
      }
      return { table, columns, rows };
    }
  }

  const selectMatch = /\bSELECT\b/iu.exec(remainder);
  if (!selectMatch) return { table, columns, rows: [] };
  const projectionStart = columnClose + 1 + selectMatch.index + selectMatch[0].length;
  let depth = 0;
  let quote = null;
  let projectionEnd = statement.length;
  for (let index = projectionStart; index < statement.length; index += 1) {
    const char = statement[index];
    if (quote !== null) {
      if (char === quote && statement[index + 1] === quote) { index += 1; continue; }
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth -= 1; continue; }
    if (depth === 0 && /^(?:FROM|WHERE|UNION|ON\s+DUPLICATE)\b/iu.test(statement.slice(index))) {
      projectionEnd = index;
      break;
    }
  }
  const projection = splitTopLevel(statement.slice(projectionStart, projectionEnd));
  const literalRows = table === 'sys_resource'
    ? literalDerivedResourceRows(statement, projectionEnd, projection, columns.indexOf('parent_id')) : null;
  return { table, columns, rows: literalRows?.rows ?? [projection], menuOwners: literalRows?.menuOwners };
}

// Resolve only a directly selected, single-level table of constant seed rows.
// Unsupported expressions retain the original projection and its literal checks.
function literalDerivedResourceRows(statement, fromIndex, projection, parentIndex) {
  const from = /^FROM\s*\(/iu.exec(statement.slice(fromIndex));
  if (!from) return null;
  const open = fromIndex + from[0].length - 1;
  const close = findMatchingParenthesis(statement, open);
  if (close < 0) return null;
  const alias = /^\s*(?:AS\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)(?=\s|$)/iu.exec(statement.slice(close + 1));
  if (!alias) return null;
  const tableAlias = alias[1].replaceAll('`', '').toLowerCase();
  const tail = statement.slice(close + 1 + alias[0].length);
  if (!/^\s*(?:WHERE\b|ON\s+DUPLICATE\b|$)/iu.test(tail)) {
    const join = /^\s*JOIN\s+(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+(?:AS\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+ON\b/iu.exec(tail);
    if (!join || join[1].replaceAll('`', '').toLowerCase() === tableAlias) return null;
    // A joined table can select the parent, but cannot change constant seed values.
    // Its own projected fields remain unresolved and retain the literal checks.
  }
  const branches = splitTopLevel(statement.slice(open + 1, close), /^UNION\s+ALL\b/iu);
  const names = [];
  const rows = [];
  for (const [branchIndex, branch] of branches.entries()) {
    const select = /^\s*SELECT\s+([\s\S]+)$/iu.exec(branch);
    if (!select) return null;
    const values = [];
    for (const expression of splitTopLevel(select[1])) {
      const constant = /^\s*('(?:''|[^'])*'|"(?:""|[^"])*"|-?\d+(?:\.\d+)?|NULL)(?:\s+(?:AS\s+)?(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*))?\s*$/iu.exec(expression);
      if (!constant) return null;
      if (branchIndex === 0) {
        if (!constant[2]) return null;
        const name = constant[2].replaceAll('`', '').toLowerCase();
        if (names.includes(name)) return null;
        names.push(name);
      }
      values.push(constant[1]);
    }
    if (values.length !== names.length) return null;
    rows.push(values);
  }
  const resolvedRows = rows.map((values) => projection.map((expression) => {
    const reference = /^\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s*$/u.exec(expression);
    if (!reference || reference[1].replaceAll('`', '').toLowerCase() !== tableAlias) return expression;
    const index = names.indexOf(reference[2].replaceAll('`', '').toLowerCase());
    return index >= 0 ? values[index] : expression;
  }));
  return { rows: resolvedRows, menuOwners: rows.map(values => joinedMenuOwner(tail, tableAlias, names, values, projection[parentIndex])) };
}

// The Forge menu identity is tenant/type/perms/client/deletion state. This is
// a static identity binding, not evidence that a migration ran or a row exists.
function menuOwner(predicates, qualifier = '', resolve = expression => expression) {
  const fields = new Map();
  for (const predicate of splitTopLevel(predicates, /^AND\b/iu)) {
    const match = /^\s*([\w`.]+)\s*=\s*([\s\S]+?)\s*$/u.exec(predicate);
    if (!match) return null;
    const name = match[1].replaceAll('`', '').toLowerCase();
    if (qualifier && !name.startsWith(`${qualifier}.`)) return null;
    const field = qualifier ? name.slice(qualifier.length + 1) : name;
    if (!['tenant_id', 'resource_type', 'perms', 'client_code', 'del_flag'].includes(field) || fields.has(field)) return null;
    const expression = resolve(match[2].trim());
    const value = ['tenant_id', 'resource_type', 'del_flag'].includes(field) ? sqlInteger(expression) : sqlLiteral(expression);
    if (value === null || value === undefined || value === '') return null;
    fields.set(field, value);
  }
  if (fields.size !== 5 || fields.get('resource_type') !== 2 || fields.get('del_flag') !== 0) return null;
  return JSON.stringify(['tenant_id', 'resource_type', 'perms', 'client_code', 'del_flag'].map(field => fields.get(field)));
}

function joinedMenuOwner(tail, seedAlias, names, values, parent) {
  const join = /^\s*JOIN\s+`?sys_resource`?\s+(?:AS\s+)?(`[^`]+`|[A-Za-z_]\w*)\s+ON\s+([\s\S]*?)(?:\s+WHERE\s+[\s\S]*)?\s*$/iu.exec(tail);
  if (!join) return null;
  const alias = join[1].replaceAll('`', '').toLowerCase();
  if (alias === seedAlias || parent?.replace(/[\s`]/gu, '').toLowerCase() !== `${alias}.id`) return null;
  return menuOwner(join[2], alias, expression => {
    const reference = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/u.exec(expression.replaceAll('`', ''));
    if (!reference || reference[1].toLowerCase() !== seedAlias) return expression;
    return values[names.indexOf(reference[2].toLowerCase())] ?? '';
  });
}

function scalarMenuOwner(record, index, parent) {
  if (!/^@[A-Za-z_]\w*$/u.test(parent)) return null;
  const source = record.content.slice(0, index);
  let owner = null;
  let offset = 0;
  for (const statement of splitTopLevel(maskComments(source), /^;/u)) {
    const assignment = /^\s*SET\s+(@[A-Za-z_]\w*)\s*(?::=|=)\s*/iu.exec(statement);
    if (assignment?.[1].toLowerCase() === parent) {
      // Mask only locates syntax; literal values must come from the original SQL.
      const value = source.slice(offset + assignment[0].length, offset + statement.length).trim();
      const lookup = /^\(\s*SELECT\s+id\s+FROM\s+`?sys_resource`?\s+WHERE\s+([\s\S]+?)\s+ORDER\s+BY\s+id\s+LIMIT\s+1\s*\)$/iu.exec(value);
      owner = lookup ? menuOwner(lookup[1]) : null;
    } else if (new RegExp(`${parent}\\s*(?::=|=)|\\bINTO\\s+${parent}\\b`, 'iu').test(statement)) owner = null;
    offset += statement.length + 1;
  }
  return owner;
}

function sameResourceMenu(left, right) {
  if (left.menuOwner || right.menuOwner) return Boolean(left.menuOwner && right.menuOwner && left.menuOwner === right.menuOwner);
  // A qualified SQL alias has meaning only inside its own SELECT. Identical
  // alias spellings in two statements are not evidence of the same menu.
  if (left.parent.includes('.') || right.parent.includes('.')) return false;
  return left.parent === right.parent;
}

function orphanPermissionResource(statement) {
  const parsed = insertColumnsAndRows(statement);
  if (!parsed || parsed.table !== 'sys_resource') return false;
  const parentIndex = parsed.columns.indexOf('parent_id');
  const typeIndex = parsed.columns.indexOf('resource_type');
  if (parentIndex < 0 || typeIndex < 0) return false;
  return parsed.rows.some((row) => {
    const resourceType = row[typeIndex]?.trim() ?? '';
    const parent = row[parentIndex]?.trim() ?? '';
    return /^(?:3|4|'3'|'4'|"3"|"4")$/u.test(resourceType)
      && /^(?:0|'0'|"0"|NULL)$/iu.test(parent);
  });
}

function sqlLiteral(expression = '') {
  const value = expression.trim();
  const single = /^'((?:''|[^'])*)'$/su.exec(value);
  if (single) return single[1].replaceAll("''", "'");
  const double = /^"((?:""|[^"])*)"$/su.exec(value);
  if (double) return double[1].replaceAll('""', '"');
  return null;
}

function sqlInteger(expression = '') {
  const match = /^(?:'(-?\d+)'|"(-?\d+)"|(-?\d+))$/u.exec(expression.trim());
  return match ? Number.parseInt(match[1] ?? match[2] ?? match[3], 10) : null;
}

function changedInsertStatements(record) {
  if (record.status === 'D' || !record.path.endsWith('.sql')) return [];
  const masked = maskComments(record.content);
  const statements = [];
  for (const match of masked.matchAll(/\bINSERT\s+(?:IGNORE\s+)?INTO\s+(?:`[^`]+`|[A-Za-z0-9_.]+)\s*/giu)) {
    const statementEnd = masked.indexOf(';', match.index);
    const end = statementEnd >= 0 ? statementEnd : masked.length;
    if (!rangeTouchesAddedLine(record, record.content, match.index, end)) continue;
    const statement = record.content.slice(match.index, end);
    statements.push({ index: match.index, end, statement, parsed: insertColumnsAndRows(statement) });
  }
  return statements;
}

function rowValue(parsed, row, column) {
  const index = parsed.columns.indexOf(column);
  return index >= 0 ? row[index]?.trim() ?? '' : '';
}

function normalizedPermission(value) {
  return sqlLiteral(value)?.trim() ?? '';
}

function normalizedApiPath(value) {
  const literal = sqlLiteral(value);
  if (literal === null) return '';
  return `/${literal}`.replace(/\/+/gu, '/').replace(/^\/api(?=\/)/u, '')
    .replace(/\{[^/}]+\}|:[^/]+|\*/gu, ':param').replace(/\/$/u, '') || '/';
}

function normalizedControllerPath(value) {
  return `/${value}`.replace(/\/+/gu, '/').replace(/^\/api(?=\/)/u, '')
    .replace(/\{[^/}]+\}|:[^/]+|\*/gu, ':param').replace(/\/$/u, '') || '/';
}

// This existing runtime controller is protected by Forge's configured API-resource
// interceptor. Each object has literal resource URLs; configKey is a Java route
// variable, not a wildcard permission granted to every object.
function isSharedDynamicCrudEndpoint(endpoint) {
  return endpoint.file === 'forge-server/forge-framework/forge-plugin-parent/forge-plugin-generator/src/main/java/com/mdframe/forge/plugin/generator/controller/DynamicCrudController.java'
    && endpoint.apiPath.startsWith('/ai/crud/:param');
}

function resourceControllerEndpoint(controllers, resource) {
  const matching = controllers.filter((endpoint) => {
    if (endpoint.method !== resource.method) return false;
    if (endpoint.apiPath === resource.apiPath) return true;
    if (!isSharedDynamicCrudEndpoint(endpoint)) return false;
    const template = endpoint.apiPath.split('/');
    const requested = resource.apiPath.split('/');
    return template.length === requested.length
      && template.every((segment, index) => segment === requested[index]
        || (segment === ':param' && requested[index].length > 0));
  }).sort((left, right) => left.apiPath.split('/').filter(segment => segment === ':param').length
    - right.apiPath.split('/').filter(segment => segment === ':param').length);
  // A public/ignored literal route must not fall through to a protected ID route.
  return matching[0]?.public ? undefined : matching[0];
}

function roleGrantFiltersActiveRole(sql) {
  const aliases = [];
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+(?:`?\w+`?\.)?`?sys_role`?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/giu)) {
    const alias = match[1] && !/^(?:WHERE|INNER|LEFT|RIGHT|CROSS|JOIN|ON|ORDER|GROUP|LIMIT|UNION)$/iu.test(match[1])
      ? match[1] : '';
    aliases.push(alias);
  }
  return aliases.some((alias) => {
    const qualifier = alias ? `${alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\.\\s*` : '(?:[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*)?';
    return new RegExp(`\\b${qualifier}role_status\\b\\s*=\\s*(?:1|'1')`, 'iu').test(sql)
      && new RegExp(`\\b${qualifier}del_flag\\b\\s*=\\s*(?:0|'0')`, 'iu').test(sql);
  });
}

// Deliberately bounded SQL grammar. Opaque predicates cannot establish the
// finite recipient set claimed by a reviewed decision.
export function explicitRoleGrantRecipients(statement) {
  // The generic source masker also erases string literals. Here role literals
  // are evidence, so retain them and reject comment-bearing opaque SQL.
  if (/\/\*|--|#|\/\//u.test(statement)) return null;
  const sql = statement;
  const match = /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+`?sys_role_resource`?\s*\(([^()]*)\)\s*SELECT\s+([\s\S]+?)\s+FROM\s+`?sys_role`?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?\s+WHERE\s+([\s\S]+?)\s*$/iu.exec(sql);
  if (!match) return null;
  const columns = splitTopLevel(match[1]).map(item => item.trim().replaceAll('`', '').toLowerCase());
  const projection = splitTopLevel(match[2]);
  const alias = match[3] ?? 'sys_role';
  const qualifier = `${alias}\\s*\\.\\s*`;
  if (new Set(columns).size !== columns.length || projection.length !== columns.length
    || !new RegExp(`^\\s*${qualifier}id\\s*$`, 'iu').test(projection[columns.indexOf('role_id')] ?? '')) return null;
  let roles = null;
  const filters = new Map();
  for (const clause of splitTopLevel(match[4], /^\s+AND\s+/iu)) {
    const role = new RegExp(`^\\s*${qualifier}role_key\\s*(?:=\\s*('(?:[A-Za-z0-9:_-]+)')|IN\\s*\\(([^()]*)\\))\\s*$`, 'iu').exec(clause);
    if (role) {
      if (roles !== null) return null;
      roles = splitTopLevel(role[1] ?? role[2]).map(value => sqlLiteral(value));
      if (roles.length === 0 || roles.some(value => value === null || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(value))) return null;
      continue;
    }
    const filter = new RegExp(`^\\s*${qualifier}(tenant_id|role_status|del_flag)\\s*=\\s*('?\\d+'?)\\s*$`, 'iu').exec(clause);
    if (!filter || filters.has(filter[1].toLowerCase()) || sqlInteger(filter[2]) === null) return null;
    filters.set(filter[1].toLowerCase(), sqlInteger(filter[2]));
  }
  return roles !== null && filters.get('role_status') === 1 && filters.get('del_flag') === 0
    ? [...new Set(roles)].sort() : null;
}

function sqlComparisonIsPredicate(masked, offset) {
  // Preserve clause context through subqueries; quoted text is not SQL syntax.
  const clauses = [''];
  const tokens = /'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`|[();]|\b(?:ON\s+DUPLICATE\s+KEY\s+UPDATE|WHERE|HAVING|ON|SET|SELECT|VALUES)\b/giu;
  for (const token of masked.slice(0, offset).matchAll(tokens)) {
    const word = token[0].toUpperCase();
    if (/^['"`]/u.test(word)) continue;
    if (word === '(') clauses.push(clauses.at(-1));
    else if (word === ')') { if (clauses.length > 1) clauses.pop(); }
    else if (word === ';') { clauses.length = 1; clauses[0] = ''; }
    else clauses[clauses.length - 1] = word;
  }
  return ['WHERE', 'HAVING', 'ON'].includes(clauses.at(-1));
}

function scanSql(record, findings) {
  const { content, path: file } = record;
  const masked = maskComments(content);
  const isFlyway = /^forge-server\/db\/migration\/[^/]+\.sql$/u.test(file);
  if (isFlyway && ['A', 'C', 'R', 'U', 'P'].includes(record.status) && migrationMetadata(file) === null) {
    findings.push(finding('DB-MIGRATION-002', file, 1,
      'Flyway filename must match Vx.y.z__lower_snake.sql with a numeric dotted version.'));
  }
  const tables = createTables(content);
  for (const table of tables) {
    if (table.malformed) {
      findings.push(finding('DB-SCHEMA-001', file, lineAt(content, table.index), `CREATE TABLE ${table.name} is not structurally complete.`));
      continue;
    }
    const missing = REQUIRED_TABLE_COLUMNS.filter((name) => !table.columns.has(name));
    if (missing.length > 0) {
      findings.push(finding('DB-SCHEMA-001', file, lineAt(content, table.index),
        `Table ${table.name} is missing required Forge columns: ${missing.join(', ')}.`, { table: table.name, missing }));
    }
    if (!/\bENGINE\s*=\s*InnoDB\b/iu.test(table.tail) || !/\b(?:DEFAULT\s+)?CHARSET\s*=\s*utf8mb4\b/iu.test(table.tail)) {
      findings.push(finding('DB-SCHEMA-002', file, lineAt(content, table.index),
        `Table ${table.name} must declare ENGINE=InnoDB and DEFAULT CHARSET=utf8mb4.`, { table: table.name }));
    }
    if (!/\bCOMMENT\s*=\s*['"][^'"]+['"]/iu.test(table.tail)) {
      findings.push(finding('DB-SCHEMA-003', file, lineAt(content, table.index),
        `Table ${table.name} must declare a non-empty table comment.`, { table: table.name }));
    }
    for (const name of REQUIRED_TABLE_COLUMNS.filter((column) => table.columns.has(column))) {
      const definition = table.columns.get(name).definition;
      const identifier = ['id', 'tenant_id', 'create_by', 'create_dept', 'update_by', 'del_flag'].includes(name);
      const timestamp = ['create_time', 'update_time'].includes(name);
      if ((identifier && !/\bBIGINT\b/iu.test(definition))
          || (timestamp && !/\b(?:DATETIME|TIMESTAMP)\b/iu.test(definition))
          || !/\bCOMMENT\s+['"][^'"]+['"]/iu.test(definition)) {
        findings.push(finding('DB-SCHEMA-003', file, lineAt(content, table.index),
          `Table ${table.name}.${name} has no approved type/comment contract.`, { table: table.name, column: name }));
      }
    }
    const delDefinition = table.columns.get('del_flag')?.definition ?? '';
    if (table.columns.has('del_flag') && !/\bBIGINT\b/iu.test(delDefinition)) {
      findings.push(finding('DB-DELETE-001', file, lineAt(content, table.index), `Table ${table.name}.del_flag must be BIGINT.`));
    }
    if (table.columns.has('del_flag') && (!/\bNOT\s+NULL\b/iu.test(delDefinition) || !/\bDEFAULT\s+['"]?0['"]?\b/iu.test(delDefinition))) {
      findings.push(finding('DB-DELETE-001', file, lineAt(content, table.index),
        `Table ${table.name}.del_flag must be NOT NULL DEFAULT 0.`));
    }
    for (const constraint of table.constraints.filter((item) => /\bUNIQUE\b/iu.test(item))) {
      const normalized = constraint.toLowerCase();
      if (!/\btenant_id\b/u.test(normalized) || !/\bdel_flag\b/u.test(normalized)) {
        findings.push(finding('DB-DELETE-001', file, lineAt(content, table.index),
          `Active-only unique key on ${table.name} must include tenant_id and del_flag.`, { constraint: constraint.slice(0, 300) }));
      }
    }
  }

  for (const match of masked.matchAll(/\bCREATE\s+UNIQUE\s+INDEX\s+(?:`[^`]+`|[A-Za-z0-9_]+)\s+ON\s+(?:`[^`]+`|[A-Za-z0-9_.]+)\s*\(([^)]*)\)/giu)) {
    const columns = match[1].toLowerCase();
    if (!/\btenant_id\b/u.test(columns) || !/\bdel_flag\b/u.test(columns)) {
      findings.push(finding('DB-DELETE-001', file, lineAt(content, match.index),
        'Active-only CREATE UNIQUE INDEX must include tenant_id and del_flag.'));
    }
  }
  for (const match of masked.matchAll(/\bCONSTRAINT\s+(?:`[^`]+`|[A-Za-z0-9_]+)\s+UNIQUE(?:\s+(?:KEY|INDEX))?\s*\(([^)]*)\)/giu)) {
    const columns = match[1].toLowerCase();
    if (!/\btenant_id\b/u.test(columns) || !/\bdel_flag\b/u.test(columns)) {
      findings.push(finding('DB-DELETE-001', file, lineAt(content, match.index),
        'Active-only named UNIQUE constraint must include tenant_id and del_flag.'));
    }
  }

  const destructive = /\b(?:DROP\s+(?:TABLE|COLUMN|DATABASE)|TRUNCATE\s+TABLE|ALTER\s+TABLE[\s\S]{0,300}?DROP\s+(?:COLUMN|PRIMARY\s+KEY)|RENAME\s+TABLE)\b/giu;
  for (const match of masked.matchAll(destructive)) {
    findings.push(finding('DB-MIGRATION-001', file, lineAt(content, match.index), `Destructive DDL is blocked: ${match[0].replace(/\s+/gu, ' ').slice(0, 180)}.`));
  }
  if (record.status === 'M' && /(?:^|\/)forge-server\/db\/migration\/V[^/]+\.sql$/iu.test(file)) {
    findings.push(finding('DB-MIGRATION-001', file, 1, 'An existing versioned Flyway migration was modified; create the next migration instead.'));
  }
  if (record.status === 'D' && /(?:^|\/)forge-server\/db\/migration\/V[^/]+\.sql$/iu.test(file)) {
    findings.push(finding('DB-MIGRATION-001', file, 1, 'A versioned Flyway migration was deleted.'));
  }

  const insertPattern = /\bINSERT\s+(IGNORE\s+)?INTO\s+(?:`[^`]+`|[A-Za-z0-9_.]+)\s*/giu;
  for (const match of masked.matchAll(insertPattern)) {
    const after = masked.slice(match.index + match[0].length).trimStart();
    const statementEnd = masked.indexOf(';', match.index);
    const statement = masked.slice(match.index, statementEnd >= 0 ? statementEnd : masked.length);
    const rawStatement = content.slice(match.index, statementEnd >= 0 ? statementEnd : content.length);
    if (!after.startsWith('(')) {
      findings.push(finding('DB-SEED-001', file, lineAt(content, match.index), 'INSERT must declare an explicit target column list.'));
    }
    if (!match[1] && !/\bNOT\s+EXISTS\b/iu.test(statement) && !/\bON\s+DUPLICATE\s+KEY\b/iu.test(statement)) {
      findings.push(finding('DB-SEED-001', file, lineAt(content, match.index), 'Seed INSERT is not guarded for idempotent replay.'));
    }
    if (insertUsesTenantZero(rawStatement)) {
      findings.push(finding('DB-SEED-001', file, lineAt(content, match.index), 'Built-in Forge data must use tenant_id = 1, never tenant 0.'));
    }
    if (orphanPermissionResource(rawStatement)) {
      findings.push(finding('PERMISSION-RESOURCE-001', file, lineAt(content, match.index),
        'Button and API resources (resource_type 3/4) must resolve their parent_id to the owning menu, never 0 or NULL.'));
    }
  }
  for (const match of masked.matchAll(/(?:\btenant_id\b\s*=\s*0\b|\bSELECT\s+0\s+(?:AS\s+)?tenant_id\b)/giu)) {
    if (/^tenant_id/iu.test(match[0]) && sqlComparisonIsPredicate(masked, match.index)) continue;
    findings.push(finding('DB-SEED-001', file, lineAt(content, match.index), 'Built-in Forge data must use tenant_id = 1, never tenant 0.'));
  }
  for (const match of content.matchAll(/\$\{[^}\r\n]+\}/gu)) {
    findings.push(finding('DB-SEED-001', file, lineAt(content, match.index), 'Raw ${...} is forbidden in Flyway SQL; construct literal templates explicitly.'));
  }
  if (isFlyway) {
    for (const match of masked.matchAll(/\b(?:UPDATE\s+(?:`[^`]+`|[A-Za-z0-9_.]+)\s+SET|DELETE\s+FROM\s+(?:`[^`]+`|[A-Za-z0-9_.]+))[\s\S]*?(?:;|$)/giu)) {
      if (!/\bWHERE\b/iu.test(match[0])
          || /\bWHERE\s+(?:\(*\s*1\s*=\s*1\s*\)*|TRUE\b)/iu.test(match[0])) {
        findings.push(finding('DB-MIGRATION-002', file, lineAt(content, match.index),
          'Flyway data UPDATE/DELETE must have a bounded non-tautological WHERE predicate.'));
      }
    }
  }
}

function isEntityPath(file) {
  return /\/src\/main\/java\/.+\/(?:domain(?:\/entity)?|entity)\/[^/]+\.java$/u.test(file)
    && !/\/PageQuery\.java$/u.test(file)
    // The auth starter owns transport models in domain, not database entities.
    && !/\/forge-starter-auth\/src\/main\/java\/com\/mdframe\/forge\/starter\/auth\/domain\/[^/]+(?:Request|Result|Payload|VO)\.java$/u.test(file);
}

function javaMethodRange(content, signaturePattern) {
  const match = signaturePattern.exec(content);
  if (!match) return null;
  const open = content.indexOf('{', match.index + match[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    else if (content[index] === '}' && --depth === 0) {
      return { start: match.index, end: index + 1, body: content.slice(open + 1, index) };
    }
  }
  return { start: match.index, end: content.length, body: content.slice(open + 1) };
}

function javaLogicalDeleteDeclarations(content) {
  const code = maskJavaComments(content);
  const executable = maskJavaNonCode(content);
  // Keep the annotation attached to this field: another field, a removed
  // annotation or a quoted/commented example cannot establish the contract.
  return [...code.matchAll(/@TableLogic\s*\(([^()]*)\)\s*(?:@[A-Za-z_$][\w.$]*(?:\([^()]*\))?\s*)*private\s+(Integer|Long|int|long)\s+delFlag\s*;/gu)]
    .filter(match => executable.startsWith('@TableLogic', match.index))
    .map(match => {
      match[0] = content.slice(match.index, match.index + match[0].length);
      return match;
    });
}

function scanJava(record, findings, context = {}, legacyFindings = []) {
  const { content, path: file } = record;
  const recordSourceFinding = (item, matches) => {
    const unchanged = record.status === 'M' && typeof record.baseContent === 'string'
      && matches.length > 0 && matches.every(match => record.baseContent.includes(match[0])
        && !rangeTouchesAddedLine(record, content, match.index, match.index + match[0].length));
    if (unchanged) legacyFindings.push({ ...item, severity: 'legacy', evidence: {
      ...item.evidence, applicability: 'unchanged-at-review-base', baseContentSha256: sha256(record.baseContent),
    } });
    else findings.push(item);
  };
  const isController = /\/controller\/[^/]+Controller\.java$/u.test(file);
  const isService = /\/service\/(?:impl\/)?[^/]+(?:Service|ServiceImpl)\.java$/u.test(file);
  const className = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/u.exec(content)?.[1] ?? path.posix.basename(file, '.java');

  if (isEntityPath(file) && /\bclass\s+[A-Za-z_$][\w$]*/u.test(content)) {
    if (!/@TableName\s*\(/u.test(content)) {
      findings.push(finding('BE-ENTITY-001', file, 1, `${className} must declare its explicit @TableName ownership.`));
    }
    if (!/\bextends\s+TenantEntity\b/u.test(content)) {
      findings.push(finding('BE-ENTITY-001', file, 1, `${className} must extend TenantEntity.`));
    }
    const duplicated = ['tenantId', 'createBy', 'createTime', 'createDept', 'updateBy', 'updateTime']
      .filter((field) => new RegExp(`\\bprivate\\s+[^;=]+\\s+${field}\\s*(?:[;=])`, 'u').test(content));
    if (duplicated.length > 0) {
      findings.push(finding('BE-ENTITY-001', file, 1, `${className} redeclares TenantEntity/BaseEntity fields: ${duplicated.join(', ')}.`, { duplicated }));
    }
    const deleteDeclarations = javaLogicalDeleteDeclarations(content);
    const currentDelete = deleteDeclarations.length === 1 ? deleteDeclarations[0] : null;
    if (!currentDelete || currentDelete[2] !== 'Long'
        || !/^\s*value\s*=\s*"0"\s*,\s*delval\s*=\s*"id"\s*$/u.test(currentDelete[1])) {
      const previousDeletes = typeof record.baseContent === 'string'
        ? javaLogicalDeleteDeclarations(record.baseContent) : [];
      const unchangedDelete = currentDelete && previousDeletes.length === 1
        && currentDelete[0] === previousDeletes[0][0];
      recordSourceFinding(finding('BE-ENTITY-002', file, 1,
        `${className} must declare the primary-key tombstone @TableLogic Long delFlag contract.`),
      unchangedDelete ? [currentDelete] : []);
    }
  }

  const paginationSource = maskJavaNonCode(content);
  // An ordinary test helper's local page variable is not an external API
  // parameter. Test fixtures that actually declare routes retain this check.
  const ordinaryTestSource = /\/src\/test\/java\//u.test(file)
    && !/@(?:[A-Za-z_$][\w$]*\.)*(?:RestController|Controller|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/u.test(paginationSource);
  const legacyPagePatterns = [
    /\b(?:Integer|Long|int|long)\s+page\b/gu,
    /[?&]page=/gu,
  ];
  for (const pattern of legacyPagePatterns) {
    for (const match of paginationSource.matchAll(pattern)) {
      if (!rangeTouchesAddedLine(record, content, match.index, match.index + match[0].length)) continue;
      if (/\/PageParamResolver\.java$/u.test(file) && /\b(?:Integer|Long|int|long)\s+page\b/u.test(match[0])) continue;
      if (ordinaryTestSource && /\b(?:Integer|Long|int|long)\s+page\b/u.test(match[0])) continue;
      findings.push(finding('BE-PAGE-001', file, lineAt(content, match.index),
        'New backend pagination must use PageQuery or pageNum/pageSize, not page.'));
    }
  }
  if (/\.subList\s*\(|\.stream\s*\(\s*\)\s*\.skip\s*\(|\.skip\s*\([^)]*\)\s*\.limit\s*\(/u.test(content)) {
    findings.push(finding('BE-PAGE-001', file, 1, 'In-memory pagination is forbidden; paginate in the database Mapper.'));
  }
  const oversizedPages = [...content.matchAll(/\bnew\s+Page\s*<[^>]*>\s*\([^,]+,\s*([0-9][0-9_]*[lL]?|pageSize\s*\*|Integer\.MAX_VALUE)/gu)]
    .filter(match => !/^[0-9][0-9_]*[lL]?$/u.test(match[1])
      || Number(match[1].replace(/[_lL]/gu, '')) > 100
      || !/^\s*[,)]/u.test(content.slice(match.index + match[0].length)));
  if (oversizedPages.length > 0) {
    recordSourceFinding(finding('BE-PAGE-001', file, 1, 'External page size exceeds the Forge maximum or bypasses normalized PageQuery.'), oversizedPages);
  }
  if (/\/PageQuery\.java$/u.test(file)
      && /\btoPage\s*\([^)]*\)\s*\{[\s\S]{0,1000}?new\s+Page\s*<[^>]*>\s*\(\s*(?:this\.)?pageNum\s*,\s*(?:this\.)?pageSize\s*\)/u.test(content)) {
    findings.push(finding('BE-PAGE-001', file, 1, 'PageQuery.toPage() bypasses normalized getters and therefore bypasses the page-size ceiling.'));
  }
  if (/\/PageQuery\.java$/u.test(file)) {
    const toPage = javaMethodRange(paginationSource, /\btoPage\s*\([^)]*\)\s*\{/u);
    if (toPage && rangeTouchesAddedLine(record, content, toPage.start, toPage.end)
        && /\bnew\s+Page\s*</u.test(toPage.body)
        && !/new\s+Page\s*<[^>]*>\s*\(\s*(?:this\.)?getPageNum\s*\(\s*\)\s*,\s*(?:this\.)?getPageSize\s*\(\s*\)\s*\)/u.test(toPage.body)) {
      findings.push(finding('BE-PAGE-002', file, lineAt(content, toPage.start),
        'The shared PageQuery.toPage() owner must consume getPageNum()/getPageSize(); raw fields or parallel normalization are forbidden.'));
    }
  }
  if (/\/PageParamResolver\.java$/u.test(file)) {
    const resolve = javaMethodRange(paginationSource, /\b(?:public\s+)?(?:static\s+)?int\s+resolve\s*\([^)]*\)\s*\{/u);
    if (resolve && rangeTouchesAddedLine(record, content, resolve.start, resolve.end)) {
      const normalizesPositive = /\bMath\.max\s*\(\s*1\s*,/u.test(resolve.body)
        || /\bnormalize(?:PageNum|PositivePage)\s*\(/u.test(resolve.body)
        || /(?:page|pageNum)\s*(?:==\s*null\s*\|\||\|\|\s*(?:page|pageNum)\s*)?(?:<=\s*0|<\s*1)/u.test(resolve.body);
      if (!normalizesPositive) {
        findings.push(finding('BE-PAGE-002', file, lineAt(content, resolve.start),
          'PageParamResolver.resolve() must normalize null, zero, and negative aliases to page 1 before returning them.'));
      }
    }
  }
  if (!context.pageQueryFoundationRepaired
      && /\/src\/main\/java\//u.test(file)
      && !/\/PageQuery\.java$/u.test(file)
      && /\bPageQuery\b[\s\S]{0,2000}?\.toPage\s*\(/u.test(content)) {
    const calls = [...paginationSource.matchAll(/\b[A-Za-z_$][\w$]*\s*\.\s*toPage\s*\(/gu)];
    recordSourceFinding(finding('BE-PAGE-001', file, calls.length ? lineAt(content, calls[0].index) : 1,
      'The fixed Forge baseline PageQuery.toPage() bypasses its normalized getters; construct Page with getPageNum()/getPageSize() until the foundation is repaired.'), calls);
  }
  if (isService && /\b(?:LambdaQueryWrapper|QueryWrapper)\b|\.lambdaQuery\s*\(/u.test(content)) {
    findings.push(finding('BE-QUERY-001', file, 1, 'Service-layer query wrappers are forbidden for business query/list/page behavior; use Mapper XML.'));
  }
  if (/@(?:Select|Update|Delete|Insert)\s*\(/u.test(content)) {
    findings.push(finding('BE-QUERY-001', file, 1, 'Annotation SQL is forbidden for new Forge business data access; use Mapper XML.'));
  }

  if (isController) {
    const dependencyCode = maskJavaNonCode(content);
    const jacksonObjectMapper = /^\s*import\s+com\.fasterxml\.jackson\.databind\.ObjectMapper\s*;/mu.test(dependencyCode)
      && !/\b(?:class|interface|enum|record)\s+ObjectMapper\b/u.test(dependencyCode);
    const mapperDependencies = [...content.matchAll(/import\s+.+\.(?:mapper|service\.impl)\.[^;]+;|private\s+final\s+\w*Mapper\b/gu)]
      .filter(match => !(jacksonObjectMapper && /^private\s+final\s+ObjectMapper\b/u.test(match[0])));
    if (mapperDependencies.length > 0) {
      recordSourceFinding(finding('BE-CONTROLLER-001', file, 1, 'Controller cannot depend on Mapper or Service implementation classes.'), mapperDependencies);
    }
    const entityDependencies = [...content.matchAll(/import\s+(?!com\.mdframe\.forge\.starter\.)[^;]+\.(?:domain|entity)\.[A-Z][^;]+;/gu)];
    if (entityDependencies.length > 0) {
      recordSourceFinding(finding('BE-CONTROLLER-001', file, 1, 'Entity/domain objects cannot cross the HTTP boundary; use Command/Query DTO and VO.'), entityDependencies);
    }
    const javaCode = maskJavaComments(content);
    const controllerClassIndex = javaCode.search(/\bclass\s+\w+Controller\b/u);
    const mappings = javaHttpMappings(content);
    for (const mapping of mappings) {
      const annotationBoundary = Math.max(controllerClassIndex, javaCode.lastIndexOf('}', mapping.index), javaCode.lastIndexOf(';', mapping.index));
      const signature = javaEndpointSignature(content, mapping);
      const declarationOffset = maskJavaNonCode(javaCode.slice(mapping.end, Math.min(javaCode.length, mapping.end + 1200))).search(/\b(?:public|protected|private)\b/u);
      const annotationEnd = declarationOffset >= 0 ? mapping.end + declarationOffset : mapping.end;
      const methodAnnotations = javaCode.slice(Math.max(0, annotationBoundary + 1), annotationEnd);
      const recordEndpointFinding = (item) => {
        const classRoute = /@RequestMapping\b\s*(?:\(([^)]*)\))?/u.exec(javaCode.slice(0, controllerClassIndex))?.[0] ?? '';
        if (unchangedJavaEndpoint(record, mapping, classRoute, context.displayCatalogs)) legacyFindings.push({ ...item, severity: 'legacy', evidence: {
          ...item.evidence, applicability: 'unchanged-at-review-base', baseContentSha256: sha256(record.baseContent),
        } });
        else findings.push(item);
      };
      if (mapping.method !== 'Get' && !/@OperationLog\s*\(/u.test(methodAnnotations)) {
        recordEndpointFinding(finding('BE-CONTROLLER-001', file, lineAt(content, mapping.index), `${mapping.method} endpoint requires @OperationLog.`));
      }
      if (signature && !/^(?:RespInfo|ResponseEntity|SseEmitter|Flux|StreamingResponseBody)\b/u.test(signature[1])
          && !(signature[1] === 'void' && hasServletStreamingParameter(content, signature[2]))) {
        recordEndpointFinding(finding('BE-CONTROLLER-001', file, lineAt(content, mapping.index), `Endpoint return type must use Forge's response/streaming contract, found ${signature[1].slice(0, 100)}.`));
      }
      if (signature?.[2].includes('@RequestBody')
          && !/@Valid\b|@Validated\b|@NotEmpty\b|@Size\s*\(/u.test(signature[2])) {
        recordSourceFinding(finding('BE-CONTROLLER-001', file, lineAt(content, mapping.index),
          '@RequestBody must declare DTO validation or a non-empty/size constraint for collection and array inputs.'),
        [{ 0: signature[0], index: mapping.index + signature.index }]);
      }
    }
    const crudLike = /Mapping\s*\(\s*"\/(?:page|list)"/u.test(content)
      && /Mapping\s*\(\s*"\/(?:add|edit|remove)/u.test(content);
    if (crudLike) {
      const header = content.slice(0, content.search(/\bclass\s/u));
      const controllerBase = header.match(/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?"([^"\r\n]+)"\s*\)/u)?.[1];
      const accepted = controllerBase === undefined ? undefined : context.acceptedApiContract?.endpoints
        .filter(endpoint => endpoint.path.startsWith(`${controllerBase}/`));
      const specified = accepted?.length > 0;
      const required = ['/getById', '/add', '/edit', '/remove/{id}'].flatMap(route => {
        const endpoints = specified ? accepted.filter(endpoint => endpoint.path === `${controllerBase}${route}`)
          : [{ method: 'POST' }];
        return endpoints.map(endpoint => {
          const verb = endpoint.method[0] + endpoint.method.slice(1).toLowerCase();
          const escaped = route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
          return [`@${verb}Mapping("${route}")`, new RegExp(`@${verb}Mapping\\s*\\(\\s*"${escaped}"\\s*\\)`, 'u')];
        });
      });
      for (const [label, pattern] of required) if (!pattern.test(content)) {
        const item = finding('BE-CRUD-001', file, 1, `Generated CRUD controller is missing ${label}.`);
        const base = record.baseContent;
        if (record.status === 'M' && typeof base === 'string' && !pattern.test(base)
            && /Mapping\s*\(\s*"\/(?:page|list)"/u.test(base)
            && /Mapping\s*\(\s*"\/(?:add|edit|remove)/u.test(base)) {
          legacyFindings.push({ ...item, severity: 'legacy', evidence: {
            applicability: 'unchanged-at-review-base', baseContentSha256: sha256(base),
          } });
        } else findings.push(item);
      }
      if (/@(?:Put|Delete)Mapping\b/u.test(content)) {
        findings.push(finding('BE-CRUD-001', file, 1, 'Generated CRUD controllers cannot use PUT or DELETE mappings.'));
      }
    }
  }

  const utilityClass = /\b(?:class|interface|enum|record)\s+[A-Za-z_$][\w$]*(?:Util|Utils|Helper)\b/u.test(content);
  if (utilityClass) {
    const allowed = /\/support\/[^/]+\.java$/u.test(file)
      || /^forge-server\/forge-framework\/forge-starter-parent\/forge-starter-[^/]+\/src\/main\/java\/.+\/util\/[^/]+\.java$/u.test(file)
      || /^forge-server\/forge-framework\/forge-plugin-parent\/forge-plugin-generator\/src\/main\/java\/.+\/util\/[^/]+\.java$/u.test(file);
    if (!allowed) findings.push(finding('BE-UTILITY-001', file, 1, `${className} has no approved Forge capability owner directory.`));
  }

  if (/\/dto\/[^/]+\.java$/u.test(file)
      && !/forge-plugin-system\/.+\/tenant\//u.test(file)
      && /\b(?:private|public|protected)\s+(?:final\s+)?[A-Za-z_$][\w$<>, ?.\[\]]*\s+tenantId\b/u.test(content)) {
    findings.push(finding('BE-TENANT-001', file, 1, 'Ordinary request DTO cannot accept tenantId from the client.'));
  }

  if (/\/src\/main\/java\//u.test(file)) {
    const javaCode = maskJavaNonCode(content);
    const tenantSubject = String.raw`(?:\b(?:tenantId|[A-Za-z_$][\w$]*TenantId)\b|\bTenantContextHolder\s*\.\s*getTenantId\s*\(\s*\))`;
    const tenantConstant = String.raw`(?:-?\d[\d_]*[lL]?|\b[A-Z][A-Z0-9_]*(?:\s*\.\s*[A-Z][A-Z0-9_]*)*\b)`;
    const tenantFallbackPatterns = [
      new RegExp(String.raw`${tenantSubject}\s*==\s*null\s*\?\s*${tenantConstant}\s*:`, 'gu'),
      new RegExp(String.raw`${tenantSubject}\s*!=\s*null\s*\?[^:;\r\n]{1,240}:\s*${tenantConstant}`, 'gu'),
      new RegExp(String.raw`\bif\s*\(\s*${tenantSubject}\s*==\s*null\s*\)\s*(?:\{\s*)?(?:return\s+${tenantConstant}|${tenantSubject}\s*=\s*${tenantConstant})`, 'gu'),
      new RegExp(String.raw`\bObjects\.requireNonNullElse\s*\(\s*${tenantSubject}\s*,\s*${tenantConstant}\s*\)`, 'gu'),
      new RegExp(String.raw`\bObjects\.requireNonNullElseGet\s*\(\s*${tenantSubject}\s*,\s*\(\s*\)\s*->\s*${tenantConstant}\s*\)`, 'gu'),
      new RegExp(String.raw`\bOptional\.ofNullable\s*\(\s*${tenantSubject}\s*\)\s*\.orElse\s*\(\s*${tenantConstant}\s*\)`, 'gu'),
      new RegExp(String.raw`\bOptional\.ofNullable\s*\(\s*${tenantSubject}\s*\)\s*\.orElseGet\s*\(\s*\(\s*\)\s*->\s*${tenantConstant}\s*\)`, 'gu'),
    ];
    for (const pattern of tenantFallbackPatterns) {
      for (const match of javaCode.matchAll(pattern)) {
        if (!rangeTouchesAddedLine(record, content, match.index, match.index + match[0].length)) continue;
        findings.push(finding('BE-TENANT-002', file, lineAt(content, match.index),
          'Missing tenant context cannot fall back to a constant tenant ID; fail closed or propagate an explicitly authorized tenant scope.'));
      }
    }

    if (isService) {
      const mutationCall = /\b(?:save|updateById|removeById|deleteById)\s*\(/gu;
      for (const match of javaCode.matchAll(mutationCall)) {
        const receiver = persistenceReceiver(javaCode, match.index);
        if (!receiver) continue;
        const boundary = Math.max(
          javaCode.lastIndexOf(';', receiver.start - 1),
          javaCode.lastIndexOf('{', receiver.start - 1),
          javaCode.lastIndexOf('}', receiver.start - 1),
        );
        if (javaCode.slice(boundary + 1, receiver.start).trim().length !== 0) continue;
        const open = javaCode.indexOf('(', match.index);
        const close = findMatchingParenthesis(javaCode, open);
        if (close < 0) continue;
        const terminator = /^\s*;/u.exec(javaCode.slice(close + 1));
        if (!terminator) continue;
        if (localMapBusinessResult(content, javaCode, receiver, match.index, open, close)) continue;
        const end = close + 1 + terminator[0].length;
        if (!rangeTouchesAddedLine(record, content, receiver.start, end)) continue;
        findings.push(finding('BE-MUTATION-001', file, lineAt(content, match.index),
          'A persistence mutation result is discarded; false or an unexpected affected-row count must produce a stable not-found or concurrent-change failure.'));
      }
    }
  }

  for (const match of content.matchAll(/catch\s*\([^)]*\)\s*\{\s*\}/gu)) {
    findings.push(finding('BE-SAFETY-001', file, lineAt(content, match.index), 'Empty catch block swallows a failure.'));
  }
  for (const match of content.matchAll(/\bSystem\.(?:out|err)\.(?:print|println|printf)\s*\(/gu)) {
    findings.push(finding('BE-SAFETY-001', file, lineAt(content, match.index), 'System.out/System.err is forbidden in production backend code.'));
  }
  for (const match of content.matchAll(/\b(?:log|logger)\.(?:trace|debug|info|warn|error)\s*\([^\n;]*(?:password|passwd|token|secret|apiKey|authorization)[^\n;]*[);]/giu)) {
    findings.push(finding('BE-SAFETY-001', file, lineAt(content, match.index), 'Log statement may expose a password, token, API key, or authorization value.'));
  }
}

function scanMapperXml(record, findings) {
  const { content, path: file } = record;
  for (const match of content.matchAll(/\bSELECT\s+\*/giu)) {
    findings.push(finding('DB-QUERY-001', file, lineAt(content, match.index), 'Mapper XML must list explicit columns; SELECT * is forbidden.'));
  }
  for (const match of content.matchAll(/\$\{[^}\r\n]+\}/gu)) {
    findings.push(finding('DB-QUERY-001', file, lineAt(content, match.index), 'New Mapper XML cannot use ${}; values use #{} and dynamic identifiers require a reviewed allowlist adapter.'));
  }
  for (const match of content.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/giu)) {
    const attrs = match[1];
    const body = maskComments(match[2]);
    if (/\b(?:page|list)\b/iu.test(attrs) || /\bPage\b/u.test(attrs)) {
      if (!/\bORDER\s+BY\b/iu.test(body)) {
        findings.push(finding('DB-QUERY-001', file, lineAt(content, match.index), 'Page/list Mapper query requires stable ORDER BY.'));
      }
      if (!/\bdel_flag\b\s*=\s*(?:0|'0')/iu.test(body)) {
        findings.push(finding('DB-QUERY-001', file, lineAt(content, match.index), 'Page/list Mapper query must filter active rows with del_flag = 0.'));
      }
    }
  }
}

function isBusinessVue(file, content) {
  return /^forge-admin-ui\/src\/views\//u.test(file)
    && /(?:api-config|tableColumns|searchSchema|\/page|\/add|\/edit|\/remove)/u.test(content)
    && !/^forge-admin-ui\/src\/views\/(?:flow|lowcode|report|ai\/dashboard|app-center)\//u.test(file);
}

function frontendMarkupMatches(content, names) {
  return [...content.matchAll(new RegExp(`<(?:${names})\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gu'))];
}

function scanFrontend(record, findings, legacyFindings) {
  const { content, path: file } = record;
  const templateExpressions = new Set();
  const javaScriptSegments = frontendJavaScriptSegments(file, content).map(segment => ({
    ...segment,
    unsafeIntegers: unsafeJavaScriptIntegerLiterals(segment.source, segment.offset, templateExpressions),
  }));
  const businessCrud = file.endsWith('.vue') && isBusinessVue(file, content);
  const legacyPage = record.status === 'M' && typeof record.baseContent === 'string'
    && isBusinessVue(file, record.baseContent);
  const unchangedMatches = (matches) => legacyPage && matches.every((match) =>
    record.baseContent.includes(match[0])
      && !rangeTouchesAddedLine(record, content, match.index, match.index + match[0].length));
  const unchangedSourceMatches = (matches) => record.status === 'M' && typeof record.baseContent === 'string'
    && matches.length > 0 && matches.every(match => record.baseContent.includes(match[0])
      && !rangeTouchesAddedLine(record, content, match.index, match.index + match[0].length));
  const recordPageFinding = (item, legacy) => {
    if (legacy) legacyFindings.push({ ...item, severity: 'legacy', evidence: {
      ...item.evidence, applicability: 'unchanged-at-review-base', baseContentSha256: sha256(record.baseContent),
    } });
    else findings.push(item);
  };
  if (businessCrud && !/\bAiCrudPage\b/u.test(content)) {
    const manualStructure = frontendMarkupMatches(content, 'n-data-table|NDataTable|n-table|NTable|n-pagination|NPagination|n-form|NForm|el-table|el-pagination|el-form');
    recordPageFinding(finding('FE-CRUD-001', file, 1, 'Ordinary Forge business CRUD page must use AiCrudPage.'),
      legacyPage && !/\bAiCrudPage\b/u.test(record.baseContent) && unchangedMatches(manualStructure));
  }
  if (businessCrud && /<(?:n-pagination|NPagination)\b|\bNPagination\b/u.test(content)) {
    const pagination = [
      ...frontendMarkupMatches(content, 'n-pagination|NPagination'),
      ...content.matchAll(/\bNPagination\b/gu),
    ];
    recordPageFinding(finding('FE-CRUD-001', file, 1, 'Business CRUD page hand-rolls pagination instead of using AiCrudPage.'), unchangedMatches(pagination));
  }
  if (businessCrud) {
    for (const match of content.matchAll(/\b(?:status|type|category|level)\w*Options\s*=\s*(?:ref|reactive)?\s*\(??\s*\[[\s\S]{0,500}?\{\s*(?:label|value)\s*:/giu)) {
      recordPageFinding(finding('FE-DICT-001', file, lineAt(content, match.index), 'Page-local business option maps are forbidden; use a Forge dictionary.'), unchangedSourceMatches([match]));
    }
    if (/\bstatus\b/u.test(content) && /(?:label|title)\s*:\s*['"][^'"]+['"][\s\S]{0,120}?value\s*:/u.test(content)
        && !/\b(?:useDict|DictSelect|DictTag)\b/u.test(content)) {
      const matches = [...content.matchAll(/\bstatus\b|(?:label|title)\s*:\s*['"][^'"]+['"][\s\S]{0,120}?value\s*:/gu)];
      recordPageFinding(finding('FE-DICT-001', file, 1, 'Status labels/options require useDict, DictSelect, and DictTag.'),
        unchangedSourceMatches(matches) && !/\b(?:useDict|DictSelect|DictTag)\b/u.test(record.baseContent));
    }
  }
  for (const match of content.matchAll(/\{id\}|(?:put|delete)@[^'"\s]+|(?:detail|update|delete)\s*:\s*['"](?:put|delete)@/giu)) {
    if (match[0] === '{id}' && templateExpressions.has(match.index)) continue;
    recordPageFinding(finding('FE-API-001', file, lineAt(content, match.index), 'Generated frontend CRUD contract must use POST-safe routes and :id placeholders.'), unchangedSourceMatches([match]));
  }
  for (const segment of javaScriptSegments) {
    const executable = maskJavaScriptNonCode(segment.source);
    for (const match of executable.matchAll(/\b(?:Number|parseInt|parseFloat)\s*\([^)]*(?:\bid\b|Id\b)[^)]*\)|\+\s*(?:row\.)?\w*(?:id|Id)\b/giu)) {
      recordPageFinding(finding('FE-DATA-001', file, lineAt(content, segment.offset + match.index), 'Forge Snowflake IDs must stay strings in frontend code.'),
        unchangedSourceMatches([{ 0: match[0], index: segment.offset + match.index }]));
    }
    for (const unsafe of segment.unsafeIntegers) {
      recordPageFinding(finding('FE-DATA-001', file, lineAt(content, unsafe.index),
        'Unsafe JavaScript integer literal loses precision before it can be converted to a string; write Snowflake IDs as quoted strings.'),
      unchangedSourceMatches([{ 0: unsafe.token, index: unsafe.index }]));
    }
  }
  for (const match of content.matchAll(/<(?:img|n-avatar|NAvatar)\b[^>]*:src\s*=\s*"[^"]*(?:avatar|image|logo|file|fileId)[^"]*"/giu)) {
    recordPageFinding(finding('FE-DATA-001', file, lineAt(content, match.index), 'Protected file/image rendering must use AuthImage or the authenticated file adapter.'), unchangedSourceMatches([match]));
  }
  const httpRestricted = /^forge-admin-ui\/src\/(?:api|views|components)\//u.test(file)
    && !/(?:\/utils\/|\/components\/common\/AuthImage\.vue$|\/utils\/sse\.)/u.test(file);
  if (httpRestricted) {
    for (const match of content.matchAll(/(?:from\s+['"]axios['"]|\baxios\s*\.|\bfetch\s*\()/gu)) {
      recordPageFinding(finding('FE-HTTP-001', file, lineAt(content, match.index), 'Use the Forge request/API adapter instead of direct axios or fetch.'), unchangedSourceMatches([match]));
    }
  }
  if (businessCrud) {
    for (const match of content.matchAll(/#[0-9a-f]{3,8}\b/giu)) {
      recordPageFinding(finding('FE-DESIGN-001', file, lineAt(content, match.index), 'Raw color literal is forbidden in a new or changed admin business page line; use a Forge design token.'), unchangedMatches([match]));
    }
    if (/(?:from\s+['"]element-plus['"]|<el-[a-z])/iu.test(content)) {
      const elements = [
        ...frontendMarkupMatches(content, 'el-[a-z][\\w-]*'),
        ...content.matchAll(/\bimport\s+(?:[^;]*?)\bfrom\s+['"]element-plus['"]/gu),
      ];
      recordPageFinding(finding('FE-DESIGN-001', file, 1, 'New or changed admin business components must use the canonical Naive UI component system.'),
        elements.length > 0 && unchangedMatches(elements));
    }
  }
  for (const match of content.matchAll(/(?:vconsole|eruda|script)[^\r\n]{0,300}(?:@latest|https?:\/\/)|(?:nonce|traceId|idempotencyKey)[^\r\n]{0,200}?Math\.random\s*\(/giu)) {
    findings.push(finding('FE-RUNTIME-001', file, lineAt(content, match.index), 'Dynamic latest/CDN runtime code or Math.random security identity is forbidden.'));
  }
}

function scanGlobal(record, findings) {
  const { content, path: file } = record;
  const isGovernanceImplementation = file === 'docker/harness/forge-governance.mjs'
    || file === 'docker/harness/forge-governance-policy.json';
  for (const match of content.matchAll(/(?:forge[-_ ]?(?:governance|policy)[-_ ]?(?:ignore|off|disable|skip)|@SuppressWarnings\s*\(\s*"Forge|forge[-_ ]?bypass)/giu)) {
    findings.push(finding('GOV-BYPASS-001', file, lineAt(content, match.index), 'Repository-authored governance bypass directive is forbidden.'));
  }
  // The policy engine necessarily contains the literal signatures it detects.
  // This exact versioned implementation path is covered by the image receipt;
  // no project path receives the exemption.
  if (file !== 'docker/harness/forge-governance.mjs') {
    const embeddedCredentialPattern = new RegExp(
      '-----BEGIN (?:RSA |EC |OPENSSH )?' + 'PRIVATE KEY-----'
        + String.raw`|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\r\n]{8,}['"]`,
      'giu',
    );
    for (const match of content.matchAll(embeddedCredentialPattern)) {
      if (/(?:\/src\/test\/|\/__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$)/u.test(file)
          && /[:=]\s*['"](?:old|new|replacement)-value['"]$/u.test(match[0])) continue;
      findings.push(finding('BE-SAFETY-001', file, lineAt(content, match.index), 'Possible embedded credential or private key is forbidden.'));
    }
  }
  if (file.endsWith('/SKILL.md') || file === 'SKILL.md') {
    const skillSafetyPattern = new RegExp(
      String.raw`\bsudo\b|\bcurl\b[^\n|]{0,500}\|\s*(?:bash|sh)\b|\bnpx\b[^\n]*(?:@latest|\s+skills\s+add)|`
        + '-----BEGIN ' + 'PRIVATE KEY-----',
      'giu',
    );
    for (const match of content.matchAll(skillSafetyPattern)) {
      const message = /PRIVATE KEY/iu.test(match[0])
        ? 'Skill contains embedded private key credential material.'
        : 'Skill contains an unreviewed privileged command or dynamic installer.';
      findings.push(finding('SKILL-SAFETY-001', file, lineAt(content, match.index), message));
    }
  }
  if (/(?:\/src\/test\/|\/__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$)/u.test(file)) {
    for (const match of content.matchAll(/@Disabled\b|\b(?:describe|it|test)\.skip\s*\(|\b(?:xdescribe|xit|xtest)\s*\(/gu)) {
      findings.push(finding('QUALITY-TEST-002', file, lineAt(content, match.index), 'Changed automated test is disabled or skipped.'));
    }
    const javaCode = file.endsWith('.java') ? maskJavaNonCode(content) : '';
    const methodVariables = [...javaCode.matchAll(/\b(?:(?:java\.lang\.reflect\.)?Method|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]{0,600}?\.getDeclaredMethod\s*\(/gu)]
      .map((match) => match[1]);
    const parameterOnlyAnnotations = '(?:RequestBody|RequestPart|RequestParam|RequestHeader|PathVariable|CookieValue|MatrixVariable|Valid|Validated|NotNull|NotEmpty|NotBlank|Size|Min|Max|Positive|PositiveOrZero|Negative|NegativeOrZero)';
    const invalidReflectionPatterns = [
      ...methodVariables.map((name) => new RegExp(`\\b${name}\\s*\\.\\s*getAnnotation\\s*\\(\\s*${parameterOnlyAnnotations}\\.class\\s*\\)`, 'gu')),
      new RegExp(String.raw`\.getDeclaredMethod\s*\([^;]{0,600}?\)\s*\.\s*getAnnotation\s*\(\s*${parameterOnlyAnnotations}\.class\s*\)`, 'gu'),
    ];
    for (const pattern of invalidReflectionPatterns) {
      for (const match of javaCode.matchAll(pattern)) {
        if (!rangeTouchesAddedLine(record, content, match.index, match.index + match[0].length)) continue;
        findings.push(finding('QUALITY-TEST-003', file, lineAt(content, match.index),
          'Method.getAnnotation() cannot observe parameter annotations; select the parameter and use Parameter.getAnnotation()/getParameterAnnotations().'));
      }
    }
  }
  if (!isGovernanceImplementation) {
    for (const match of content.matchAll(/(?:"[^"\r\n]+"\s*:\s*"(?:latest|\*)"|\b[^\s'"@]+@latest\b|\bnpx\b[^\r\n]{0,300}@latest\b|\bcurl\b[^\r\n|]{0,500}\|\s*(?:bash|sh)\b)/giu)) {
      findings.push(finding('SUPPLY-001', file, lineAt(content, match.index),
        'Mutable latest/wildcard dependency or remote installer is forbidden.'));
    }
    if (file === 'docker-forge-admin/Dockerfile.admin'
      || /(?:^|\/)(?:Dockerfile|[^/]+\.dockerfile)$/iu.test(file)) {
      for (const match of content.matchAll(/^\s*FROM\s+(?!\$\{?)([^\s]+)(?:\s+AS\s+\S+)?\s*$/gimu)) {
        if (!/@sha256:[a-f0-9]{64}$/iu.test(match[1])) {
          findings.push(finding('SUPPLY-001', file, lineAt(content, match.index),
            `Container base is mutable and has no manifest digest: ${match[1].slice(0, 160)}.`));
        }
      }
    }
    if (/\.(?:ya?ml)$/iu.test(file)) {
      for (const match of content.matchAll(/^\s*image:\s*([^\s#]+)\s*(?:#.*)?$/gimu)) {
        if (!/\$\{/u.test(match[1]) && !/@sha256:[a-f0-9]{64}$/iu.test(match[1])) {
          findings.push(finding('SUPPLY-001', file, lineAt(content, match.index),
            `Compose runtime image is mutable and has no manifest digest: ${match[1].slice(0, 160)}.`));
        }
      }
    }
    const packagingProperties = /(?:^|\/)pom\.xml$/u.test(file)
      ? explicitPackagingProperties(content) : [];
    for (const match of content.matchAll(/<\s*(?:skipTests|maven\.test\.skip|forge\.tests\.skip)\s*>\s*true\s*<\/|\b(?:maven\.test\.skip|forge\.tests\.skip)\s*[=:]\s*true\b|(?<![\w-])-D(?:skipTests(?![=\w])|(?:skipTests|maven\.test\.skip|forge\.tests\.skip)=true\b)|--passWithNoTests\b/giu)) {
      if (match[0].startsWith('<') && packagingProperties.some(([start, end]) => match.index >= start && match.index < end)) continue;
      findings.push(finding('QUALITY-BUILD-001', file, lineAt(content, match.index),
        'Build configuration disables or makes required tests optional.'));
    }
  }
}

function explicitPackagingProperties(content) {
  const xml = content.replace(/<!--[\s\S]*?-->/gu, comment => comment.replace(/[^\r\n]/gu, ' '));
  // This opt-in profile contains only its id and properties: any activation or
  // plugin configuration remains outside the exception, as do verification commands.
  const ranges = [];
  for (const match of xml.matchAll(/<profile\s*>([\s\S]*?)<\/profile\s*>/gu)) {
    const properties = /^\s*<id\s*>\s*fast-package\s*<\/id\s*>\s*<properties\s*>([\s\S]*?)<\/properties\s*>\s*$/u.exec(match[1]);
    if (!properties) continue;
    const bodyStart = match.index + match[0].indexOf('>') + 1;
    const propertiesStart = bodyStart + match[1].indexOf('>', match[1].indexOf('<properties')) + 1;
    ranges.push([propertiesStart, propertiesStart + properties[1].length]);
  }
  return ranges;
}

function resourceRows(records, findings) {
  const rows = [];
  for (const record of records) {
    for (const item of changedInsertStatements(record)) {
      if (!item.parsed || item.parsed.table !== 'sys_resource') continue;
      if (item.parsed.unresolvedResourceUnion) {
        findings.push(finding('PERMISSION-CONTRACT-001', record.path, lineAt(record.content, item.index),
          'A changed UNION ALL resource insert must contain complete literal resource projections.'));
        continue;
      }
      for (const [rowIndex, row] of item.parsed.rows.entries()) {
        const resourceType = sqlInteger(rowValue(item.parsed, row, 'resource_type'));
        if (![2, 3, 4].includes(resourceType)) continue;
        const parent = rowValue(item.parsed, row, 'parent_id').replace(/\s+/gu, '').toLowerCase();
        rows.push({
          file: record.path,
          line: lineAt(record.content, item.index),
          resourceType,
          parent,
          menuOwner: item.parsed.menuOwners?.[rowIndex] ?? scalarMenuOwner(record, item.index, parent),
          componentExpression: rowValue(item.parsed, row, 'component'),
          permission: normalizedPermission(rowValue(item.parsed, row, 'perms')),
          method: (sqlLiteral(rowValue(item.parsed, row, 'api_method')) ?? '').toUpperCase(),
          apiPath: normalizedApiPath(rowValue(item.parsed, row, 'api_url')),
        });
      }
    }
  }
  return rows;
}

function controllerPermission(annotations) {
  const matches = [...annotations.matchAll(/@SaCheckPermission\b/gu)];
  if (matches.length === 0) return null;
  const unresolved = { values: [], mode: 'unknown', display: '<unresolved>' };
  if (matches.length !== 1) return unresolved;
  const start = matches[0].index + matches[0][0].length;
  const opening = /^\s*\(/u.exec(annotations.slice(start));
  if (!opening) return unresolved;
  const open = start + opening[0].length - 1;
  const close = findMatchingParenthesis(annotations, open);
  if (close < 0) return unresolved;
  const args = annotations.slice(open + 1, close).trim();
  const scalar = /^(?:value\s*=\s*)?"([^"\\\r\n]+)"(?:\s*,\s*mode\s*=\s*SaMode\.(?:AND|OR))?\s*$/u.exec(args);
  if (scalar?.[1].trim()) return { values: [scalar[1]], mode: 'single', display: scalar[1] };
  const array = /^value\s*=\s*\{([^}]*)\}\s*,\s*mode\s*=\s*SaMode\.(OR|AND)\s*$/u.exec(args);
  if (!array || !/^\s*"[^"\\\r\n]+"(?:\s*,\s*"[^"\\\r\n]+")*\s*,?\s*$/u.test(array[1])) return unresolved;
  const values = [...array[1].matchAll(/"([^"\\\r\n]+)"/gu)].map((match) => match[1]);
  if (values.some((value) => !value.trim())) return unresolved;
  return { values, mode: array[2], display: values.join(` ${array[2]} `) };
}

function controllerAnnotationBoundaries(code) {
  const boundaries = code.split('');
  for (const match of code.matchAll(/@SaCheckPermission\s*\(/gu)) {
    const close = findMatchingParenthesis(code, match.index + match[0].length - 1);
    if (close < 0) continue;
    // An annotation's array braces are not the preceding Java method boundary.
    for (let index = match.index; index <= close; index += 1) {
      if (/[{};]/u.test(code[index])) boundaries[index] = ' ';
    }
  }
  return boundaries.join('');
}

function controllerContracts(records) {
  const contracts = [];
  for (const record of records.filter((item) => item.status !== 'D'
    && /\/controller\/[^/]+Controller\.java$/u.test(item.path))) {
    const code = maskJavaComments(record.content);
    const classIndex = code.search(/\bclass\s+\w+Controller\b/u);
    const classAnnotations = classIndex >= 0 ? code.slice(Math.max(0, classIndex - 1200), classIndex) : '';
    const requestMapping = /@RequestMapping\b\s*(?:\(([^)]*)\))?/u.exec(classAnnotations);
    const basePath = annotationStringPath(requestMapping?.[1]);
    const classPermission = controllerPermission(classAnnotations);
    const classPublic = /@(?:PublicApi|SaIgnore|ApiPermissionIgnore)\b/u.test(classAnnotations);
    const boundaryCode = controllerAnnotationBoundaries(code);
    for (const mapping of javaHttpMappings(record.content)) {
      const annotationBoundary = Math.max(classIndex, boundaryCode.lastIndexOf('}', mapping.index), boundaryCode.lastIndexOf(';', mapping.index));
      const declarationOffset = maskJavaNonCode(code.slice(mapping.end, Math.min(code.length, mapping.end + 1200))).search(/\b(?:public|protected|private)\b/u);
      const annotationEnd = declarationOffset >= 0 ? mapping.end + declarationOffset : mapping.end;
      const annotations = code.slice(Math.max(0, annotationBoundary + 1), annotationEnd);
      const permission = controllerPermission(annotations) ?? classPermission;
      contracts.push({
        file: record.path,
        line: lineAt(record.content, mapping.index),
        method: mapping.method.toUpperCase(),
        apiPath: normalizedControllerPath(`${basePath}/${mapping.path}`),
        permission: permission?.display ?? '',
        permissionValues: permission && ['single', 'OR'].includes(permission.mode) ? permission.values : [],
        permissionMode: permission?.mode ?? 'missing',
        public: classPublic || /@(?:PublicApi|SaIgnore|ApiPermissionIgnore)\b/u.test(annotations),
      });
    }
  }
  return contracts;
}

async function currentControllerRecords(root, changedRecords) {
  const byPath = new Map(changedRecords.filter((record) => /\/controller\/[^/]+Controller\.java$/u.test(record.path))
    .map((record) => [record.path, record]));
  // Accepted upstream files can remain untracked while a later task wires permissions.
  // Read them as dependency context without adding them to the task's scan records.
  const current = nulPaths(runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'forge-server'], { encoding: null }), 'current controller path')
    .filter((file) => /\/controller\/[^/]+Controller\.java$/u.test(file));
  for (const file of current) {
    if (byPath.has(file)) continue;
    const resolved = await resolveInputFile(root, file);
    const content = await readFile(resolved.absolute, 'utf8');
    byPath.set(file, { status: 'B', path: file, content, addedLines: [], addedContent: '' });
  }
  return [...byPath.values()].filter((record) => record.status !== 'D');
}

function currentRepositoryPaths(root, records) {
  const paths = new Set(nulPaths(runGit(root, ['ls-files', '-z'], { encoding: null }), 'tracked repository path'));
  // Menu resolution needs current upstream views, including not-yet-committed pages.
  for (const file of nulPaths(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'forge-admin-ui/src/views'],
    { encoding: null }), 'untracked menu component path')) paths.add(file);
  for (const record of records) {
    if (record.status === 'D') paths.delete(record.path);
    else paths.add(record.path);
  }
  return paths;
}

function javaTestFrameworkRequirements(content) {
  const requirements = [];
  const candidates = [
    ['junit', /\bimport\s+(?:static\s+)?org\.junit(?:\.jupiter)?\./u],
    ['assertj', /\bimport\s+(?:static\s+)?org\.assertj\./u],
    ['mockito', /\bimport\s+(?:static\s+)?org\.mockito\./u],
    ['testng', /\bimport\s+(?:static\s+)?org\.testng\./u],
  ];
  for (const [framework, pattern] of candidates) {
    const match = pattern.exec(content);
    if (match) requirements.push({ framework, index: match.index });
  }
  return requirements;
}

function mavenTestFrameworks(pomContent) {
  const withoutComments = pomContent.replace(/<!--[\s\S]*?-->/gu, '');
  const dependenciesOnly = withoutComments
    .replace(/<dependencyManagement\b[\s\S]*?<\/dependencyManagement\s*>/giu, '')
    .replace(/<build\b[\s\S]*?<\/build\s*>/giu, '');
  const artifacts = new Set();
  for (const match of dependenciesOnly.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency\s*>/giu)) {
    const artifact = /<artifactId\b[^>]*>\s*([^<\s]+)\s*<\/artifactId\s*>/iu.exec(match[1])?.[1];
    if (artifact) artifacts.add(artifact);
  }
  const frameworks = new Set();
  if (artifacts.has('spring-boot-starter-test')) {
    frameworks.add('junit');
    frameworks.add('assertj');
    frameworks.add('mockito');
  }
  if ([...artifacts].some((artifact) => /^(?:junit|junit-jupiter(?:-api|-engine|-params)?)$/u.test(artifact))) frameworks.add('junit');
  if (artifacts.has('assertj-core')) frameworks.add('assertj');
  if ([...artifacts].some((artifact) => /^mockito-(?:core|inline|junit-jupiter)$/u.test(artifact))) frameworks.add('mockito');
  if (artifacts.has('testng')) frameworks.add('testng');
  return frameworks;
}

function localMavenParentPom(pomPath, pomContent) {
  const xml = pomContent.replace(/<!--[\s\S]*?-->/gu, '');
  const parent = /<parent\b[^>]*>([\s\S]*?)<\/parent\s*>/iu.exec(xml)?.[1];
  if (!parent || /<relativePath\s*\/\s*>/iu.test(parent)) return null;
  const explicit = /<relativePath\b[^>]*>\s*([^<]+?)\s*<\/relativePath\s*>/iu.exec(parent)?.[1]?.trim();
  const relative = explicit || '../pom.xml';
  if (relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative) || /^[A-Za-z]:/u.test(relative)) return null;
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(pomPath), relative));
  if (candidate === '..' || candidate.startsWith('../') || path.posix.isAbsolute(candidate)) return null;
  return candidate;
}

async function currentRepositoryText(root, repositoryPath, recordsByPath, repositoryPaths) {
  const changed = recordsByPath.get(repositoryPath);
  if (changed) return changed.status === 'D' ? null : changed.content;
  if (!repositoryPaths.has(repositoryPath)) return null;
  const resolved = await resolveInputFile(root, repositoryPath);
  return readFile(resolved.absolute, 'utf8');
}

async function effectiveMavenTestFrameworks(root, modulePath, recordsByPath, repositoryPaths) {
  const frameworks = new Set();
  const visited = new Set();
  let pomPath = `${modulePath}/pom.xml`;
  for (let depth = 0; pomPath && depth < 12; depth += 1) {
    if (visited.has(pomPath)) break;
    visited.add(pomPath);
    const content = await currentRepositoryText(root, pomPath, recordsByPath, repositoryPaths);
    if (content === null) break;
    for (const framework of mavenTestFrameworks(content)) frameworks.add(framework);
    const parent = localMavenParentPom(pomPath, content);
    pomPath = parent && repositoryPaths.has(parent) ? parent : null;
  }
  return frameworks;
}

function menuComponentCandidates(component) {
  const normalized = component.replace(/^\/+|^@\/views\//gu, '').replace(/\.(?:vue|jsx?|tsx?)$/u, '');
  return [
    `forge-admin-ui/src/views/${normalized}.vue`,
    `forge-admin-ui/src/views/${normalized}.js`,
    `forge-admin-ui/src/views/${normalized}.ts`,
    `forge-admin-ui/src/views/${normalized}.tsx`,
    `forge-admin-ui/src/views/${normalized}/index.vue`,
  ];
}

function changedMethod(record, pattern) {
  const range = javaMethodRange(maskJavaNonCode(record.content), pattern);
  return range && rangeTouchesAddedLine(record, record.content, range.start, range.end) ? range : null;
}

function javaEndpointSource(content, mapping) {
  const masked = maskJavaNonCode(content);
  const classIndex = masked.search(/\bclass\s+\w+Controller\b/u);
  const classOpen = classIndex >= 0 ? masked.indexOf('{', classIndex) : -1;
  if (classOpen < 0 || classOpen >= mapping.index) return null;
  const boundary = Math.max(classOpen, masked.lastIndexOf('}', mapping.index), masked.lastIndexOf(';', mapping.index));
  const start = boundary + 1 + (content.slice(boundary + 1).search(/\S/u));
  const declarationOffset = masked.slice(mapping.end, mapping.end + 1200).search(/\b(?:public|protected|private)\b/u);
  if (declarationOffset < 0) return null;
  const declaration = mapping.end + declarationOffset;
  const range = javaMethodRange(masked.slice(declaration), /^[^;{]*\{/u);
  if (!range) return null;
  const end = declaration + range.end;
  return { start, end, source: content.slice(start, end) };
}

function sameEndpointAfterBodyTransport(before, after) {
  if (!before || !after) return false;
  const signature = /\bpublic\s+([\w<>, ?]+)\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/u;
  const oldCode = maskJavaComments(before), newCode = maskJavaComments(after);
  const oldMethod = signature.exec(oldCode), newMethod = signature.exec(newCode);
  if (!oldMethod || !newMethod || oldMethod[1] !== newMethod[1] || oldMethod[2] !== newMethod[2]) return false;
  const bodyParam = /^\s*@(?:Valid|Validated)\s+@RequestBody\s+\w+\s+(\w+)\s*$/u.exec(newMethod[3]);
  const params = oldMethod[3].split(',').map(value => /^\s*@RequestParam\s+(String|Long|Integer|Boolean)\s+(\w+)\s*$/u.exec(value));
  if (!bodyParam || params.length === 0 || params.some(value => !value)) return false;
  const receiver = bodyParam[1];
  let normalized = newCode.slice(newMethod.index + newMethod[0].length);
  for (const [, type, name] of params) {
    const getter = `get${name[0].toUpperCase()}${name.slice(1)}`;
    const pattern = new RegExp(`\\b${receiver}\\.${getter}\\s*\\(\\s*\\)`, 'gu');
    // Replacements apply only to code, never literals or comments.
    const masked = maskJavaNonCode(normalized);
    normalized = normalized.replace(pattern, (match, offset) => masked.slice(offset, offset + match.length) === match ? name : match);
    const aliasCode = maskJavaNonCode(normalized);
    normalized = normalized.replace(new RegExp(`\\b${type}\\s+${name}\\s*=\\s*${name}\\s*;`, 'gu'),
      (match, offset) => aliasCode.slice(offset, offset + match.length) === match ? '' : match);
  }
  const prefix = newCode.slice(0, newMethod.index);
  const reconstructed = prefix + oldMethod[0] + normalized;
  // Only transport binding and redundant aliases may change. Guards, delegates,
  // route/permission/log annotations and response behavior remain identical.
  if (oldCode.includes('"""') || reconstructed.includes('"""')) return false;
  const canonical = code => code.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu)
    .map((part, index) => index % 2 ? part : part.replace(/\s+/gu, '')).join('');
  return canonical(reconstructed) === canonical(oldCode);
}

function displayLocalizationCatalogs(records) {
  const catalogs = new Map();
  const parse = (content) => {
    const values = new Map();
    for (const line of content.split(/\r?\n/u)) {
      const match = /^([A-Za-z0-9_.-]+)=(.*)$/u.exec(line);
      if (!match) continue;
      const value = match[2].trimStart();
      values.set(match[1], values.has(match[1]) || value.includes('\\') ? null : value);
    }
    return values;
  };
  for (const record of records) {
    const module = /^(forge-server\/.+)\/src\/main\/resources\/forge\/i18n\/business\/messages\.properties$/u.exec(record.path)?.[1];
    if (!module || !['A', 'M', 'U'].includes(record.status)) continue;
    if (catalogs.has(module)) { catalogs.set(module, null); continue; }
    const values = parse(record.content);
    const base = typeof record.baseContent === 'string' ? parse(record.baseContent) : new Map();
    for (const [key, value] of values) {
      if (base.has(key) && base.get(key) !== value) values.set(key, null);
    }
    catalogs.set(module, values);
  }
  return catalogs;
}

function sameEndpointAfterDisplayLocalization(record, before, after, catalogs) {
  if (!before || !after || before.includes('"""') || after.includes('"""')) return false;
  const code = maskJavaNonCode(record.content);
  if (!/^\s*import\s+com\.mdframe\.forge\.starter\.core\.i18n\.UiMessages\s*;/mu.test(code)
      || /\b(?:class|interface|enum|record|[A-Za-z_$][\w$]*(?:<[^>]+>)?)\s+UiMessages\b/u.test(code)) return false;
  const module = /^(forge-server\/.+)\/src\/main\/java\//u.exec(record.path)?.[1];
  const catalog = catalogs?.get(module);
  const literal = value => /^"(?:\\.|[^"\\\r\n])*"$/u.test(value);
  const normalize = (source) => {
    const text = maskJavaComments(source), masked = maskJavaNonCode(text), replacements = [];
    for (const match of masked.matchAll(/\bUiMessages\s*\.\s*(label|translate|message)\s*\(/gu)) {
      const prefix = text.slice(0, match.index);
      // Only fixed display arguments, never return values, guards, machine values,
      // arbitrary String.format calls or other method bodies.
      if (!/(?:\bthrow\s+new\s+BusinessException\s*\(|\bURLEncoder\s*\.\s*encode\s*\(|\.setSummary\s*\(\s*String\s*\.\s*format\s*\()\s*$/u.test(prefix)) continue;
      const open = match.index + match[0].lastIndexOf('(');
      const close = findMatchingParenthesis(text, open);
      if (close < 0) continue;
      const args = splitTopLevel(text.slice(open + 1, close)).map(value => value.trim());
      let replacement;
      if (match[1] === 'label' && args.length === 2 && args.every(literal)) replacement = args[0];
      if (match[1] === 'translate' && args.length === 1 && literal(args[0])) replacement = args[0];
      if (match[1] === 'message' && literal(args[0] ?? '') && catalog) {
        let key;
        try { key = JSON.parse(args[0]); } catch { continue; }
        const value = catalog.get(key);
        if (typeof value !== 'string' || value.includes("'")) continue;
        if (args.length === 1 && !/[{}]/u.test(value)) replacement = JSON.stringify(value);
        else if (args.length === 2 && /^[^{}]*\{0\}$/u.test(value)
            && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*(?:\(\))?)*$/u.test(args[1])) {
          replacement = `${JSON.stringify(value.slice(0, -3))} + ${args[1]}`;
        }
      }
      if (replacement !== undefined) replacements.push({ start: match.index, end: close + 1, replacement });
    }
    let normalized = text;
    for (const item of replacements.reverse()) normalized = normalized.slice(0, item.start) + item.replacement + normalized.slice(item.end);
    const canonical = normalized.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu)
      .map((part, index) => index % 2 ? part : part.replace(/\s+/gu, '')).join('');
    return { canonical, replacements: replacements.length };
  };
  const previous = normalize(before), current = normalize(after);
  return current.replacements > 0 && previous.canonical === current.canonical;
}

function unchangedJavaEndpoint(record, mapping, classRoute, displayCatalogs) {
  if (record.status !== 'M' || typeof record.baseContent !== 'string') return false;
  const baseCode = maskJavaComments(record.baseContent);
  const baseClassIndex = baseCode.search(/\bclass\s+\w+Controller\b/u);
  if (baseClassIndex < 0) return false;
  const baseAnnotations = baseCode.slice(Math.max(0, baseClassIndex - 1200), baseClassIndex);
  if (/@(?:SaCheckPermission|PublicApi)\b/u.test(baseAnnotations)) return false;
  const baseRoute = /@RequestMapping\b\s*(?:\(([^)]*)\))?/u.exec(baseAnnotations)?.[0] ?? '';
  if (baseRoute !== classRoute) return false;
  const current = javaEndpointSource(record.content, mapping);
  if (!current) return false;
  const matches = javaHttpMappings(record.baseContent).filter(item => item.method === mapping.method && item.path === mapping.path);
  if (matches.length !== 1) return false;
  const previous = javaEndpointSource(record.baseContent, matches[0])?.source;
  return (!rangeTouchesAddedLine(record, record.content, current.start, current.end) && previous === current.source)
    || sameEndpointAfterBodyTransport(previous, current.source)
    || sameEndpointAfterDisplayLocalization(record, previous, current.source, displayCatalogs);
}

function assertedJUnitClassReferences(content) {
  const code = maskJavaNonCode(content);
  const junitImport = /\bimport\s+org\.junit(?:\.jupiter\.api)?\.Test\s*;/u.test(code);
  const tests = [...code.matchAll(/@(?:org\.junit(?:\.jupiter\.api)?\.)?Test\b/gu)];
  if (tests.length === 0 || (!junitImport && !/@org\.junit(?:\.jupiter\.api)?\.Test\b/u.test(code))) return [];
  const staticAssertions = [...code.matchAll(/\bimport\s+static\s+org\.junit\.(?:jupiter\.api\.Assertions|Assert)\.(assert[\w$]+|\*)\s*;/gu)].map(match => match[1]);
  const assertionImport = /\bimport\s+org\.junit\.(?:jupiter\.api\.Assertions|Assert)\s*;/u.test(code);
  const assertedBodies = tests.flatMap(test => {
    const range = javaMethodRange(code.slice(test.index), /^[^{;]*\{/u);
    if (!range) return [];
    const body = code.slice(test.index + range.start, test.index + range.end);
    const asserted = staticAssertions.some(name => new RegExp(`\\b${name === '*' ? 'assert[\\w$]+' : name}\\s*\\(`, 'u').test(body))
      || (assertionImport && /\b(?:Assertions|Assert)\.assert[\w$]+\s*\(/u.test(body))
      || /\borg\.junit\.(?:jupiter\.api\.Assertions|Assert)\.assert[\w$]+\s*\(/u.test(body);
    return asserted ? [body] : [];
  });
  if (assertedBodies.length === 0) return [];
  const classLiterals = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*class\b/gu)].map(match => match[1]);
  const constructed = assertedBodies.flatMap(body => [...body.matchAll(/\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^;{}()]*>)?\s*\(/gu)].map(match => match[1]));
  return [...classLiterals, ...constructed];
}

async function scanCrossFile(root, records, findings, legacyFindings = [], roleGrantPolicy, displayCatalogs) {
  const changedTestPaths = records.filter((record) => /(?:\/src\/test\/|\/__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$)/u.test(record.path))
    .map((record) => record.path.toLowerCase());
  const assertedClasses = new Set(records.filter(record => /\/src\/test\/.*\.java$/u.test(record.path))
    .flatMap(record => assertedJUnitClassReferences(record.content)));
  for (const record of records.filter((item) => ['A', 'U'].includes(item.status))) {
    const javaName = /\/([^/]+?)(?:Controller|ServiceImpl|Service|Util|Utils|Helper)\.java$/u.exec(record.path)?.[1];
    const javaClassName = path.posix.basename(record.path, '.java');
    if (javaName && !changedTestPaths.some((testPath) => testPath.includes(javaName.toLowerCase())) && !assertedClasses.has(javaClassName)) {
      findings.push(finding('QUALITY-TEST-001', record.path, 1, `New production class ${javaName}* has no matching changed automated test.`));
    }
    if (/^forge-admin-ui\/src\/components\/[^/]+\.vue$/u.test(record.path)) {
      const component = path.posix.basename(record.path, '.vue').toLowerCase();
      if (!changedTestPaths.some((testPath) => testPath.includes(component))) {
        findings.push(finding('QUALITY-TEST-001', record.path, 1, 'New global Vue component has no matching component test.'));
      }
    }
  }

  const repositoryPaths = currentRepositoryPaths(root, records);
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  for (const record of records.filter((item) => item.status !== 'D' && /\/src\/test\/java\/.*\.java$/u.test(item.path))) {
    const requirements = javaTestFrameworkRequirements(record.content);
    if (requirements.length === 0) continue;
    const modulePath = record.path.slice(0, record.path.indexOf('/src/test/java/'));
    const available = await effectiveMavenTestFrameworks(root, modulePath, recordsByPath, repositoryPaths);
    for (const requirement of requirements.filter((item) => !available.has(item.framework))) {
      findings.push(finding('QUALITY-TEST-004', record.path, lineAt(record.content, requirement.index),
        `Java test imports ${requirement.framework}, but its owning Maven module/declared local parent chain has no compatible test dependency.`));
    }
  }

  const resources = resourceRows(records, findings);
  if (resources.length > 0) {
    for (const resource of resources.filter((item) => item.resourceType === 2)) {
      const component = sqlLiteral(resource.componentExpression);
      const unsafe = component !== null && (/^(?:https?:|\/)/iu.test(component) || component.includes('..') || component.includes('\\'));
      if (component === null || component.trim() === '' || unsafe
          || !menuComponentCandidates(component).some((candidate) => repositoryPaths.has(candidate))) {
        findings.push(finding('FE-MENU-001', resource.file, resource.line,
          component === null
            ? 'A changed menu component is not a literal and cannot be bound to a reviewed frontend view.'
            : `Menu component ${component || '<empty>'} does not resolve to a real forge-admin-ui/src/views component.`));
      }
    }

    const apiResources = resources.filter((item) => item.resourceType === 4);
    const buttonResources = resources.filter((item) => item.resourceType === 3);
    const controllers = apiResources.length > 0 || buttonResources.length > 0
      ? controllerContracts(await currentControllerRecords(root, records)) : [];
    for (const resource of apiResources) {
      if (!resource.method || !resource.apiPath || !resource.permission) {
        findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
          'A changed API resource must declare literal perms, api_method, and api_url values.'));
        continue;
      }
      const endpoint = resourceControllerEndpoint(controllers, resource);
      if (!endpoint) {
        findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
          `${resource.method} ${resource.apiPath} has no matching non-public Forge Controller endpoint.`));
      } else if (endpoint.permissionMode !== 'OR' && endpoint.permission !== resource.permission
          && !(isSharedDynamicCrudEndpoint(endpoint) && endpoint.permissionMode === 'missing')) {
        // Forge independently checks configured type-4 resources by URL and HTTP method.
        // A fully literal OR annotation adds business authorization; it need not repeat
        // the route permission or introduce replacement buttons in this migration.
        const businessAnchor = buttonResources.find((candidate) => candidate.permission === endpoint.permission
          && candidate.parent && resource.parent && sameResourceMenu(candidate, resource));
        if (!businessAnchor) {
          findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
            `${resource.method} ${resource.apiPath} declares route resource ${resource.permission}, but ${endpoint.file}:${endpoint.line} enforces ${endpoint.permission || '<none>'} and no same-menu business permission anchor exists.`));
        }
      }
    }
    for (const resource of buttonResources.filter((item) => item.permission)) {
      const matchingApis = apiResources.filter((candidate) => candidate.permission === resource.permission);
      const matchingControllers = controllers.filter((candidate) => !candidate.public
        && candidate.permissionValues.includes(resource.permission));
      if (matchingControllers.length === 0 && matchingApis.length === 0
          && (apiResources.length > 0 || controllers.some((candidate) => candidate.permission))) {
        findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
          `Button permission ${resource.permission} has no matching API resource or Controller enforcement contract.`));
      }
      for (const endpoint of matchingControllers) {
        const matchingApi = apiResources.find((candidate) => candidate.method === endpoint.method
          && candidate.apiPath === endpoint.apiPath);
        if (!matchingApi) {
          findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
            `Button permission ${resource.permission} has Controller enforcement at ${endpoint.method} ${endpoint.apiPath} but no matching type-4 API resource.`));
        } else if (resource.parent && matchingApi.parent && !sameResourceMenu(resource, matchingApi)) {
          findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
            `Button permission ${resource.permission} and ${endpoint.method} ${endpoint.apiPath} must share the same owning menu parent.`));
        }
      }
      for (const matchingApi of matchingApis) {
        if (resource.parent && matchingApi.parent && !sameResourceMenu(resource, matchingApi)) {
          findings.push(finding('PERMISSION-CONTRACT-001', resource.file, resource.line,
            `Button/API permission ${resource.permission} must share the same owning menu parent.`));
        }
      }
    }
  }

  for (const record of records.filter((item) => item.status !== 'D' && item.path.endsWith('.sql'))) {
    for (const item of changedInsertStatements(record)) {
      if (item.parsed?.table !== 'sys_role_resource') continue;
      const sql = maskComments(item.statement);
      const activeRole = roleGrantFiltersActiveRole(sql);
      if (!activeRole) {
        findings.push(finding('PERMISSION-ROLE-001', record.path, lineAt(record.content, item.index),
          'A changed role-resource grant must join/guard sys_role and filter role_status = 1 plus del_flag = 0.'));
      }
      if (roleGrantPolicy !== undefined) {
        const decision = roleGrantPolicy.decisions.find(value => value.path === record.path
          && value.fileSha256 === record.sha256 && value.statementSha256 === sha256(item.statement));
        const roles = explicitRoleGrantRecipients(item.statement);
        if (!decision || roles === null || JSON.stringify(roles) !== JSON.stringify(decision.roleKeys)) {
          findings.push(finding('PERMISSION-ROLE-001', record.path, lineAt(record.content, item.index),
            'This role grant requires a protected explicit decision matching the exact SQL file, statement, and finite recipient roles.'));
        }
      }
    }
  }

  const pageQuery = records.find((record) => record.status !== 'D' && /\/PageQuery\.java$/u.test(record.path));
  const resolver = records.find((record) => record.status !== 'D' && /\/PageParamResolver\.java$/u.test(record.path));
  const pageOwnerChanged = pageQuery && (
    changedMethod(pageQuery, /\btoPage\s*\([^)]*\)\s*\{/u)
    || changedMethod(pageQuery, /\bgetPage(?:Num|Size)\s*\([^)]*\)\s*\{/u));
  const resolverChanged = resolver && changedMethod(resolver, /\b(?:public\s+)?(?:static\s+)?int\s+resolve\s*\([^)]*\)\s*\{/u);
  const pageTests = records.filter((record) => record.status !== 'D' && /\/src\/test\/.*(?:PageQuery|PageParamResolver)[^/]*Test\.java$/u.test(record.path));
  if (pageOwnerChanged) {
    const evidence = maskJavaComments(pageTests.map((record) => record.content).join('\n'));
    const required = [/[=(,]\s*null\b/u, /[=(,]\s*0\b/u, /[=(,]\s*-1\b/u, /[=(,]\s*100\b/u, /[=(,]\s*(?:101|[2-9]\d{2,})\b/u];
    if (!/\b(?:toPage|getPageNum|getPageSize)\s*\(/u.test(evidence) || required.some((pattern) => !pattern.test(evidence))) {
      findings.push(finding('BE-PAGE-002', pageQuery.path, 1,
        'A changed PageQuery owner requires changed boundary tests for null, zero, negative, maximum, and over-maximum inputs.'));
    }
  }
  if (resolverChanged) {
    const evidence = maskJavaComments(pageTests.map((record) => record.content).join('\n'));
    if (!/\bPageParamResolver\s*\.\s*resolve\s*\(/u.test(evidence)
        || [/[=(,]\s*null\b/u, /[=(,]\s*0\b/u, /[=(,]\s*-1\b/u].some((pattern) => !pattern.test(evidence))) {
      findings.push(finding('BE-PAGE-002', resolver.path, 1,
        'A changed PageParamResolver.resolve() requires changed executable tests for null, zero, and negative aliases.'));
    }
  }
  for (const record of pageTests) {
    const code = maskJavaComments(record.content);
    const invalidAssertions = [
      /\bassertEquals\s*\(\s*(0|-\d+)\s*,[\s\S]{0,300}?\b(?:PageParamResolver\.resolve|getPageNum|getPageSize|getCurrent|getSize)\s*\(/gu,
      /\bassertEquals\s*\(\s*((?:10[1-9]|1[1-9]\d|[2-9]\d{2,}))\s*,[\s\S]{0,300}?\b(?:getPageSize|getSize)\s*\(/gu,
    ];
    for (const pattern of invalidAssertions) {
      for (const match of code.matchAll(pattern)) {
        if (!rangeTouchesAddedLine(record, record.content, match.index, match.index + match[0].length)) continue;
        findings.push(finding('BE-PAGE-002', record.path, lineAt(record.content, match.index),
          `Pagination boundary test fixes an illegal normalized result (${match[1]}); assert page 1 or the configured page-size ceiling.`));
      }
    }
  }

  const aggregate = records.map((record) => record.content).join('\n');
  const changedSql = records.filter((record) => record.status !== 'D' && record.path.endsWith('.sql'))
    .map((record) => record.content).join('\n');
  for (const record of records.filter((item) => ['A', 'M', 'C', 'R', 'U', 'P'].includes(item.status)
    && /\/controller\/[^/]+Controller\.java$/u.test(item.path))) {
    const code = maskJavaComments(record.content);
    const classIndex = code.search(/\bclass\s+\w+Controller\b/u);
    const classAnnotations = classIndex >= 0 ? code.slice(Math.max(0, classIndex - 1200), classIndex) : '';
    const classProtected = /@(?:SaCheckPermission|PublicApi)\b/u.test(classAnnotations);
    const requestMapping = /@RequestMapping\b\s*(?:\(([^)]*)\))?/u.exec(classAnnotations);
    const basePath = annotationStringPath(requestMapping?.[1]);
    for (const mapping of javaHttpMappings(record.content)) {
      const annotationBoundary = Math.max(classIndex, code.lastIndexOf('}', mapping.index), code.lastIndexOf(';', mapping.index));
      const declarationOffset = maskJavaNonCode(code.slice(mapping.end, Math.min(code.length, mapping.end + 1200))).search(/\b(?:public|protected|private)\b/u);
      const annotationEnd = declarationOffset >= 0 ? mapping.end + declarationOffset : mapping.end;
      const methodAnnotations = code.slice(Math.max(0, annotationBoundary + 1), annotationEnd);
      if (classProtected || /@(?:SaCheckPermission|PublicApi)\b/u.test(methodAnnotations)) continue;
      const method = mapping.method.toUpperCase();
      const endpointPath = `${basePath}/${mapping.path}`.replace(/\/+/gu, '/');
      const resourceBound = changedSql.split(';').some((statement) => statement.includes(endpointPath)
        && new RegExp(`(?:api_method[^\r\n]{0,300}?${method}|${method}[^\r\n]{0,300}?api_method)`, 'iu').test(statement)
        && /(?:resource_type[^\r\n]{0,300}\b4\b|\btype\s*=\s*4\b)/iu.test(statement));
      if (!resourceBound) {
        const item = finding('PERMISSION-API-001', record.path, lineAt(record.content, mapping.index),
          `${method} ${endpointPath} has neither backend permission enforcement nor an exact changed API resource.`);
        if (unchangedJavaEndpoint(record, mapping, requestMapping?.[0] ?? '', displayCatalogs)) {
          legacyFindings.push({ ...item, severity: 'legacy', evidence: {
            applicability: 'unchanged-at-review-base', baseContentSha256: sha256(record.baseContent),
          } });
        } else findings.push(item);
      }
    }
  }
  const workflowIntent = records.some((record) => ['A', 'M', 'C', 'R', 'U', 'P'].includes(record.status)
    && /(?:approval|approve|审批|审核|processInstance|businessFlow)/iu.test(`${record.path}\n${record.addedContent}`));
  if (workflowIntent) {
    const hasRealFlow = /(?:BusinessCodeFormProvider|FlowDefinition|@Flow(?:Bind|Start|Callback)|process_instance_id|processInstanceId|<userTask\b|\.bpmn\b)/u.test(aggregate);
    if (!hasRealFlow) {
      const origin = records.find((record) => /(?:approval|approve|审批|审核)/iu.test(`${record.path}\n${record.addedContent}`));
      findings.push(finding('FLOW-001', origin?.path ?? records[0]?.path ?? 'unknown', 1,
        'Approval intent was implemented without Flowable binding/BPMN/business process identity artifacts.'));
    }
    for (const record of records.filter((item) => item.path.endsWith('.sql'))) {
      for (const table of createTables(record.content)) {
        if (/(?:approval|approve|workflow|flow|审批|审核)/iu.test(`${table.name}\n${record.content.slice(table.index, table.close + 1)}`)) {
          const missing = ['business_key', 'process_instance_id'].filter((column) => !table.columns.has(column));
          if (missing.length > 0) findings.push(finding('FLOW-001', record.path, lineAt(record.content, table.index),
            `Workflow table ${table.name} is missing ${missing.join(', ')}.`, { table: table.name, missing }));
        }
      }
    }
  }
}

function resolveRepositoryIdentity(root) {
  const result = runGit(root, ['config', '--local', '--get', 'forge-delivery.project-slug'], { allowFailure: true });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-z0-9][a-z0-9-]{1,62}$/u.test(value) ? value : 'unbound';
}

export function applyPolicyExceptions(policy, findings, records, repository, now = new Date()) {
  const contentByPath = new Map(records.map((record) => [record.path, record.sha256 ? `sha256:${record.sha256}` : null]));
  const applied = [];
  const remaining = [];
  for (const item of findings) {
    const exception = policy.exceptions.find((candidate) => candidate.ruleId === item.ruleId
      && candidate.repository === repository
      && candidate.path === item.file
      && candidate.contentSha256 === contentByPath.get(item.file)
      && Date.parse(candidate.expiresAt) > now.getTime());
    if (!exception) {
      remaining.push(item);
      continue;
    }
    applied.push({
      exceptionId: exception.id,
      ruleId: item.ruleId,
      path: item.file,
      contentSha256: exception.contentSha256,
      approvalRef: exception.approvalRef,
      owner: exception.owner,
      expiresAt: exception.expiresAt,
    });
  }
  return {
    findings: remaining,
    applied: [...new Map(applied.map((item) => [`${item.exceptionId}\0${item.ruleId}\0${item.path}`, item])).values()]
      .sort((left, right) => left.exceptionId.localeCompare(right.exceptionId, 'en') || left.path.localeCompare(right.path, 'en')),
  };
}

function semanticObligations(policy, records, uiObligations = []) {
  const changed = records.filter((record) => record.status !== 'D');
  const ruleIds = new Set();
  if (changed.some((record) => /\/controller\/|^forge-admin-ui\/src\/views\//u.test(record.path))) ruleIds.add('PERMISSION-001');
  if (changed.some((record) => /(?:\/components\/|\/(?:util|utils|support)\/)/u.test(record.path))) ruleIds.add('DESIGN-001');
  if (changed.some((record) => record.path.endsWith('.sql') || isEntityPath(record.path))) ruleIds.add('DB-REVIEW-001');
  if (changed.some((record) => /\/(?:controller|service)\//u.test(record.path))) ruleIds.add('BE-RELIABILITY-001');
  if (changed.some((record) => /^forge-(?:admin|h5|report)-ui\/src\/(?:views|components)\//u.test(record.path))) ruleIds.add('FE-UX-001');
  if (changed.some((record) => /\/(?:controller|service|manager)\/|^forge-(?:admin|h5|report)-ui\/src\/views\//u.test(record.path))) ruleIds.add('OBS-001');
  if (changed.some((record) => /\.(?:java|vue|js|ts|sql|xml)$/u.test(record.path))) ruleIds.add('QUALITY-TDD-001');
  for (const obligation of uiObligations) ruleIds.add(obligation.ruleId);
  return policy.rules.filter((rule) => ruleIds.has(rule.id) && rule.severity !== 'advisory').map((rule) => {
    const instances = uiObligations.filter((item) => item.ruleId === rule.id).map((item) => ({
      file: item.path,
      line: item.line,
      message: item.message,
      ...(item.actualConsumers === undefined ? {} : {
        consumers: item.consumers,
        actualConsumers: item.actualConsumers,
        requiredConsumers: item.requiredConsumers,
      }),
      ...(item.missingStates === undefined ? {} : { missingStates: item.missingStates }),
    }));
    return {
      ruleId: rule.id,
      enforcement: rule.enforcement,
      summary: rule.summary,
      requiredEvidence: rule.requiredEvidence,
      ...(instances.length === 0 ? {} : { instances }),
    };
  });
}

function isUiContractSource(file) {
  return /^forge-admin-ui\/src\/(?:api|components|views)\//u.test(file)
    && /\.(?:vue|[cm]?[jt]sx?)$/u.test(file);
}

async function uiContractRecords(root, changedRecords, contract) {
  const changedByPath = new Map(changedRecords.filter((record) => isUiContractSource(record.path))
    .map((record) => [record.path, record]));
  const addedOwner = [...changedByPath.values()].some((record) => ['A', 'C', 'U'].includes(record.status) && (
    record.path.startsWith(contract.scope.businessApiPrefix)
    || contract.scope.sharedComponentPrefixes.some((prefix) => record.path.startsWith(prefix))
  ));
  if (addedOwner) {
    const tracked = nulPaths(runGit(root, ['ls-files', '-z', '--', 'forge-admin-ui/src'], { encoding: null }), 'tracked UI path')
      .filter(isUiContractSource);
    if (tracked.length > MAX_FILES) {
      throw new GovernanceError('TOO_MANY_FILES', `UI consumer graph exceeds ${MAX_FILES} tracked source files.`);
    }
    let totalBytes = 0;
    for (const file of tracked) {
      if (changedByPath.has(file)) continue;
      const resolved = await resolveInputFile(root, file);
      totalBytes += resolved.stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new GovernanceError('TOO_MUCH_CONTENT', `UI consumer graph exceeds ${MAX_TOTAL_BYTES} bytes.`);
      }
      changedByPath.set(file, {
        path: file,
        status: 'B',
        content: await readFile(resolved.absolute, 'utf8'),
      });
    }
  }
  return [...changedByPath.values()].filter((record) => record.status !== 'D').map((record) => ({
    path: record.path,
    status: ['A', 'C', 'U'].includes(record.status) ? 'added' : 'context',
    content: record.content,
  }));
}

const UI_EQUIVALENT_RULES = new Map([
  ['UI-DESIGN-001', 'FE-DESIGN-001'],
  ['UI-HTTP-001', 'FE-HTTP-001'],
  ['UI-IMAGE-001', 'FE-DATA-001'],
  ['UI-PAGE-001', 'FE-CRUD-001'],
  ['UI-DICT-001', 'FE-DICT-001'],
]);

function mergeUiContractFindings(findings, uiReceipt, records) {
  for (const item of uiReceipt.findings) {
    const existingRule = UI_EQUIVALENT_RULES.get(item.ruleId);
    if (existingRule && findings.some((candidate) => candidate.ruleId === existingRule && candidate.file === item.path)) continue;
    const source = records.find((record) => record.path === item.path)?.content ?? '';
    if (item.ruleId === 'UI-HTTP-001' && /does not import the canonical request owner/u.test(item.message)
        && /\brequest\s*\./u.test(source)) continue;
    findings.push(finding(item.ruleId, item.path, item.line, item.message, {
      uiContractVersion: uiReceipt.contractVersion,
      canonicalOwner: item.owner,
    }));
  }
}

function ruleIndex(policy) {
  return new Map(policy.rules.map((rule) => [rule.id, rule]));
}

// The authenticated Manager uses the same diff and SQL grammar as the checker.
// This is a preview only; it neither approves recipients nor changes source.
export async function previewGovernanceRoleGrants({ root: inputRoot, base, sourceHead, contractId, ownedPaths }) {
  const root = await resolveRoot(inputRoot);
  if (!/^[0-9a-f]{40}$/u.test(base ?? '')) throw new GovernanceError('INVALID_ROLE_PREVIEW_BASE', 'Role preview requires a pinned base commit.');
  if (!/^[0-9a-f]{40}$/u.test(sourceHead ?? '') || runGit(root, ['rev-parse', 'HEAD']).stdout.trim() !== sourceHead) {
    throw new GovernanceError('ROLE_PREVIEW_SOURCE_CHANGED', 'Role preview source differs from the protected observation.');
  }
  const scope = normalizeGovernanceTaskScope({ contractId, ownedPaths });
  const records = collectChangedRecords(root, base, []).filter(record => record.status !== 'D'
    && record.path.endsWith('.sql')
    && scope.ownedPaths.some(owned => record.path === owned || record.path.startsWith(`${owned}/`)));
  const hydrated = await hydrateRecords(root, records, base);
  const grants = [];
  for (const record of hydrated) {
    for (const item of changedInsertStatements(record)) {
      if (item.parsed?.table !== 'sys_role_resource') continue;
      grants.push({ path: record.path, line: lineAt(record.content, item.index),
        fileSha256: record.sha256, statementSha256: sha256(item.statement),
        statement: item.statement, roleKeys: explicitRoleGrantRecipients(item.statement) });
    }
  }
  if (grants.length > 64 || Buffer.byteLength(JSON.stringify(grants)) > 64 * 1024) {
    throw new GovernanceError('ROLE_PREVIEW_TOO_LARGE', 'Role preview exceeds the bounded confirmation size.');
  }
  return grants;
}

// Main adopts process/convention reductions, not the environment branch's
// blanket downgrade of permission, migration, supply-chain or test integrity.
const DIRECT_ADVISORY_RULES = new Set([
  'BE-ENTITY-001', 'BE-CRUD-001', 'UI-DIALOG-001', 'QUALITY-TEST-001',
]);

export function directGovernanceSeverity(rule, item) {
  if (!rule) return 'block';
  if (DIRECT_ADVISORY_RULES.has(rule.id)) return 'advisory';
  if (rule.id === 'BE-SAFETY-001' && /System\.out/iu.test(item.message ?? '')
    && !/secret|credential|password|token|private key/iu.test(item.message)) return 'advisory';
  return rule.severity;
}

export async function audit(options, policy) {
  const directDevelopment = process.env.FORGE_DEVELOPMENT_MODE === 'direct';
  const root = await resolveRoot(options.root);
  const baseCommit = runGit(root, ['rev-parse', `${options.base}^{commit}`]).stdout.trim();
  const head = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (options.expectedNoChangeHead !== undefined
      && (!/^[0-9a-f]{40}$/u.test(options.expectedNoChangeHead)
        || options.expectedNoChangeHead !== baseCommit || options.expectedNoChangeHead !== head)) {
    throw new GovernanceError('INVALID_NO_CHANGE_HEAD', 'The no-change baseline must equal both the resolved base and HEAD.');
  }
  const taskScope = options.taskScope === undefined ? undefined : normalizeGovernanceTaskScope(options.taskScope);
  const acceptedApiContract = options.acceptedApiContract === undefined ? undefined
    : normalizeAcceptedApiContract(options.acceptedApiContract);
  if (acceptedApiContract !== undefined && (options.paths.length > 0 || acceptedApiContract.sourceCommit !== head)) {
    throw new GovernanceError('INVALID_API_CONTRACT', 'Accepted APIs require the matching source and a complete task or release audit.');
  }
  const roleGrantPolicy = options.roleGrantPolicy === undefined ? undefined : normalizeGovernanceRoleGrantPolicy(options.roleGrantPolicy);
  const sourceProvenancePolicy = options.sourceProvenancePolicy === undefined ? undefined
    : normalizeReferenceProvenancePolicy(options.sourceProvenancePolicy);
  if (sourceProvenancePolicy !== undefined && (options.paths.length > 0
      || taskScope?.contractId !== sourceProvenancePolicy.contractId)) {
    throw new GovernanceError('INVALID_SOURCE_PROVENANCE_POLICY', 'Source reviews require the complete matching task scope.');
  }
  if (roleGrantPolicy !== undefined && (options.paths.length > 0
    || (taskScope !== undefined && taskScope.contractId !== roleGrantPolicy.contractId))) {
    throw new GovernanceError('INVALID_ROLE_POLICY', 'Role decisions require a complete audit of the same protected contract.');
  }
  if (taskScope && options.paths.length > 0) throw new GovernanceError('INVALID_TASK_SCOPE', 'Task scope cannot be combined with diagnostic paths.');
  const allRecords = collectChangedRecords(root, options.base, options.paths);
  const owns = file => taskScope.ownedPaths.some(owned => file === owned || file.startsWith(`${owned}/`));
  const rawRecords = taskScope === undefined ? allRecords
    : allRecords.filter(record => owns(record.path) || (record.oldPath && owns(record.oldPath)));
  // Account for the complete owned Git diff before selecting text analyzers.
  // An unsupported asset cannot silently disappear from a passing receipt.
  // Deletions carry no new opaque content and remain part of the inventory.
  const unsupportedRecords = rawRecords.filter(record => record.status !== 'D' && !relevantPath(record.path));
  const records = await hydrateRecords(root,
    rawRecords.filter(record => record.status === 'D' || relevantPath(record.path)), baseCommit);
  const noChanges = options.expectedNoChangeHead === head && options.paths.length === 0 && records.length === 0
    && runGit(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']).stdout.length === 0;
  const findings = unsupportedRecords.map(record => finding('GOV-SCOPE-001', record.path, 1,
    'This changed file has no supported governance analyzer. The complete task/change scope cannot pass while this input is unreviewed.'));
  const legacyFindings = [];
  const changedPageQuery = records.find((record) => record.status !== 'D' && /\/PageQuery\.java$/u.test(record.path));
  const pageQueryFoundationRepaired = changedPageQuery !== undefined
    && /\btoPage\s*\([^)]*\)\s*\{[\s\S]{0,1000}?new\s+Page\s*<[^>]*>\s*\(\s*(?:this\.)?getPageNum\s*\(\s*\)\s*,\s*(?:this\.)?getPageSize\s*\(\s*\)\s*\)/u.test(changedPageQuery.content);
  const scanContext = { pageQueryFoundationRepaired, displayCatalogs: displayLocalizationCatalogs(records), acceptedApiContract };
  for (const record of records) {
    scanGlobal(record, findings);
    if (record.status === 'D') {
      if (record.path.endsWith('.sql')) scanSql(record, findings);
      continue;
    }
    const extension = path.posix.extname(record.path).toLowerCase();
    if (extension === '.sql') scanSql(record, findings);
    if (extension === '.java') scanJava(record, findings, scanContext, legacyFindings);
    if (extension === '.xml' && /\/src\/main\/resources\/mapper\//u.test(record.path)) scanMapperXml(record, findings);
    if (['.vue', '.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(extension)
        && /^forge-(?:admin|h5|report)-ui\//u.test(record.path)) scanFrontend(record, findings, legacyFindings);
  }
  const uiContract = await loadForgeUiContract();
  const uiReceipt = auditForgeUiContract({
    contract: uiContract,
    files: await uiContractRecords(root, records, uiContract),
  });
  mergeUiContractFindings(findings, uiReceipt, records);
  await scanCrossFile(root, records, findings, legacyFindings, roleGrantPolicy, scanContext.displayCatalogs);
  scanMigrationInventory(root, baseCommit, records, findings);
  if (options.paths.length > 0) {
    findings.push(finding('GOV-SCOPE-001', '<audit-scope>', 1,
      'An explicit --path subset is diagnostic and cannot produce a passing complete-change receipt.'));
  }
  if (options.paths.length === 0 && rawRecords.length === 0 && !noChanges) {
    findings.push(finding('GOV-SCOPE-001', '<audit-scope>', 1,
      'A complete-change receipt cannot have an empty diff; pass the reviewed predecessor with --base for an already committed candidate.'));
  }
  const repositoryIdentity = resolveRepositoryIdentity(root);
  const referenceProvenance = sourceProvenancePolicy === undefined ? undefined : auditReferenceProvenance({
    policy: sourceProvenancePolicy,
    repository: repositoryIdentity,
    baseCommit,
    head,
    contractId: taskScope.contractId,
    completeTaskScope: options.paths.length === 0 && records.length > 0 && unsupportedRecords.length === 0,
    files: [...records, ...unsupportedRecords.map(record => ({ ...record, sha256: null, content: null, opaque: true }))],
  });
  if (referenceProvenance !== undefined) {
    for (const item of referenceProvenance.findings) {
      findings.push(finding('SUPPLY-001', item.file, 1, item.code + ': ' + item.message));
    }
  }
  const exceptionResult = applyPolicyExceptions(policy, findings, records, repositoryIdentity);
  const rules = ruleIndex(policy);
  const normalizedFindings = [...new Map(exceptionResult.findings.map((item) => [`${item.ruleId}\0${item.file}\0${item.line}\0${item.message}`, item])).values()]
    .map((item) => ({ ...item, severity: directDevelopment
      ? directGovernanceSeverity(rules.get(item.ruleId), item) : rules.get(item.ruleId)?.severity ?? 'block' }))
    .sort((left, right) => left.file.localeCompare(right.file, 'en') || left.line - right.line || left.ruleId.localeCompare(right.ruleId, 'en'));
  const blockCount = normalizedFindings.filter((item) => item.severity === 'block').length;
  const receipt = {
    ok: blockCount === 0,
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    ...(directDevelopment ? { developmentMode: 'direct' } : {}),
    profile: policy.profile,
    sourceBaseline: policy.sourceBaseline,
    repositoryIdentity,
    ...(referenceProvenance === undefined ? {} : { referenceProvenance }),
    executionProven: true,
    runtimeBehaviorProven: false,
    semanticReviewProven: false,
    scope: {
      base: options.base,
      baseCommit,
      head,
      explicitPaths: options.paths.length > 0,
      completeChange: taskScope === undefined && options.paths.length === 0 && records.length > 0 && unsupportedRecords.length === 0,
      ...(taskScope === undefined ? {} : { taskContractId: taskScope.contractId,
        ownedPaths: taskScope.ownedPaths, completeTaskScope: records.length > 0 && unsupportedRecords.length === 0 }),
      ...(noChanges ? { noChanges: true } : {}),
      ...(roleGrantPolicy === undefined ? {} : { roleGrantPolicySha256: sha256(JSON.stringify(roleGrantPolicy)) }),
      ...(acceptedApiContract === undefined ? {} : { acceptedApiContractSha256: sha256(JSON.stringify(acceptedApiContract)) }),
    },
    files: records.map(({ path: filePath, status, bytes, sha256: digest }) => ({ path: filePath, status, bytes, sha256: digest })),
    counts: { files: records.length, block: blockCount, review: normalizedFindings.length - blockCount, legacy: legacyFindings.length },
    findings: normalizedFindings,
    legacyFindings,
    appliedExceptions: exceptionResult.applied,
    obligations: directDevelopment ? [] : semanticObligations(policy, records, uiReceipt.obligations),
    generatedAt: new Date().toISOString(),
  };
  receipt.receiptDigest = `sha256:${sha256(canonicalJson({ ...receipt, generatedAt: null }))}`;
  return receipt;
}

function printAuditText(receipt, io) {
  io.stdout.write(`${receipt.ok ? 'PASS' : 'FAIL'} Forge governance ${receipt.policyVersion}: ${receipt.counts.files} files, ${receipt.counts.block} blocking findings, ${receipt.counts.legacy} unchanged legacy findings retained.\n`);
  for (const item of receipt.findings) {
    io.stdout.write(`${item.severity.toUpperCase()} ${item.ruleId} ${item.file}:${item.line} ${item.message}\n`);
  }
  for (const item of receipt.legacyFindings) {
    io.stdout.write(`LEGACY ${item.ruleId} ${item.file}:${item.line} ${item.message} [unchanged at ${receipt.scope.baseCommit}; not remediated]\n`);
  }
  for (const item of receipt.obligations) {
    io.stdout.write(`REQUIRES ${item.ruleId} ${item.summary}\n`);
  }
  io.stdout.write(`Receipt ${receipt.receiptDigest}; static execution proven=true, runtime/semantic proof=false.\n`);
}

export async function main(argv, io = process) {
  let options;
  try {
    options = parseArgs(argv);
    if (['help', '--help', '-h'].includes(options.command)) {
      io.stdout.write(`${help()}\n`);
      return 0;
    }
    const { policy: versionedPolicy } = await loadPolicy();
    const policy = process.env.FORGE_DEVELOPMENT_MODE !== 'direct' ? versionedPolicy : {
      ...versionedPolicy,
      developmentMode: 'direct',
      rules: versionedPolicy.rules.map(rule => ({ ...rule,
        severity: directGovernanceSeverity(rule, { message: '' }),
        ...(rule.id === 'BE-SAFETY-001'
          ? { summary: `${rule.summary} In direct development System.out style findings are advisory; actual safety findings retain their severity.` }
          : {}),
      })),
    };
    if (options.command === 'catalog') {
      if (options.format === 'json') io.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
      else io.stdout.write(`${policy.profile} ${policy.policyVersion}: ${policy.rules.length} rules\n${policy.rules.map((rule) => `${rule.id}\t${rule.severity}\t${rule.enforcement}\t${rule.summary}`).join('\n')}\n`);
      return 0;
    }
    if (options.command === 'explain') {
      const rule = policy.rules.find((item) => item.id === options.rule);
      if (!rule) throw new GovernanceError('RULE_NOT_FOUND', 'A known --rule is required.');
      if (options.format === 'json') io.stdout.write(`${JSON.stringify(rule, null, 2)}\n`);
      else io.stdout.write(`${rule.id} [${rule.severity}/${rule.enforcement}]\n${rule.summary}\nRemediation: ${rule.remediation}\nEvidence: ${rule.requiredEvidence.join(', ')}\n`);
      return 0;
    }
    const receipt = await audit(options, policy);
    if (options.format === 'json') io.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else printAuditText(receipt, io);
    return receipt.ok ? 0 : 2;
  } catch (error) {
    const code = error instanceof GovernanceError ? error.code : 'FORGE_GOVERNANCE_FAILED';
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Forge governance failed.';
    const payload = { ok: false, error: { code, message } };
    if (options?.format === 'text') io.stderr.write(`forge-governance: ${code}: ${message}\n`);
    else io.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process);
}
