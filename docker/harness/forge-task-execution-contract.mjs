import crypto from 'node:crypto';
import { normalizeForgeSemanticResources } from './forge-semantic-resource-lease.mjs';

export const FORGE_TASK_EXECUTION_CONTRACT_SCHEMA_VERSION = 1;

export const ACTION_CEILINGS = Object.freeze([
  'read-only',
  'workspace-write',
  'test',
  'git-checkpoint',
  'release',
]);
export const MAX_TASK_CONTRACT_PROMPT_BYTES = 1024 * 1024;
export const FRONTEND_FORMAT_MAINTENANCE_PROFILE = 'frontend-format-maintenance';

// Owner suspended model-only release gates. Keep their identity separate from proof.
export const SUSPENDABLE_INDEPENDENT_REVIEW_OBLIGATIONS = Object.freeze([
  'api-error-and-auth-contract', 'complete-crud-vertical-slice',
  'stable-dictionary-code-contract', 'unique-semantic-owner',
]);

export const TASK_PROFILES = Object.freeze([
  'project-files',
  'requirements',
  'domain-contract',
  'migration',
  'database',
  'backend',
  'crud',
  'dictionary',
  'frontend-admin',
  'security',
  'workflow',
  'shared-owner',
  'ui-design',
  'cross-layer-acceptance',
  'read-only-review',
  FRONTEND_FORMAT_MAINTENANCE_PROFILE,
]);

const REQUIRED_SKILL_ORDER = Object.freeze([
  'forge-task-contract',
  'forge-task-router',
  'forge-change-design',
  'forge-requirement-coverage',
  'forge-database-migration',
  'forge-backend-architecture',
  'forge-crud-production',
  'forge-frontend-admin',
  'forge-dictionary-contract',
  'forge-security-tenancy-permission',
  'forge-ui-consistency-review',
  'forge-workflow-production',
  'forge-testing-observability',
  'forge-git-checkpoint',
  'forge-controlled-release',
  'forge-evidence-truth',
]);

const VERIFICATION_PROFILE_ORDER = Object.freeze([
  'governance',
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
const REQUESTABLE_FRONTEND_VERIFICATION = Object.freeze(['frontend-admin-typecheck', 'frontend-admin-build']);
const FRONTEND_VERIFICATION_REQUEST = /执行|运行|完成|补齐|补充|要求|必须|需要|\b(?:run|execute|perform|require)\b/iu;
const FRONTEND_VERIFICATION_DEFERRED = /不要|不得|禁止|不能|不必|无需|不需要|不运行|不执行|不做|不重复|不再|没有|未(?:被|执行|运行|完成)|尚未|暂不|暂缓|推迟|跳过|后续|稍后|以后|下次|只读|说明|解释|如何|怎么|引用|示例|日志|工具(?:结果|输出)|此前|上一轮|上轮|已(?:经)?(?:完成|运行|执行|通过|要求)|不\s*(?:typecheck|type|build|类型检查|构建)|\b(?:not|never|skip|defer|later|without)\b/iu;

function requestedFrontendVerification(prompt, taskProfiles, actionCeiling, ordinaryChanged) {
  if (!ordinaryChanged || actionCeiling === 'read-only' || !taskProfiles.includes('frontend-admin')) return [];
  const profiles = new Set();
  // This is the protected user prompt, not a model-declared proposal profile.
  const direct = prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  // Bind a restriction to its own action clause: declining publication or an
  // old test rerun must not erase an explicit current build request.
  for (const sentence of direct.match(/[^\n。！？!?；;]+(?:[。！？!?；;]|$)/gu) ?? []) {
    if (/[？?]$/u.test(sentence)) continue;
    const background = /^\s*(?:此前|上一轮|上轮|引用|示例|日志|工具(?:结果|输出))/u.test(sentence);
    const sentenceProfiles = new Set();
    for (const clause of sentence.split(/[，,]/u)) {
      if (background && !/^\s*(?:本次|本轮|这次|当前|现在)/u.test(clause)) continue;
      // A named current restriction removes that check, including a request in
      // an earlier sentence. Historical statements and other objects do not.
      const namedDeferral = clause.match(/^\s*(?:(?:但|不过|本次|本轮|这次|当前|现在|请)\s*)*(?:(?:暂不|先不|不要|不得|禁止|无需|不必|不需要|不)\s*(?:执行|运行|做|重跑)\s*(.+?)|(.+?)\s*(?:暂缓|推迟|跳过))[。！!\s]*$/u);
      const deferredChecks = (namedDeferral?.[1] ?? namedDeferral?.[2] ?? '').trim();
      if (/^(?:typecheck|type-check|类型检查|build|构建)(?:\s*(?:、|和|及|与|\/)\s*(?:typecheck|type-check|类型检查|build|构建))*$/iu.test(deferredChecks)) {
        for (const [profile, pattern] of [
          ['frontend-admin-typecheck', /typecheck|type-check|类型检查/iu],
          ['frontend-admin-build', /build|构建/iu],
        ]) {
          if (pattern.test(deferredChecks)) {
            sentenceProfiles.delete(profile);
            profiles.delete(profile);
          }
        }
        continue;
      }
      // An omitted object still refers to this sentence's requested checks.
      // Explicit other objects (publication, historical tests) do not match.
      if (/^\s*(?:(?:但|不过|本次|本轮|当前|现在|请)\s*)*(?:暂不|先不|不要|不得|禁止|无需|不必|不需要)\s*(?:执行|运行|做|重跑)(?:了|即可)?[。！!\s]*$/u.test(clause)) {
        sentenceProfiles.clear();
        continue;
      }
      if (!FRONTEND_VERIFICATION_REQUEST.test(clause) || FRONTEND_VERIFICATION_DEFERRED.test(clause)) continue;
      if (/\b(?:typecheck|type-check|type\s*\/\s*build)\b|类型检查/iu.test(clause)) sentenceProfiles.add('frontend-admin-typecheck');
      if (/\bbuild\b|构建/iu.test(clause)) sentenceProfiles.add('frontend-admin-build');
    }
    for (const profile of sentenceProfiles) profiles.add(profile);
  }
  return ordered(profiles, REQUESTABLE_FRONTEND_VERIFICATION);
}

function applyRequestedFrontendVerification(fields, requested = []) {
  fields.requiredVerificationProfiles = ordered([...fields.requiredVerificationProfiles, ...requested], VERIFICATION_PROFILE_ORDER);
}
const RED_PROFILE_ORDER = Object.freeze([
  'backend-red-test',
  'frontend-red-test',
]);

const OBLIGATION_ORDER = Object.freeze([
  'preserve-action-ceiling',
  'repository-relative-owned-paths',
  'report-evidence-boundaries',
  'test-first',
  'final-governance-audit',
  'final-verification',
  'no-implicit-git-or-release',
  'forward-only-migration',
  'immutable-migration-history',
  'empty-and-upgrade-schema-verification',
  'transaction-index-and-query-review',
  'api-error-and-auth-contract',
  'spec-and-quality-review',
  'complete-crud-vertical-slice',
  'stable-dictionary-code-contract',
  'loading-empty-error-and-busy-states',
  'responsive-keyboard-and-browser-review',
  'tenant-and-permission-fail-closed',
  'security-negative-tests',
  'workflow-state-transition-tests',
  'idempotent-workflow-callbacks',
  'unique-semantic-owner',
  'dual-consumer-contract-tests',
  'explicit-path-git-checkpoint',
  'controlled-release-only',
]);

const SEMANTIC_OWNER_ORDER = Object.freeze([
  'database-migration-history',
  'database-schema-and-persistence',
  'backend-module-contract',
  'crud-vertical-slice',
  'dictionary-code-contract',
  'frontend-admin-surface',
  'security-tenancy-and-permission',
  'workflow-state-machine',
  'shared-contract',
  'review-findings',
]);

const ACTION_LEVEL = new Map(ACTION_CEILINGS.map((value, index) => [value, index]));
const PROFILE_SET = new Set(TASK_PROFILES);
const CONTRACT_KEYS = Object.freeze([
  'schemaVersion',
  'contractId',
  'taskProfiles',
  'requiredSkills',
  'tddRequired',
  'requiredVerificationProfiles',
  'requiredRedProfiles',
  'requiredObligations',
  'semanticOwners',
  'actionCeiling',
  'ownedPaths',
  'sourceFingerprint',
]);

const INPUT_KEYS = new Set(['prompt', 'ownedPaths', 'actionCeiling', 'taskProfiles']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SUPPLEMENTAL_TEST_PATH = /^(?:tests?|test-fixtures|fixtures)\//u;
const BACKEND_PATH = /^forge-server(?:\/|$)/u;
const FRONTEND_PATH = /^forge-admin-ui(?:\/|$)/u;
const H5_SOURCE_PATH = /^forge-h5-ui\/src(?:\/|$)/u;
export const H5_TEST_FILE_PATTERN = /^forge-h5-ui\/src\/(?:[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\/)*[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\.(?:test|spec)\.js$/u;
const MIGRATION_PATH = /(?:^|\/)db\/migration(?:\/|$)|(?:^|\/)migrations?(?:\/|$)/iu;
const DATABASE_PATH = /(?:^|\/)(?:mapper|entity|repository|dao|database|db)(?:\/|$)|\.(?:sql|ddl)$/iu;
const SECURITY_PATH = /(?:^|\/)(?:security|auth|authentication|authorization|tenant|permission|data-scope)(?:\/|$)/iu;
const WORKFLOW_PATH = /(?:^|\/)(?:workflow|flowable|bpmn|approval)(?:\/|$)|\.bpmn20?\.xml$/iu;
const SHARED_OWNER_PATH = /(?:^|\/)(?:shared|common|starter|plugin-parent|forge-framework)(?:\/|$)/iu;
const ROOT_BACKEND_PATH = /^(?:pom\.xml|mvnw|mvnw\.cmd|\.mvn\/)/u;
const ROOT_SHARED_PATH = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u;
const REQUIRED_CHANGE_SPEC_PATH = /^code-copilot\/changes\/[a-z0-9][a-z0-9._-]{0,127}\/spec\.md$/u;
const CHANGE_RECORD_PATH = /^code-copilot\/changes\/[a-z0-9][a-z0-9._-]{0,127}\/(?:tasks|test-spec|execution-log)\.md$/u;
const FRONTEND_FORMAT_SOURCE_PATH = /^forge-admin-ui\/src\/(?:[^/]+\/)*[^/]+\.(?:vue|js|jsx|ts|tsx|css|scss|less)$/u;

const PROMPT_RULES = Object.freeze([
  ['migration', /\b(?:migration|flyway|ddl)\b|数据库迁移|表结构迁移|向前迁移/iu],
  ['database', /\b(?:database|sql|schema|mapper|entity|index)\b|数据库|数据表|索引|持久化/iu],
  ['backend', /\b(?:backend|rest(?:ful)?|controller|service|dto|vo|api)\b|后端|接口|服务层/iu],
  ['crud', /\bcrud\b|增删改查|新增.{0,12}(?:修改|编辑).{0,12}(?:删除|查询)|列表.{0,12}表单/iu],
  ['dictionary', /\b(?:dictionary|enum|coded[ -]?field)\b|字典|枚举|状态码|码值/iu],
  ['frontend-admin', /\b(?:frontend|admin[ -]?ui|vue|component|dialog|form)\b|管理端|前端|页面|弹窗|组件/iu],
  ['security', /\b(?:security|rbac|auth(?:entication|orization)?|permission|tenant|data[ -]?scope)\b|安全|鉴权|权限|租户|数据范围/iu],
  // Resubmitting an execution job is not an approval workflow. Require the
  // approval subject for this ambiguous action; paths/declarations still apply.
  ['workflow', /\b(?:workflow|flowable|bpmn|approval)\b|工作流|审批流程|流程审批|会签|驳回|重提[^，,。；;！？!?\r\n]{0,12}审批|(?:实现|新增|修改|开发)[^，,。；;！？!?\r\n]{0,12}审批|审批[^，,。；;！？!?\r\n]{0,12}(?:功能|页面|接口|状态|重提)/iu],
  ['shared-owner', /\bshared[ -]?owner\b|\bshared (?:contract|component|utility)\b|公共组件|共享[^\r\n]{0,16}(?:owner|能力|逻辑|合同|组件|工具)|语义 owner/iu],
]);

const PROFILE_SKILLS = Object.freeze({
  'project-files': [],
  requirements: ['forge-change-design', 'forge-requirement-coverage'],
  'domain-contract': [
    'forge-change-design',
    'forge-crud-production',
    'forge-dictionary-contract',
    'forge-security-tenancy-permission',
  ],
  migration: ['forge-database-migration', 'forge-security-tenancy-permission'],
  database: ['forge-database-migration'],
  backend: ['forge-backend-architecture'],
  crud: [
    'forge-database-migration',
    'forge-backend-architecture',
    'forge-crud-production',
    'forge-frontend-admin',
    'forge-dictionary-contract',
    'forge-security-tenancy-permission',
  ],
  dictionary: ['forge-dictionary-contract'],
  'frontend-admin': ['forge-frontend-admin', 'forge-security-tenancy-permission'],
  security: ['forge-security-tenancy-permission'],
  workflow: [
    'forge-workflow-production',
    'forge-database-migration',
    'forge-security-tenancy-permission',
  ],
  'shared-owner': [],
  'ui-design': [
    'forge-change-design',
    'forge-frontend-admin',
    'forge-dictionary-contract',
    'forge-security-tenancy-permission',
    'forge-ui-consistency-review',
  ],
  'cross-layer-acceptance': ['forge-ui-consistency-review', 'forge-testing-observability'],
  'read-only-review': [],
  [FRONTEND_FORMAT_MAINTENANCE_PROFILE]: [],
});

const LEGACY_PROFILE_VERIFICATION = Object.freeze({
  'project-files': [],
  requirements: [],
  'domain-contract': [],
  migration: ['full-regression'],
  database: ['backend-module-test'],
  backend: ['backend-module-test'],
  crud: ['backend-module-test', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'full-regression'],
  dictionary: ['backend-module-test', 'frontend-admin-test', 'full-regression'],
  'frontend-admin': ['frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build'],
  security: ['changed-safe', 'full-regression'],
  workflow: ['full-regression'],
  'shared-owner': ['full-regression'],
  'ui-design': [],
  'cross-layer-acceptance': [],
  'read-only-review': [],
  [FRONTEND_FORMAT_MAINTENANCE_PROFILE]: [],
});

// Ordinary task verification follows the changed area. Application-wide type
// checking, builds and reactor regression are not implicit delivery gates.
const PROFILE_VERIFICATION = Object.freeze({
  ...LEGACY_PROFILE_VERIFICATION,
  migration: ['backend-module-test'],
  crud: [],
  dictionary: [],
  'frontend-admin': ['frontend-admin-lint', 'frontend-admin-test'],
  security: [],
  workflow: [],
  'shared-owner': [],
});

const PROFILE_RED = Object.freeze({
  'project-files': [],
  requirements: [],
  'domain-contract': [],
  migration: ['backend-red-test'],
  database: ['backend-red-test'],
  backend: ['backend-red-test'],
  crud: ['backend-red-test', 'frontend-red-test'],
  dictionary: ['backend-red-test', 'frontend-red-test'],
  'frontend-admin': ['frontend-red-test'],
  security: ['backend-red-test'],
  workflow: ['backend-red-test'],
  'shared-owner': ['backend-red-test'],
  'ui-design': [],
  'cross-layer-acceptance': [],
  'read-only-review': [],
  [FRONTEND_FORMAT_MAINTENANCE_PROFILE]: [],
});

const PROFILE_OBLIGATIONS = Object.freeze({
  'project-files': [],
  requirements: [],
  'domain-contract': [],
  migration: [
    'forward-only-migration',
    'immutable-migration-history',
    'empty-and-upgrade-schema-verification',
  ],
  database: ['transaction-index-and-query-review'],
  backend: ['api-error-and-auth-contract'],
  crud: ['complete-crud-vertical-slice'],
  dictionary: ['stable-dictionary-code-contract'],
  'frontend-admin': [
    'loading-empty-error-and-busy-states',
    'responsive-keyboard-and-browser-review',
  ],
  security: ['tenant-and-permission-fail-closed', 'security-negative-tests'],
  workflow: ['workflow-state-transition-tests', 'idempotent-workflow-callbacks'],
  'shared-owner': ['unique-semantic-owner', 'dual-consumer-contract-tests'],
  'ui-design': [],
  'cross-layer-acceptance': [],
  'read-only-review': [],
  [FRONTEND_FORMAT_MAINTENANCE_PROFILE]: [],
});

const PROFILE_OWNERS = Object.freeze({
  'project-files': [],
  requirements: ['review-findings'],
  'domain-contract': ['crud-vertical-slice'],
  migration: ['database-migration-history'],
  database: ['database-schema-and-persistence'],
  backend: ['backend-module-contract'],
  crud: ['crud-vertical-slice'],
  dictionary: ['dictionary-code-contract'],
  'frontend-admin': ['frontend-admin-surface'],
  security: ['security-tenancy-and-permission'],
  workflow: ['workflow-state-machine'],
  'shared-owner': ['shared-contract'],
  'ui-design': ['frontend-admin-surface'],
  'cross-layer-acceptance': ['review-findings'],
  'read-only-review': ['review-findings'],
  [FRONTEND_FORMAT_MAINTENANCE_PROFILE]: [],
});

export class ForgeTaskContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeTaskContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeTaskContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CONTRACT_NOT_SERIALIZABLE', 'Canonical JSON rejects non-finite numbers.');
    return value;
  }
  if (typeof value !== 'object') {
    fail('CONTRACT_NOT_SERIALIZABLE', `Canonical JSON rejects values of type ${typeof value}.`);
  }
  if (seen.has(value)) fail('CONTRACT_NOT_SERIALIZABLE', 'Canonical JSON rejects cyclic values.');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => canonicalValue(entry, seen));
  } else {
    if (!isPlainObject(value)) fail('CONTRACT_NOT_SERIALIZABLE', 'Canonical JSON accepts only plain objects.');
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('CONTRACT_NOT_SERIALIZABLE', `Canonical JSON rejects undefined field ${key}.`);
      result[key] = canonicalValue(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value, new Set()));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail('CONTRACT_INVALID_TYPE', `${label} must be a plain object.`);
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('CONTRACT_UNSUPPORTED_FIELD', `${label} contains unsupported field ${key}.`);
  }
}

