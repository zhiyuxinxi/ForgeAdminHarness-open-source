import crypto from 'node:crypto';
import { SOURCE_QUALITY_PROFILE, sourceQualitySelectors } from './forge-backend-source-quality.mjs';
import { MAVEN_VERIFICATION_ARGS } from './maven-verification-policy.mjs';
import { normalizeForgeRoleGrantDecisions, H5_TEST_FILE_PATTERN } from './forge-task-execution-contract.mjs';
import { normalizeReferenceProvenancePolicy } from './forge-reference-provenance.mjs';

const MAVEN_OFFLINE_REPOSITORY_ARG = '-Dmaven.repo.local=/verify-cache/m2/repository';

// Explicitly enabling tests disables Maven's active-by-default dev profile.
// Keep its resource-filtering properties while enable-tests clears test groups.
export const MAVEN_TEST_PROFILE_ARG = '-Pdev,enable-tests';

export const VERIFY_PROFILE_NAMES = Object.freeze([
  'governance',
  'backend-red-test',
  'frontend-red-test',
  'backend-module-compile',
  'backend-module-test',
  'backend-test-class',
  'frontend-admin-lint',
  'frontend-admin-test',
  'frontend-admin-typecheck',
  'frontend-admin-build',
  'frontend-h5-test',
  'frontend-h5-build',
  'changed-safe',
  'full-regression',
]);

const PROFILE_SET = new Set([...VERIFY_PROFILE_NAMES, SOURCE_QUALITY_PROFILE]);
export const BACKGROUND_VERIFICATION_PROFILES = Object.freeze([
  'backend-module-compile', 'backend-module-test', 'backend-test-class',
  'full-regression', 'frontend-admin-build', 'frontend-admin-test',
]);

export function defaultBackgroundVerification(profile, selectors = {}) {
  return BACKGROUND_VERIFICATION_PROFILES.includes(profile)
    && (profile !== 'frontend-admin-test' || !selectors.testFiles?.length);
}

