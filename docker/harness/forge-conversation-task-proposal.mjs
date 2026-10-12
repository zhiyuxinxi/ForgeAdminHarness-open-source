import crypto from 'node:crypto';

import {
  FRONTEND_FORMAT_MAINTENANCE_PROFILE,
  TASK_PROFILES,
  canonicalStringify,
  compileForgeTaskExecutionContract,
  isForgeFrontendFormatMaintenancePath,
  isForgeTaskOwnedPath,
  normalizeForgeTaskOwnedPaths,
} from './forge-task-execution-contract.mjs';

const INPUT_KEYS = Object.freeze(['proposal', 'writerScopes']);
const PROPOSAL_KEYS = Object.freeze(['goal', 'ownedPaths', 'taskProfiles', 'references']);
const WRITER_SCOPE_KEYS = Object.freeze(['taskProfile', 'ownedPaths']);
const REFERENCE_KEYS = Object.freeze(['path', 'sha256']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_REFERENCES = 64;
const GLOB_PATTERN = /[*?[\]{}]/u;
const SENSITIVE_SEGMENT_PATTERN = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519)|.*(?:credential|credentials|password|passwd|secret|secrets|密码|凭据|密钥).*|.*\.(?:key|pem|p12|pfx|jks|keystore))$/iu;
const FORMAT_ONLY_REQUEST = /(?:^|[。！？!?;\n；])\s*(?:请\s*)?(?:(?:本次|这次|当前任务)\s*)?(?:只|仅)(?:需要|需|限)?\s*(?:修复|修正|处理|调整|修)[^。！？!?;\n；]{0,96}(?:已有|现有|已报告|已发现|当前)[^。！？!?;\n；]{0,64}(?:eslint|lint|格式|排版)|(?:^|[.;\n])\s*(?:please\s+)?only\s+(?:fix|correct|resolve)\s+[^.;\n]{0,80}\b(?:existing|current|reported)\b[^.;\n]{0,64}\b(?:eslint|lint|formatting)\b/iu;
const PRESERVE_BEHAVIOR = /(?:保持|保留)(?:业务|运行时)?(?:行为|功能|逻辑)(?:不变|一致)|不(?:改动|改变|修改)(?:业务|运行时)?(?:行为|功能|逻辑)|\b(?:preserve|keep)\s+(?:(?:existing|business|runtime)\s+)*(?:behavior|behaviour|functionality)\b|\bwithout\s+changing\s+(?:(?:business|runtime)\s+)?(?:behavior|behaviour|functionality)\b/iu;
const BEHAVIOR_CHANGE_REQUEST = /(?:新增|增加|实现|修复|修改|调整|重构|删除|移除|变更)[^。！？!?;\n；，,]{0,24}(?:业务逻辑|功能|权限|鉴权|认证|安全|租户|路由|接口|数据库|审批|流程)|\b(?:add|implement|change|fix|modify|remove|refactor)\s+[^.;\n]{0,40}\b(?:behavior|behaviour|feature|functionality|permission|authorization|authentication|tenant|routing|api|database)\b/iu;
const EXPLICIT_TEST_FIRST = /(?:\b(?:TDD|test[- ]first|RED\s*(?:→|->)\s*GREEN)\b|先写[^\r\n]{0,80}(?:失败|回归)[^\r\n]{0,40}测试|先[^\r\n]{0,60}测试[^\r\n]{0,40}再(?:做|修|改|实现))/iu;

function userRequestedTestFirst(promptText) {
  return promptText.split(/[，,。！？!?;；\r\n]/u).some(clause =>
    [...clause.matchAll(new RegExp(EXPLICIT_TEST_FIRST.source, 'giu'))].some(match => {
      const prefix = clause.slice(0, match.index);
      return !/(?:不要|无需|不必|不需要|不用|不做|暂不|先不)\s*(?:采用|进行|执行|做)?\s*$/u.test(prefix)
        && !/^\s*(?:无需|不必|不需要|不用|不做|暂不)/u.test(clause.slice(match.index + match[0].length));
    }));
}