function normalizePrompt(value) {
  if (typeof value !== 'string') fail('CONTRACT_PROMPT_INVALID', 'prompt must be a string.');
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim().normalize('NFC');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes < 1 || bytes > MAX_TASK_CONTRACT_PROMPT_BYTES || normalized.includes('\0')) {
    fail('CONTRACT_PROMPT_INVALID', 'prompt must contain from 1 to 1048576 UTF-8 bytes and no NUL.');
  }
  return normalized;
}

function normalizeOwnedPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0')) {
    fail('CONTRACT_PATH_INVALID', 'Each owned path must be a non-empty bounded string without NUL.');
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('CONTRACT_PATH_INVALID', 'Owned paths cannot contain surrounding whitespace or control characters.');
  }
  const normalized = value.replaceAll('\\', '/').normalize('NFC');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes(':')) {
    fail('CONTRACT_PATH_INVALID', 'Owned paths must be repository-relative and cannot use a drive, UNC path, or ADS.');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('CONTRACT_PATH_TRAVERSAL', 'Owned paths cannot contain empty, dot, or traversal segments.');
  }
  return normalized;
}

function ordered(values, catalog) {
  const selected = new Set(values);
  return catalog.filter((value) => selected.has(value));
}

function normalizeOwnedPaths(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > 256 || (!allowEmpty && value.length < 1)) {
    fail('CONTRACT_PATHS_INVALID', allowEmpty
      ? 'ownedPaths must contain at most 256 paths.'
      : 'ownedPaths must contain from 1 to 256 paths.');
  }
  const normalized = value.map(normalizeOwnedPath).sort();
  const portable = new Set();
  for (const entry of normalized) {
    const key = entry.toLocaleLowerCase('en-US');
    if (portable.has(key)) fail('CONTRACT_PATH_DUPLICATE', 'ownedPaths must be unique on case-insensitive filesystems.');
    portable.add(key);
  }
  return normalized;
}

function normalizeActionCeiling(value) {
  if (!ACTION_LEVEL.has(value)) {
    fail('CONTRACT_ACTION_CEILING_INVALID', `actionCeiling must be one of: ${ACTION_CEILINGS.join(', ')}.`);
  }
  return value;
}

export { normalizeOwnedPath as normalizeForgeTaskOwnedPath, normalizeOwnedPaths as normalizeForgeTaskOwnedPaths };

function normalizeDeclaredProfiles(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_PROFILES.length) {
    fail('CONTRACT_TASK_PROFILE_INVALID', 'taskProfiles must be a non-empty bounded array when supplied.');
  }
  const selected = new Set();
  for (const profile of value) {
    if (typeof profile !== 'string' || !PROFILE_SET.has(profile)) {
      fail('CONTRACT_TASK_PROFILE_UNKNOWN', `Unknown Forge task profile: ${String(profile)}.`);
    }
    if (selected.has(profile)) fail('CONTRACT_TASK_PROFILE_INVALID', 'taskProfiles must be unique.');
    selected.add(profile);
  }
  return ordered(selected, TASK_PROFILES);
}