// Supplied by protected candidate binding, never by a model run selector.
export function normalizeAcceptedApiContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'artifactDigest,endpoints,schemaVersion,sourceCommit,taskId,workflowId'
    || value.schemaVersion !== 1 || !/^[0-9a-f]{64}$/u.test(value.artifactDigest ?? '')
    || !/^[0-9a-f]{40}$/u.test(value.sourceCommit ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.taskId ?? '')
    || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(value.workflowId ?? '')
    || !Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > 2048
    || value.endpoints.some(item => !item || Object.keys(item).sort().join(',') !== 'method,path'
      || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(item.method)
      || typeof item.path !== 'string' || item.path.length > 2048 || !item.path.startsWith('/')
      || /[\\\s\0?#]/u.test(item.path) || item.path.includes('//')
      || item.path.split('/').some(part => part === '.' || part === '..'))
    || new Set(value.endpoints.map(item => `${item.method} ${item.path}`)).size !== value.endpoints.length) {
    throw new Error('Accepted API contract projection is invalid.');
  }
  return { schemaVersion: 1, taskId: value.taskId, workflowId: value.workflowId, sourceCommit: value.sourceCommit,
    artifactDigest: value.artifactDigest, endpoints: value.endpoints.map(item => ({ ...item }))
      .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`, 'en')) };
}

export function normalizeGovernanceTaskScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'contractId,ownedPaths'
    || !/^[0-9a-f]{64}$/u.test(value.contractId ?? '')
    || !Array.isArray(value.ownedPaths) || value.ownedPaths.length < 1 || value.ownedPaths.length > 256
    || value.ownedPaths.some(file => typeof file !== 'string' || file.length > 1024
      || /[\\\0\r\n:*?]/u.test(file) || file.startsWith('-')
      || file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))
    || new Set(value.ownedPaths).size !== value.ownedPaths.length) {
    throw new Error('Protected governance task scope is invalid.');
  }
  return { contractId: value.contractId, ownedPaths: [...value.ownedPaths].sort() };
}

export function governanceTaskScopeForContract(contract) {
  return contract?.actionCeiling === 'workspace-write' && contract.ownedPaths?.length > 0
    ? normalizeGovernanceTaskScope({ contractId: contract.contractId, ownedPaths: contract.ownedPaths })
    : undefined;
}

export function governanceTaskScopeArguments(scope) {
  if (scope === undefined) return [];
  const normalized = normalizeGovernanceTaskScope(scope);
  return ['--task-contract-id', normalized.contractId,
    ...normalized.ownedPaths.flatMap(file => ['--task-owned-path', file])];
}

// Accepted APIs constrain route obligations without narrowing release audit paths.
export function governanceAcceptedApiContractArguments(policy) {
  return policy === undefined ? [] : ['--accepted-api-contract', JSON.stringify(normalizeAcceptedApiContract(policy))];
}

// Independent of audit path filtering: checkpoint/release audits still examine
// the complete diff while enforcing the same protected role decisions.
export function normalizeGovernanceRoleGrantPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'contractId,decisions'
    || !/^[0-9a-f]{64}$/u.test(value.contractId ?? '')
    || !Array.isArray(value.decisions)) throw new Error('Protected role grant policy is invalid.');
  const decisions = normalizeForgeRoleGrantDecisions(value.decisions, value.decisions.map(item => item?.path));
  const result = { contractId: value.contractId, decisions };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error('Protected role grant policy is too large.');
  return result;
}

export function governanceRoleGrantPolicyForContract(contract) {
  return contract?.roleGrantDecisions === undefined ? undefined
    : normalizeGovernanceRoleGrantPolicy({ contractId: contract.contractId, decisions: contract.roleGrantDecisions });
}

export function governanceRoleGrantArguments(policy) {
  return policy === undefined ? [] : ['--role-grant-policy', JSON.stringify(normalizeGovernanceRoleGrantPolicy(policy))];
}

export function governanceSourceProvenanceArguments(policy) {
  return policy === undefined ? [] : ['--source-provenance-policy', JSON.stringify(normalizeReferenceProvenancePolicy(policy))];
}

// Comparison only, after protected same-source revalidation. Keep the original
// receipt and argv unchanged; callers still validate the complete fixed plan.
export function revalidatedGovernanceTaskArguments(argv, scope, rolePolicy, sourcePolicy, acceptedApiContract) {
  if (acceptedApiContract !== undefined) {
    const suffix = governanceAcceptedApiContractArguments(acceptedApiContract);
    if (!Array.isArray(argv) || argv.filter(arg => arg === '--accepted-api-contract').length !== 1
      || JSON.stringify(argv.slice(-2)) !== JSON.stringify(suffix)) return null;
    const prefix = argv.slice(0, -2);
    const compared = scope === undefined && rolePolicy === undefined && sourcePolicy === undefined
      ? (prefix[0] === 'audit' && prefix[1] === '--base' && /^[0-9a-f]{40}$/u.test(prefix[2] ?? '')
        && (prefix.length === 3 || (prefix.length === 5 && prefix[3] === '--expected-no-change-head'
          && prefix[4] === prefix[2])) ? prefix : null)
      : revalidatedGovernanceTaskArguments(prefix, scope, rolePolicy, sourcePolicy);
    return compared === null ? null : [...compared, ...suffix];
  }
  if (argv?.includes('--accepted-api-contract')) return null;
  if (sourcePolicy !== undefined) {
    const suffix = governanceSourceProvenanceArguments(sourcePolicy);
    // A source review binds the exact contract and candidate. Never rewrite it
    // while renewing another contract's otherwise reusable execution facts.
    if (!Array.isArray(argv) || scope?.contractId !== sourcePolicy.contractId
      || argv.filter(arg => arg === '--source-provenance-policy').length !== 1
      || JSON.stringify(argv.slice(-2)) !== JSON.stringify(suffix)) return null;
    const scopeOffset = argv.indexOf('--task-contract-id');
    if (scopeOffset < 0 || argv[scopeOffset + 1] !== sourcePolicy.contractId) return null;
    const compared = revalidatedGovernanceTaskArguments(argv.slice(0, -2), scope, rolePolicy);
    return compared === null ? null : [...compared, ...suffix];
  }
  if (argv?.includes('--source-provenance-policy')) return null;
  if ((scope === undefined && rolePolicy === undefined) || !Array.isArray(argv)) return null;
  if (rolePolicy !== undefined) {
    if (argv.at(-2) !== '--role-grant-policy' || argv.filter(arg => arg === '--role-grant-policy').length !== 1) return null;
    let previous;
    try { previous = normalizeGovernanceRoleGrantPolicy(JSON.parse(argv.at(-1))); } catch { return null; }
    const expected = normalizeGovernanceRoleGrantPolicy(rolePolicy);
    if (JSON.stringify(previous) !== argv.at(-1)
      || JSON.stringify(previous.decisions) !== JSON.stringify(expected.decisions)) return null;
    const prefix = argv.slice(0, -2);
    if (scope !== undefined) {
      const oldOffset = prefix.length - governanceTaskScopeArguments(scope).length;
      if (prefix[oldOffset + 1] !== previous.contractId) return null;
      const compared = revalidatedGovernanceTaskArguments(prefix, scope);
      return compared === null ? null : [...compared, ...governanceRoleGrantArguments(expected)];
    }
    if (prefix.some(arg => arg === '--task-contract-id' || arg === '--task-owned-path')) return null;
    return [...prefix, ...governanceRoleGrantArguments(expected)];
  }
  const suffix = governanceTaskScopeArguments(scope);
  const offset = argv.length - suffix.length;
  if (offset < 3 || argv[offset] !== '--task-contract-id'
    || !/^[0-9a-f]{64}$/u.test(argv[offset + 1] ?? '')
    || argv.filter(arg => arg === '--task-contract-id').length !== 1) return null;
  const comparison = [...argv];
  comparison[offset + 1] = scope.contractId;
  return JSON.stringify(comparison.slice(offset)) === JSON.stringify(suffix) ? comparison : null;
}
const MODULE_PATTERN = /^forge-server\/[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const TEST_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.]{0,199}(?:#[A-Za-z_$][A-Za-z0-9_$]{0,99})?$/u;
const FRONTEND_TEST_FILE_PATTERN = /^forge-admin-ui\/(?:src|tests?)\/[A-Za-z0-9_./@+-]+(?:\.spec|\.test)\.(?:js|jsx|ts|tsx)$/u;
const FRONTEND_SOURCE_FILE_PATTERN = /^forge-admin-ui\/src\/[A-Za-z0-9_./@+-]+\.(?:js|jsx|ts|tsx|vue)$/u;

// These observed formatting rules must not block a changed-file check. Keep
// semantic rules and the warning ceiling intact; both executors use this list.
export const FRONTEND_LINT_PREVIOUS_FORMAT_ARGS = Object.freeze([
  '--rule', 'style/quotes: off',
  '--rule', 'style/arrow-parens: off',
  '--rule', 'style/max-statements-per-line: off',
  '--rule', 'vue/singleline-html-element-content-newline: off',
  '--rule', 'vue/component-name-in-template-casing: off',
  '--rule', 'vue/html-self-closing: off',
  '--rule', 'perfectionist/sort-imports: off',
]);
export const FRONTEND_LINT_FORMAT_ARGS = Object.freeze([
  ...FRONTEND_LINT_PREVIOUS_FORMAT_ARGS,
  '--rule', 'format/prettier: off',
  '--rule', 'unocss/order-attributify: off',
  '--rule', 'antfu/if-newline: off',
  '--rule', 'antfu/consistent-list-newline: off',
  '--rule', 'antfu/curly: off',
]);

function lintSourceFile(file) {
  return typeof file === 'string' && /^forge-admin-ui\/src\/.+\.(?:js|jsx|ts|tsx|vue)$/u.test(file)
    && !/[\0\r\n\\]/u.test(file) && !file.split('/').some((part) => part === '.' || part === '..' || part === '');
}

export async function resolveFrontendLintFiles(source) {
  return resolveFrontendChangedFiles(source, lintSourceFile);
}

function typecheckSourceFile(file) {
  return typeof file === 'string' && /^forge-admin-ui\/.+\.(?:[cm]?[jt]s|[jt]sx|vue)$/u.test(file)
    && !/[\0\r\n\\]/u.test(file) && !file.split('/').some(part => part === '.' || part === '..' || part === '');
}

export function frontendTypecheckArguments(files) {
  if (!Array.isArray(files) || new Set(files).size !== files.length || files.some(file => !typecheckSourceFile(file))) {
    throw verifyError('VERIFY_SOURCE_INVALID', 'Typecheck roots must be the complete protected frontend change scope.');
  }
  if (files.length === 0) {
    throw verifyError('VERIFY_TYPECHECK_EMPTY_SCOPE', 'There are no current frontend source roots to typecheck; no typecheck was executed.');
  }
  return ['--project', 'forge-admin-ui', '--files', JSON.stringify(files)];
}

export async function resolveFrontendTypecheckFiles(source) {
  const files = await resolveFrontendChangedFiles(source, typecheckSourceFile);
  frontendTypecheckArguments(files);
  return files;
}

async function resolveFrontendChangedFiles(source, applicable, includeDeleted = false) {
  if (!/^[0-9a-f]{40}$/u.test(source.reviewBase ?? '') || typeof source.readGit !== 'function'
      || !Array.isArray(source.inventory?.files)) {
    throw verifyError('VERIFY_SOURCE_INVALID', 'Changed-file verification requires the protected TaskSpace base and source inventory.');
  }
  const git = async (argv) => {
    const result = await source.readGit(argv);
    if (result.exitCode !== 0 || result.timedOut === true || result.truncated === true || typeof result.stdout !== 'string') {
      throw verifyError('VERIFY_SOURCE_GIT_FAILED', 'The changed-file verification scope could not be read completely.');
    }
    return result.stdout;
  };
  if (source.reviewBase !== source.inventory.head) {
    await git(['merge-base', '--is-ancestor', source.reviewBase, source.inventory.head]);
  }
  const tracked = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', source.reviewBase, '--']);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  const present = new Set(source.inventory.files.filter((item) => !item.deleted).map((item) => item.relative));
  return [...new Set((tracked + untracked).split('\0').filter((file) => (includeDeleted || present.has(file)) && applicable(file)))].sort();
}

export async function resolveFrontendTestFilters(source) {
  const files = await resolveFrontendChangedFiles(source,
    file => lintSourceFile(file.replace(/^forge-admin-ui\/tests?\//u, 'forge-admin-ui/src/')), true);
  const filters = [...new Set(files.map(file => {
    const relative = file.replace(/^forge-admin-ui\//u, '');
    if (FRONTEND_TEST_FILE_PATTERN.test(file)) return relative;
    const directory = relative.slice(0, relative.lastIndexOf('/'));
    return /^(?:src|tests?)$/u.test(directory) ? relative.replace(/\.[^.]+$/u, '') : `${directory}/`;
  }))].sort();
  return filters.filter(file => !filters.some(parent => parent !== file && parent.endsWith('/') && file.startsWith(parent)));
}

export function frontendTestScopeFilters(filters) {
  if (filters === undefined) return []; // Historical unfiltered receipt plans.
  if (!Array.isArray(filters) || filters.some(file => typeof file !== 'string'
    || !/^(?:src|tests?)\/.+/u.test(file) || /[\0\r\n\\]/u.test(file)
    || file.split('/').some(part => part === '.' || part === '..') || file.includes('//'))) {
    throw new Error('Frontend test filters must come from the protected changed-file scope.');
  }
  // Vitest applies file filters before its dependency walk. An empty changed
  // scope must select no tests, rather than falling back to the whole project.
  return filters.length ? filters : ['__forge_no_changed_frontend_tests__/'];
}

export function frontendLintBatches(selectors, lintFiles) {
  if (!Array.isArray(lintFiles) || new Set(lintFiles).size !== lintFiles.length || lintFiles.some((file) => !lintSourceFile(file))) {
    throw new Error('Changed-file lint requires its trusted file scope; full-project fallback is disabled.');
  }
  const files = selectors.files === undefined ? lintFiles : lintFiles.filter((file) => selectors.files.includes(file));
  if (selectors.files !== undefined && files.length === 0 && lintFiles.length !== 0) {
    throw verifyError('VERIFY_REQUEST_INVALID', 'The selected lint files are outside this task change; use the default changed-file lint command.');
  }
  return Array.from({ length: Math.ceil(files.length / 32) }, (_, index) => files.slice(index * 32, (index + 1) * 32));
}

// A real empty-scope observation keeps the execution record truthful without
// installing dependencies or inventing an ESLint execution.
export const FRONTEND_LINT_EMPTY_SCRIPT = String.raw`
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const [gitExecutable,base,head]=process.argv.slice(1);
function git(args){
  const r=spawnSync(gitExecutable,['-c','safe.directory='+process.cwd(),...args],{encoding:'utf8',maxBuffer:8388608,shell:false});
  if(r.error||r.status!==0)throw Error('Lint scope Git observation failed');
  return r.stdout;
}
if(!/^[0-9a-f]{40}$/.test(base)||git(['rev-parse','HEAD']).trim()!==head)throw Error('Lint scope source changed');
git(['merge-base','--is-ancestor',base,head]);
const changed=git(['diff','--no-ext-diff','--no-textconv','--name-only','-z','--no-renames',base,'--']);
const added=git(['ls-files','--others','--exclude-standard','-z']);
const files=[...new Set((changed+added).split('\0'))].filter(f=>/^forge-admin-ui\/src\/.+\.(?:js|jsx|ts|tsx|vue)$/.test(f))
  .filter(f=>{if(/[\0\r\n\\]/.test(f)||f.split('/').some(p=>p==='.'||p==='..'||p===''))throw Error('Invalid lint path');
    try{const s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('Linked lint source');return s.isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}});
if(files.length)throw Error('Lint scope is not empty');
process.stdout.write(JSON.stringify({type:'forge-verify/frontend-lint-scope',base,head,applicableFiles:0,eslintExecuted:false,dependencyInstallExecuted:false})+'\n');
`;
const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function exactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

// Admission is capability evidence from the protected container Runner, not a
// test result. The acceptance service uses this only for trusted direct tasks.
export function validateContainerExecutionAdmissionReceipt(value, options = {}) {
  exactKeys(value, ['schemaVersion', 'receiptType', 'admissionId', 'projectSlug', 'taskId',
    'runner', 'profiles', 'source', 'cache', 'executor', 'issuedAt', 'expiresAt',
    'outcome', 'reasonCode', 'truth'], 'container admission');
  if (value.schemaVersion !== 1 || value.receiptType !== 'forge-verify/execution-admission'
    || value.outcome !== 'ready' || value.reasonCode !== null) throw new Error('Container admission is not ready.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  requiredString(value.admissionId, uuid, 'container admission ID');
  requiredString(value.projectSlug, /^[a-z0-9][a-z0-9-]{1,47}$/u, 'container admission project');
  requiredString(value.taskId, /^[a-z0-9][a-z0-9-]{1,47}$/u, 'container admission task');
  if ((options.projectSlug !== undefined && value.projectSlug !== options.projectSlug)
    || (options.taskId !== undefined && value.taskId !== options.taskId)) throw new Error('Container admission identity mismatch.');
  const profiles = validateVerifyAction({ action: 'admit', profiles: value.profiles }).profiles;
  exactKeys(value.runner, ['bootId', 'revision'], 'container admission runner');
  requiredString(value.runner.bootId, uuid, 'container runner boot ID');
  requiredString(value.runner.revision, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 'container runner revision');
  exactKeys(value.source, ['head', 'workspaceFingerprint', 'dependencyManifestFingerprint'], 'container admission source');
  requiredString(value.source.head, /^[0-9a-f]{40,64}$/u, 'container source HEAD');
  requiredString(value.source.workspaceFingerprint, SHA256_PATTERN, 'container source fingerprint');
  requiredString(value.source.dependencyManifestFingerprint, SHA256_PATTERN, 'container dependency fingerprint');
  exactKeys(value.cache, ['mode', 'compatible', 'packDigest'], 'container admission cache');
  if (value.cache.mode !== 'project-scoped-immutable-pack' || value.cache.compatible !== true) throw new Error('Container admission cache is unproven.');
  requiredString(value.cache.packDigest, SHA256_PATTERN, 'container cache digest');
  const proofs = ['proven', 'dockerApiProven', 'toolchainImageProven', 'samePathBindProven', 'stateWriteProven', 'cleanupProven'];
  exactKeys(value.executor, proofs, 'container admission executor');
  if (proofs.some(key => value.executor[key] !== true)) throw new Error('Container execution capability is unproven.');
  const truths = ['executionProven', 'verificationProven', 'semanticCorrectnessProven', 'databaseIntegrationProven', 'releaseProven'];
  exactKeys(value.truth, truths, 'container admission truth');
  if (truths.some(key => value.truth[key] !== false)) throw new Error('Container admission must not claim execution or release.');
  for (const key of ['issuedAt', 'expiresAt']) {
    if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))
      || new Date(value[key]).toISOString() !== value[key]) throw new Error('Container admission timestamp is invalid.');
  }
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  if (expires - issued < 30_000 || expires - issued > 15 * 60_000) throw new Error('Container admission lease is invalid.');
  if (options.observedAt !== undefined) {
    const now = Date.parse(options.observedAt);
    if (!Number.isFinite(now) || now < issued || now >= expires) throw new Error('Container admission is not current.');
  }
  return { executionMode: 'container-toolchain', profiles, receipt: value };
}

function uniqueStrings(value, pattern, maximum, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain from 1 to ${maximum} values.`);
  }
  const result = value.map((entry) => requiredString(entry, pattern, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} values must be unique.`);
  return result;
}

function frontendFiles(value, pattern, maximum, label) {
  const result = uniqueStrings(value, pattern, maximum, label);
  if (result.some((entry) => entry.split('/').some((segment) => segment === '.' || segment === '..'))) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  return result;
}

function orderedProfiles(value) {
  const direct = process.env.FORGE_DEVELOPMENT_MODE === 'direct';
  // Source-quality is already an optional capability/run profile. Direct
  // admission accepts that same set without changing the signed base catalog.
  const catalog = direct ? [...VERIFY_PROFILE_NAMES, SOURCE_QUALITY_PROFILE] : VERIFY_PROFILE_NAMES;
  const profiles = uniqueStrings(value, /^[a-z][a-z0-9-]{1,63}$/u, catalog.length, 'verify profiles');
  if (profiles.some((profile) => !PROFILE_SET.has(profile))) throw new Error('verify profile is not allowed.');
  const selected = new Set(profiles);
  const canonical = catalog.filter((profile) => selected.has(profile));
  if (canonical.length !== profiles.length
    || (!direct && canonical.some((profile, index) => profile !== profiles[index]))) {
    throw new Error('verify profiles must use the reviewed catalog order.');
  }
  return direct ? canonical : profiles;
}

function validateSelectors(profile, value) {
  if (profile === SOURCE_QUALITY_PROFILE) return sourceQualitySelectors(value);
  const selectors = value ?? {};
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) {
    throw new Error('verify selectors must be an object.');
  }
  if (['backend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class'].includes(profile)) {
    const exactTest = ['backend-red-test', 'backend-test-class'].includes(profile);
    if (!exactTest && Object.hasOwn(selectors, 'tests')) {
      throw new Error(`${profile} does not accept --test; use backend-test-class with --module and --test for a focused check. A focused result does not replace required module verification.`);
    }
    exactKeys(selectors, exactTest ? ['modules', 'tests'] : ['modules'], 'verify selectors');
    let modules;
    try {
      modules = uniqueStrings(
        selectors.modules, MODULE_PATTERN, profile === 'backend-red-test' ? 1 : 16, 'verify modules',
      );
    } catch (error) {
      throw new Error(`${error.message} Use --module with a repository-relative path starting with forge-server/, for example forge-server/forge-business/forge-business-core; do not use the Maven -pl relative path.`);
    }
    const tests = exactTest
      ? uniqueStrings(selectors.tests, TEST_PATTERN, profile === 'backend-red-test' ? 1 : 32, 'verify tests')
      : undefined;
    return { modules, ...(tests === undefined ? {} : { tests }) };
  }
  if (profile === 'frontend-red-test') {
    exactKeys(selectors, ['testFiles'], 'verify selectors');
    return { testFiles: frontendFiles(selectors.testFiles, FRONTEND_TEST_FILE_PATTERN, 1, 'verify testFiles') };
  }
  if (profile === 'frontend-admin-lint') {
    exactKeys(selectors, Object.keys(selectors).length === 0 ? [] : ['files'], 'verify selectors');
    return Object.keys(selectors).length === 0
      ? {}
      : { files: frontendFiles(selectors.files, FRONTEND_SOURCE_FILE_PATTERN, 32, 'verify files') };
  }
  if (profile === 'frontend-h5-test') {
    exactKeys(selectors, ['testFiles'], 'verify selectors');
    return { testFiles: frontendFiles(selectors.testFiles, H5_TEST_FILE_PATTERN, 32, 'verify testFiles') };
  }
  if (profile === 'frontend-admin-test') {
    exactKeys(selectors, Object.keys(selectors).length === 0 ? [] : ['testFiles'], 'verify selectors');
    return Object.keys(selectors).length === 0
      ? {}
      : { testFiles: frontendFiles(selectors.testFiles, FRONTEND_TEST_FILE_PATTERN, 32, 'verify testFiles') };
  }
  exactKeys(selectors, [], 'verify selectors');
  return {};
}

export function validateVerifyAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('verify action must be an object.');
  }
  const action = value.action;
  if (!['admit', 'capability', 'run', 'status', 'receipt', 'review'].includes(action)) {
    throw new Error('verify action is not allowed.');
  }
  if (action === 'review') {
    exactKeys(value, ['action', 'acceptanceContractId'], 'verify review');
    return { action, acceptanceContractId: requiredString(value.acceptanceContractId, /^[0-9a-f]{64}$/u, 'verify acceptanceContractId') };
  }
  if (action === 'admit') {
    exactKeys(value, ['action', 'profiles'], 'verify admission');
    return { action, profiles: orderedProfiles(value.profiles) };
  }
  if (action === 'capability') {
    exactKeys(value, ['action', 'profile'], 'verify capability');
    const profile = requiredString(value.profile, /^[a-z][a-z0-9-]{1,63}$/u, 'verify profile');
    if (!PROFILE_SET.has(profile)) throw new Error('verify profile is not allowed.');
    return { action, profile };
  }
  if (action === 'run') {
    exactKeys(value, ['action', 'profile', 'selectors', 'idempotencyKey', 'admissionId', 'includeDiagnostics', 'receiptId', 'executionMode'], 'verify run');
    if (Object.hasOwn(value, 'includeDiagnostics') && value.includeDiagnostics !== true) {
      throw new Error('verify includeDiagnostics must be true when provided.');
    }
    const profile = requiredString(value.profile, /^[a-z][a-z0-9-]{1,63}$/u, 'verify profile');
    if (!PROFILE_SET.has(profile)) throw new Error('verify profile is not allowed.');
    if (Object.hasOwn(value, 'executionMode') && (value.executionMode !== 'background'
      || !BACKGROUND_VERIFICATION_PROFILES.includes(profile)
      || Object.hasOwn(value, 'receiptId'))) {
      throw new Error(`Background execution is supported only for ${BACKGROUND_VERIFICATION_PROFILES.join(', ')} without receipt reuse.`);
    }
    if (Object.hasOwn(value, 'receiptId') && profile === SOURCE_QUALITY_PROFILE) {
      throw new Error('Backend source quality is optional diagnostics, not a checkpoint obligation. Keep its existing report; do not rerun or rebind it solely because code was saved. Read it with forge-verify receipt --receipt-id <original-id>.');
    }
    if (Object.hasOwn(value, 'receiptId') && ['backend-red-test', 'frontend-red-test'].includes(profile)) {
      throw new Error('verify receipt reuse is not supported for diagnostic profiles.');
    }
    return {
      action,
      profile,
      selectors: validateSelectors(profile, value.selectors),
      idempotencyKey: requiredString(value.idempotencyKey, IDEMPOTENCY_PATTERN, 'verify idempotencyKey'),
      admissionId: requiredString(value.admissionId, RECEIPT_ID_PATTERN, 'verify admissionId'),
      ...(value.executionMode === 'background' ? { executionMode: 'background' } : {}),
      ...(Object.hasOwn(value, 'receiptId') ? { receiptId: requiredString(value.receiptId, RECEIPT_ID_PATTERN, 'verify reuse receiptId') } : {}),
      ...(value.includeDiagnostics === true ? { includeDiagnostics: true } : {}),
    };
  }
  if (action === 'status') {
    exactKeys(value, ['action', 'jobId', 'waitSeconds'], 'verify status');
    return { action, jobId: requiredString(value.jobId, RECEIPT_ID_PATTERN, 'verify jobId'),
      ...(Object.hasOwn(value, 'waitSeconds') ? { waitSeconds: boundedInteger(value.waitSeconds, 1, 60, 'verify status waitSeconds') } : {}) };
  }
  exactKeys(value, ['action', 'receiptId', 'includeDiagnostics'], 'verify receipt');
  if (Object.hasOwn(value, 'includeDiagnostics') && value.includeDiagnostics !== true) {
    throw new Error('verify includeDiagnostics must be true when provided.');
  }
  return {
    action,
    receiptId: requiredString(value.receiptId, RECEIPT_ID_PATTERN, 'verify receiptId'),
    ...(value.includeDiagnostics === true ? { includeDiagnostics: true } : {}),
  };
}

export function validateVerificationContract(value, expectedProjectSlug) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('verification contract must be an object.');
  }
  exactKeys(value, [
    'schemaVersion', 'projectSlug', 'runnerRevision', 'toolchainImage', 'cacheRoot',
    'stateRoot', 'profiles', 'limits',
  ], 'verification contract');
  if (value.schemaVersion !== 1) throw new Error('Unsupported verification contract schema.');
  const projectSlug = requiredString(value.projectSlug, /^[a-z0-9][a-z0-9-]{1,47}$/u, 'verification projectSlug');
  if (expectedProjectSlug !== undefined && projectSlug !== expectedProjectSlug) {
    throw new Error('verification contract project does not match the runner.');
  }
  const runnerRevision = requiredString(value.runnerRevision, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u, 'verification runnerRevision');
  const toolchainImage = requiredString(value.toolchainImage, /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u, 'verification toolchainImage');
  if (!toolchainImage.includes('@sha256:') && !DIGEST_PATTERN.test(toolchainImage)) {
    throw new Error('verification toolchainImage must be pinned by immutable digest.');
  }
  for (const field of ['cacheRoot', 'stateRoot']) {
    if (typeof value[field] !== 'string'
      || !(/^(?:\/|[A-Za-z]:[\\/])/u.test(value[field]))
      || value[field].includes('\0')) {
      throw new Error(`verification ${field} must be an absolute path.`);
    }
  }
  // Schema 1 installations from toolkit 78 predate the optional H5 test
  // profile. Preserve that exact catalog without accepting arbitrary profiles.
  const catalogs = [VERIFY_PROFILE_NAMES, VERIFY_PROFILE_NAMES.filter(name => name !== 'frontend-h5-test')];
  if (!Array.isArray(value.profiles) || !catalogs.some(catalog => value.profiles.length === catalog.length
    && value.profiles.every((name, index) => name === catalog[index]))) {
    throw new Error('verification profiles must equal the reviewed ordered profile catalog.');
  }
  if (!value.limits || typeof value.limits !== 'object' || Array.isArray(value.limits)) {
    throw new Error('verification limits must be an object.');
  }
  exactKeys(value.limits, ['maxFiles', 'maxBytes', 'maxLogBytes', 'defaultTimeoutSeconds'], 'verification limits');
  return {
    schemaVersion: 1,
    projectSlug,
    runnerRevision,
    toolchainImage,
    cacheRoot: value.cacheRoot,
    stateRoot: value.stateRoot,
    profiles: [...value.profiles],
    limits: {
      maxFiles: boundedInteger(value.limits.maxFiles, 1, 250_000, 'verification maxFiles'),
      maxBytes: boundedInteger(value.limits.maxBytes, 1, 4 * 1024 * 1024 * 1024, 'verification maxBytes'),
      maxLogBytes: boundedInteger(value.limits.maxLogBytes, 1024, 16 * 1024 * 1024, 'verification maxLogBytes'),
      defaultTimeoutSeconds: boundedInteger(value.limits.defaultTimeoutSeconds, 30, 1800, 'verification defaultTimeoutSeconds'),
    },
  };
}

export function selectorDigest(selectors) {
  return crypto.createHash('sha256').update(JSON.stringify(selectors), 'utf8').digest('hex');
}

export function verificationIdempotencyDigest({ projectSlug, taskId, sourceFingerprint, profile, selectors, idempotencyKey, admissionId, developmentMode }) {
  for (const [label, value] of Object.entries({ projectSlug, taskId, profile, idempotencyKey, admissionId })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required for verify idempotency.`);
  }
  requiredString(sourceFingerprint, SHA256_PATTERN, 'verify sourceFingerprint');
  return crypto.createHash('sha256').update(JSON.stringify({
    projectSlug, taskId, sourceFingerprint, profile, selectors, idempotencyKey, admissionId,
    ...(developmentMode === 'direct' ? { developmentMode } : {}),
  }), 'utf8').digest('hex');
}