function userRequestedFormatMaintenance(promptText, ownedPaths, references) {
  if (typeof promptText !== 'string' || !FORMAT_ONLY_REQUEST.test(promptText)
    || !PRESERVE_BEHAVIOR.test(promptText) || userRequestedTestFirst(promptText)) return false;
  const otherRequests = promptText.replace(new RegExp(PRESERVE_BEHAVIOR.source, 'giu'), '');
  if (BEHAVIOR_CHANGE_REQUEST.test(otherRequests)) return false;
  // Existing preparation validates these references against regular files and
  // their bytes. This selects a user-constrained strategy, not semantic equality.
  const referenced = new Set(references.map((reference) => reference.path));
  return ownedPaths.length > 0 && ownedPaths.every((file) =>
    isForgeFrontendFormatMaintenancePath(file) && referenced.has(file));
}

class ConversationTaskProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConversationTaskProposalError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new ConversationTaskProposalError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    fail('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', `${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const canonical = [...expected].filter((key) => Object.hasOwn(value, key)).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== canonical[index])) {
    fail(
      'CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID',
      `${label} must contain exactly: ${expected.join(', ')}.`,
    );
  }
}

function normalizeDisplayText(value) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim().normalize('NFC');
}

function portablePath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').normalize('NFC') : value;
}

export function isForgeCredentialHandlingSourcePath(value) {
  if (typeof value !== 'string') return false;
  const normalized = portablePath(value);
  const segments = normalized.split('/');
  const filename = segments.at(-1);
  return !segments.slice(0, -1).some(segment => SENSITIVE_SEGMENT_PATTERN.test(segment))
    && /(?:password|credential)/iu.test(filename)
    && !/(?:secret|passwd|密码|凭据|密钥)/iu.test(filename)
    && (/(?:^|\/)src\/main\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)+[A-Z][A-Za-z0-9_$]*(?:Request|DTO)\.java$/u.test(normalized)
      || /(?:^|\/)src\/test\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)+[A-Z][A-Za-z0-9_$]*Test\.java$/u.test(normalized)
      || /^forge-admin-ui\/src\/api\/(?:[A-Za-z_$][A-Za-z0-9_$-]*\/)*[A-Za-z_$][A-Za-z0-9_$]*(?:\.spec)?\.[jt]s$/u.test(normalized));
}

function assertNonSensitiveRepositoryPath(value, label) {
  if (typeof value !== 'string') return;
  const normalized = portablePath(value);
  // Vue dynamic-route filenames are literal paths here; preparation verifies
  // reference file bytes before this compiler, and scope matching never globs.
  const withoutLiteralRoute = normalized.replace(/(?:^|\/)(?:[A-Za-z0-9_-]+\.)?\[[A-Za-z_][A-Za-z0-9_]*\]\.vue$/u, '/literal-route.vue');
  if (GLOB_PATTERN.test(withoutLiteralRoute)) {
    fail('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', `${label} cannot contain glob syntax: ${value}.`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => /^\.git$/iu.test(segment) || /^\.forge-/iu.test(segment))) {
    fail('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', `${label} cannot target repository or Harness internal state: ${value}.`);
  }
  // The password utility and login decoder are implementation evidence, not
  // credential files.
  // Keep this exception read-only and require the normal Java source layout;
  // sensitive parent directories and all writer paths remain protected.
  const passwordImplementationReference = label === 'Reference path'
    && /(?:^|\/)src\/main\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)+(?:PasswordUtil|LoginPasswordDecoder)\.java$/u.test(normalized);
  // Password request DTOs, their tests, and credential API clients describe
  // credential handling; their source filenames are not credential stores.
  // Only the terminal source filename is exempt. Parent-directory protection
  // and the subsequent exact writer-scope check still apply.
  const credentialSource = isForgeCredentialHandlingSourcePath(normalized);
  if (segments.some((segment, index) => SENSITIVE_SEGMENT_PATTERN.test(segment)
    && !((passwordImplementationReference || credentialSource) && index === segments.length - 1))) {
    fail('CONVERSATION_TASK_PROPOSAL_PATH_FORBIDDEN', `${label} cannot target secret-bearing files: ${value}.`);
  }
}

function validateReferences(value, goal) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REFERENCES) {
    fail(
      'CONVERSATION_TASK_PROPOSAL_REFERENCE_INVALID',
      `references must contain from 1 to ${MAX_REFERENCES} repository files.`,
    );
  }
  for (const reference of value) {
    exactKeys(reference, REFERENCE_KEYS, 'proposal reference');
    assertNonSensitiveRepositoryPath(reference.path, 'Reference path');
    if (typeof reference.sha256 !== 'string' || !SHA256_PATTERN.test(reference.sha256)) {
      fail(
        'CONVERSATION_TASK_PROPOSAL_REFERENCE_INVALID',
        'Each reference sha256 must be a lowercase SHA-256 digest.',
      );
    }
  }

  // Read-only contracts accept repository evidence outside write-profile roots
  // while applying the same bounded, traversal-safe path canonicalization.
  const canonical = compileForgeTaskExecutionContract({
    prompt: goal,
    actionCeiling: 'read-only',
    ownedPaths: value.map((reference) => reference.path),
    taskProfiles: ['read-only-review'],
  }).ownedPaths;
  const byPath = new Map(value.map((reference) => [portablePath(reference.path), reference.sha256]));
  return canonical.map((path) => ({ path, sha256: byPath.get(path) }));
}

export function isCurrentProjectWriterScope(scope) {
  return scope?.taskProfile === 'project-files' && scope.scopeRoot === 'current-project'
    && Array.isArray(scope.ownedPaths) && scope.ownedPaths.length === 0;
}

export function conversationWriterScopeOwnsPath(scope, candidate) {
  if (isCurrentProjectWriterScope(scope)) {
    // This configuration marker never becomes a model-owned '.' or wildcard.
    // Resolution and symlink confinement remain enforced by the workspace FS.
    try {
      normalizeForgeTaskOwnedPaths([candidate]);
      assertNonSensitiveRepositoryPath(candidate, 'Proposed path');
      return true;
    } catch { return false; }
  }
  return scope.ownedPaths.some(root => isForgeTaskOwnedPath(candidate, root));
}

function validateWriterScopes(value) {
  if (!Array.isArray(value) || value.length > TASK_PROFILES.length) {
    fail(
      'CONVERSATION_TASK_WRITER_SCOPES_INVALID',
      `writerScopes must be an array containing at most ${TASK_PROFILES.length} entries.`,
    );
  }
  const profiles = new Set();
  return value.map((scope) => {
    exactKeys(scope, Object.hasOwn(scope, 'scopeRoot') ? [...WRITER_SCOPE_KEYS, 'scopeRoot'] : WRITER_SCOPE_KEYS, 'writer scope');
    if (profiles.has(scope.taskProfile)) {
      fail('CONVERSATION_TASK_WRITER_SCOPES_INVALID', 'Writer scope taskProfile values must be unique.');
    }
    profiles.add(scope.taskProfile);
    if (Object.hasOwn(scope, 'scopeRoot')) {
      if (!isCurrentProjectWriterScope(scope)) {
        fail('CONVERSATION_TASK_WRITER_SCOPES_INVALID', 'Only the trusted project-files scope can name the current project root.');
      }
      return { taskProfile: 'project-files', scopeRoot: 'current-project', ownedPaths: [] };
    }
    if (!Array.isArray(scope.ownedPaths)) {
      fail('CONVERSATION_TASK_WRITER_SCOPES_INVALID', 'Writer scope ownedPaths must be an array.');
    }
    for (const ownedPath of scope.ownedPaths) {
      assertNonSensitiveRepositoryPath(ownedPath, 'Writer scope path');
    }
    const contract = compileForgeTaskExecutionContract({
      prompt: 'Configured conversation writer scope',
      actionCeiling: 'workspace-write',
      ownedPaths: scope.ownedPaths,
      taskProfiles: [scope.taskProfile],
    });
    return {
      taskProfile: scope.taskProfile,
      ownedPaths: contract.ownedPaths,
    };
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

export function compileConversationTaskProposal(input, contractOptions = {}) {
  if (!isPlainObject(input)) {
    fail('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', 'Conversation task proposal input must be a plain object.');
  }
  const expectedInputKeys = [...INPUT_KEYS,
    ...(Object.hasOwn(input, 'promptText') ? ['promptText'] : []),
    ...(Object.hasOwn(input, 'actionCeiling') ? ['actionCeiling'] : []),
    ...(Object.hasOwn(input, 'formatMaintenanceSupported') ? ['formatMaintenanceSupported'] : []),
  ];
  exactKeys(input, expectedInputKeys, 'conversation task proposal input');
  const actionCeiling = Object.hasOwn(input, 'actionCeiling') ? input.actionCeiling : 'workspace-write';
  if (!['workspace-write', 'git-checkpoint', 'release'].includes(actionCeiling)) {
    fail('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', 'Proposal action ceiling must be a server-authorized production action.');
  }
  if (Object.hasOwn(input, 'formatMaintenanceSupported') && typeof input.formatMaintenanceSupported !== 'boolean') {
    fail('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', 'Format maintenance capability must be a server-owned boolean.');
  }
  exactKeys(input.proposal, [...PROPOSAL_KEYS,
    ...(Object.hasOwn(input.proposal, 'reviewContractSource') ? ['reviewContractSource'] : [])], 'proposal');

  const goal = normalizeDisplayText(input.proposal.goal);
  if (!Array.isArray(input.proposal.ownedPaths)) {
    fail('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', 'proposal.ownedPaths must be an array.');
  }
  if (!Array.isArray(input.proposal.taskProfiles)) {
    fail('CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID', 'proposal.taskProfiles must be an array.');
  }
  if (input.proposal.taskProfiles.includes(FRONTEND_FORMAT_MAINTENANCE_PROFILE)) {
    fail('CONVERSATION_TASK_PROPOSAL_PROFILE_FORBIDDEN', 'The model cannot declare a format-maintenance strategy.');
  }
  for (const ownedPath of input.proposal.ownedPaths) {
    assertNonSensitiveRepositoryPath(ownedPath, 'Proposed path');
  }

  const references = validateReferences(input.proposal.references, goal);
  let dualReview = contractOptions.dualReview;
  if (Object.hasOwn(input.proposal, 'reviewContractSource')) {
    const reference = references.find((item) => item.path === input.proposal.reviewContractSource);
    if (reference === undefined) fail('CONVERSATION_REVIEW_REFERENCE_INVALID', 'The requested review contract must be an actually read, hashed reference.');
    dualReview = { sourcePath: reference.path, sha256: reference.sha256 };
  }
  if (contractOptions.backendTestBindings !== undefined) {
    const sourceReferences = new Map(references.map(reference => [reference.path, reference.sha256]));
    if (!Array.isArray(contractOptions.backendTestBindings)
      || contractOptions.backendTestBindings.some(binding => !binding
        || sourceReferences.get(binding.testPath) !== binding.testSha256
        || !Array.isArray(binding.coveredPaths)
        || binding.coveredPaths.some(file => !sourceReferences.has(file))
        || (Object.hasOwn(binding, 'moduleDependencies')
          && (sourceReferences.get(`${binding.module}/pom.xml`) !== binding.testPomSha256
            || !Array.isArray(binding.moduleDependencies)
            || binding.moduleDependencies.some(dependency => !dependency
              || sourceReferences.get(`${dependency.module}/pom.xml`) !== dependency.pomSha256))))) {
      fail('CONVERSATION_TEST_BINDING_REFERENCE_INVALID', 'Focused test bindings must name this proposal\'s verified test, covered source and dependency references.');
    }
  }
  const writerScopes = validateWriterScopes(input.writerScopes);
  const prompt = input.promptText ?? goal;

  // Actual write paths and declared consumer impact establish layer scope.
  // A page or API mentioned as context is not evidence of a change to that layer.
  // Keep all other trusted-prompt obligations (including security, shared
  // contracts and cross-layer CRUD); none can be subtracted by the model.
  const declared = compileForgeTaskExecutionContract({
    prompt,
    actionCeiling,
    ownedPaths: input.proposal.ownedPaths,
    taskProfiles: input.proposal.taskProfiles,
  });
  let inferred;
  try {
    inferred = compileForgeTaskExecutionContract({
      prompt,
      actionCeiling,
      ownedPaths: input.proposal.ownedPaths,
    });
  } catch (error) {
    // Recognized paths such as a Required Spec need not imply a layer. The
    // declared compilation above has already validated its explicit profiles.
    if (error?.code !== 'CONTRACT_TASK_PROFILE_UNKNOWN'
      && !(error?.code === 'CONTRACT_UNKNOWN_WRITE_PATH' && declared.taskProfiles.includes('project-files'))) throw error;
    inferred = declared;
  }
  let contextualDatabaseOnly = false;
  if (declared.taskProfiles.includes('frontend-admin')
    && !declared.taskProfiles.some(profile => ['backend', 'database', 'migration'].includes(profile))
    && inferred.taskProfiles.includes('database')) {
    // SQL/menu file references and route names are context for a UI-only scope.
    // Conservatively retain database objects even when the action is not next
    // to the object. The compiler still handles negation and completed context;
    // declarations and actual database/backend paths remain binding.
    const databaseWork = prompt.split(/[。！？!?;；\n，,]/u).filter(clause =>
      /数据库|数据表|表结构|持久化|\b(?:database|schema|ddl)\b|(?:新增|增加|创建|修改|调整|修复|优化|重构|删除|执行|运行)\s*(?:现有|已有|新的)?\s*(?:索引|SQL\b)|\b(?:add|create|alter|modify|change|update|drop|migrate|optimize|fix|run|execute)\s+(?:(?:an?|the|existing)\s+)?(?:table|index|sql)\b/iu.test(clause));
    contextualDatabaseOnly = databaseWork.length === 0 || !compileForgeTaskExecutionContract({
      prompt: databaseWork.join('\n'),
      actionCeiling,
      ownedPaths: inferred.ownedPaths,
    }).taskProfiles.includes('database');
  }
  const inferredProfiles = inferred.taskProfiles.filter((profile) =>
    (profile !== 'database' || !contextualDatabaseOnly)
      && (!['backend', 'frontend-admin'].includes(profile) || declared.taskProfiles.includes(profile)));
  const taskProfiles = [...new Set([...inferredProfiles, ...declared.taskProfiles])];
  if (input.formatMaintenanceSupported === true
    && userRequestedFormatMaintenance(input.promptText, inferred.ownedPaths, references)) {
    taskProfiles.push(FRONTEND_FORMAT_MAINTENANCE_PROFILE);
  }
  const contract = compileForgeTaskExecutionContract({
    prompt,
    actionCeiling,
    ownedPaths: inferred.ownedPaths,
    taskProfiles,
  }, { ...contractOptions, ...(dualReview === undefined ? {} : { dualReview }) });

  const applicableScopes = writerScopes
    .filter((scope) => isCurrentProjectWriterScope(scope) || contract.taskProfiles.includes(scope.taskProfile));
  const deniedPaths = contract.ownedPaths.filter((candidate) =>
    !applicableScopes.some((scope) => conversationWriterScopeOwnsPath(scope, candidate)));
  if (deniedPaths.length > 0) {
    fail(
      'CONVERSATION_TASK_SCOPE_DENIED',
      `Proposed repository paths are outside configured writer scopes: ${deniedPaths.join(', ')}.`,
      { deniedPaths: Object.freeze([...deniedPaths]) },
    );
  }

  const payload = { goal, contract, references };
  return deepFreeze({ ...payload, proposalDigest: digest(payload) });
}