function classifyPath(relative, projectFiles = false) {
  const profiles = new Set();
  let recognized = false;
  if (projectFiles && (relative.split('/').some(segment => /^\.git$/iu.test(segment) || /^\.forge-/iu.test(segment))
    || /[*?{}]/u.test(relative))) {
    fail('CONTRACT_PATH_INVALID', 'Project-file ownership cannot target internal state or wildcard paths.');
  }
  // Explicit project-file tasks may own ordinary files anywhere in the current
  // repository. Real Forge source still contributes its non-optional checks.
  const ordinaryFile = /\.[^/]+$/u.test(relative)
    && !ROOT_BACKEND_PATH.test(relative)
    && relative !== 'docker-forge-admin/Dockerfile.admin'
    && !(BACKEND_PATH.test(relative) && /\.(?:java|xml|sql|ddl|properties|ya?ml)$/iu.test(relative))
    && !(FRONTEND_PATH.test(relative) && /\.(?:vue|[cm]?[jt]sx?|json|ya?ml|css|s[ac]ss|less)$/iu.test(relative))
    && !(H5_SOURCE_PATH.test(relative) && /\.(?:vue|[cm]?[jt]sx?|json|css|s[ac]ss|less)$/iu.test(relative));
  if (projectFiles && ordinaryFile) return { profiles: new Set(['project-files']), recognized: true };
  const migrationPath = MIGRATION_PATH.test(relative);
  if ((BACKEND_PATH.test(relative) || ROOT_BACKEND_PATH.test(relative)
    || relative === 'docker-forge-admin/Dockerfile.admin') && !migrationPath) {
    profiles.add('backend');
    recognized = true;
  }
  if (FRONTEND_PATH.test(relative)) {
    profiles.add('frontend-admin');
    recognized = true;
  }
  if (H5_SOURCE_PATH.test(relative)) {
    profiles.add('shared-owner');
    recognized = true;
  }
  if (migrationPath) {
    profiles.add('migration');
    profiles.add('database');
    recognized = true;
  } else if (DATABASE_PATH.test(relative) && BACKEND_PATH.test(relative)) {
    profiles.add('database');
  }
  // The security views are the business security-management module, not an
  // authentication implementation. Nested auth/permission paths still count.
  const securityPath = relative.replace(/^forge-admin-ui\/src\/views\/security(?:\/|$)/u, '');
  if (SECURITY_PATH.test(securityPath)) profiles.add('security');
  if (WORKFLOW_PATH.test(relative)) profiles.add('workflow');
  if (SHARED_OWNER_PATH.test(relative)) profiles.add('shared-owner');
  if (ROOT_SHARED_PATH.test(relative)) {
    profiles.add('shared-owner');
  }
  if (isForgeChangeRecordPath(relative)) recognized = true;
  if (SUPPLEMENTAL_TEST_PATH.test(relative)) recognized = true;
  if (projectFiles && !recognized) {
    profiles.add('project-files');
    recognized = true;
  }
  return { profiles, recognized };
}

export function isForgeRequiredChangeSpecPath(value) {
  return typeof value === 'string' && REQUIRED_CHANGE_SPEC_PATH.test(value);
}

export function isForgeChangeRecordPath(value) {
  return isForgeRequiredChangeSpecPath(value)
    || (typeof value === 'string' && CHANGE_RECORD_PATH.test(value));
}

export function isForgeFrontendFormatMaintenancePath(value) {
  return typeof value === 'string' && FRONTEND_FORMAT_SOURCE_PATH.test(value);
}

function validateFormatMaintenanceScope(taskProfiles, actionCeiling, ownedPaths) {
  if (!taskProfiles.includes(FRONTEND_FORMAT_MAINTENANCE_PROFILE)) return;
  // This marker is selected by the trusted ordinary-task proposal consumer.
  // Continuations recompile its authorized scope without repeating the request.
  if (actionCeiling === 'read-only' || !taskProfiles.includes('frontend-admin')
    || ownedPaths.length === 0 || !ownedPaths.every(isForgeFrontendFormatMaintenancePath)) {
    fail('CONTRACT_FORMAT_MAINTENANCE_INVALID', 'Format maintenance requires exact frontend-admin/src source files and a write-capable contract.');
  }
}

export function isForgeTaskOwnedPath(candidate, owned) {
  if (typeof candidate !== 'string' || typeof owned !== 'string') return false;
  if (isForgeChangeRecordPath(owned)
    || owned === 'docker-forge-admin/Dockerfile.admin') return candidate === owned;
  return candidate === owned || candidate.startsWith(`${owned}/`);
}

function classifyProfiles(prompt, ownedPaths, actionCeiling, declaredProfiles) {
  const profiles = new Set(declaredProfiles ?? []);
  const projectFiles = profiles.has('project-files');
  const pathProfiles = new Set();
  const unknownWritePaths = [];
  for (const relative of ownedPaths) {
    const classified = classifyPath(relative, projectFiles);
    for (const profile of classified.profiles) pathProfiles.add(profile);
    if (!classified.recognized && actionCeiling !== 'read-only') unknownWritePaths.push(relative);
  }
  if (unknownWritePaths.length > 0) {
    fail(
      'CONTRACT_UNKNOWN_WRITE_PATH',
      `Write scope contains unclassified paths: ${unknownWritePaths.join(', ')}.`,
    );
  }
  for (const profile of pathProfiles) profiles.add(profile);
  if (projectFiles && pathProfiles.size === 1 && pathProfiles.has('project-files')) {
    profiles.delete('backend');
    profiles.delete('frontend-admin');
  }
  if (declaredProfiles === undefined) {
    // Classify requested business changes, not explicitly excluded work or a
    // completed context or platform dependency repair. Keep the original prompt in the
    // source fingerprint; actual paths and declared consumers are never removed.
    const requested = prompt
      // Source entrypoints and emitted UI bundles are not database indexes.
      // Keep actual SQL paths, declared roles and separate index requests intact.
      .replace(/\bindex(?:-[A-Za-z0-9_]+)?\.(?:vue|mjs|cjs|jsx?|tsx?)\b/giu, '源文件')
      // A named release step and its service-based responsibility describe the
      // delivery mechanism, not database source work. Separate requests survive.
      .replace(/\btest-database-snapshot\b/giu, '发布快照阶段')
      .replace(/平台(?:现在)?按(?:本次|当前)(?:实际)?发布的服务(?:判断|确定)数据库义务/gu, '平台判断发布检查范围')
      // A saved form-asset property is a UI schema, not a database schema.
      // Retain separate database requests and the original fingerprint text.
      .replace(/(\b(?:forms|formAssets)\[\d+\])\.schema\b/gu, '$1.界面结构')
      // A schema explicitly qualified by a UI/form/search surface describes
      // rendering configuration. Do not consume a separate database schema,
      // unqualified schema request, SQL text, or path-derived responsibility.
      .replace(/((?:\b(?:UI|form|page|search|query)|(?:前端|界面|页面|表单|查询|搜索)(?:区|配置|字段)?)(?:\s*(?:的|所用|使用|依据|根据|据))?\s*)schema\b/giu, '$1界面结构')
      // Display-name propagation across existing list/form views is not a new
      // CRUD slice. Explicit CRUD or create/edit/delete requests still match.
      .replace(/列表(?:与|和|及|[/／])表单(?:[/／]详情)?(?=(?:展示|显示)(?:名称|标签|标题))/gu, '视图')
      // These bounded clauses preserve existing behavior; they do not request
      // new dictionary/security work. Positive clauses remain in the prompt.
      .replace(/(^|[。！？!?;；\n，,])\s*(?:原|已有|现有)(?:数据|校验|字典|权限)(?:[/／、及与和](?:数据|校验|字典|权限))*(?:未改|未变|不变)(?=$|[。！？!?;；\n，,])/gu, '$1')
      .replace(/(^|[。！？!?;；\n，,])\s*(?:保持|保留)(?:(?:项目|租户)隔离(?:及|和|与))?(?:现有|原有|正常|实际)(?:状态(?:及|和|与))?(?:权限|鉴权)(?:边界|机制|行为|逻辑)?(?=$|[。！？!?;；\n，,])/gu, '$1')
      .replace(/((?:沿|遵循|使用)(?:当前|现有|已有)(?:文件)?(?:API|接口)(?:和|与|及))权限(?=(?:形成|执行|完成)(?:真实)?操作)/giu, '$1现有约束')
      // Consuming a shared component or describing its limits is not an owner
      // change. Keep clauses that also ask to change it, and all owned paths.
      .replace(/((?:使用|复用|接入|引用|调用|消费)\s*(?:现有|已有|已合并的)?\s*)(?:公共组件|共享组件)(?![^。！？!?;；\n，,]*(?:修改|修复|调整|新增|扩展|删除|重构|替换|更新))/gu, '$1现有组件')
      .replace(/(?:公共组件|共享组件)(?=\s*(?:不会|不能)自动)(?![^。！？!?;；\n，,]*(?:修改|修复|调整|新增|扩展|删除|重构|替换|更新))/gu, '现有组件')
      // Tool/API parameter schemas are not database schema changes. Keep the
      // qualifier (notably API) and any separate schema-change request intact.
      .replace(/((?:\bJSON|\btool|\bAPI|\bprepare_task\s+proposal|工具|参数|调用|接口|帮助)\s*[/／:_-]?\s*)schema\b/giu, '$1参数格式')
      .replace(/((?:按|按照)\s*(?:(?:当前|现有|真实|实际|返回的)\s*){0,3})schema\b(?=[，,][^\r\n。！？!?;；]{0,200}\b(?:references|ownedPaths)\b)/giu, '$1工具参数格式')
      .replace(/(^|[。！？!?;；\n：:])([^。！？!?;；\n：:]+)/gu, (sentence, separator, body) => {
        // A completed earlier batch is evidence, not a new layer request. Keep
        // mixed sentences containing fresh work or unresolved requirements.
        const completed = /^[^，,。！？!?;；\n]{0,80}(?:已经|已|刚(?:刚)?(?:在[^，,。！？!?;；\n]{0,64})?)(?:完成|发布|修复|通过)(?:了)?/u.test(body);
        // A verified successful comparison describes existing behavior. It
        // must not create a database obligation for an unrelated UI repair.
        const verifiedComparison = /(?:则能|能够正常)[^。！？!?;；\n]{0,96}[，,][^。！？!?;；\n]{0,80}已(?:分别)?验证(?:了)?(?:这一|该|上述)?(?:差异|结果)/u.test(body);
        const currentWork = /请|现在|本轮|本次|这次|接下来|但|不过|仍需|尚未|未完成|需要|还需|同时|继续|续跑|[，,]\s*(?:新增|增加|修改|修复|补齐|实现|开发|重构|更新|调整)/u.test(body);
        return (completed || verifiedComparison) && !currentWork ? separator : sentence;
      })
      .replace(/(^|[。！？!?;；\n，,、])\s*(?:(?:本轮|本次|这次|当前任务)\s*)?(数据库|数据表|表结构)\s*(不要|无需|不必|不需要|不再|暂不|不)(修改|调整|更改|改动|改变|改|动)/gu, '$1$3$4$2')
      // Rejecting a mistaken classification does not request that database work.
      // Require a complete clause so a separate or mixed positive request survives.
      .replace(/(^|[。！？!?;；\n，,])\s*(?:不能|不应|不该|不得|不要)\s*(?:把|将)(?:(?!但|同时|而是)[^。！？!?;；\n，,]){1,80}?(?:误当(?:成|作|做)|误认为|误判为)\s*(?:数据库|数据表|表结构|SQL|schema|索引|持久化)(?:的)?(?:变更|修改|迁移|需求|任务|工作)(?=$|[。！？!?;；\n，,])/giu, '$1')
      .replace(/(^|[。！？!?;；\n，,、])\s*(?:(?:本轮|本次|这次|当前任务|前端任务|后端任务)\s*)?(?:也\s*)?(?:不要|无需|不必|不需要|不再|暂不|不)(?:因(?:(?!但|同时|而是)[^。！？!?;；\n，,]){1,120}?而)?(?:强制)?(?:夹带(?:无关|额外)|要求|重复|重跑|重构|修改|调整|更改|改动|改变|改|动|执行|运行|加载|验证|检查|新增|增加|触及|涉及)(?:(?!但|同时|而是)[^。！？!?;；\n，,])*/gu, '$1')
      .replace(/(?:平台|Host|工作舱|容器)(?:已经|已)(?:修复|恢复|解决)[^。！？!?;；\n，,]{0,48}(?:依赖|node_modules|Maven|缓存)[^。！？!?;；\n，,]{0,16}(?:目录|文件)(?:的)?(?:读取|读写|访问|执行)?权限/giu, '平台环境已恢复');
    const exclusiveLayers = new Set([...requested.matchAll(/(?:^|[。！？!?;；\n，,])\s*(?:(?:本轮|本次|这次|当前任务)\s*)?(?:只|仅)(?:需要|需|限)?\s*(?:修改|修复|调整|验证|检查|测试|复核|收尾|处理|涉及|覆盖|变更|执行|运行)\s*(?:此前|当前|现有|已有)?\s*(前端|后端)(?!\s*(?:和|及|与|、|\/|以及)\s*(?:前端|后端))/gu)]
      .map((match) => match[1] === '前端' ? 'frontend-admin' : 'backend'));
    for (const [profile, pattern] of PROMPT_RULES) {
      if (['backend', 'frontend-admin'].includes(profile) && exclusiveLayers.size === 1 && !exclusiveLayers.has(profile)) continue;
      if (pattern.test(requested)) profiles.add(profile);
    }
  }
  // A production Forge CRUD slice owns coded status/dictionary behavior even
  // when the short task title omits those words. Keep this implication in the
  // deterministic compiler so behavior suites and the phase guard cannot add
  // an extra, unenforced Skill requirement out of band.
  if (profiles.has('crud')) profiles.add('dictionary');
  if (actionCeiling === 'read-only') {
    profiles.add('read-only-review');
  } else if (profiles.has('read-only-review')) {
    fail('CONTRACT_PROFILE_ACTION_CONFLICT', 'read-only-review cannot authorize a write-capable contract.');
  }
  if (actionCeiling !== 'read-only' && profiles.size === 0) {
    fail('CONTRACT_TASK_PROFILE_UNKNOWN', 'Write-capable tasks require at least one recognized Forge task profile.');
  }
  return ordered(profiles, TASK_PROFILES);
}