export function verificationCommand(profile, selectors, sourceHead, lintFiles, reviewBase, testFilters, typecheckFiles) {
  if (profile === SOURCE_QUALITY_PROFILE) throw new Error('Backend source quality requires the Host runner and its pinned scanner bundle.');
  requiredString(sourceHead, /^[0-9a-f]{40}$/u, 'verify sourceHead');
  const normalized = validateSelectors(profile, selectors);
  const mavenModules = normalized.modules?.map((entry) => entry.replace(/^forge-server\//u, '')).join(',');
  switch (profile) {
    case 'governance':
      return { steps: [{ cwd: '/workspace', argv: ['forge-governance', 'audit', '--base', sourceHead] }] };
    case 'backend-red-test':
      return {
        steps: [{
          cwd: '/workspace/forge-server',
          argv: ['mvn', ...MAVEN_VERIFICATION_ARGS, MAVEN_OFFLINE_REPOSITORY_ARG, '-o', MAVEN_TEST_PROFILE_ARG, '-pl', mavenModules, '-am', '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false', `-Dtest=${normalized.tests[0]}`, '-Dsurefire.failIfNoSpecifiedTests=false', 'test'],
        }],
      };
    case 'frontend-red-test':
      return { steps: [
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'] },
        { cwd: '/workspace/forge-admin-ui', argv: ['pnpm', 'test', '--', '--run', normalized.testFiles[0].replace(/^forge-admin-ui\//u, ''), '--reporter=json', '--outputFile=/workspace/test-results-admin-red.json'] },
      ] };
    case 'backend-module-compile':
      return { steps: [{ cwd: '/workspace/forge-server', argv: ['mvn', ...MAVEN_VERIFICATION_ARGS, MAVEN_OFFLINE_REPOSITORY_ARG, '-o', MAVEN_TEST_PROFILE_ARG, '-pl', mavenModules, '-am', '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false', '-DskipTests', 'test-compile'] }] };
    case 'backend-module-test':
      return { steps: [{ cwd: '/workspace/forge-server', argv: ['mvn', ...MAVEN_VERIFICATION_ARGS, MAVEN_OFFLINE_REPOSITORY_ARG, '-o', MAVEN_TEST_PROFILE_ARG, '-pl', mavenModules, '-am', '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false', 'test'] }] };
    case 'backend-test-class':
      return {
        steps: [{
          cwd: '/workspace/forge-server',
          argv: ['mvn', ...MAVEN_VERIFICATION_ARGS, MAVEN_OFFLINE_REPOSITORY_ARG, '-o', MAVEN_TEST_PROFILE_ARG, '-pl', mavenModules, '-am', '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false', `-Dtest=${normalized.tests.join(',')}`, '-Dsurefire.failIfNoSpecifiedTests=false', 'test'],
        }],
      };
    case 'frontend-admin-lint': {
      const batches = frontendLintBatches(normalized, lintFiles);
      if (batches.length === 0) {
        requiredString(reviewBase, /^[0-9a-f]{40}$/u, 'lint review base');
        return { steps: [{ cwd: '/workspace', argv: ['node', '-e', FRONTEND_LINT_EMPTY_SCRIPT, 'git', reviewBase, sourceHead] }] };
      }
      return { steps: [
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'] },
        ...batches.map((files) => ({ cwd: '/workspace/forge-admin-ui', argv: ['pnpm', 'exec', 'eslint', ...files.map((entry) => entry.replace(/^forge-admin-ui\//u, '')), '--max-warnings=0', ...FRONTEND_LINT_FORMAT_ARGS] })),
      ] };
    }
    case 'frontend-admin-test':
      return { steps: [
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'] },
        { cwd: '/workspace/forge-admin-ui', argv: ['pnpm', 'test', ...(normalized.testFiles?.map((entry) => entry.replace(/^forge-admin-ui\//u, ''))
          ?? [...frontendTestScopeFilters(testFilters), `--changed=${requiredString(reviewBase ?? sourceHead, /^[0-9a-f]{40}$/u, 'test review base')}`, '--passWithNoTests']), '--reporter=json', '--outputFile=/workspace/test-results-admin.json'] },
      ] };
    case 'frontend-admin-typecheck':
      return { steps: [
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'] },
        { cwd: '/workspace', argv: ['node', '/usr/local/lib/frontend-typecheck.mjs', ...frontendTypecheckArguments(typecheckFiles)] },
      ] };
    case 'frontend-admin-build':
      return { steps: [
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'] },
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'build'] },
      ] };
    case 'frontend-h5-test':
      return { steps: [{ cwd: '/workspace/forge-h5-ui', argv: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination=/workspace/test-results-h5.xml', ...normalized.testFiles.map(entry => entry.replace(/^forge-h5-ui\//u, ''))] }] };
    case 'frontend-h5-build':
      return { steps: [
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-h5-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'] },
        { cwd: '/workspace', argv: ['corepack', 'pnpm', '--dir', 'forge-h5-ui', 'build:h5'] },
      ] };
    case 'changed-safe':
      return { steps: [{ cwd: '/workspace', argv: ['forge-governance', 'audit', '--base', sourceHead] }] };
    case 'full-regression':
      return { steps: [{ cwd: '/workspace/forge-server', argv: ['mvn', ...MAVEN_VERIFICATION_ARGS, MAVEN_OFFLINE_REPOSITORY_ARG, '-o', MAVEN_TEST_PROFILE_ARG, '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false', 'test'] }] };
    default:
      throw new Error('verify profile is not allowed.');
  }
}

export function publicVerifyError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'VERIFY_OPERATION_FAILED',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'Verification failed.',
    retryable: error?.retryable === true,
    ...(typeof error?.recommendedAction === 'string'
      ? { recommendedAction: error.recommendedAction.slice(0, 1000) }
      : {}),
  };
}

export function verifyError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.retryable !== undefined) error.retryable = options.retryable;
  if (options.recommendedAction !== undefined) error.recommendedAction = options.recommendedAction;
  return error;
}