export function backendTestSelectorsForOwnedPaths(ownedPaths) {
  const backendPaths = ownedPaths.filter(file => file.startsWith('forge-server/'));
  const modules = new Set();
  const testModules = new Set();
  const tests = new Set();
  for (const file of backendPaths) {
    // The owned test specification remains in the contract/source fingerprint.
    // It needs a real test in the same module, but is not an executable resource.
    const specification = /^(forge-server(?:\/[A-Za-z0-9_.-]+)*)\/src\/test\/resources\/(?:[A-Za-z0-9_-]+\/)*spec\.md$/u.exec(file);
    if (specification && !file.split('/').some(part => part === '.' || part === '..')) {
      modules.add(specification[1]);
      continue;
    }
    const match = /^(forge-server(?:\/[^/]+)*)\/src\/(main|test)\/java\/([A-Za-z_$][A-Za-z0-9_$/]*)\.java$/u.exec(file);
    if (!match) return null;
    modules.add(match[1]);
    if (match[2] === 'test') {
      testModules.add(match[1]);
      tests.add(match[3].replaceAll('/', '.'));
    }
  }
  if (!tests.size || [...modules].some(module => !testModules.has(module))) return null;
  return { modules: [...modules].sort(), tests: [...tests].sort() };
}

const JAVA_TEST_PATH = /^(forge-server(?:\/[A-Za-z0-9_.-]+)*)\/src\/test\/java\/([A-Za-z_$][A-Za-z0-9_$/]*)\.java$/u;

function backendTestIdentity(file) {
  if (typeof file !== 'string' || file.split('/').some(part => part === '.' || part === '..')) return null;
  const match = JAVA_TEST_PATH.exec(file);
  return match ? { module: match[1], test: match[2].replaceAll('/', '.') } : null;
}

function isVersionedMigrationSource(file) {
  return typeof file === 'string' && !file.split('/').some(part => part === '.' || part === '..')
    && /^forge-server\/db\/migration\/V[0-9]+(?:[._][0-9]+)*__[A-Za-z0-9_]+\.sql$/u.test(file);
}

function migrationBackendScope(ownedPaths, testPath) {
  const paths = ownedPaths.filter(file => file.startsWith('forge-server/')).sort();
  return backendTestIdentity(testPath) && paths.includes(testPath)
    && paths.some(isVersionedMigrationSource)
    && paths.every(file => file === testPath || isVersionedMigrationSource(file)) ? paths : null;
}

function integrationBackendScope(ownedPaths, testPath) {
  const identity = backendTestIdentity(testPath);
  if (!identity || !ownedPaths.includes(testPath)) return null;
  const modules = new Set();
  for (const file of ownedPaths.filter(item => item.startsWith('forge-server/'))) {
    if (file === testPath) continue;
    if (file.startsWith(`${identity.module}/src/test/resources/`)
      && /\/src\/test\/resources\/(?:[A-Za-z0-9_-]+\/)*spec\.md$/u.test(file)) continue;
    const source = /^(forge-server(?:\/[A-Za-z0-9_.-]+)*)\/src\/main\/java\/[A-Za-z_$][A-Za-z0-9_$/]*\.java$/u.exec(file);
    if (!source || file.split('/').some(part => part === '.' || part === '..') || source[1] === identity.module) return null;
    modules.add(source[1]);
  }
  return modules.size ? [...modules].sort() : null;
}

function normalizeIntegrationTestBinding(binding, ownedPaths) {
  exactKeys(binding, new Set(['module', 'test', 'testPath', 'testSha256', 'coveredPaths', 'testPomSha256', 'moduleDependencies']), 'Backend integration binding');
  const identity = backendTestIdentity(binding.testPath);
  const modules = integrationBackendScope(ownedPaths, binding.testPath);
  const paths = ownedPaths.filter(file => file.startsWith('forge-server/')).sort();
  if (!identity || identity.module !== binding.module || identity.test !== binding.test || !modules
    || !SHA256_PATTERN.test(binding.testSha256 ?? '') || !SHA256_PATTERN.test(binding.testPomSha256 ?? '')
    || canonicalStringify(binding.coveredPaths) !== canonicalStringify(paths)
    || !Array.isArray(binding.moduleDependencies) || binding.moduleDependencies.length !== modules.length) {
    fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Integration bindings require the owned test, exact production sources and direct Maven dependency evidence.');
  }
  const dependencies = binding.moduleDependencies.map((entry, index) => {
    exactKeys(entry, new Set(['module', 'pomSha256']), 'Backend integration dependency');
    if (entry.module !== modules[index] || !SHA256_PATTERN.test(entry.pomSha256 ?? '')) {
      fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Integration dependencies must cover every production module canonically.');
    }
    return { ...entry };
  });
  return { ...binding, coveredPaths: [...paths], moduleDependencies: dependencies };
}

function normalizeBackendTestBindings(bindings, ownedPaths) {
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 64) {
    fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Backend test bindings must be a bounded non-empty array.');
  }
  if (bindings.length === 1 && Object.hasOwn(bindings[0], 'moduleDependencies')) {
    return [normalizeIntegrationTestBinding(bindings[0], ownedPaths)];
  }
  const backendPaths = ownedPaths.filter(file => file.startsWith('forge-server/'));
  if (backendPaths.some(isVersionedMigrationSource)) {
    const binding = bindings[0];
    exactKeys(binding, new Set(['module', 'test', 'testPath', 'testSha256', 'coveredPaths']), 'Backend migration test binding');
    const identity = backendTestIdentity(binding.testPath);
    const paths = migrationBackendScope(ownedPaths, binding.testPath);
    if (bindings.length !== 1 || !paths || identity.module !== binding.module || identity.test !== binding.test
      || !SHA256_PATTERN.test(binding.testSha256 ?? '')
      || canonicalStringify(binding.coveredPaths) !== canonicalStringify(paths)) {
      fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Migration bindings require the owned test and exact versioned SQL scope.');
    }
    return [{ ...binding, coveredPaths: [...paths] }];
  }
  if (!backendPaths.length || backendPaths.some(file => !backendTestIdentity(file))) {
    fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Helper bindings only cover exact backend test source files.');
  }
  const covered = new Set();
  const tests = new Set();
  for (const binding of bindings) {
    exactKeys(binding, new Set(['module', 'test', 'testPath', 'testSha256', 'coveredPaths']), 'Backend test binding');
    const identity = backendTestIdentity(binding.testPath);
    if (!identity || identity.module !== binding.module || identity.test !== binding.test
      || !SHA256_PATTERN.test(binding.testSha256 ?? '')
      || tests.has(binding.testPath) || !Array.isArray(binding.coveredPaths) || !binding.coveredPaths.length
      || canonicalStringify(binding.coveredPaths) !== canonicalStringify([...new Set(binding.coveredPaths)].sort())
      || binding.coveredPaths.some(file => !backendPaths.includes(file) || backendTestIdentity(file)?.module !== binding.module)
      || (ownedPaths.includes(binding.testPath) && !binding.coveredPaths.includes(binding.testPath))) {
      fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Backend test bindings must identify distinct tests covering only this module and owned scope, including any owned test itself.');
    }
    tests.add(binding.testPath);
    for (const file of binding.coveredPaths) covered.add(file);
  }
  if (backendPaths.some(file => !covered.has(file))
    || canonicalStringify(bindings.map(item => item.testPath)) !== canonicalStringify([...tests].sort())) {
    fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Backend test bindings must canonically cover every owned backend source.');
  }
  return bindings.map(binding => ({ ...binding, coveredPaths: [...binding.coveredPaths] }));
}

// This bounded reader accepts direct, literal Maven dependencies only. Profile,
// plugin and dependency-management declarations cannot prove a runtime edge.
function directMavenDependencies(content) {
  let xml = content.replace(/<!--[\s\S]*?-->/gu, '');
  if (/<!|<[A-Za-z][\w.-]*:/u.test(xml)) return null;
  const parent = /<parent\s*>([\s\S]*?)<\/parent\s*>/u.exec(xml)?.[1] ?? '';
  xml = xml.replace(/<parent\s*>[\s\S]*?<\/parent\s*>/gu, '');
  for (const tag of ['dependencyManagement', 'profiles', 'build', 'reporting']) {
    xml = xml.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gu'), '');
  }
  const project = /<project\b[^>]*>([\s\S]*)<\/project\s*>/u.exec(xml)?.[1];
  if (!project) return null;
  const header = project.split(/<(?:dependencies|properties|modules|repositories|pluginRepositories)\b/u)[0];
  const value = (body, tag) => new RegExp(`<${tag}\\s*>\\s*([A-Za-z0-9_.-]+)\\s*<\\/${tag}\\s*>`, 'u').exec(body)?.[1];
  const group = value(header, 'groupId') ?? value(parent, 'groupId');
  const artifact = value(header, 'artifactId');
  if (!group || !artifact) return null;
  const blocks = [...project.matchAll(/<dependencies\s*>([\s\S]*?)<\/dependencies\s*>/gu)];
  if (blocks.length > 1) return null;
  const dependencies = new Set();
  for (const match of (blocks[0]?.[1] ?? '').matchAll(/<dependency\s*>([\s\S]*?)<\/dependency\s*>/gu)) {
    const body = match[1];
    const scope = /<scope\b/u.test(body) ? value(body, 'scope') : 'compile';
    const type = /<type\b/u.test(body) ? value(body, 'type') : 'jar';
    const optional = /<optional\b/u.test(body) ? value(body, 'optional') : 'false';
    if (scope !== 'compile' || type !== 'jar' || optional !== 'false' || /<classifier\b/u.test(body)) continue;
    const dependencyGroup = value(body, 'groupId');
    const dependencyArtifact = value(body, 'artifactId');
    if (dependencyGroup && dependencyArtifact) dependencies.add(`${dependencyGroup}:${dependencyArtifact}`);
  }
  return { coordinate: `${group}:${artifact}`, dependencies };
}

function deriveIntegrationTestBinding(ownedPaths, verifiedReferences) {
  const tests = ownedPaths.filter(file => backendTestIdentity(file));
  if (tests.length !== 1) return undefined;
  const testPath = tests[0], identity = backendTestIdentity(testPath);
  const modules = integrationBackendScope(ownedPaths, testPath);
  if (!modules) return undefined;
  const references = new Map();
  const needed = new Set([testPath, `${identity.module}/pom.xml`, ...modules.map(module => `${module}/pom.xml`)]);
  for (const reference of verifiedReferences) {
    if (!needed.has(reference.path) || typeof reference.content !== 'string' || reference.content.length > 1024 * 1024) continue;
    if (sha256(reference.content) !== reference.sha256 || references.has(reference.path)) {
      fail('CONTRACT_BACKEND_TEST_SOURCE_CHANGED', 'Integration source or Maven bytes differ from their verified hash.');
    }
    references.set(reference.path, reference);
  }
  if ([...needed].some(file => !references.has(file))) return undefined;
  const test = references.get(testPath);
  if (/\\u[0-9a-f]{4}/iu.test(test.content)) return undefined;
  const code = test.content.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, ' ');
  const packageName = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/u.exec(code)?.[1];
  const simpleName = identity.test.split('.').at(-1);
  if (`${packageName}.${simpleName}` !== identity.test || !new RegExp(`\\bclass\\s+${simpleName}\\b`, 'u').test(code)
    || !/\bimport\s+org\.junit\.jupiter\.api\.(?:Test|\*)\s*;/u.test(code) || !/@Test\b/u.test(code)
    || !/\bimport\s+org\.springframework\.boot\.test\.context\.(?:SpringBootTest|\*)\s*;/u.test(code)
    || !/@SpringBootTest\s*\(\s*classes\s*=\s*[A-Za-z_$][\w$.]*\.class\s*(?:,\s*webEnvironment\s*=\s*SpringBootTest\.WebEnvironment\.RANDOM_PORT\s*)?\)/u.test(code)) return undefined;
  const testPom = references.get(`${identity.module}/pom.xml`);
  const application = directMavenDependencies(testPom.content);
  if (!application) return undefined;
  const dependencies = [];
  for (const module of modules) {
    const reference = references.get(`${module}/pom.xml`);
    const production = directMavenDependencies(reference.content);
    if (!production || !application.dependencies.has(production.coordinate)) return undefined;
    dependencies.push({ module, pomSha256: reference.sha256 });
  }
  return [normalizeIntegrationTestBinding({ ...identity, testPath, testSha256: test.sha256,
    testPomSha256: testPom.sha256, moduleDependencies: dependencies,
    coveredPaths: ownedPaths.filter(file => file.startsWith('forge-server/')).sort() }, ownedPaths)];
}

function deriveMigrationTestBinding(ownedPaths, verifiedReferences) {
  const tests = ownedPaths.filter(file => backendTestIdentity(file));
  if (tests.length !== 1) return undefined;
  const testPath = tests[0], paths = migrationBackendScope(ownedPaths, testPath);
  if (!paths) return undefined;
  const references = new Map(verifiedReferences.map(reference => [reference.path, reference]));
  if (paths.some(file => !SHA256_PATTERN.test(references.get(file)?.sha256 ?? ''))) return undefined;
  const source = references.get(testPath), identity = backendTestIdentity(testPath);
  if (typeof source.content !== 'string' || source.content.length > 1024 * 1024) return undefined;
  if (sha256(source.content) !== source.sha256) {
    fail('CONTRACT_BACKEND_TEST_SOURCE_CHANGED', 'Migration test source bytes differ from their verified hash.');
  }
  if (/\\u[0-9a-f]{4}/iu.test(source.content)) return undefined;
  const tokens = /"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu;
  const code = source.content.replace(tokens, ' ');
  const literals = source.content.replace(tokens, token => token.startsWith('/') ? ' ' : token);
  const packageName = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/u.exec(code)?.[1];
  const simpleName = identity.test.split('.').at(-1);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (`${packageName}.${simpleName}` !== identity.test
    || !new RegExp(`\\bclass\\s+${escape(simpleName)}\\b`, 'u').test(code)
    || !/\bimport\s+org\.junit\.jupiter\.api\.(?:Test|\*)\s*;/u.test(code) || !/@Test\b/u.test(code)
    || !/\bFiles\.(?:readString|readAllBytes)\s*\(/u.test(code)) return undefined;
  for (const file of paths.filter(isVersionedMigrationSource)) {
    const literal = `"(?:${escape(file)}|${escape(file.slice('forge-server/'.length))})"`;
    const directPath = new RegExp(`\\b(?:of|resolve)\\s*\\(\\s*${literal}\\s*\\)`, 'u').test(literals);
    const constant = new RegExp(`\\bString\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${literal}\\s*;`, 'u').exec(literals)?.[1];
    const passedReference = constant && new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\(\\s*${escape(constant)}\\s*\\)`, 'u').test(code);
    if (!directPath && !passedReference) return undefined;
  }
  // References bind SQL bytes; sourceFingerprint and real class receipts still
  // prove the candidate/execution. This only selects the explicitly read test.
  return normalizeBackendTestBindings([{ ...identity, testPath, testSha256: source.sha256, coveredPaths: paths }], ownedPaths);
}

// Consume only bytes already read and hashed by trusted task preparation. This
// does not scan the repository or infer execution/coverage from a class name.
export function deriveBackendTestBindings(ownedPaths, verifiedReferences) {
  const backendPaths = ownedPaths.filter(file => file.startsWith('forge-server/'));
  if (!backendPaths.length) return undefined;
  if (backendPaths.some(isVersionedMigrationSource)) return deriveMigrationTestBinding(ownedPaths, verifiedReferences);
  if (backendPaths.some(file => !backendTestIdentity(file))) return deriveIntegrationTestBinding(ownedPaths, verifiedReferences);
  const sources = new Map();
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const reference of verifiedReferences) {
    const identity = backendTestIdentity(reference.path);
    if (!identity || typeof reference.content !== 'string' || reference.content.length > 1024 * 1024) continue;
    if (sha256(reference.content) !== reference.sha256) {
      fail('CONTRACT_BACKEND_TEST_SOURCE_CHANGED', 'Test mapping source bytes differ from their verified hash.');
    }
    // Unicode source escapes make this bounded lexical check inconclusive.
    if (/\\u[0-9a-f]{4}/iu.test(reference.content)) continue;
    const code = reference.content.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, ' ');
    const packageName = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/u.exec(code)?.[1];
    const simpleName = identity.test.split('.').at(-1);
    if (`${packageName}.${simpleName}` !== identity.test || !new RegExp(`\\bclass\\s+${escape(simpleName)}\\b`, 'u').test(code)) continue;
    const junit = ['Test', 'RepeatedTest', 'TestFactory', 'TestTemplate', 'ParameterizedTest'].some(annotation => {
      const namespace = annotation === 'ParameterizedTest' ? 'org.junit.jupiter.params' : 'org.junit.jupiter.api';
      return new RegExp(`@${escape(namespace)}\\.${annotation}\\b`, 'u').test(code)
        || (new RegExp(`\\bimport\\s+${escape(namespace)}\\.(?:${annotation}|\\*)\\s*;`, 'u').test(code)
          && new RegExp(`@${annotation}\\b`, 'u').test(code));
    });
    sources.set(reference.path, { ...identity, packageName, simpleName, code, junit, sha256: reference.sha256 });
  }
  if (backendPaths.some(file => !sources.has(file)) || backendPaths.every(file => sources.get(file).junit)) return undefined;
  const bindings = [];
  for (const [testPath, candidate] of sources) {
    if (!candidate.junit) continue;
    const coveredPaths = backendPaths.filter(file => {
      const helper = sources.get(file);
      // A verified owned JUnit class is executed itself; another test cannot
      // replace it merely by referring to its class name.
      if (helper.junit) return file === testPath;
      if (helper.module !== candidate.module) return false;
      const fullyQualified = escape(helper.test);
      const shortNameVisible = helper.packageName === candidate.packageName
        || new RegExp(`\\bimport\\s+${fullyQualified}\\s*;`, 'u').test(candidate.code);
      const names = shortNameVisible ? `(?:${fullyQualified}|${escape(helper.simpleName)})` : fullyQualified;
      return new RegExp(`(?:\\bnew\\s+${names}\\s*\\(|\\b${names}\\s*\\.)`, 'u').test(candidate.code);
    }).sort();
    if (coveredPaths.length) bindings.push({ module: candidate.module, test: candidate.test,
      testPath, testSha256: candidate.sha256, coveredPaths });
  }
  if (backendPaths.some(file => !bindings.some(binding => binding.coveredPaths.includes(file)))) return undefined;
  return normalizeBackendTestBindings(bindings.sort((a, b) => a.testPath < b.testPath ? -1 : 1), ownedPaths);
}

export function backendTestSelectorsForContract(contract) {
  if (!Object.hasOwn(contract, 'backendTestBindings')) return backendTestSelectorsForOwnedPaths(contract.ownedPaths);
  const bindings = normalizeBackendTestBindings(contract.backendTestBindings, contract.ownedPaths);
  return { modules: [...new Set(bindings.flatMap(item => [item.module, ...(item.moduleDependencies ?? []).map(dependency => dependency.module)]))].sort(), tests: [...new Set(bindings.map(item => item.test))].sort() };
}

function applyIntegrationVerification(fields, bindings) {
  if (bindings?.some(binding => Object.hasOwn(binding, 'moduleDependencies') || binding.coveredPaths.some(isVersionedMigrationSource))
    && fields.requiredVerificationProfiles.includes('backend-module-test')) {
    fields.requiredVerificationProfiles = ordered(fields.requiredVerificationProfiles.map(profile =>
      profile === 'backend-module-test' ? 'backend-test-class' : profile), VERIFICATION_PROFILE_ORDER);
  }
}

function ownsOnlyFrontendTools(ownedPaths) {
  const frontendPaths = ownedPaths.filter(relative => FRONTEND_PATH.test(relative));
  const utility = /^forge-admin-ui\/src\/utils\/(?:[^/]+\/)*[^/]+\.(?:[cm]?[jt]s)$/u;
  const testFile = /^forge-admin-ui\/(?:[^/]+\/)*[^/]+\.(?:test|spec)\.[cm]?[jt]s$/u;
  return frontendPaths.some(relative => utility.test(relative))
    && frontendPaths.every(relative => utility.test(relative) || testFile.test(relative));
}

function scopedAdminDockerPackagingFields(fields, taskProfiles, actionCeiling, ownedPaths) {
  if (actionCeiling === 'read-only' || ownedPaths.length !== 1
    || ownedPaths[0] !== 'docker-forge-admin/Dockerfile.admin'
    || taskProfiles.length === 0
    || taskProfiles.some(profile => !['backend', 'migration', 'database'].includes(profile))) return null;
  // Copying existing resources into the image changes packaging, not Java or SQL.
  // The real artifact and migration/restore run remain separate delivery evidence;
  // governance must not claim that those checks have been performed.
  const inapplicable = new Set(['final-verification',
    ...PROFILE_OBLIGATIONS.backend, ...PROFILE_OBLIGATIONS.migration, ...PROFILE_OBLIGATIONS.database]);
  return { ...fields,
    requiredVerificationProfiles: fields.requiredVerificationProfiles.filter(profile => profile !== 'backend-module-test'),
    requiredObligations: fields.requiredObligations.filter(id => !inapplicable.has(id)),
  };
}

function derivedFields(taskProfiles, actionCeiling, independentReview = 'required', legacyVerification = false, ownedPaths = [], ordinaryOwnedPaths = null, consumerOwnedPaths = ownedPaths) {
  const readOnly = actionCeiling === 'read-only';
  const projectFilesOnly = taskProfiles.length === 1 && taskProfiles[0] === 'project-files';
  const formatMaintenance = taskProfiles.includes(FRONTEND_FORMAT_MAINTENANCE_PROFILE);
  const ordinaryConversation = ordinaryOwnedPaths !== null;
  const testFirst = !formatMaintenance && !ordinaryConversation && !projectFilesOnly;
  const toolsOnly = ordinaryConversation && ownsOnlyFrontendTools(ordinaryOwnedPaths);
  const skills = new Set(['forge-task-contract', 'forge-task-router', 'forge-evidence-truth']);
  const verification = new Set();
  const redProfiles = new Set();
  const obligations = new Set([
    'preserve-action-ceiling',
    'repository-relative-owned-paths',
    'report-evidence-boundaries',
  ]);
  const owners = new Set();

  if (!readOnly) {
    if (!projectFilesOnly) {
      skills.add('forge-change-design');
      skills.add('forge-testing-observability');
    }
    verification.add('governance');
    if (testFirst) obligations.add('test-first');
    obligations.add('final-governance-audit');
    if (!projectFilesOnly) obligations.add('final-verification');
    obligations.add('no-implicit-git-or-release');
  }
  for (const profile of taskProfiles) {
    for (const skill of PROFILE_SKILLS[profile]) skills.add(skill);
    if (!readOnly) {
      for (const item of (legacyVerification ? LEGACY_PROFILE_VERIFICATION : PROFILE_VERIFICATION)[profile]) verification.add(item);
      if (testFirst) for (const item of PROFILE_RED[profile]) redProfiles.add(item);
      if (!(toolsOnly && profile === 'frontend-admin')) {
        for (const item of PROFILE_OBLIGATIONS[profile]) obligations.add(item);
      }
    }
    for (const owner of PROFILE_OWNERS[profile]) owners.add(owner);
  }
  if (ACTION_LEVEL.get(actionCeiling) >= ACTION_LEVEL.get('git-checkpoint')) {
    skills.add('forge-git-checkpoint');
    obligations.add('explicit-path-git-checkpoint');
  }
  if (actionCeiling === 'release') {
    skills.add('forge-controlled-release');
    obligations.add('controlled-release-only');
  }
  const suspended = independentReview === 'suspended'
    ? ordered([...obligations].filter(id => SUSPENDABLE_INDEPENDENT_REVIEW_OBLIGATIONS.includes(id)), OBLIGATION_ORDER) : [];
  if (!legacyVerification && verification.has('backend-module-test')
    && backendTestSelectorsForOwnedPaths(ownedPaths) !== null) {
    verification.delete('backend-module-test');
    verification.add('backend-test-class');
  }
  if (!readOnly && consumerOwnedPaths.some(relative => H5_SOURCE_PATH.test(relative)
    && classifyPath(relative, taskProfiles.includes('project-files')).profiles.has('shared-owner'))) {
    verification.add('frontend-h5-build');
    if (consumerOwnedPaths.some(relative => H5_TEST_FILE_PATTERN.test(relative))) verification.add('frontend-h5-test');
  }
  return {
    ...(independentReview === 'suspended' ? { suspendedReviewObligations: suspended } : {}),
    requiredSkills: ordered(skills, REQUIRED_SKILL_ORDER),
    tddRequired: !readOnly && testFirst,
    requiredVerificationProfiles: ordered(verification, VERIFICATION_PROFILE_ORDER),
    requiredRedProfiles: ordered(redProfiles, RED_PROFILE_ORDER),
    requiredObligations: ordered([...obligations].filter(id => !suspended.includes(id)), OBLIGATION_ORDER),
    semanticOwners: ordered(owners, SEMANTIC_OWNER_ORDER),
  };
}

function normalizedSourceInput(input) {
  exactKeys(input, INPUT_KEYS, 'Forge task contract input');
  const prompt = normalizePrompt(input.prompt);
  const actionCeiling = normalizeActionCeiling(input.actionCeiling);
  const ownedPaths = normalizeOwnedPaths(input.ownedPaths, { allowEmpty: actionCeiling === 'read-only' });
  const declaredTaskProfiles = normalizeDeclaredProfiles(input.taskProfiles);
  return { prompt, ownedPaths, actionCeiling, declaredTaskProfiles };
}

export function verificationScopeForContract(contract) {
  if (!contract) return 'legacy';
  const fields = derivedFields(contract.taskProfiles, contract.actionCeiling, 'required', false, contract.ownedPaths);
  applyIntegrationVerification(fields, contract.backendTestBindings);
  applyRequestedFrontendVerification(fields, contract.requestedVerificationProfiles);
  const current = fields.requiredVerificationProfiles;
  const previous = derivedFields(contract.taskProfiles, contract.actionCeiling).requiredVerificationProfiles;
  const packaging = Object.hasOwn(contract, 'suspendedReviewObligations') && contract.tddRequired === false
    ? scopedAdminDockerPackagingFields(fields, contract.taskProfiles, contract.actionCeiling, contract.ownedPaths) : null;
  return [current, previous, ...(packaging ? [packaging.requiredVerificationProfiles] : [])].some(profiles => canonicalStringify(contract.requiredVerificationProfiles)
    === canonicalStringify(profiles)) ? 'changed' : 'legacy';
}

export function fingerprintForgeTaskExecutionSource(input) {
  const normalized = normalizedSourceInput(input);
  return sha256(canonicalStringify({
    schemaVersion: FORGE_TASK_EXECUTION_CONTRACT_SCHEMA_VERSION,
    prompt: normalized.prompt,
    ownedPaths: normalized.ownedPaths,
    actionCeiling: normalized.actionCeiling,
    declaredTaskProfiles: normalized.declaredTaskProfiles ?? [],
  }));
}

export function deriveForgeTaskIntent({ prompt, actionCeiling }) {
  const normalizedPrompt = normalizePrompt(prompt);
  const normalizedActionCeiling = normalizeActionCeiling(actionCeiling);
  const taskProfiles = classifyProfiles(
    normalizedPrompt,
    [],
    normalizedActionCeiling,
    undefined,
  );
  return deepFreeze({
    schemaVersion: FORGE_TASK_EXECUTION_CONTRACT_SCHEMA_VERSION,
    kind: 'forge-task-intent',
    taskProfiles,
    actionCeiling: normalizedActionCeiling,
    ...derivedFields(taskProfiles, normalizedActionCeiling),
  });
}

function withoutContractId(contract) {
  const { contractId: _ignored, ...payload } = contract;
  return payload;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function normalizeForgeDualReviewBinding(value) {
  exactKeys(value, new Set(['sourcePath', 'sha256']), 'Dual review binding');
  if (Object.keys(value).length !== 2 || typeof value.sourcePath !== 'string'
    || !/^(?:forge-server|forge-admin-ui)\/.+\.json$/u.test(value.sourcePath)
    || normalizeOwnedPath(value.sourcePath) !== value.sourcePath || !SHA256_PATTERN.test(value.sha256 ?? '')) {
    fail('CONTRACT_DUAL_REVIEW_BINDING_INVALID', 'Dual review requires a current repository JSON contract reference and its SHA-256.');
  }
  return { sourcePath: value.sourcePath, sha256: value.sha256 };
}

function applyDualReview(contract, binding) {
  contract.dualReview = normalizeForgeDualReviewBinding(binding);
  contract.requiredObligations = ordered([...contract.requiredObligations, 'spec-and-quality-review'], OBLIGATION_ORDER);
}

// The protected compiler supplies decisions; a model task proposal cannot.
// Bind each decision to the exact grant so permission approval cannot spread
// to another SQL statement, file, or recipient role.
export function normalizeForgeRoleGrantDecisions(value, ownedPaths) {
  if (!Array.isArray(value) || value.length > 64) {
    fail('CONTRACT_ROLE_DECISION_INVALID', 'Role grant decisions must be a bounded array.');
  }
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'fileSha256,path,roleKeys,statementSha256'
      || typeof item.path !== 'string' || item.path.length > 1024 || !item.path.startsWith('forge-server/') || !item.path.endsWith('.sql')
      || item.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')
      || /[\\\0\r\n:*?]/u.test(item.path)
      || !ownedPaths.some(root => isForgeTaskOwnedPath(item.path, root))
      || typeof item.statementSha256 !== 'string' || !SHA256_PATTERN.test(item.statementSha256)
      || typeof item.fileSha256 !== 'string' || !SHA256_PATTERN.test(item.fileSha256)
      || !Array.isArray(item.roleKeys) || item.roleKeys.length < 1 || item.roleKeys.length > 32
      || item.roleKeys.some(role => typeof role !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(role))
      || new Set(item.roleKeys).size !== item.roleKeys.length) {
      fail('CONTRACT_ROLE_DECISION_INVALID', 'Role grant decisions require an owned SQL path, exact statement digest, and explicit role keys.');
    }
    const key = `${item.path}\0${item.statementSha256}`;
    if (seen.has(key)) fail('CONTRACT_ROLE_DECISION_INVALID', 'Role grant decision is duplicated.');
    seen.add(key);
    return { path: item.path, roleKeys: [...item.roleKeys].sort(), statementSha256: item.statementSha256, fileSha256: item.fileSha256 };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en')
    || left.statementSha256.localeCompare(right.statementSha256, 'en'));
}

function contractSemanticResources(value) {
  try { return normalizeForgeSemanticResources(value); }
  catch (error) { fail('CONTRACT_SEMANTIC_RESOURCES_INVALID', error.message); }
}

export function compileForgeTaskExecutionContract(input, options = {}) {
  exactKeys(options, new Set(['independentReview', 'verificationScope', 'focusedBackendVerification', 'ordinaryFinalVerification', 'backendTestBindings', 'dualReview', 'roleGrantDecisions', 'semanticResources']), 'Task contract compiler options');
  if (options.ordinaryFinalVerification !== undefined && typeof options.ordinaryFinalVerification !== 'boolean') {
    fail('CONTRACT_VERIFICATION_SCOPE_INVALID', 'Ordinary final verification support must be boolean.');
  }
  if (options.focusedBackendVerification !== undefined && typeof options.focusedBackendVerification !== 'boolean') {
    fail('CONTRACT_VERIFICATION_SCOPE_INVALID', 'Focused backend verification support must be boolean.');
  }
  // Existing consumers keep the historical contract until their image advertises support.
  const independentReview = options.independentReview ?? 'required';
  if (!['required', 'suspended'].includes(independentReview)) {
    fail('CONTRACT_REVIEW_MODE_INVALID', 'Independent review mode must be required or suspended.');
  }
  const verificationScope = options.verificationScope ?? 'legacy';
  if (!['legacy', 'changed'].includes(verificationScope)) {
    fail('CONTRACT_VERIFICATION_SCOPE_INVALID', 'Verification scope must be legacy or changed.');
  }
  const normalized = normalizedSourceInput(input);
  const roleGrantDecisions = options.roleGrantDecisions === undefined ? undefined
    : normalizeForgeRoleGrantDecisions(options.roleGrantDecisions, normalized.ownedPaths);
  const semanticResources = options.semanticResources === undefined ? undefined
    : contractSemanticResources(options.semanticResources);
  const taskProfiles = classifyProfiles(
    normalized.prompt,
    normalized.ownedPaths,
    normalized.actionCeiling,
    normalized.declaredTaskProfiles,
  );
  validateFormatMaintenanceScope(taskProfiles, normalized.actionCeiling, normalized.ownedPaths);
  const requestedVerificationProfiles = requestedFrontendVerification(normalized.prompt, taskProfiles,
    normalized.actionCeiling, independentReview === 'suspended' && verificationScope === 'changed');
  const sourceFingerprint = sha256(canonicalStringify({
    schemaVersion: FORGE_TASK_EXECUTION_CONTRACT_SCHEMA_VERSION,
    prompt: normalized.prompt,
    ownedPaths: normalized.ownedPaths,
    actionCeiling: normalized.actionCeiling,
    declaredTaskProfiles: normalized.declaredTaskProfiles ?? [],
    ...(options.dualReview === undefined ? {} : { dualReview: normalizeForgeDualReviewBinding(options.dualReview) }),
    ...(roleGrantDecisions === undefined ? {} : { roleGrantDecisions }),
    ...(semanticResources === undefined ? {} : { semanticResources }),
  }));
  const contract = {
    schemaVersion: FORGE_TASK_EXECUTION_CONTRACT_SCHEMA_VERSION,
    contractId: '',
    taskProfiles,
    ...derivedFields(taskProfiles, normalized.actionCeiling, independentReview, verificationScope === 'legacy',
      options.focusedBackendVerification === true ? normalized.ownedPaths : [],
      independentReview === 'suspended' && verificationScope === 'changed' && options.ordinaryFinalVerification !== false
        ? normalized.ownedPaths : null, normalized.ownedPaths),
    actionCeiling: normalized.actionCeiling,
    ownedPaths: normalized.ownedPaths,
    sourceFingerprint,
    ...(requestedVerificationProfiles.length === 0 ? {} : { requestedVerificationProfiles }),
    ...(roleGrantDecisions === undefined ? {} : { roleGrantDecisions }),
    ...(semanticResources === undefined ? {} : { semanticResources }),
  };
  if (options.backendTestBindings !== undefined) {
    const bindings = normalizeBackendTestBindings(options.backendTestBindings, normalized.ownedPaths);
    if (options.focusedBackendVerification === true && verificationScope === 'changed') applyIntegrationVerification(contract, bindings);
    if (!contract.requiredVerificationProfiles.includes('backend-test-class')) {
      fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Backend bindings require the focused backend verification profile.');
    }
    contract.backendTestBindings = bindings;
  }
  if (options.dualReview !== undefined) {
    if (normalized.actionCeiling === 'read-only') fail('CONTRACT_REVIEW_MODE_INVALID', 'A dual review gate requires an executable task contract.');
    applyDualReview(contract, options.dualReview);
  }
  if (independentReview === 'suspended' && verificationScope === 'changed' && options.ordinaryFinalVerification !== false) {
    const packaging = scopedAdminDockerPackagingFields(contract, taskProfiles, normalized.actionCeiling, normalized.ownedPaths);
    if (packaging) Object.assign(contract, packaging);
  }
  applyRequestedFrontendVerification(contract, requestedVerificationProfiles);
  contract.contractId = sha256(canonicalStringify(withoutContractId(contract)));
  return deepFreeze(contract);
}

function assertCanonicalStringArray(value, catalog, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail('CONTRACT_FIELD_INVALID', `${label} must be a string array.`);
  }
  const canonical = ordered(value, catalog);
  if (canonical.length !== value.length || canonical.some((entry, index) => entry !== value[index])) {
    fail('CONTRACT_FIELD_INVALID', `${label} must equal its unique canonical order.`);
  }
}

function assertEqualArray(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail('CONTRACT_DERIVATION_MISMATCH', `${label} does not match the task profiles and action ceiling.`);
  }
}

export function validateForgeTaskExecutionContract(value) {
  const suspendedReview = Object.hasOwn(value, 'suspendedReviewObligations');
  const boundBackendTests = Object.hasOwn(value, 'backendTestBindings');
  const dualReview = Object.hasOwn(value, 'dualReview');
  const roleDecisions = Object.hasOwn(value, 'roleGrantDecisions');
  const hasSemanticResources = Object.hasOwn(value, 'semanticResources');
  const hasRequestedVerification = Object.hasOwn(value, 'requestedVerificationProfiles');
  const contractKeys = [...CONTRACT_KEYS, ...(suspendedReview ? ['suspendedReviewObligations'] : []),
    ...(boundBackendTests ? ['backendTestBindings'] : []), ...(dualReview ? ['dualReview'] : []),
    ...(roleDecisions ? ['roleGrantDecisions'] : []), ...(hasSemanticResources ? ['semanticResources'] : []),
    ...(hasRequestedVerification ? ['requestedVerificationProfiles'] : [])];
  exactKeys(value, contractKeys, 'Forge task execution contract');
  if (Object.keys(value).length !== contractKeys.length) {
    fail('CONTRACT_REQUIRED_FIELD_MISSING', 'Forge task execution contract is missing a required field.');
  }
  const semanticResources = hasSemanticResources ? contractSemanticResources(value.semanticResources) : undefined;
  if (hasSemanticResources && canonicalStringify(value.semanticResources) !== canonicalStringify(semanticResources)) {
    fail('CONTRACT_SEMANTIC_RESOURCES_INVALID', 'semanticResources must use canonical keys and array order.');
  }
  if (value.schemaVersion !== FORGE_TASK_EXECUTION_CONTRACT_SCHEMA_VERSION) {
    fail('CONTRACT_SCHEMA_UNSUPPORTED', 'Unsupported Forge task execution contract schema.');
  }
  if (typeof value.contractId !== 'string' || !SHA256_PATTERN.test(value.contractId)) {
    fail('CONTRACT_ID_INVALID', 'contractId must be a lowercase SHA-256 digest.');
  }
  if (typeof value.sourceFingerprint !== 'string' || !SHA256_PATTERN.test(value.sourceFingerprint)) {
    fail('CONTRACT_SOURCE_FINGERPRINT_INVALID', 'sourceFingerprint must be a lowercase SHA-256 digest.');
  }
  const actionCeiling = normalizeActionCeiling(value.actionCeiling);
  assertCanonicalStringArray(value.taskProfiles, TASK_PROFILES, 'taskProfiles');
  if (actionCeiling === 'read-only' && !value.taskProfiles.includes('read-only-review')) {
    fail('CONTRACT_PROFILE_ACTION_CONFLICT', 'A read-only contract must include read-only-review.');
  }
  if (actionCeiling !== 'read-only' && value.taskProfiles.includes('read-only-review')) {
    fail('CONTRACT_PROFILE_ACTION_CONFLICT', 'A write-capable contract cannot include read-only-review.');
  }
  const ownedPaths = normalizeOwnedPaths(value.ownedPaths, { allowEmpty: actionCeiling === 'read-only' });
  assertEqualArray(value.ownedPaths, ownedPaths, 'ownedPaths');
  if (roleDecisions && canonicalStringify(value.roleGrantDecisions)
    !== canonicalStringify(normalizeForgeRoleGrantDecisions(value.roleGrantDecisions, ownedPaths))) {
    fail('CONTRACT_ROLE_DECISION_INVALID', 'Role grant decisions must be canonical.');
  }
  if (boundBackendTests) {
    normalizeBackendTestBindings(value.backendTestBindings, ownedPaths);
    if (!value.requiredVerificationProfiles.includes('backend-test-class')) {
      fail('CONTRACT_BACKEND_TEST_BINDING_INVALID', 'Helper bindings require focused backend verification.');
    }
  }
  validateFormatMaintenanceScope(value.taskProfiles, actionCeiling, ownedPaths);
  if (actionCeiling !== 'read-only') {
    const pathProfiles = new Set();
    for (const relative of ownedPaths) {
      const classified = classifyPath(relative, value.taskProfiles.includes('project-files'));
      if (!classified.recognized) fail('CONTRACT_UNKNOWN_WRITE_PATH', `Write scope contains unclassified path: ${relative}.`);
      for (const profile of classified.profiles) pathProfiles.add(profile);
    }
    for (const profile of pathProfiles) {
      if (!value.taskProfiles.includes(profile)) {
        fail('CONTRACT_DERIVATION_MISMATCH', `taskProfiles omits path-derived profile ${profile}.`);
      }
    }
    if (value.taskProfiles.length === 0) {
      fail('CONTRACT_TASK_PROFILE_UNKNOWN', 'Write-capable contracts require a task profile.');
    }
  }
  assertCanonicalStringArray(value.requiredSkills, REQUIRED_SKILL_ORDER, 'requiredSkills');
  assertCanonicalStringArray(
    value.requiredVerificationProfiles,
    VERIFICATION_PROFILE_ORDER,
    'requiredVerificationProfiles',
  );
  assertCanonicalStringArray(value.requiredRedProfiles, RED_PROFILE_ORDER, 'requiredRedProfiles');
  assertCanonicalStringArray(value.requiredObligations, OBLIGATION_ORDER, 'requiredObligations');
  assertCanonicalStringArray(value.semanticOwners, SEMANTIC_OWNER_ORDER, 'semanticOwners');
  if (typeof value.tddRequired !== 'boolean') fail('CONTRACT_FIELD_INVALID', 'tddRequired must be boolean.');
  const reviewMode = suspendedReview ? 'suspended' : 'required';
  const expected = derivedFields(value.taskProfiles, actionCeiling, reviewMode, false, ownedPaths);
  const ordinaryExpected = suspendedReview
    ? derivedFields(value.taskProfiles, actionCeiling, reviewMode, false, ownedPaths, ownedPaths) : expected;
  if (hasRequestedVerification) {
    assertCanonicalStringArray(value.requestedVerificationProfiles, REQUESTABLE_FRONTEND_VERIFICATION, 'requestedVerificationProfiles');
    if (!suspendedReview || actionCeiling === 'read-only' || !value.taskProfiles.includes('frontend-admin')
      || value.requestedVerificationProfiles.length === 0) {
      fail('CONTRACT_VERIFICATION_SCOPE_INVALID', 'Requested frontend checks require an ordinary executable frontend contract.');
    }
    applyRequestedFrontendVerification(expected, value.requestedVerificationProfiles);
    applyRequestedFrontendVerification(ordinaryExpected, value.requestedVerificationProfiles);
  }
  if (dualReview) {
    if (actionCeiling === 'read-only') fail('CONTRACT_REVIEW_MODE_INVALID', 'A dual review gate requires an executable task contract.');
    applyDualReview(expected, value.dualReview);
    applyDualReview(ordinaryExpected, value.dualReview);
  }
  if (boundBackendTests) {
    applyIntegrationVerification(expected, value.backendTestBindings);
    applyIntegrationVerification(ordinaryExpected, value.backendTestBindings);
  }
  const packagingExpected = suspendedReview
    ? scopedAdminDockerPackagingFields(ordinaryExpected, value.taskProfiles, actionCeiling, ownedPaths) : null;
  const packagingBehavior = packagingExpected !== null && value.tddRequired === packagingExpected.tddRequired
    && canonicalStringify(value.requiredRedProfiles) === canonicalStringify(packagingExpected.requiredRedProfiles)
    && canonicalStringify(value.requiredObligations) === canonicalStringify(packagingExpected.requiredObligations);
  // Keep complete historical contracts readable. A new ordinary contract must
  // match the complete scoped behavior; partial removal cannot weaken proof.
  const ordinaryBehavior = value.tddRequired === ordinaryExpected.tddRequired
    && canonicalStringify(value.requiredRedProfiles) === canonicalStringify(ordinaryExpected.requiredRedProfiles)
    && canonicalStringify(value.requiredObligations) === canonicalStringify(ordinaryExpected.requiredObligations);
  const behavior = packagingBehavior ? packagingExpected : ordinaryBehavior ? ordinaryExpected : expected;
  const scopedBehavior = ordinaryBehavior && (ordinaryExpected.tddRequired !== expected.tddRequired
    || canonicalStringify(ordinaryExpected.requiredObligations) !== canonicalStringify(expected.requiredObligations));
  if (suspendedReview) {
    assertCanonicalStringArray(value.suspendedReviewObligations, OBLIGATION_ORDER, 'suspendedReviewObligations');
    assertEqualArray(value.suspendedReviewObligations, expected.suspendedReviewObligations, 'suspendedReviewObligations');
  }
  assertEqualArray(value.requiredSkills, expected.requiredSkills, 'requiredSkills');
  // Stored, signed historical contracts remain readable without rewriting their
  // obligations or receipts. Newly compiled contracts always use scoped defaults.
  const legacyProfiles = derivedFields(value.taskProfiles, actionCeiling, reviewMode, true, [], null, ownedPaths)
    .requiredVerificationProfiles;
  const matchesCurrent = value.requiredVerificationProfiles.length === expected.requiredVerificationProfiles.length
    && value.requiredVerificationProfiles.every((profile, index) => profile === expected.requiredVerificationProfiles[index]);
  const previousProfiles = derivedFields(value.taskProfiles, actionCeiling, reviewMode).requiredVerificationProfiles;
  const matchesPrevious = canonicalStringify(value.requiredVerificationProfiles) === canonicalStringify(previousProfiles);
  if (hasRequestedVerification) {
    assertEqualArray(value.requiredVerificationProfiles, behavior.requiredVerificationProfiles, 'requiredVerificationProfiles');
  } else if (packagingBehavior) {
    assertEqualArray(value.requiredVerificationProfiles, packagingExpected.requiredVerificationProfiles, 'requiredVerificationProfiles');
  } else if (!matchesCurrent && !matchesPrevious
    && canonicalStringify(value.requiredVerificationProfiles) !== canonicalStringify(expected.requiredVerificationProfiles.filter(profile => profile !== 'frontend-h5-test'))) {
    assertEqualArray(value.requiredVerificationProfiles,
      scopedBehavior ? expected.requiredVerificationProfiles : legacyProfiles, 'requiredVerificationProfiles');
  }
  assertEqualArray(value.requiredRedProfiles, behavior.requiredRedProfiles, 'requiredRedProfiles');
  assertEqualArray(value.requiredObligations, behavior.requiredObligations, 'requiredObligations');
  assertEqualArray(value.semanticOwners, expected.semanticOwners, 'semanticOwners');
  if (value.tddRequired !== behavior.tddRequired) {
    fail('CONTRACT_DERIVATION_MISMATCH', 'tddRequired does not match the action ceiling and task profiles.');
  }
  const expectedId = sha256(canonicalStringify(withoutContractId(value)));
  if (value.contractId !== expectedId) fail('CONTRACT_HASH_MISMATCH', 'contractId does not match canonical contract content.');
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    contractId: value.contractId,
    ...(suspendedReview ? { suspendedReviewObligations: [...value.suspendedReviewObligations] } : {}),
    taskProfiles: [...value.taskProfiles],
    requiredSkills: [...value.requiredSkills],
    tddRequired: value.tddRequired,
    requiredVerificationProfiles: [...value.requiredVerificationProfiles],
    ...(hasRequestedVerification ? { requestedVerificationProfiles: [...value.requestedVerificationProfiles] } : {}),
    requiredRedProfiles: [...value.requiredRedProfiles],
    requiredObligations: [...value.requiredObligations],
    semanticOwners: [...value.semanticOwners],
    actionCeiling: value.actionCeiling,
    ownedPaths: [...value.ownedPaths],
    sourceFingerprint: value.sourceFingerprint,
    ...(boundBackendTests ? { backendTestBindings: normalizeBackendTestBindings(value.backendTestBindings, ownedPaths) } : {}),
    ...(dualReview ? { dualReview: normalizeForgeDualReviewBinding(value.dualReview) } : {}),
    ...(roleDecisions ? { roleGrantDecisions: normalizeForgeRoleGrantDecisions(value.roleGrantDecisions, ownedPaths) } : {}),
    ...(hasSemanticResources ? { semanticResources } : {}),
  });
}

export function isActionWithinCeiling(actionCeiling, requestedAction) {
  const ceiling = normalizeActionCeiling(actionCeiling);
  const requested = normalizeActionCeiling(requestedAction);
  return ACTION_LEVEL.get(requested) <= ACTION_LEVEL.get(ceiling);
}

export function assertActionWithinCeiling(contractOrCeiling, requestedAction) {
  const actionCeiling = typeof contractOrCeiling === 'string'
    ? contractOrCeiling
    : validateForgeTaskExecutionContract(contractOrCeiling).actionCeiling;
  if (!isActionWithinCeiling(actionCeiling, requestedAction)) {
    fail(
      'CONTRACT_ACTION_CEILING_EXCEEDED',
      `Requested action ${requestedAction} exceeds contract ceiling ${actionCeiling}.`,
    );
  }
  return requestedAction;
}
