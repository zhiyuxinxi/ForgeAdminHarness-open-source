import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify,
  compileForgeTaskExecutionContract,
  isActionWithinCeiling,
  validateForgeTaskExecutionContract,
  verificationScopeForContract,
} from './forge-task-execution-contract.mjs';
import { validateSourceTransition } from './taskspace-policy.mjs';

export const PROTECTED_EXECUTION_SCHEMA_VERSION = 1;
export const FORGE_CONTRACT_CONTINUATION_SUPPORTED = true;
export const FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED = true;
export const FORGE_CHANGED_VERIFICATION_SUPPORTED = true;
export const FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED = true;
export const FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED = true;
export const PROTECTED_EXECUTION_STATE_SCHEMA_VERSION = 3;
export const EXECUTION_POLICY_SCHEMA_VERSION = 1;
export const MAX_CLAIMABLE_PROMPT_BYTES = 1024 * 1024;
export const EXECUTION_CONTEXT_TTL_MS = 15 * 60 * 1000;
export const MAX_EXECUTION_STATE_BYTES = 2 * 1024 * 1024;
export const PROTECTED_EXECUTION_RECOVERY_MODE = 'expired-unsubmitted-exact-context-v1';
export const PROTECTED_EXECUTION_READBACK_SCHEMA = 'forge-protected-session-readback/v1';
const LEGACY_FRONTEND_PROFILE_CATALOG_VERSION = '2026.09.03.4';
const FRONTEND_TYPECHECK_PROFILE = 'frontend-admin-typecheck';
export const EXECUTION_RECOVERY_PERMIT_TTL_MS = 5 * 60 * 1000;
export const EXECUTION_RECOVERY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const PROJECT_SLUG_PATTERN = TASK_ID_PATTERN;
const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const ACTOR_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const DSH_ID_PATTERN = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AUTHORIZATION_REFERENCE_PATTERN = /^[^\0\r\n]{1,256}$/u;
const MAX_RECOVERY_READBACK_AGE_MS = 30 * 1000;
const EXECUTION_STATE_LOCK_DEAD_OWNER_GRACE_MS = 30 * 1000;
const MAX_EXECUTION_STATE_LOCK_BYTES = 4096;
const EXECUTION_STATE_FLOCK_EXECUTABLE = '/usr/bin/flock';
const EXECUTION_STATE_FLOCK_CONFLICT_EXIT_CODE = 75;
const MAX_EXECUTION_RECOVERY_TOMBSTONES = 512;
const EXECUTION_CLASSIFICATIONS = new Set([
  'claimable-text',
  'read-only-image',
  'read-only-oversized',
  'read-only-subagent',
  'read-only-unknown',
]);
const DSH_PROMPT_ROUTES = new Set(['session.prompt', 'subagent.prompt']);
const PRODUCTION_TASK_ACTION_CEILINGS = new Set([
  'workspace-write',
  'git-checkpoint',
  'release',
]);
const PREFIXED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class ProtectedExecutionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', `${label} must be an object.`);
  }
  const admitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!admitted.has(key)) {
      throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', `${label} contains unsupported field ${key}.`);
    }
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function optionalString(value, pattern, label) {
  if (value === undefined || value === null) return null;
  return requiredString(value, pattern, label);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function digestProductionTaskAuthorityBinding({
  projectSlug,
  taskId,
  actorUserId,
  actorUsername,
  conversationId,
  dshSessionId,
  route,
  rpcId,
  promptDigest,
  sourceCommit,
  workspaceFingerprint,
  caseFamily,
  productionAuthorityId,
  controllerGrantDigest,
  contractId,
  actionCeiling,
  ownedPaths,
}) {
  return sha256(Buffer.from(canonicalStringify({
    schemaVersion: 1,
    authorityClass: 'production-task-writer',
    projectSlug,
    taskId,
    actorUserId,
    actorUsername,
    conversationId,
    dshSessionId,
    route,
    rpcId,
    promptDigest,
    sourceCommit,
    workspaceFingerprint,
    caseFamily,
    productionAuthorityId,
    controllerGrantDigest,
    contractId,
    actionCeiling,
    ownedPaths,
  }), 'utf8'));
}

function canonicalTextContent(content) {
  return JSON.stringify(content.map((part) => ({ type: 'text', text: part.text })));
}

export function digestDirectUserTextContent(content) {
  if (!Array.isArray(content)
    || content.some((part) => !part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string')) {
    throw new ProtectedExecutionError('EXECUTION_TEXT_INVALID', 'Direct user text content is invalid.');
  }
  return sha256(Buffer.from(canonicalTextContent(content), 'utf8'));
}

const GLOBAL_READ_ONLY_MUTATION = /\b(?:implement|fix|modify|change|add|create|delete|refactor|build)\b|(?:修复|修改|新增|创建|删除|去掉|移除|撤回|重构|实现|同步|解决冲突|发布|发版|部署|上线|改代码|写代码)/iu;
const EXPLICIT_GLOBAL_READ_ONLY_ANALYSIS = /^(?:(?:本轮|本次|当前|现在|这轮|此次)\s*)?(?:请\s*)?(?:(?:只读)(?!\s*角色)(?:地|方式)?(?:分析|检查|审查|评审|查看|解释|讨论)?|(?:只|仅)(?:(?:给出?|提供)\s*[^，,。；;！？!?\r\n]{0,24}方案|(?:做|进行)?(?:分析|检查|审查|评审|查看|解释|讨论)))/u;
const BARE_READ_ONLY_ANALYSIS = /^(?:请\s*)?(?:分析|检查(?!范围\s*(?:严格)?(?:按|仅限于?))|审查|评审|查看|解释|讨论)(?:一下)?/u;
const DIRECT_IMPLEMENTATION_CLAUSE = /^(?:(?:现在|本次|本轮|这次|这轮)\s*)?(?:请\s*)?(?:在(?:(?:本|当前|这个)(?:会话|对话)(?:中)?|(?:既有|现有)[^，,。；;！？!?\r\n]{1,128}中)\s*)?(?:(?:直接|继续|开始|完成|分别|再|只|仅)\s*)*(?:(?:检查|核对|诊断|定位|审查)并)?(?:实施|实现|修复|修正|纠正|修|修改|新增|增加|创建|删除|去掉|移除|撤回|重构|同步|改代码|写代码)(?![^，,。；;！？!?\r\n]*(?:方案|讨论|是否|能否))/u;
const AUTHORIZED_IMPLEMENTATION_CLAUSE = /^(?:(?:本轮|本次|当前)\s*)?(?:已获授权|已授权|我(?:现在)?明确授权你|我授权你)(?:先\s*(?:prepare|准备)\s*[，,]\s*(?:再|然后|接着)\s*(?:只|仅)?)?(?:(?:只|仅)\s*)*(?:编写|实施|实现|修复|修改|新增|创建|修)(?![^，,。；;！？!?\r\n]*(?:方案|讨论|是否|能否))/u;
const READ_ONLY_EVIDENCE_CLAUSE = /^(?:请\s*)?(?:只读(?:取)?|仅读取)(?:(?:旧|历史|原|已有|该|这份|同一份)(?:的)?)?(?:回执|日志)(?:即可)?$/u;
// A bounded evidence read can accompany a direct verification-and-checkpoint request.
const BOUNDED_EVIDENCE_READ_CLAUSE = /^(?:请\s*)?(?:只读取|仅读取)(?:判定)?本批(?:所需的)?证据(?:即可)?$/u;
const READ_ONLY_STATUS_CLAUSE = /^(?:请\s*)?(?:只读(?:取)?|仅读取)(?:当前|最终|现有)?(?:状态记录|状态|版本)(?:即可)?$/u;
// Comma splitting can leave a field attribute before its closing parenthesis
// or Markdown cell delimiter. It does not constrain a separately requested implementation.
const READ_ONLY_FIELD_ATTRIBUTE = /^只读\s*[)）|]$/u;
// A read-only UI subject followed by its display behavior describes the product,
// not the agent's turn. The implementation check below is still required, and
// task qualifiers, inspection verbs, code/data reads and global bans stay restrictive.
const READ_ONLY_UI_PROPERTY_CLAUSE = /^只读(?:页面|表单|详情(?:页|弹窗|浮层)?|审批(?:页|表单|详情)?|视图|弹窗|浮层|抽屉|控件|字段)(?:\s*[/、和及与]\s*(?:页面|表单|详情(?:页|弹窗|浮层)?|审批(?:页|表单|详情)?|视图|弹窗|浮层|抽屉|控件|字段))*\s*(?:沿用?|使用|复用|采用|保持|保留|展示|显示|呈现|默认|已有\s*[0-9]{1,5}\s*(?:个)?输入控件$|禁止编辑|不可编辑|不允许编辑|禁用|隐藏|不显示|不提供编辑|(?:不应该?|不能)(?:变成|显示为|呈现为))/u;
// A named file's recorded digest is a fact about that reference, not a command
// making the whole turn read-only. It grants no authority on its own; explicit
// turn restrictions and the separate action-intent checks still apply.
const READ_ONLY_FILE_DIGEST_FACT = /^只读(?:需求|参考|配置|源)?文件\s+[A-Za-z0-9_./\\@+-]{1,512}\.[A-Za-z0-9]{1,12}\s+的\s+SHA-?256\s*(?:仍为|为|是)\s*[a-f0-9]{64}$/iu;
// Scope source inspection inside an authorized implementation; a source-reading
// request on its own and an explicit global write prohibition remain read-only.
// "Reference X read-only" scopes the reference operation, regardless of X's
// name or path. Only a separate direct implementation clause activates this
// exception; whole-turn qualifiers and global write prohibitions still win.
const READ_ONLY_SOURCE_REFERENCE_CLAUSE = /^(?:请\s*)?(?:(?:只读取|仅读取)(?:直接)?相关(?:的)?(?:源码|源文件|参考源码)(?:即可)?|(?:只读|仅读)\s*(?:参考|引用|references?\b)[^，,。；;！？!?\r\n]{1,256}|(?:只读(?:取)?|仅读(?:取)?)(?:现有|已有|实际|相关)?\s*`?[\w./\\-]+\.[A-Za-z0-9]{1,12}`?(?:\s*[、和与]\s*`?[\w./\\-]+\.[A-Za-z0-9]{1,12}`?)*)$/iu;
// Reading a method's source context is local to the implementation, not a
// whole-turn restriction. It still needs independent file-write authorization.
const READ_ONLY_METHOD_CONTEXT_CLAUSE = /^(?:请\s*)?(?:只读(?:取)?|仅读(?:取)?)(?:这些|上述|相关|指定)?(?:方法|函数|调用方|调用点|接口)(?:前后)?(?:的)?(?:必要)?上下文(?:[和及与](?:相关)?(?:POM|配置|源码))?$/u;
const SCOPED_FILE_WRITE_AUTHORIZATION = /^(?:本轮|本次|当前)(?:明确)?允许(?:修改|新增|创建)(?:下列|以下)/u;
// Bound implementation/reference inspection to its source, not the whole turn.
// Database/data reads and whole-turn qualifiers are deliberately excluded.
const READ_ONLY_IMPLEMENTATION_CONTEXT_CLAUSE = /^(?:请\s*)?(?:只读(?:取)?|仅读(?:取)?)(?:(?:这些|上述|相关|指定)(?:直接|相关|必要)?|(?:所需|必要)(?:的)?(?:局部|相关)?)(?:实现|源码|源文件|helper\b|方法|函数|请求|响应|字典|Excel|API|接口|合同)(?:合同)?(?:\s*[和及与、/]\s*(?:现有|相关|直接)?(?:实现|源码|源文件|helper\b|方法|函数|请求|响应|字典|Excel|API|接口|合同)(?:合同)?)*(?:即可)?$/iu;
const EXPLICIT_FILE_WRITE_SCOPE = /^(?:本轮|本次|当前)写入(?:只|仅)限(?:于)?(?:原有|以下|下列|这)?(?:[1-9][0-9]{0,2}|[一二两三四五六七八九十]+)?个?文件(?=[：:。；;！!\s]|$)/u;
// A named UI file's local style/semantics edit is an explicit bounded write.
// The sentence-level caller excludes questions, quotations and fenced examples.
const NAMED_COMPONENT_STYLE_WRITE_SCOPE = /^(?:本轮|本次|当前)(?:只|仅)可修改(?:上述|该|这个)?\s*`?[A-Za-z0-9_./-]{1,512}\.(?:vue|jsx|tsx|css|scss|less)`?\s*(?:的)?(?:直接相关)?(?:局部)?(?:样式|语义)(?:[/和及与、](?:样式|语义))*(?=[，,。；;！!\s]|$)/u;
const READ_ONLY_COMPONENT_STYLE_CONTEXT = /^(?:请\s*)?(?:只读取|仅读取)(?:此|该|这个|上述|相关|指定)组件(?:的)?(?:直接)?相关(?:的)?(?:模板|样式)(?:[/和及与、](?:模板|样式))*(?:[和及与、](?:项目)?(?:已有|现有)?主题\s*tokens?(?:[/和及与、](?:对应)?(?:共享)?\s*tab\s*样式)?)?(?:即可)?$/iu;
// Comparing a named implementation read-only is scoped to that source, only
// when another direct clause authorizes implementation. Whole-turn read-only
// qualifiers and data inspection are deliberately excluded.
const READ_ONLY_SOURCE_COMPARISON_CLAUSE = /^(?:请\s*)?(?:只读|仅读)(?:核对|比对)(?:原|现有|已有|实际|相关)(?:的)?[^，,。；;！？!?\r\n]{0,128}(?:源码|源文件|helper\b|参考实现|生产接收方)(?:即可)?$/iu;
// An explicit initialization step can be followed by a read of its result.
// Do not infer a writer from a status read alone or a discussion of initialization.
const METADATA_INITIALIZATION_CLAUSE = /^(?:(?:请\s*)?按(?:原|上述|已确认)(?:请求|要求)完成[^：:\r\n]{1,128}[：:]\s*|(?:(?:请|先|继续|直接|开始)\s*)*)初始化(?:(?:当前|本次|该)?(?:交付状态|状态记录|元数据|fixture))?$/iu;
const SOURCE_INSPECTION_FINDING = /^只读(?:检查|核对)(?:当前|现有)[A-Za-z_][A-Za-z0-9_.—–-]{0,95}[：:]\s*(?!请|是否|确认|验证|核对|检查|分析|列出|不要|不得|禁止)[^，,。；;！？!?\r\n]{1,80}(?:不允许|允许|不能|可以|存在|不存在|为空|超过)(?:[^，,。；;！？!?\r\n]*)$/u;
// A source review's confirmed repair findings describe evidence. Only an
// independent implementation request enables this exception; turn bans still win.
const READ_ONLY_SOURCE_REVIEW_FINDING = /^(?:当前\s*)?只读(?:源码|源文件)(?:审阅|审查|检查|核对)(?:已)?(?:确认|发现)(?:了)?(?:以下|下列|[一二两三四五六七八九十百0-9]{1,3}(?:项|个))(?:问题)?(?:需要|仍需|需|待)(?:你)?(?:在(?:原|当前|既有)候选上)?修复(?:[：:]\s*(?:第[一二两三四五六七八九十0-9]{1,3})?)?$/u;
const DIRECT_CANDIDATE_RELEASE_CLAUSE = /^(?:现在\s*)?(?:请\s*)?(?:发布|发版|部署|上线)(?:当前|本轮|本次|本对话)(?:已完成的)?[^，,。；;！？!?\r\n]{0,80}候选[。！!\s]*$/u;
// A completed diagnostic statement reports evidence; it does not constrain a
// separate explicit implementation request. Global write prohibitions still win.
const COMPLETED_READ_ONLY_DIAGNOSTIC = /^(?:只读(?:取)?|仅读取)(?:[^，,。；;！？!?\r\n]{1,80}(?:已经|已)(?:定位|确认|发现|查明|验证|证明)|(?:基线)?(?:比对|对比)(?:记录)?\s*#?\d{1,12}\s*(?:确认|证明|表明|显示)|(?:核对|比对)(?:现有|当前)(?:的)?[A-Za-z_][A-Za-z0-9_.]{0,63}[：:]\s*[A-Za-z_][A-Za-z0-9_.]*\s*=)/u;
// Insufficient read evidence is a statement about proof, not an instruction to
// stop an independently authorized repair. Imperatives and turn qualifiers are
// excluded; this exception neither grants writes nor changes owned file scopes.
const READ_ONLY_EVIDENCE_LIMIT_STATEMENT = /^(?:只读(?:取)?|仅读取)(?:资源|源文件|源码|文件|日志|回执|报告)[^，,。；;！？!?\r\n]{0,80}(?:不能|无法|不足以)(?:证明|确认|说明)[^，,。；;！？!?\r\n]{0,40}(?:已(?:经)?(?:修(?:复|好)?|通过|完成|生效|解决)|修复(?:成功|完成|生效)|验证通过)$/u;
export const CHANGED_VERIFICATION_CLAUSE = /^(?:请\s*)?(?:只|仅)(?:检查|验证|测试|扫描)(?:(?:本次|这次|当前|此次|这轮|本轮|本批|这批)?(?:变更|改动|新增(?:[、及和与]?修改)?|(?:改|修改)了(?:的)?(?:地方|部分|文件|代码)|修改)|(?:本次|这次|当前|此次|这轮|本轮|本批|这批)(?:及|和|与)(?:直接)?受影响(?:的)?(?:部分|范围)|(?:对应|相关)(?:的)?(?:测试类|测试|用例)|(?:真实|直接)?受影响(?:的)?(?:部分|范围|文件|代码|内容))(?:及|和|与|或|的|范围|直接影响(?:的)?(?:范围|部分|文件|代码)|(?:即可)?$)/u;
// A completed inventory or its counted two-commit sample describes evidence.
// It does not authorize writes, or exempt current-turn/read-only instructions.
const READ_ONLY_INVENTORY_FACT = /^只读盘点(?:已(?:完成|结束)|(?:选取|覆盖|统计)(?:上述|前述)两(?:次)?提交之间(?:变更|差异)(?:的)?\s*[1-9][0-9]{0,5}\s*个(?:生产)?\s*(?:[A-Za-z][A-Za-z0-9+#.-]{0,23}\s*)?文件)$/u;
// An explicitly non-completion candidate heading describes the supplied inventory,
// not a new inspection-only instruction. Independent implementation is required.
const READ_ONLY_INVENTORY_CANDIDATE_HEADING = /^(?:(?:本次|本轮|当前|此次)\s*)?只读盘点(?:页面|文件|接口)?候选[（(](?:不是完成证明|不代表(?:已)?完成)[）)][：:]$/u;
// Preserve business read-only states without changing the operator's task scope.
const READ_ONLY_BUSINESS_STATE_RULE = /^只读(?:归档|审计)(?:[/、及和与](?:归档|审计|审批|库存流水))*(?:等)?(?:真实)?(?:业务)?语义限制(?:按|依据)(?:现有|既有)业务(?:核定|处理|保留)$/u;
// Visibility is not permission to act on a business record. This limitation
// does not itself authorize implementation; the existing direct-write check does.
const READ_ONLY_BUSINESS_ACCESS_LIMIT = /^只读(?:范围(?:对齐)?不扩大|可见不自动获得(?:他人)?)(?:办理|签署|修改)(?:(?:、|或|及|和)(?:办理|签署|修改))*(?:资格|权限)$/u;
// An adjacent end-user view requirement can constrain the business record UI,
// while the separate implementation request still authorizes code changes.
const RECIPIENT_VIEW_REQUIREMENT = /^(?:使|让)[^，,。；;！？!?\r\n]{0,36}(?:用户|收件人|角色|成员)[^，,。；;！？!?\r\n]{0,48}(?:查看|阅读)[^，,。；;！？!?\r\n]{0,48}(?:流程|申请|记录|详情)[^，,。；;！？!?\r\n]{0,16}$/u;
const RECORD_READ_ONLY_BEHAVIOR = /^只读(?:当前|该|本条|这条)(?:业务)?(?:记录|申请|详情)$/u;
const POST_IMPLEMENTATION_RELEASE_CLAUSE = /(?:^|[，,])\s*(?:请\s*)?(?:完成后(?:受控)?提交(?:代码)?并|(?:检查|验证|测试)通过后(?:再)?(?:受控)?)(?:发布|发版|部署|上线)(?=到|[、，,。；;！!\s]|$)/u;
const CONTINUED_DELIVERY_CLAUSE = /^(?:(?:请\s*)?继续(?:当前|原)(?:任务|目标)[：:]\s*)?(?:请\s*)?(?:沿(?:着)?(?:当前|原|现有)(?:任务|候选|范围))?(?:继续|完成|执行)(?:检查点|提交(?:代码)?|(?:受控)?(?:发布|发版|部署|上线))(?=[、，,。；;！!\s]|$)/u;
const GLOBAL_READ_ONLY_NEGATION = /^(?:(?:但|但是|不过)\s*)?(?:(?:本轮|本次|当前|现在|这轮|此次)\s*)?(?:请\s*)?(?:不要|不得|禁止|暂不|先不|不)\s*(?:(?:做|进行)\s*(?:任何\s*)?(?:修改|改动|写入|实现|执行)|(?:修改|改动|改|编辑|写入|写|实现|执行)\s*(?:(?:任何|全部|所有)\s*)?(?:代码|源码|文件|项目|仓库|内容|命令|操作|变更)?)(?:了|即可)?$/u;
const GLOBAL_READ_ONLY_ENGLISH = /^(?:please\s+)?(?:read[- ]?only\b|(?:(?:only\s+)?(?:review|analy[sz]e|inspect|explain|audit)\b)(?!.*\b(?:implement|fix|modify|change|add|create|delete|refactor|build)\b)|(?:(?:do not|don't|must not|never)\s+(?:edit|write|change|modify|implement|execute)(?:\s+(?:anything|all|any\s+(?:code|files?)|the\s+(?:code|files?)))?))\s*[.!]?$/iu;

// "查看详情" can name the application's interaction rather than an AI inspection.
// Keep questions and explicit inspection-only clauses outside this imperative form.
// Preserving other behavior limits that UI change; it does not cancel the request.
export function hasUiInteractionWriteIntent(prompt) {
  return typeof prompt === 'string'
    && /^(?:请\s*)?(?:查看|打开)详情(?:页|页面|弹窗)?(?:时)?\s*(?:默认)?(?:显示|选中|切换到|定位到)[^，,。；;！？?\r\n]{0,64}(?:tab\s*页|标签页|页签)(?:[，,。；;]\s*(?:并)?(?:保持(?:其他|其余|其它)(?:行为|功能)|(?:其他|其余|其它)(?:行为|功能)保持)不变)?[。！!\s]*$/iu.test(prompt.trim());
}

export const QUESTION_REQUEST = /^(?:(?:请问|我想知道)[，,\s]*)?(?:如何|怎样|怎么|能否|是否|能不能)|^(?:how (?:to|can|do)|can (?:you|we|I))\b/iu;
export const ATTRIBUTED_RELEASE_SENTENCE = /(?:引用(?:内容)?|示例|文档(?:示例|说明)|日志(?:显示|记录|输出)?|工具(?:输出|结果)|提示(?:文字|文案)?)(?:为|是|中|称|写着|提到|显示|记录|说明|[：:，,])[^。；;！？!?\r\n]*(?:发布|发版|部署|上线)/u;
// Scoped closeout lists may save the candidate, then integrate and release it.
const DIRECT_SUBMIT_INTEGRATE_RELEASE = /(?:^|[，,])\s*(?:现在\s*)?(?:请\s*)?(?:在(?:本|当前|这个)(?:会话|对话)(?:中)?\s*)?(?:(?:继续|完成)(?:后)?\s*(?:(?:剩余|必要)(?:的)?)?\s*(?:受控)?|(?:只|仅)处理(?:仍)?必要的(?:治理、)?|(?:(?:先\s*)?(?:通过平台受控能力)?完成|(?:继续)?(?:(?:检查|核对|诊断|定位|审查)并)?(?:修改|修复)|(?:沿[^，,。；;！？!?\r\n]{1,48})?继续)[^。；;！？!?\r\n]{1,240}(?:并|后|[，,]\s*(?:正常|随后|接着|然后)(?:受控)?|、(?:受控)?))(?:直接)?(?:受控)?(?:提交(?:代码)?|保存)、?(?:受控)?集成(?:、|[，,]\s*|并|和|以及|及|与)(?:受控)?(?:发布|发版|部署|上线)(?:(?:并(?:回收|确认|核对)(?:真实)?(?:终态|结果))|(?:(?:和|以及)(?:真实)?终态回收))?(?=到|[，,。；;：:！!\s]|$)/u;

// Use the same explicit closeout instruction for execution eligibility and
// release intent. Keep sentence terminators so a question cannot become a command.
export function hasDirectSubmitIntegrateRelease(prompt) {
  const direct = prompt.replace(/```[^]*?```|~~~[^]*?~~~/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  return (direct.match(/[^。；;！？!?]+(?:[。；;！？!?]|$)/gu) ?? []).some((sentence) => {
    const text = sentence.trim();
    return !/[？?]\s*$/u.test(text) && !QUESTION_REQUEST.test(text)
      && !ATTRIBUTED_RELEASE_SENTENCE.test(text) && DIRECT_SUBMIT_INTEGRATE_RELEASE.test(text);
  });
}

// A direct controlled preparation is an operation, not source-write authority.
// Its local verification limit must not downgrade the whole turn to inspection.
export function hasDirectControlledPreparationIntent(prompt) {
  if (typeof prompt !== 'string') return false;
  return prompt.split(/[。；;\r\n]+/u).some(sentence => {
    const text = sentence.trim();
    return !/[？?]/u.test(text)
      && /^(?:现在\s*)?(?:请\s*)?(?:使用(?:当前|本次)(?:已接受的)?[^，,。；;！？!?\r\n]{0,64}候选源码[，,]\s*通过(?:现有|已有)受控\s*(?:forge-release\s+)?prepare\b|(?:继续(?:执行|运行)?|执行|运行)(?:当前|本次)[^，,。；;！？!?\r\n]{0,64}(?:受控\s*(?:forge-release\s+)?prepare\b|任务的发布后受控运行补验(?=[，,。；;！!\s]|$)))/u.test(text);
  });
}

export function hasGlobalReadOnlyIntent(prompt) {
  if (typeof prompt !== 'string') return false;
  // Retain the source line when punctuation separates a business property
  // from its subject. A table cell or record-state predicate is not a turn scope.
  const contextualClauses = prompt.split(/[\r\n]+/u).flatMap((line) => {
    const table = /^\s*\|.*\|.*\|\s*$/u.test(line);
    const cells = table ? line.trim().slice(1, -1).split('|') : [];
    const turnRestriction = cells.some(cell => cell.split(/[，,。；;！？!?]+/u).some(part => {
      const text = part.trim();
      return GLOBAL_READ_ONLY_NEGATION.test(text) || GLOBAL_READ_ONLY_ENGLISH.test(text)
        || (/^(?:本轮|本次|当前|现在|这轮|此次)/u.test(text) && EXPLICIT_GLOBAL_READ_ONLY_ANALYSIS.test(text));
    }));
    return [...line.matchAll(/[^，,。；;！？!?]+/gu)].map(match => {
      const text = match[0].trim();
      const before = line.slice(0, match.index);
      const cellSubject = table ? before.slice(before.lastIndexOf('|') + 1).replace(/[，,\s]+$/u, '').trim() : '';
      const stateSubject = before.replace(/[，,\s]+$/u, '').split(/[。；;！？!?]/u).at(-1).trim();
      const businessReadOnly = /^只读/u.test(text) && !turnRestriction
        && (READ_ONLY_UI_PROPERTY_CLAUSE.test(text)
          || READ_ONLY_BUSINESS_STATE_RULE.test(text)
          || READ_ONLY_BUSINESS_ACCESS_LIMIT.test(text)
          || (table && cellSubject && !/^(?:请|本轮|本次|当前|现在|这轮|此次|本任务)/u.test(cellSubject))
          // Keep this bounded object-responsibility question attached to its
          // menu subject. The implementation check below still supplies all
          // write authority; mentioning a menu alone exempts no restriction.
          || (/^(?:该|本|当前|上述|这个)菜单(?:直接)?(?:维护|管理)哪些(?:业务)?对象$/u.test(stateSubject)
            && /^只读取哪些共享(?:业务)?对象$/u.test(text))
          || (/^只读$/u.test(text)
            && /(?:记录|单据|表单|字段|控件)\s*(?:置|设(?:置)?为|保持为?)\s*[^，,。；;！？!?]{1,128}$/u.test(stateSubject)));
      return { text, businessReadOnly, turnRestriction };
    }).filter(clause => clause.text);
  });
  const clauses = contextualClauses.map(clause => clause.text);
  // Preserve sentence terminators and attribution prefixes: a quoted file-write
  // scope or a question about it is not implementation authorization.
  const directFileScope = prompt.replace(/```[^]*?```|~~~[^]*?~~~/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  const authorizesFileScope = (directFileScope.match(/[^。；;！？!?]+(?:[。；;！？!?]|$)/gu) ?? [])
    .some(sentence => !/[？?]\s*$/u.test(sentence) && (EXPLICIT_FILE_WRITE_SCOPE.test(sentence.trim())
      || NAMED_COMPONENT_STYLE_WRITE_SCOPE.test(sentence.trim())));
  const authorizesReferenceInspection = authorizesFileScope
    || (directFileScope.match(/[^。；;！？!?]+(?:[。；;！？!?]|$)/gu) ?? []).some(sentence => {
      const text = sentence.trim();
      return !/[？?]\s*$/u.test(text) && (DIRECT_IMPLEMENTATION_CLAUSE.test(text)
        || AUTHORIZED_IMPLEMENTATION_CLAUSE.test(text) || SCOPED_FILE_WRITE_AUTHORIZATION.test(text));
    });
  const authorizesReviewRepair = authorizesReferenceInspection
    || (directFileScope.match(/[^。；;！？!?]+(?:[。；;！？!?]|$)/gu) ?? []).some(sentence => {
      const text = sentence.trim();
      return !/[？?]\s*$/u.test(text) && !QUESTION_REQUEST.test(text)
        && !ATTRIBUTED_RELEASE_SENTENCE.test(text)
        && DIRECT_CANDIDATE_RELEASE_CLAUSE.test(text.split(/[，,]/u)[0]);
    });
  // Keep conditional delivery commands attached to their sentence: questions,
  // quotations and recorded instructions do not authorize continued work.
  const postImplementationRelease = (directFileScope.match(/[^。；;！？!?]+(?:[。；;！？!?]|$)/gu) ?? [])
    .some(sentence => {
      const text = sentence.trim();
      return !/[？?]\s*$/u.test(text) && !QUESTION_REQUEST.test(text)
        && !ATTRIBUTED_RELEASE_SENTENCE.test(text) && POST_IMPLEMENTATION_RELEASE_CLAUSE.test(text);
    });
  const implementing = clauses.some((clause) => DIRECT_IMPLEMENTATION_CLAUSE.test(clause)
    || AUTHORIZED_IMPLEMENTATION_CLAUSE.test(clause)
    || SCOPED_FILE_WRITE_AUTHORIZATION.test(clause)
    || METADATA_INITIALIZATION_CLAUSE.test(clause)
    || CONTINUED_DELIVERY_CLAUSE.test(clause))
    // Keep commas in an explicit "authorize preparation, then repair" sequence.
    // A bounded reference read is still not an implementation authorization.
    || prompt.split(/[。；;！？!?\r\n]+/u)
      .some((sentence) => AUTHORIZED_IMPLEMENTATION_CLAUSE.test(sentence.trim()))
    || hasDirectSubmitIntegrateRelease(prompt) || postImplementationRelease || authorizesFileScope;
  const controlledPreparation = hasDirectControlledPreparationIntent(prompt);
  const verificationCheckpoint = directFileScope.split(/[。；;\r\n]+/u).some(sentence =>
    /^(?:请\s*)?完成[^。；;！？!?\r\n]{1,120}(?:验证|测试)[，,]\s*并(?:通过[^，,。；;！？!?\r\n]{1,32})?保存(?:本地\s*)?(?:Git\s*)?检查点\s*$/iu.test(sentence.trim()));
  if (clauses.some((clause, index) => contextualClauses[index].turnRestriction
    || GLOBAL_READ_ONLY_NEGATION.test(clause)
    || GLOBAL_READ_ONLY_ENGLISH.test(clause)
    || ((EXPLICIT_GLOBAL_READ_ONLY_ANALYSIS.test(clause) || READ_ONLY_SOURCE_REFERENCE_CLAUSE.test(clause)
      || READ_ONLY_METHOD_CONTEXT_CLAUSE.test(clause) || READ_ONLY_IMPLEMENTATION_CONTEXT_CLAUSE.test(clause))
      && !READ_ONLY_FILE_DIGEST_FACT.test(clause)
      && !(verificationCheckpoint && BOUNDED_EVIDENCE_READ_CLAUSE.test(clause))
      && !(authorizesReviewRepair && READ_ONLY_SOURCE_REVIEW_FINDING.test(clause))
      && !((implementing || controlledPreparation) && (CHANGED_VERIFICATION_CLAUSE.test(clause)
        || /^只读原件摘要[0-9a-f]{64}$/u.test(clause)))
      && !(implementing && !READ_ONLY_SOURCE_REVIEW_FINDING.test(clause) && (contextualClauses[index].businessReadOnly
        || CHANGED_VERIFICATION_CLAUSE.test(clause)
        || READ_ONLY_EVIDENCE_CLAUSE.test(clause)
        || READ_ONLY_STATUS_CLAUSE.test(clause)
        || READ_ONLY_FIELD_ATTRIBUTE.test(clause)
        || READ_ONLY_SOURCE_REFERENCE_CLAUSE.test(clause)
        || READ_ONLY_METHOD_CONTEXT_CLAUSE.test(clause)
        || (authorizesReferenceInspection && (READ_ONLY_IMPLEMENTATION_CONTEXT_CLAUSE.test(clause)
          || READ_ONLY_COMPONENT_STYLE_CONTEXT.test(clause)))
        || READ_ONLY_SOURCE_COMPARISON_CLAUSE.test(clause)
        || COMPLETED_READ_ONLY_DIAGNOSTIC.test(clause)
        || READ_ONLY_EVIDENCE_LIMIT_STATEMENT.test(clause)
        || READ_ONLY_INVENTORY_FACT.test(clause)
        || READ_ONLY_INVENTORY_CANDIDATE_HEADING.test(clause)
        || SOURCE_INSPECTION_FINDING.test(clause)
        || (RECORD_READ_ONLY_BEHAVIOR.test(clause)
          && RECIPIENT_VIEW_REQUIREMENT.test(clauses[index - 1] ?? ''))))))) return true;
  return !GLOBAL_READ_ONLY_MUTATION.test(prompt) && !hasUiInteractionWriteIntent(prompt)
    && clauses.some((clause) => BARE_READ_ONLY_ANALYSIS.test(clause));
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readOnlyClassification(route, body, reason, parsed = {}) {
  return Object.freeze({
    schemaVersion: PROTECTED_EXECUTION_SCHEMA_VERSION,
    route,
    classification: route === 'subagent.prompt' ? 'read-only-subagent' : 'read-only-unknown',
    bodyBytes: body.length,
    bodyDigest: sha256(body),
    ...parsed,
    reason,
  });
}

/**
 * Parse only the reviewed DSH 0.1.1-rc.2 prompt wire. Unknown or wider shapes
 * are deliberately represented as read-only generation advances.
 */
export function classifyPinnedDshPromptBody(body, route) {
  if (!Buffer.isBuffer(body) || !DSH_PROMPT_ROUTES.has(route)) {
    throw new ProtectedExecutionError('EXECUTION_PROMPT_ROUTE_INVALID', 'Pinned DSH prompt route is invalid.');
  }
  if (body.length > MAX_CLAIMABLE_PROMPT_BYTES) {
    return Object.freeze({
      schemaVersion: PROTECTED_EXECUTION_SCHEMA_VERSION,
      route,
      classification: 'read-only-oversized',
      bodyBytes: body.length,
      bodyDigest: sha256(body),
      reason: 'PROMPT_BODY_EXCEEDS_CLAIM_LIMIT',
    });
  }

  let envelope;
  try {
    envelope = JSON.parse(body.toString('utf8'));
  } catch {
    return readOnlyClassification(route, body, 'PROMPT_BODY_NOT_JSON');
  }
  if (!exactObject(envelope, ['type', 'rpcId', 'method', 'payload'])
    || envelope.type !== 'client-request'
    || envelope.method !== route
    || typeof envelope.rpcId !== 'string'
    || !RPC_ID_PATTERN.test(envelope.rpcId)) {
    return readOnlyClassification(route, body, 'PROMPT_ENVELOPE_UNRECOGNIZED');
  }

  if (route === 'subagent.prompt') {
    const payload = envelope.payload;
    const parsed = exactObject(payload, ['parentSessionId', 'childSessionId', 'mode', 'content'])
      || exactObject(payload, ['parentSessionId', 'childSessionId', 'mode', 'content', 'clientTimeZone'])
      ? {
          rpcId: envelope.rpcId,
          dshSessionId: typeof payload.childSessionId === 'string' && DSH_ID_PATTERN.test(payload.childSessionId)
            ? payload.childSessionId : undefined,
        }
      : {};
    return readOnlyClassification(route, body, 'SUBAGENT_PROMPT_NOT_WRITER_ELIGIBLE', parsed);
  }

  const payload = envelope.payload;
  if (!(exactObject(payload, ['sessionId', 'mode', 'content'])
    || exactObject(payload, ['sessionId', 'mode', 'content', 'clientTimeZone']))
    || !DSH_ID_PATTERN.test(payload.sessionId)
    || !['queue', 'steer'].includes(payload.mode)
    || !Array.isArray(payload.content)) {
    return readOnlyClassification(route, body, 'SESSION_PROMPT_PAYLOAD_UNRECOGNIZED', { rpcId: envelope.rpcId });
  }

  const text = [];
  let imageCount = 0;
  for (const part of payload.content) {
    if (exactObject(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string') {
      text.push({ type: 'text', text: part.text });
      continue;
    }
    if ((exactObject(part, ['type', 'mediaType', 'data'])
      || exactObject(part, ['type', 'mediaType', 'data', 'name']))
      && part.type === 'image'
      && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mediaType)
      && typeof part.data === 'string'
      && (part.name === undefined || typeof part.name === 'string')) {
      imageCount += 1;
      continue;
    }
    return readOnlyClassification(route, body, 'SESSION_PROMPT_CONTENT_UNRECOGNIZED', {
      rpcId: envelope.rpcId,
      dshSessionId: payload.sessionId,
      mode: payload.mode,
    });
  }

  const base = {
    schemaVersion: PROTECTED_EXECUTION_SCHEMA_VERSION,
    route,
    rpcId: envelope.rpcId,
    dshSessionId: payload.sessionId,
    mode: payload.mode,
    bodyBytes: body.length,
    bodyDigest: sha256(body),
    textDigest: digestDirectUserTextContent(text),
    promptText: text.map((part) => part.text).join('\n'),
  };
  // Reference images do not cancel the authenticated user's accompanying text.
  // Authority still comes from that text; the full body digest binds attachments.
  // With no direct text, an image cannot itself grant task or release authority.
  if (imageCount > 0 && !base.promptText.trim()) {
    return Object.freeze({
      ...base,
      classification: 'read-only-image',
      imageCount,
      reason: 'IMAGE_PROMPT_NOT_WRITER_ELIGIBLE',
    });
  }
  return Object.freeze({ ...base, classification: 'claimable-text', imageCount });
}

export function unparsedPromptAdvance(route, bodyBytes, reason) {
  if (!DSH_PROMPT_ROUTES.has(route) || !Number.isSafeInteger(bodyBytes) || bodyBytes < 0) {
    throw new ProtectedExecutionError('EXECUTION_PROMPT_INVALID', 'Unparsed prompt advance is invalid.');
  }
  return Object.freeze({
    schemaVersion: PROTECTED_EXECUTION_SCHEMA_VERSION,
    route,
    classification: 'read-only-oversized',
    bodyBytes,
    reason,
  });
}

export async function loadExecutionPolicy(policyPath = process.env.FORGE_EXECUTION_POLICY_FILE
  ?? fileURLToPath(new URL('./forge-execution-policy.json', import.meta.url))) {
  let policy;
  try {
    policy = JSON.parse(await readFile(policyPath, 'utf8'));
  } catch (error) {
    throw new ProtectedExecutionError('EXECUTION_POLICY_UNAVAILABLE', `Execution policy is unavailable: ${error.code ?? error.message}`, 503);
  }
  exactKeys(policy, ['schemaVersion', 'policyMode', 'policyVersion', 'defaultActionCeiling', 'writerRoutes'], 'execution policy');
  if (policy.schemaVersion !== EXECUTION_POLICY_SCHEMA_VERSION
    || !['production', 'test-shadow'].includes(policy.policyMode)
    || typeof policy.policyVersion !== 'string' || policy.policyVersion.length < 1 || policy.policyVersion.length > 128
    || policy.defaultActionCeiling !== 'read-only'
    || !Array.isArray(policy.writerRoutes) || policy.writerRoutes.length > 32
    || (policy.policyMode === 'production' && policy.writerRoutes.length !== 0)) {
    throw new ProtectedExecutionError('EXECUTION_POLICY_INVALID', 'Execution policy envelope is invalid.', 503);
  }
  const writerRoutes = policy.writerRoutes.map((route) => {
    exactKeys(route, [
      'routeId', 'profile', 'sourceCommit', 'caseFamily', 'actionCeiling',
      'ownedPaths', 'taskProfiles', 'requiredProfiles', 'workflowId',
    ], 'execution writer route');
    if (policy.policyMode !== 'test-shadow' || route.profile !== 'test-shadow'
      || typeof route.routeId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(route.routeId)
      || !/^[0-9a-f]{40}$/u.test(route.sourceCommit)
      || typeof route.caseFamily !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(route.caseFamily)
      || (route.workflowId !== undefined
        && (typeof route.workflowId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(route.workflowId)))
      || route.actionCeiling !== 'workspace-write'
      || !Array.isArray(route.ownedPaths) || route.ownedPaths.length < 1
      || !Array.isArray(route.taskProfiles) || route.taskProfiles.length < 1
      || !Array.isArray(route.requiredProfiles)) {
      throw new ProtectedExecutionError('EXECUTION_POLICY_INVALID', 'Test-shadow writer route is invalid.', 503);
    }
    return Object.freeze({
      ...route,
      ownedPaths: Object.freeze([...route.ownedPaths].sort()),
      taskProfiles: Object.freeze([...route.taskProfiles]),
      requiredProfiles: Object.freeze([...route.requiredProfiles]),
      workflowId: route.workflowId ?? null,
    });
  });
  return Object.freeze({ ...policy, writerRoutes: Object.freeze(writerRoutes) });
}

function sameSemanticResourceBinding(left, right) {
  const present = Object.hasOwn(left ?? {}, 'semanticResources');
  return present === Object.hasOwn(right ?? {}, 'semanticResources')
    && (!present || canonicalStringify(left.semanticResources) === canonicalStringify(right.semanticResources));
}

function selectAuthority(policy, trustedPolicyInput) {
  if (trustedPolicyInput === undefined) {
    return {
      authorityClass: 'production-read-only',
      testOnly: false,
      sourceCommit: null,
      workspaceFingerprint: null,
      caseFamily: null,
      productionAuthorityId: null,
      productionAuthorityDigest: null,
      controllerGrantDigest: null,
      expectedContractId: null,
      actionCeiling: policy.defaultActionCeiling,
      ownedPaths: [],
      taskProfiles: undefined,
      requiredProfiles: [],
      workflowId: null,
      phaseId: null,
      phaseIndex: null,
      phaseCatalogVersion: null,
      phaseCatalogDigest: null,
    };
  }
  if (trustedPolicyInput?.profile === 'production-controller') {
    exactKeys(trustedPolicyInput, [
      'profile', 'sourceCommit', 'workspaceFingerprint', 'caseFamily',
      'productionAuthorityId', 'productionAuthorityDigest', 'controllerGrantDigest',
      'expectedContractId', 'taskAuthority',
    ], 'trusted production policy input');
    const task = trustedPolicyInput.taskAuthority;
    exactKeys(task, ['actionCeiling', 'ownedPaths', 'taskProfiles',
      ...(Object.hasOwn(task ?? {}, 'contract') ? ['contract'] : [])], 'trusted production task authority');
    if (policy.policyMode !== 'production'
      || !/^[0-9a-f]{40}$/u.test(trustedPolicyInput.sourceCommit ?? '')
      || !SHA256_PATTERN.test(trustedPolicyInput.workspaceFingerprint ?? '')
      || typeof trustedPolicyInput.caseFamily !== 'string'
      || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(trustedPolicyInput.caseFamily)
      || !ACTOR_USER_ID_PATTERN.test(trustedPolicyInput.productionAuthorityId ?? '')
      || !SHA256_PATTERN.test(trustedPolicyInput.productionAuthorityDigest ?? '')
      || !SHA256_PATTERN.test(trustedPolicyInput.controllerGrantDigest ?? '')
      || !SHA256_PATTERN.test(trustedPolicyInput.expectedContractId ?? '')
      || !PRODUCTION_TASK_ACTION_CEILINGS.has(task?.actionCeiling)
      || !Array.isArray(task?.ownedPaths) || task.ownedPaths.length < 1
      || !Array.isArray(task?.taskProfiles) || task.taskProfiles.length < 1) {
      throw new ProtectedExecutionError(
        'EXECUTION_POLICY_ROUTE_DENIED',
        'Trusted production task authority is not admitted.',
        403,
      );
    }
    const taskContract = Object.hasOwn(task, 'contract') ? validateForgeTaskExecutionContract(task.contract) : undefined;
    if (taskContract !== undefined && (taskContract.contractId !== trustedPolicyInput.expectedContractId
      || taskContract.actionCeiling !== task.actionCeiling
      || canonicalStringify(taskContract.ownedPaths) !== canonicalStringify(task.ownedPaths)
      || canonicalStringify(taskContract.taskProfiles) !== canonicalStringify(task.taskProfiles))) {
      throw new ProtectedExecutionError('EXECUTION_POLICY_INVALID', 'Trusted continuation contract does not match its authority.', 503);
    }
    return {
      authorityClass: 'production-task-writer',
      testOnly: false,
      sourceCommit: trustedPolicyInput.sourceCommit,
      workspaceFingerprint: trustedPolicyInput.workspaceFingerprint,
      caseFamily: trustedPolicyInput.caseFamily,
      productionAuthorityId: trustedPolicyInput.productionAuthorityId,
      productionAuthorityDigest: trustedPolicyInput.productionAuthorityDigest,
      controllerGrantDigest: trustedPolicyInput.controllerGrantDigest,
      expectedContractId: trustedPolicyInput.expectedContractId,
      actionCeiling: task.actionCeiling,
      ownedPaths: [...task.ownedPaths],
      taskProfiles: [...task.taskProfiles],
      ...(taskContract === undefined ? {} : { taskContract }),
      requiredProfiles: [],
      workflowId: null,
      phaseId: null,
      phaseIndex: null,
      phaseCatalogVersion: null,
      phaseCatalogDigest: null,
    };
  }
  exactKeys(trustedPolicyInput, ['profile', 'sourceCommit', 'caseFamily', 'phaseAuthority'], 'trusted policy input');
  if (policy.policyMode !== 'test-shadow' || trustedPolicyInput.profile !== 'test-shadow'
    || !/^[0-9a-f]{40}$/u.test(trustedPolicyInput.sourceCommit)
    || typeof trustedPolicyInput.caseFamily !== 'string') {
    throw new ProtectedExecutionError('EXECUTION_POLICY_ROUTE_DENIED', 'Trusted policy input is not admitted.', 403);
  }
  const routes = policy.writerRoutes.filter((route) => route.profile === trustedPolicyInput.profile
    && route.sourceCommit === trustedPolicyInput.sourceCommit
    && route.caseFamily === trustedPolicyInput.caseFamily);
  if (routes.length !== 1) {
    throw new ProtectedExecutionError('EXECUTION_POLICY_ROUTE_DENIED', 'No unique test-shadow writer route matched.', 403);
  }
  const route = routes[0];
  const phase = trustedPolicyInput.phaseAuthority;
  if (route.workflowId === null && phase !== undefined) {
    throw new ProtectedExecutionError('EXECUTION_POLICY_ROUTE_DENIED', 'An unphased route cannot accept phase authority.', 403);
  }
  if (route.workflowId !== null && phase === undefined) {
    throw new ProtectedExecutionError('EXECUTION_PHASE_REQUIRED', 'This writer route requires operator phase authority.', 409);
  }
  if (phase !== undefined) {
    exactKeys(phase, [
      'workflowId', 'phaseId', 'phaseIndex', 'catalogVersion', 'catalogDigest',
      'actionCeiling', 'ownedPaths', 'taskProfiles', 'requiredProfiles',
    ], 'trusted phase authority');
    if (phase.workflowId !== route.workflowId
      || typeof phase.phaseId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(phase.phaseId)
      || !Number.isSafeInteger(phase.phaseIndex) || phase.phaseIndex < 0
      || typeof phase.catalogVersion !== 'string' || phase.catalogVersion.length < 1
      || typeof phase.catalogDigest !== 'string' || !SHA256_PATTERN.test(phase.catalogDigest)
      || !Array.isArray(phase.ownedPaths) || !Array.isArray(phase.taskProfiles)
      || !Array.isArray(phase.requiredProfiles)
      || !isActionWithinCeiling(route.actionCeiling, phase.actionCeiling)
      || phase.ownedPaths.some((candidate) => !route.ownedPaths.some((root) => candidate === root || candidate.startsWith(`${root}/`)))
      || phase.taskProfiles.some((profile) => !route.taskProfiles.includes(profile))
      || phase.requiredProfiles.some((profile) => !route.requiredProfiles.includes(profile))) {
      throw new ProtectedExecutionError('EXECUTION_PHASE_AUTHORITY_INVALID', 'Phase authority exceeds its writer route.', 503);
    }
  }
  return {
    authorityClass: 'test-shadow-writer',
    testOnly: true,
    sourceCommit: route.sourceCommit,
    workspaceFingerprint: null,
    caseFamily: route.caseFamily,
    productionAuthorityId: null,
    productionAuthorityDigest: null,
    controllerGrantDigest: null,
    expectedContractId: null,
    actionCeiling: phase?.actionCeiling ?? route.actionCeiling,
    ownedPaths: [...(phase?.ownedPaths ?? route.ownedPaths)],
    taskProfiles: [...(phase?.taskProfiles ?? route.taskProfiles)],
    requiredProfiles: [...(phase?.requiredProfiles ?? route.requiredProfiles)],
    workflowId: phase?.workflowId ?? null,
    phaseId: phase?.phaseId ?? null,
    phaseIndex: phase?.phaseIndex ?? null,
    phaseCatalogVersion: phase?.catalogVersion ?? null,
    phaseCatalogDigest: phase?.catalogDigest ?? null,
  };
}

function validatePrepareRequest(value) {
  exactKeys(value, [
    'schemaVersion', 'route', 'classification', 'rpcId', 'dshSessionId', 'mode',
    'bodyDigest', 'textDigest', 'promptText', 'bodyBytes', 'imageCount', 'reason',
    'requestId', 'actorUserId', 'actorUsername', 'conversationId',
  ], 'execution prepare request');
  if (value.schemaVersion !== PROTECTED_EXECUTION_SCHEMA_VERSION || !DSH_PROMPT_ROUTES.has(value.route)
    || !EXECUTION_CLASSIFICATIONS.has(value.classification)) {
    throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', 'Execution prepare classification is invalid.');
  }
  const bodyBytes = value.bodyBytes;
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > 512 * 1024 * 1024) {
    throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', 'Execution prompt byte count is invalid.');
  }
  const normalized = {
    schemaVersion: value.schemaVersion,
    route: value.route,
    classification: value.classification,
    actorUserId: requiredString(value.actorUserId, ACTOR_USER_ID_PATTERN, 'actorUserId'),
    actorUsername: requiredString(value.actorUsername, ACTOR_ID_PATTERN, 'actorUsername'),
    conversationId: requiredString(value.conversationId, CONVERSATION_ID_PATTERN, 'conversationId'),
    requestId: requiredString(value.requestId, REQUEST_ID_PATTERN, 'requestId'),
    rpcId: optionalString(value.rpcId, RPC_ID_PATTERN, 'rpcId'),
    dshSessionId: optionalString(value.dshSessionId, DSH_ID_PATTERN, 'dshSessionId'),
    mode: value.mode === undefined ? null : (['queue', 'steer'].includes(value.mode) ? value.mode : (() => { throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', 'mode is invalid.'); })()),
    bodyDigest: optionalString(value.bodyDigest, SHA256_PATTERN, 'bodyDigest'),
    textDigest: optionalString(value.textDigest, SHA256_PATTERN, 'textDigest'),
    promptText: typeof value.promptText === 'string' && Buffer.byteLength(value.promptText, 'utf8') <= MAX_CLAIMABLE_PROMPT_BYTES
      ? value.promptText : '',
    bodyBytes,
    imageCount: Number.isSafeInteger(value.imageCount) && value.imageCount >= 0 ? value.imageCount : 0,
    reason: typeof value.reason === 'string' && value.reason.length <= 160 ? value.reason : null,
  };
  if (value.classification === 'claimable-text'
    && (!normalized.rpcId || !normalized.dshSessionId || !normalized.bodyDigest || !normalized.textDigest
      || normalized.mode === null || bodyBytes > MAX_CLAIMABLE_PROMPT_BYTES
      || (normalized.imageCount > 0 && !normalized.promptText.trim()))) {
    throw new ProtectedExecutionError('EXECUTION_INPUT_INVALID', 'Claimable text prompt binding is incomplete.');
  }
  return normalized;
}

function validatePreviousCompletion(value, projectSlug, taskMetadata, input) {
  if (value === undefined) return undefined;
  exactKeys(value, [
    'schemaVersion', 'kind', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'sourceCommit', 'workspaceFingerprint', 'contractId',
    'acceptedAt', 'recordDigest', 'verdictDigest', 'gateDigest',
  ], 'previous completion');
  if (value.schemaVersion !== 1 || value.kind !== 'historical-code-acceptance'
    || value.projectSlug !== projectSlug || value.taskId !== taskMetadata.taskId
    || value.actorUserId !== input.actorUserId || value.actorUsername !== input.actorUsername
    || value.conversationId !== input.conversationId || value.dshSessionId !== input.dshSessionId
    || !SOURCE_COMMIT_PATTERN.test(value.sourceCommit ?? '')
    || !SHA256_PATTERN.test(value.workspaceFingerprint ?? '')
    || !SHA256_PATTERN.test(value.contractId ?? '')
    || !PREFIXED_SHA256_PATTERN.test(value.recordDigest ?? '')
    || !PREFIXED_SHA256_PATTERN.test(value.verdictDigest ?? '')
    || !PREFIXED_SHA256_PATTERN.test(value.gateDigest ?? '')
    || !validIso(value.acceptedAt)) {
    throw new ProtectedExecutionError('EXECUTION_PREVIOUS_COMPLETION_INVALID', 'Historical completion fact is invalid.', 503);
  }
  return Object.freeze(structuredClone(value));
}

function executionStatePath(projectRoot, taskId) {
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  return path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${taskId}.json`);
}

async function readState(statePath) {
  let information;
  try {
    information = await lstat(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Execution state cannot be inspected.', 503);
  }
  if (!information.isFile() || information.isSymbolicLink() || information.size < 2 || information.size > MAX_EXECUTION_STATE_BYTES) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state file is invalid.', 503);
  }
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state is not valid JSON.', 503);
  }
}

async function readStateStableReadOnly(statePath, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let before;
    try {
      before = await lstat(statePath);
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Execution state cannot be inspected.', 503);
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2
      || before.size > MAX_EXECUTION_STATE_BYTES) {
      throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state file is invalid.', 503);
    }
    let bytes;
    let after;
    try {
      bytes = await readFile(statePath);
      after = await lstat(statePath);
    } catch (error) {
      if (error?.code === 'ENOENT' && attempt < attempts) continue;
      throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Execution state cannot be inspected.', 503);
    }
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      if (attempt < attempts) continue;
      throw new ProtectedExecutionError(
        'EXECUTION_STATE_UNAVAILABLE',
        'Execution state changed while the read-only observer inspected it.',
        503,
      );
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state is not valid JSON.', 503);
    }
  }
  throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Execution state could not be observed stably.', 503);
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function absoluteRecoveryDeadline(current, recovery) {
  const originalIssuedAt = Date.parse(recovery?.originalIssuedAt ?? current?.issuedAt);
  return Number.isFinite(originalIssuedAt)
    ? originalIssuedAt + EXECUTION_RECOVERY_MAX_WINDOW_MS
    : Number.NaN;
}

function validateExecutionLifecycle(value) {
  exactKeys(value, ['status', 'consumedAt'], 'protected execution lifecycle');
  if (!['prepared', 'legacy-unverified', 'submission-attempted', 'ingress-forwarded', 'consumed', 'abandoned'].includes(value.status)
    || (value.status === 'consumed' ? !validIso(value.consumedAt) : value.consumedAt !== null)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution lifecycle is invalid.', 503);
  }
  return structuredClone(value);
}

function validateExecutionRecovery(value, current, lifecycle) {
  if (value === null) return null;
  exactKeys(value, [
    'mode', 'operationId', 'authorizationReference', 'phaseAttemptId', 'generation',
    'executionId', 'claimId', 'rpcId', 'promptDigest', 'contractId', 'permitIssuedAt',
    'permitExpiresAt', 'originalIssuedAt', 'originalExpiresAt', 'status', 'readbackSeq',
    'readbackDigest', 'refreshedAt',
  ], 'protected execution recovery');
  if (value.mode !== PROTECTED_EXECUTION_RECOVERY_MODE
    || !ACTOR_USER_ID_PATTERN.test(value.operationId ?? '')
    || !ACTOR_USER_ID_PATTERN.test(value.phaseAttemptId ?? '')
    || !AUTHORIZATION_REFERENCE_PATTERN.test(value.authorizationReference ?? '')
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !ACTOR_USER_ID_PATTERN.test(value.executionId ?? '')
    || !ACTOR_USER_ID_PATTERN.test(value.claimId ?? '')
    || !RPC_ID_PATTERN.test(value.rpcId ?? '')
    || !SHA256_PATTERN.test(value.promptDigest ?? '')
    || !SHA256_PATTERN.test(value.contractId ?? '')
    || !['permitted', 'submission-attempted', 'ingress-forwarded', 'consumed', 'abandoned'].includes(value.status)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution recovery identity is invalid.', 503);
  }
  if (value.generation !== current.generation || value.executionId !== current.executionId
    || value.claimId !== current.claimId || value.rpcId !== current.rpcId
    || value.promptDigest !== current.promptDigest || value.contractId !== current.contractId) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution recovery binding drifted.', 503);
  }
  const permitIssuedAt = Date.parse(value.permitIssuedAt);
  const permitExpiresAt = Date.parse(value.permitExpiresAt);
  const originalIssuedAt = Date.parse(value.originalIssuedAt);
  const originalExpiresAt = Date.parse(value.originalExpiresAt);
  if (![permitIssuedAt, permitExpiresAt, originalIssuedAt, originalExpiresAt].every(Number.isFinite)
    || permitExpiresAt <= permitIssuedAt
    || permitExpiresAt - permitIssuedAt > EXECUTION_RECOVERY_PERMIT_TTL_MS
    || originalExpiresAt <= originalIssuedAt
    || originalExpiresAt - originalIssuedAt > EXECUTION_CONTEXT_TTL_MS
    || permitIssuedAt > originalIssuedAt + EXECUTION_RECOVERY_MAX_WINDOW_MS
    || permitExpiresAt > originalIssuedAt + EXECUTION_RECOVERY_MAX_WINDOW_MS) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution recovery lease history is invalid.', 503);
  }
  if (value.status === 'permitted') {
    if (!['prepared', 'legacy-unverified'].includes(lifecycle.status)
      || value.readbackSeq !== null || value.readbackDigest !== null || value.refreshedAt !== null
      || current.issuedAt !== value.originalIssuedAt || current.expiresAt !== value.originalExpiresAt) {
      throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Pending execution recovery is inconsistent.', 503);
    }
  } else if (value.status === 'abandoned' && value.readbackSeq === null
    && value.readbackDigest === null && value.refreshedAt === null) {
    if (lifecycle.status !== 'abandoned'
      || current.issuedAt !== value.originalIssuedAt
      || current.expiresAt !== value.originalExpiresAt) {
      throw new ProtectedExecutionError(
        'EXECUTION_STATE_INVALID',
        'Pre-claim abandoned execution recovery is inconsistent.',
        503,
      );
    }
  } else {
    if (!Number.isSafeInteger(value.readbackSeq) || value.readbackSeq < 0
      || !SHA256_PATTERN.test(value.readbackDigest ?? '') || !validIso(value.refreshedAt)
      || current.issuedAt !== value.refreshedAt
      || Date.parse(current.expiresAt) - Date.parse(current.issuedAt) > EXECUTION_CONTEXT_TTL_MS
      || originalExpiresAt > Date.parse(value.refreshedAt)
      || (value.status === 'submission-attempted' && lifecycle.status !== 'submission-attempted')
      || (value.status === 'ingress-forwarded' && lifecycle.status !== 'ingress-forwarded')
      || (value.status === 'consumed' && lifecycle.status !== 'consumed')
      || (value.status === 'abandoned' && lifecycle.status !== 'abandoned')) {
      throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Claimed execution recovery is inconsistent.', 503);
    }
  }
  return structuredClone(value);
}

function validateExecutionRecoveryTombstone(value) {
  exactKeys(value, [
    'operationId', 'phaseAttemptId', 'executionId', 'claimId', 'generation', 'contractId',
    'rpcId', 'dshSessionId', 'textDigest', 'abandonedAt', 'reason', 'requestObserved',
    'observedSeq', 'eventDigest',
  ], 'protected execution recovery tombstone');
  for (const [label, entry] of [
    ['operationId', value.operationId], ['phaseAttemptId', value.phaseAttemptId],
    ['executionId', value.executionId], ['claimId', value.claimId],
  ]) requiredString(entry, ACTOR_USER_ID_PATTERN, `recovery tombstone ${label}`);
  requiredString(value.contractId, SHA256_PATTERN, 'recovery tombstone contractId');
  requiredString(value.rpcId, RPC_ID_PATTERN, 'recovery tombstone rpcId');
  requiredString(value.dshSessionId, DSH_ID_PATTERN, 'recovery tombstone dshSessionId');
  requiredString(value.textDigest, SHA256_PATTERN, 'recovery tombstone textDigest');
  requiredString(value.eventDigest, SHA256_PATTERN, 'recovery tombstone eventDigest');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1
    || !Number.isSafeInteger(value.observedSeq) || value.observedSeq < 0
    || !validIso(value.abandonedAt)
    || ![
      'stable-idle-unconsumed-no-resend',
      'stable-idle-pre-ingress-cancelled-no-resend',
    ].includes(value.reason)
    || typeof value.requestObserved !== 'boolean') {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution recovery tombstone is invalid.', 503);
  }
  return structuredClone(value);
}

function validateStoredState(value) {
  const legacyKeys = [
    'schemaVersion', 'revision', 'generation', 'projectSlug', 'taskId', 'actorUserId',
    'actorUsername', 'conversationId', 'current', 'updatedAt',
  ];
  const legacy = value?.schemaVersion === PROTECTED_EXECUTION_SCHEMA_VERSION;
  const previous = value?.schemaVersion === 2;
  if (legacy) exactKeys(value, legacyKeys, 'protected execution state');
  else if (previous) exactKeys(value, [...legacyKeys, 'lifecycle', 'recovery'], 'protected execution state');
  else if (value?.schemaVersion === PROTECTED_EXECUTION_STATE_SCHEMA_VERSION) {
    exactKeys(value, [...legacyKeys, 'lifecycle', 'recovery', 'tombstones'], 'protected execution state');
  } else {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state version is invalid.', 503);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || value.revision < value.generation) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state revision is invalid.', 503);
  }
  requiredString(value.projectSlug, PROJECT_SLUG_PATTERN, 'state projectSlug');
  requiredString(value.taskId, TASK_ID_PATTERN, 'state taskId');
  requiredString(value.actorUserId, ACTOR_USER_ID_PATTERN, 'state actorUserId');
  requiredString(value.actorUsername, ACTOR_ID_PATTERN, 'state actorUsername');
  requiredString(value.conversationId, CONVERSATION_ID_PATTERN, 'state conversationId');
  if (!validIso(value.updatedAt)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state timestamp is invalid.', 503);
  }
  const current = validateProtectedExecutionContext(value.current);
  if (current.generation !== value.generation) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution state generation is inconsistent.', 503);
  }
  if (legacy) {
    return {
      ...structuredClone(value),
      schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
      lifecycle: { status: 'legacy-unverified', consumedAt: null },
      recovery: null,
      tombstones: [],
    };
  }
  const lifecycle = validateExecutionLifecycle(value.lifecycle);
  const recovery = validateExecutionRecovery(value.recovery, current, lifecycle);
  const tombstones = previous ? [] : value.tombstones;
  if (!Array.isArray(tombstones) || tombstones.length > MAX_EXECUTION_RECOVERY_TOMBSTONES) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution recovery tombstones are invalid.', 503);
  }
  const validatedTombstones = tombstones.map(validateExecutionRecoveryTombstone);
  const tombstoneKeys = new Set(validatedTombstones.map((entry) => `${entry.operationId}\0${entry.executionId}`));
  if (tombstoneKeys.size !== validatedTombstones.length) {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution recovery tombstones are duplicated.', 503);
  }
  if (lifecycle.status === 'legacy-unverified' && recovery?.status !== 'permitted') {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Legacy execution state lacks a pending readback recovery.', 503);
  }
  if (lifecycle.status === 'submission-attempted' && recovery?.status !== 'submission-attempted') {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution submit claim lacks recovery evidence.', 503);
  }
  if (lifecycle.status === 'ingress-forwarded' && recovery?.status !== 'ingress-forwarded') {
    throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Execution ingress transition lacks recovery evidence.', 503);
  }
  if (lifecycle.status === 'abandoned') {
    const terminal = validatedTombstones.find((entry) => recovery !== null
      && entry.operationId === recovery.operationId && entry.executionId === current.executionId);
    if (recovery?.status !== 'abandoned' || terminal === undefined) {
      throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Abandoned execution lacks its no-resend tombstone.', 503);
    }
  }
  return {
    ...structuredClone(value),
    schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
    lifecycle,
    recovery,
    tombstones: validatedTombstones,
  };
}

async function atomicWriteJson(destination, value) {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync().catch((error) => {
        if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
      });
    } finally { await directoryHandle.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function processStartToken(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const suffix = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const token = suffix[19];
    return /^[0-9]+$/u.test(token ?? '') ? token : null;
  } catch {
    return null;
  }
}

async function processPidNamespace() {
  if (process.platform !== 'linux') return null;
  try {
    const value = await readlink('/proc/self/ns/pid');
    return /^pid:\[[0-9]+\]$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function validPidNamespace(value) {
  return value === null || (typeof value === 'string' && /^pid:\[[0-9]+\]$/u.test(value));
}

async function preserveExecutionStateLockClaim(statePath, claimPath, record, now) {
  const evidenceRoot = `${statePath}.lock-recovery`;
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const evidencePath = path.join(
    evidenceRoot,
    `${new Date(now).toISOString().replaceAll(':', '')}-${record.ownerNonce}-${crypto.randomUUID()}.json`,
  );
  try {
    await rename(claimPath, evidencePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function reconcileOrphanedExecutionStateLockClaim(statePath, lockPath, now = Date.now()) {
  const claimPath = `${lockPath}.reconcile`;
  const [lockInformation, claimInformation] = await Promise.all([
    lstat(lockPath, { bigint: true }).catch((error) => (error?.code === 'ENOENT' ? undefined : Promise.reject(error))),
    lstat(claimPath, { bigint: true }).catch((error) => (error?.code === 'ENOENT' ? undefined : Promise.reject(error))),
  ]);
  if (claimInformation === undefined || lockInformation !== undefined) return false;
  if (!claimInformation.isFile() || claimInformation.isSymbolicLink()
    || claimInformation.nlink !== 1n || claimInformation.size < 2n
    || claimInformation.size > BigInt(MAX_EXECUTION_STATE_LOCK_BYTES)) {
    throw new ProtectedExecutionError(
      'EXECUTION_STATE_LOCK_RECOVERY_INCOMPLETE',
      'An orphaned execution-state reconciliation claim is malformed.',
      409,
    );
  }
  let record;
  try {
    record = JSON.parse(await readFile(claimPath, 'utf8'));
  } catch {
    throw new ProtectedExecutionError(
      'EXECUTION_STATE_LOCK_RECOVERY_INCOMPLETE',
      'An orphaned execution-state reconciliation claim is unreadable.',
      409,
    );
  }
  if (!exactObject(record, [
    'schemaVersion', 'pid', 'processStartToken', 'pidNamespace', 'ownerNonce', 'statePathDigest', 'acquiredAt',
  ]) || record.schemaVersion !== 2 || !validPidNamespace(record.pidNamespace)
    || !ACTOR_USER_ID_PATTERN.test(record.ownerNonce ?? '')
    || record.statePathDigest !== sha256(Buffer.from(statePath, 'utf8')) || !validIso(record.acquiredAt)) {
    throw new ProtectedExecutionError(
      'EXECUTION_STATE_LOCK_RECOVERY_INCOMPLETE',
      'An orphaned execution-state reconciliation claim has invalid identity.',
      409,
    );
  }
  return preserveExecutionStateLockClaim(statePath, claimPath, record, now);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function reconcileDeadExecutionStateLock(statePath, lockPath, now = Date.now()) {
  const claimPath = `${lockPath}.reconcile`;
  let createdClaim = false;
  try {
    await link(lockPath, claimPath);
    createdClaim = true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error?.code === 'EEXIST') createdClaim = false;
    else if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
      throw new ProtectedExecutionError(
        'EXECUTION_STATE_LOCK_CAS_UNAVAILABLE',
        'The execution-state filesystem cannot atomically pin a stale lock.',
        503,
      );
    } else throw error;
  }
  let preserved = false;
  try {
    let lockInformation;
    let claimInformation;
    try {
      [lockInformation, claimInformation] = await Promise.all([
        lstat(lockPath, { bigint: true }),
        lstat(claimPath, { bigint: true }),
      ]);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    const sameFile = lockInformation.dev === claimInformation.dev
      && lockInformation.ino === claimInformation.ino
      && lockInformation.ino !== 0n;
    if (!sameFile) {
      throw new ProtectedExecutionError(
        'EXECUTION_STATE_LOCK_CAS_UNAVAILABLE',
        'The execution-state filesystem did not expose a stable lock file identity.',
        503,
      );
    }
    if (!claimInformation.isFile() || claimInformation.isSymbolicLink()
      || ![2n, 3n].includes(claimInformation.nlink)
      || claimInformation.size < 2n || claimInformation.size > BigInt(MAX_EXECUTION_STATE_LOCK_BYTES)
      || BigInt(now) - claimInformation.mtimeMs < BigInt(EXECUTION_STATE_LOCK_DEAD_OWNER_GRACE_MS)) return false;
    const handle = await open(claimPath, 'r');
    let record;
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== claimInformation.dev || opened.ino !== claimInformation.ino) {
        throw new ProtectedExecutionError(
          'EXECUTION_STATE_LOCK_CAS_UNAVAILABLE',
          'The pinned execution-state lock identity changed while it was inspected.',
          503,
        );
      }
      record = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      if (error instanceof ProtectedExecutionError) throw error;
      return false;
    } finally {
      await handle.close();
    }
    if (!exactObject(record, [
      'schemaVersion', 'pid', 'processStartToken', 'pidNamespace', 'ownerNonce', 'statePathDigest', 'acquiredAt',
    ]) || record.schemaVersion !== 2 || !Number.isSafeInteger(record.pid) || record.pid < 1
      || (record.processStartToken !== null && !/^[0-9]+$/u.test(record.processStartToken))
      || !validPidNamespace(record.pidNamespace)
      || !ACTOR_USER_ID_PATTERN.test(record.ownerNonce ?? '')
      || record.statePathDigest !== sha256(Buffer.from(statePath, 'utf8'))
      || !validIso(record.acquiredAt)
      || now - Date.parse(record.acquiredAt) < EXECUTION_STATE_LOCK_DEAD_OWNER_GRACE_MS) return false;
    if (claimInformation.nlink === 3n) {
      const ownerPath = `${lockPath}.owner-${record.ownerNonce}`;
      const ownerInformation = await lstat(ownerPath, { bigint: true }).catch(() => undefined);
      if (ownerInformation === undefined || ownerInformation.dev !== claimInformation.dev
        || ownerInformation.ino !== claimInformation.ino) {
        throw new ProtectedExecutionError(
          'EXECUTION_STATE_LOCK_RECOVERY_INCOMPLETE',
          'The stale lock has an unknown hardlink and cannot be reconciled automatically.',
          409,
        );
      }
    }
    const localPidNamespace = await processPidNamespace();
    if (record.pidNamespace !== localPidNamespace) return false;
    const alive = processAlive(record.pid);
    const currentStartToken = alive ? await processStartToken(record.pid) : null;
    if (alive && (record.processStartToken === null || currentStartToken === record.processStartToken)) return false;
    const [lockRecheck, claimRecheck] = await Promise.all([
      lstat(lockPath, { bigint: true }).catch(() => undefined),
      lstat(claimPath, { bigint: true }).catch(() => undefined),
    ]);
    if (lockRecheck === undefined || claimRecheck === undefined
      || lockRecheck.dev !== claimInformation.dev || lockRecheck.ino !== claimInformation.ino
      || claimRecheck.dev !== claimInformation.dev || claimRecheck.ino !== claimInformation.ino
      || claimRecheck.nlink !== claimInformation.nlink) return false;
    await unlink(lockPath);
    preserved = await preserveExecutionStateLockClaim(statePath, claimPath, record, now);
    if (!preserved) {
      const canonicalLock = await lstat(lockPath).catch((error) => (error?.code === 'ENOENT' ? undefined : Promise.reject(error)));
      if (canonicalLock !== undefined) return false;
      preserved = true;
    }
    return true;
  } finally {
    if (createdClaim && !preserved) await unlink(claimPath).catch(() => undefined);
  }
}

async function createExecutionStateLockCandidate(statePath, lockPath) {
  const ownerNonce = crypto.randomUUID();
  const ownerPath = `${lockPath}.owner-${ownerNonce}`;
  const record = {
    schemaVersion: 2,
    pid: process.pid,
    processStartToken: await processStartToken(process.pid),
    pidNamespace: await processPidNamespace(),
    ownerNonce,
    statePathDigest: sha256(Buffer.from(statePath, 'utf8')),
    acquiredAt: new Date().toISOString(),
  };
  const handle = await open(ownerPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(ownerPath, lockPath);
  } catch (error) {
    await unlink(ownerPath).catch(() => undefined);
    throw error;
  }
  await unlink(ownerPath).catch(() => undefined);
  return record;
}

async function releaseExecutionStateLock(lockPath, ownerNonce) {
  let current;
  try {
    current = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return;
  }
  if (current?.ownerNonce === ownerNonce) await unlink(lockPath).catch(() => undefined);
}

function linuxExecutionStateLockError(code, message, status = 503) {
  return new ProtectedExecutionError(code, message, status);
}

function sameLinuxExecutionStateLock(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n
    && left.nlink === 1n && right.nlink === 1n;
}

async function syncExecutionStateLockDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync().catch((error) => {
      if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
    });
  } finally {
    await handle.close();
  }
}

async function assertCanonicalLinuxExecutionStateLock(lockPath, openedInformation = undefined, rootRecoveryOwner = undefined) {
  let resolved;
  let information;
  try {
    [resolved, information] = await Promise.all([
      realpath(lockPath),
      lstat(lockPath, { bigint: true }),
    ]);
  } catch (error) {
    throw linuxExecutionStateLockError(
      'EXECUTION_STATE_LOCK_INVALID',
      `The Linux execution-state lock cannot be inspected (${error?.code ?? 'unknown'}).`,
    );
  }
  const expectedOwner = rootRecoveryOwner ? BigInt(rootRecoveryOwner.uid)
    : typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : null;
  if (resolved !== path.resolve(lockPath)
    || !information.isFile() || information.isSymbolicLink()
    || information.ino === 0n || information.nlink !== 1n || information.size !== 0n
    || (information.mode & 0o777n) !== 0o600n
    || (expectedOwner !== null && information.uid !== expectedOwner)
    || (rootRecoveryOwner && information.gid !== BigInt(rootRecoveryOwner.gid))
    || (openedInformation !== undefined && !sameLinuxExecutionStateLock(openedInformation, information))) {
    throw linuxExecutionStateLockError(
      'EXECUTION_STATE_LOCK_INVALID',
      'The Linux execution-state lock is not a canonical owner-only ordinary file.',
    );
  }
  return information;
}

async function runLinuxExecutionStateFlock(fd) {
  return new Promise((resolve) => {
    const child = spawn(EXECUTION_STATE_FLOCK_EXECUTABLE, [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      String(EXECUTION_STATE_FLOCK_CONFLICT_EXIT_CODE),
      '3',
    ], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
      windowsHide: true,
    });
    let stderr = '';
    let settled = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, error, stderr: stderr.slice(0, 4096) });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, error: null, stderr: stderr.slice(0, 4096) });
    });
  });
}

function assertLinuxExecutionStateFlockResult(result, expectation) {
  if (result.error !== null) {
    throw linuxExecutionStateLockError(
      'EXECUTION_STATE_LOCK_UNAVAILABLE',
      `The fixed Linux flock executable is unavailable (${result.error?.code ?? 'unknown'}).`,
    );
  }
  if (result.signal !== null || result.code !== expectation) {
    throw linuxExecutionStateLockError(
      'EXECUTION_STATE_LOCK_UNAVAILABLE',
      `The Linux execution-state flock probe failed (${result.code ?? result.signal ?? 'unknown'}).`,
    );
  }
}

async function ensureLinuxExecutionStateLock(lockPath, rootRecoveryOwner) {
  let created = false;
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      if (rootRecoveryOwner) {
        await handle.chown(rootRecoveryOwner.uid, rootRecoveryOwner.gid);
        await handle.chmod(0o600);
      }
      // A zero-length permanent inode has no partially-written identity state:
      // a crash at any point during creation leaves either no name or a valid
      // lock target for the next kernel-lock attempt.
      await handle.sync();
    } finally {
      await handle.close();
    }
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) await syncExecutionStateLockDirectory(path.dirname(lockPath));
  await assertCanonicalLinuxExecutionStateLock(lockPath, undefined, rootRecoveryOwner);
}

async function acquireLinuxExecutionStateLock(lockPath, rootRecoveryOwner) {
  await ensureLinuxExecutionStateLock(lockPath, rootRecoveryOwner);
  let handle;
  try {
    handle = await open(lockPath, 'r+');
    const openedInformation = await handle.stat({ bigint: true });
    await assertCanonicalLinuxExecutionStateLock(lockPath, openedInformation, rootRecoveryOwner);

    const acquisition = await runLinuxExecutionStateFlock(handle.fd);
    if (acquisition.error === null && acquisition.signal === null
      && acquisition.code === EXECUTION_STATE_FLOCK_CONFLICT_EXIT_CODE) {
      throw linuxExecutionStateLockError(
        'EXECUTION_STATE_BUSY',
        'Another protected execution transition owns the state lock.',
        409,
      );
    }
    assertLinuxExecutionStateFlockResult(acquisition, 0);

    // Re-acquiring through the inherited descriptor proves that the parent and
    // helper share the same open-file description. A separately opened
    // descriptor must then receive the exact contention code, proving that the
    // lock remains owned after the one-shot helper exits.
    assertLinuxExecutionStateFlockResult(await runLinuxExecutionStateFlock(handle.fd), 0);
    await assertCanonicalLinuxExecutionStateLock(lockPath, openedInformation, rootRecoveryOwner);
    const contender = await open(lockPath, 'r+');
    try {
      const contenderInformation = await contender.stat({ bigint: true });
      await assertCanonicalLinuxExecutionStateLock(lockPath, contenderInformation, rootRecoveryOwner);
      assertLinuxExecutionStateFlockResult(
        await runLinuxExecutionStateFlock(contender.fd),
        EXECUTION_STATE_FLOCK_CONFLICT_EXIT_CODE,
      );
    } finally {
      await contender.close();
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      let releaseError;
      try {
        await assertCanonicalLinuxExecutionStateLock(lockPath, openedInformation, rootRecoveryOwner);
      } catch (error) {
        releaseError = error;
      } finally {
        await handle.close();
      }
      if (releaseError !== undefined) throw releaseError;
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

export async function withExecutionStateLock(statePath, operation, rootRecoveryOwner = undefined) {
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath) || typeof operation !== 'function') {
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Execution state lock request is invalid.', 503);
  }
  // Only the host operator may preserve a separately owned writer-state lock.
  // Every ordinary caller retains the exact effective-UID check above.
  if (rootRecoveryOwner !== undefined) {
    if (process.platform !== 'linux' || process.geteuid() !== 0
      || !rootRecoveryOwner || typeof rootRecoveryOwner !== 'object' || Array.isArray(rootRecoveryOwner)
      || Object.keys(rootRecoveryOwner).sort().join(',') !== 'gid,uid'
      || !['uid', 'gid'].every(key => Number.isSafeInteger(rootRecoveryOwner[key]) && rootRecoveryOwner[key] >= 0)) {
      throw linuxExecutionStateLockError('EXECUTION_STATE_LOCK_OWNER_INVALID', 'Only a Linux root recovery may bind an exact original lock UID and GID.');
    }
    rootRecoveryOwner = Object.freeze({ uid: rootRecoveryOwner.uid, gid: rootRecoveryOwner.gid });
  }
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  if (process.platform === 'linux') {
    const release = await acquireLinuxExecutionStateLock(lockPath, rootRecoveryOwner);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  // Windows retains the existing owner-record/CAS lease. Linux must never
  // fall back to PID or namespace-based stale reclamation when flock is
  // unavailable: failure to execute the fixed helper is fail-close above.
  await reconcileOrphanedExecutionStateLockClaim(statePath, lockPath);
  let owner;
  const acquire = () => createExecutionStateLockCandidate(statePath, lockPath);
  try {
    owner = await acquire();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const reconciled = await reconcileDeadExecutionStateLock(statePath, lockPath);
    if (!reconciled) {
      throw new ProtectedExecutionError('EXECUTION_STATE_BUSY', 'Another protected execution transition owns the state lock.', 409);
    }
    try {
      owner = await acquire();
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') {
        throw new ProtectedExecutionError('EXECUTION_STATE_BUSY', 'Another protected execution transition acquired the reconciled lock.', 409);
      }
      throw retryError;
    }
  }
  try {
    return await operation();
  } finally {
    await releaseExecutionStateLock(lockPath, owner.ownerNonce);
  }
}

function sameMessage(current, request) {
  return current.route === request.route
    && current.rpcId === request.rpcId
    && current.dshSessionId === request.dshSessionId
    && current.bodyDigest === request.bodyDigest
    && current.textDigest === request.textDigest;
}

function contractProfilesForPhaseAuthority(contract, authority) {
  if (authority.phaseCatalogVersion !== LEGACY_FRONTEND_PROFILE_CATALOG_VERSION
    || !contract.requiredVerificationProfiles.includes(FRONTEND_TYPECHECK_PROFILE)) {
    return contract.requiredVerificationProfiles;
  }
  return contract.requiredVerificationProfiles.filter(
    (profile) => profile !== FRONTEND_TYPECHECK_PROFILE,
  );
}

function assertStoredIdentity(state, projectSlug, taskMetadata, input) {
  if (state && (state.projectSlug !== projectSlug || state.taskId !== taskMetadata.taskId
    || state.actorUserId !== input.actorUserId || state.actorUsername !== input.actorUsername
    || state.conversationId !== input.conversationId)) {
    throw new ProtectedExecutionError(
      'EXECUTION_IDENTITY_MISMATCH',
      'Stored execution identity conflicts with TaskSpace identity.',
      409,
    );
  }
}

async function resolveProtectedExecutionPreparation({
  projectRoot,
  projectSlug,
  taskMetadata,
  request,
  policyPath,
  trustedPolicyInput,
  trustedPhase,
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Project root is invalid.', 503);
  }
  requiredString(projectSlug, PROJECT_SLUG_PATTERN, 'projectSlug');
  const input = validatePrepareRequest(request);
  if (!taskMetadata || taskMetadata.schemaVersion !== 2 || taskMetadata.projectSlug !== projectSlug
    || taskMetadata.status !== 'active' || taskMetadata.accessMode !== 'conversation'
    || taskMetadata.actorUserId !== input.actorUserId
    || taskMetadata.actorId !== input.actorUsername
    || taskMetadata.conversationId !== input.conversationId) {
    throw new ProtectedExecutionError('EXECUTION_IDENTITY_MISMATCH', 'TaskSpace identity cannot issue an execution context.', 409);
  }
  const policy = await loadExecutionPolicy(policyPath);
  let authority = selectAuthority(policy, trustedPolicyInput);
  if (trustedPhase !== undefined) {
    // Only the Manager supplies this after loading the private Controller state.
    // It annotates an already admitted production authority; it cannot grant writes.
    exactKeys(trustedPhase, ['sourceCommit', 'caseFamily', 'phaseAuthority', ...(trustedPhase.crossLayerPreparation === undefined ? [] : ['crossLayerPreparation', 'preparationBinding'])], 'trusted production phase');
    const phase = trustedPhase.phaseAuthority;
    exactKeys(phase, [
      'workflowId', 'phaseId', 'phaseIndex', 'catalogVersion', 'catalogDigest',
      'actionCeiling', 'ownedPaths', 'taskProfiles', 'requiredProfiles',
    ], 'trusted production phase authority');
    let compiledPhaseProfiles = [];
    if (phase?.actionCeiling !== 'read-only' && Array.isArray(authority.ownedPaths)
      && Array.isArray(phase?.taskProfiles)) {
      try {
        compiledPhaseProfiles = compileForgeTaskExecutionContract({
          prompt: 'Configured Controller phase authority',
          actionCeiling: phase.actionCeiling,
          ownedPaths: authority.ownedPaths,
          taskProfiles: phase.taskProfiles,
        }).taskProfiles;
      } catch {
        throw new ProtectedExecutionError('EXECUTION_PHASE_AUTHORITY_INVALID', 'Production phase differs from its admitted authority.', 409);
      }
    }
    if (policy.policyMode !== 'production' || authority.testOnly
      || input.route !== 'session.prompt' || input.classification !== 'claimable-text' || input.mode !== 'queue'
      || !SOURCE_COMMIT_PATTERN.test(trustedPhase.sourceCommit ?? '')
      || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(trustedPhase.caseFamily ?? '')
      || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(phase.workflowId ?? '')
      || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(phase.phaseId ?? '')
      || !Number.isSafeInteger(phase.phaseIndex) || phase.phaseIndex < 0
      || typeof phase.catalogVersion !== 'string' || phase.catalogVersion.length < 1
      || !SHA256_PATTERN.test(phase.catalogDigest ?? '')
      || !Array.isArray(phase.ownedPaths) || !Array.isArray(phase.taskProfiles)
      || !Array.isArray(phase.requiredProfiles)
      || phase.actionCeiling !== authority.actionCeiling
      || (authority.sourceCommit !== null && authority.sourceCommit !== trustedPhase.sourceCommit)
      || authority.ownedPaths.some((candidate) => !phase.ownedPaths.some((root) =>
        candidate === root || candidate.startsWith(`${root}/`)))
      || (phase.actionCeiling === 'read-only' && (phase.ownedPaths.length !== 0 || phase.requiredProfiles.length !== 0))
      || (phase.actionCeiling !== 'read-only' && (authority.ownedPaths.length === 0
        || authority.taskProfiles.some((profile) => !compiledPhaseProfiles.includes(profile))))) {
      throw new ProtectedExecutionError('EXECUTION_PHASE_AUTHORITY_INVALID', 'Production phase differs from its admitted authority.', 409);
    }
    authority = {
      ...authority,
      sourceCommit: trustedPhase.sourceCommit,
      caseFamily: authority.caseFamily ?? trustedPhase.caseFamily,
      taskProfiles: authority.taskProfiles ?? [...phase.taskProfiles],
      workflowId: phase.workflowId,
      phaseId: phase.phaseId,
      phaseIndex: phase.phaseIndex,
      phaseCatalogVersion: phase.catalogVersion,
      phaseCatalogDigest: phase.catalogDigest,
      ...(trustedPhase.crossLayerPreparation === undefined ? {} : { crossLayerPreparation: trustedPhase.crossLayerPreparation, preparationBinding: trustedPhase.preparationBinding }),
    };
  }
  const prompt = input.promptText.length === 0 ? 'Protected execution is read-only.' : input.promptText;
  const compiledContract = compileForgeTaskExecutionContract({
    prompt,
    ownedPaths: authority.ownedPaths,
    actionCeiling: authority.actionCeiling,
    ...(authority.taskProfiles === undefined ? {} : { taskProfiles: authority.taskProfiles }),
  }, { independentReview: Object.hasOwn(authority.taskContract ?? {}, 'suspendedReviewObligations')
    ? 'suspended' : 'required', verificationScope: verificationScopeForContract(authority.taskContract),
    focusedBackendVerification: authority.taskContract?.requiredVerificationProfiles.includes('backend-test-class') === true,
    backendTestBindings: authority.taskContract?.backendTestBindings,
    dualReview: authority.taskContract?.dualReview,
    roleGrantDecisions: authority.taskContract?.roleGrantDecisions,
    semanticResources: authority.taskContract?.semanticResources });
  const contract = authority.taskContract ?? compiledContract;
  // selectAuthority already validated the complete stored derivation.
  // Retain its older UI/TDD requirements instead of rewriting accepted history
  // when the ordinary compiler now derives fewer applicable obligations.
  const preserveHistoricalBehavior = authority.taskContract !== undefined
    && Object.hasOwn(contract, 'suspendedReviewObligations')
    && (!compiledContract.tddRequired || contract.tddRequired)
    && compiledContract.requiredRedProfiles.every((profile) => contract.requiredRedProfiles.includes(profile))
    && compiledContract.requiredObligations.every((id) => contract.requiredObligations.includes(id));
  if (authority.taskContract !== undefined && (!sameSemanticResourceBinding(contract, compiledContract)
    || Object.keys(compiledContract)
    .filter((key) => !['contractId', 'sourceFingerprint'].includes(key))
    .filter((key) => !(preserveHistoricalBehavior
      && ['tddRequired', 'requiredRedProfiles', 'requiredObligations'].includes(key)))
    .some((key) => canonicalStringify(contract[key]) !== canonicalStringify(compiledContract[key])))) {
    throw new ProtectedExecutionError('EXECUTION_POLICY_INVALID', 'Trusted continuation changes the current task requirements.', 503);
  }
  const expectedProductionAuthorityDigest = authority.authorityClass === 'production-task-writer'
    ? digestProductionTaskAuthorityBinding({
      projectSlug,
      taskId: taskMetadata.taskId,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      conversationId: input.conversationId,
      dshSessionId: input.dshSessionId,
      route: input.route,
      rpcId: input.rpcId,
      promptDigest: input.textDigest,
      sourceCommit: authority.sourceCommit,
      workspaceFingerprint: authority.workspaceFingerprint,
      caseFamily: authority.caseFamily,
      productionAuthorityId: authority.productionAuthorityId,
      controllerGrantDigest: authority.controllerGrantDigest,
      contractId: contract.contractId,
      actionCeiling: contract.actionCeiling,
      ownedPaths: contract.ownedPaths,
    })
    : null;
  if (contract.actionCeiling !== authority.actionCeiling
    || JSON.stringify(contract.ownedPaths) !== JSON.stringify(authority.ownedPaths)
    || (authority.expectedContractId !== null && contract.contractId !== authority.expectedContractId)
    || (expectedProductionAuthorityDigest !== null
      && authority.productionAuthorityDigest !== expectedProductionAuthorityDigest)
    || (authority.testOnly
      && JSON.stringify(contractProfilesForPhaseAuthority(contract, authority))
        !== JSON.stringify(authority.requiredProfiles))) {
    throw new ProtectedExecutionError('EXECUTION_POLICY_INVALID', 'Execution policy and deterministic contract disagree.', 503);
  }
  return { input, policy, authority, contract };
}

function validateRecoveryRequest(value) {
  exactKeys(value, [
    'mode', 'operationId', 'authorizationReference', 'expectedPhaseAttemptId',
    'expectedExecutionId', 'expectedClaimId', 'expectedGeneration', 'expectedContractId',
  ], 'execution recovery request');
  if (value.mode !== PROTECTED_EXECUTION_RECOVERY_MODE
    || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1) {
    throw new ProtectedExecutionError('EXECUTION_RECOVERY_INVALID', 'Execution recovery mode or generation is invalid.', 409);
  }
  return {
    mode: value.mode,
    operationId: requiredString(value.operationId, ACTOR_USER_ID_PATTERN, 'recovery operationId'),
    authorizationReference: requiredString(
      value.authorizationReference,
      AUTHORIZATION_REFERENCE_PATTERN,
      'recovery authorizationReference',
    ),
    expectedPhaseAttemptId: requiredString(
      value.expectedPhaseAttemptId,
      ACTOR_USER_ID_PATTERN,
      'recovery expectedPhaseAttemptId',
    ),
    expectedExecutionId: requiredString(
      value.expectedExecutionId,
      ACTOR_USER_ID_PATTERN,
      'recovery expectedExecutionId',
    ),
    expectedClaimId: requiredString(value.expectedClaimId, ACTOR_USER_ID_PATTERN, 'recovery expectedClaimId'),
    expectedGeneration: value.expectedGeneration,
    expectedContractId: requiredString(
      value.expectedContractId,
      SHA256_PATTERN,
      'recovery expectedContractId',
    ),
  };
}

function validatePhaseAttemptBinding(value) {
  exactKeys(value, [
    'attemptId', 'phaseId', 'sessionMode', 'rpcId', 'promptDigest', 'executionGeneration',
  ], 'execution recovery phase attempt');
  if (value.sessionMode !== 'resume' || !Number.isSafeInteger(value.executionGeneration)
    || value.executionGeneration < 1) {
    throw new ProtectedExecutionError('EXECUTION_RECOVERY_MISMATCH', 'Recovery requires an active resumed phase attempt.', 409);
  }
  return {
    attemptId: requiredString(value.attemptId, ACTOR_USER_ID_PATTERN, 'recovery phase attemptId'),
    phaseId: requiredString(value.phaseId, /^[a-z0-9][a-z0-9-]{1,63}$/u, 'recovery phaseId'),
    sessionMode: 'resume',
    rpcId: requiredString(value.rpcId, RPC_ID_PATTERN, 'recovery phase rpcId'),
    promptDigest: requiredString(value.promptDigest, SHA256_PATTERN, 'recovery phase promptDigest'),
    executionGeneration: value.executionGeneration,
  };
}

function validateRecoveryReadback(value, now) {
  exactKeys(value, [
    'schemaVersion', 'sessionId', 'rpcId', 'textDigest', 'observedSeq', 'eventDigest',
    'sessionObserved', 'historyComplete', 'requestObserved', 'turnOpen', 'observedAt',
  ], 'protected session recovery readback');
  const observedAt = Date.parse(value.observedAt);
  if (value.schemaVersion !== PROTECTED_EXECUTION_READBACK_SCHEMA
    || !Number.isSafeInteger(value.observedSeq) || value.observedSeq < 0
    || !SHA256_PATTERN.test(value.eventDigest ?? '')
    || value.sessionObserved !== true || value.historyComplete !== true
    || value.requestObserved !== false || value.turnOpen !== false
    || !Number.isFinite(observedAt) || observedAt > now + 5_000
    || now - observedAt > MAX_RECOVERY_READBACK_AGE_MS) {
    throw new ProtectedExecutionError(
      'EXECUTION_RECOVERY_READBACK_INVALID',
      'Protected session readback does not prove an idle unsubmitted request.',
      409,
    );
  }
  return {
    schemaVersion: PROTECTED_EXECUTION_READBACK_SCHEMA,
    sessionId: requiredString(value.sessionId, DSH_ID_PATTERN, 'recovery readback sessionId'),
    rpcId: requiredString(value.rpcId, RPC_ID_PATTERN, 'recovery readback rpcId'),
    textDigest: requiredString(value.textDigest, SHA256_PATTERN, 'recovery readback textDigest'),
    observedSeq: value.observedSeq,
    eventDigest: value.eventDigest,
    sessionObserved: true,
    historyComplete: true,
    requestObserved: false,
    turnOpen: false,
    observedAt: value.observedAt,
  };
}

export async function prepareProtectedExecutionContext({
  projectRoot,
  projectSlug,
  taskMetadata,
  request,
  now = Date.now(),
  policyPath,
  trustedPolicyInput,
  trustedPhase,
  previousCompletion,
  minimumGeneration,
  expectedExecution,
}) {
  const { input, policy, authority, contract } = await resolveProtectedExecutionPreparation({
    projectRoot, projectSlug, taskMetadata, request, policyPath, trustedPolicyInput, trustedPhase,
  });
  const historicalCompletion = validatePreviousCompletion(previousCompletion, projectSlug, taskMetadata, input);
  if (historicalCompletion !== undefined && (trustedPolicyInput !== undefined
    || authority.authorityClass !== 'production-read-only' || authority.testOnly
    || input.classification !== 'claimable-text' || input.route !== 'session.prompt')) {
    throw new ProtectedExecutionError('EXECUTION_PREVIOUS_COMPLETION_INVALID', 'Historical completion is read-only direct-user context only.', 503);
  }
  if (historicalCompletion !== undefined && Date.parse(historicalCompletion.acceptedAt) > now) {
    throw new ProtectedExecutionError('EXECUTION_PREVIOUS_COMPLETION_INVALID', 'Historical completion timestamp is in the future.', 503);
  }
  if (minimumGeneration !== undefined && (!Number.isSafeInteger(minimumGeneration)
    || minimumGeneration < 2 || historicalCompletion !== undefined
    || trustedPolicyInput === undefined || authority.authorityClass !== 'test-shadow-writer'
    || authority.testOnly !== true || authority.workflowId !== 'crud-production'
    || !((authority.phaseId === 'database' && authority.phaseIndex === 2)
      || (authority.phaseId === 'frontend' && authority.phaseIndex === 5)
      || (authority.phaseId === 'access-wiring' && authority.phaseIndex === 6)
      || (authority.phaseId === 'cross-layer-acceptance' && authority.phaseIndex === 7))
    || authority.caseFamily !== 'crud-complete'
    || authority.actionCeiling !== contract.actionCeiling
    || (authority.phaseIndex === 7
      ? authority.actionCeiling !== 'read-only'
      : authority.actionCeiling !== 'workspace-write')
    || input.classification !== 'claimable-text' || input.route !== 'session.prompt'
    || input.mode !== 'queue')) {
    throw new ProtectedExecutionError(
      'EXECUTION_GENERATION_SEED_DENIED',
      'Only a first protected database, frontend, access-wiring or cross-layer test-shadow execution can inherit a Controller generation floor.',
      409,
    );
  }

  const statePath = executionStatePath(projectRoot, taskMetadata.taskId);
  return withExecutionStateLock(statePath, async () => {
    const previousRaw = await readState(statePath);
    const previous = previousRaw === undefined ? undefined : validateStoredState(previousRaw);
    if (expectedExecution !== undefined && (!expectedExecution
      || Object.keys(expectedExecution).sort().join(',') !== 'executionId,generation'
      || previous?.current.executionId !== expectedExecution.executionId
      || previous?.current.generation !== expectedExecution.generation
      || !sameMessage(previous.current, input)
      || previous.current.workflowId !== null || authority.workflowId !== null
      || authority.authorityClass !== 'production-task-writer')) {
      throw new ProtectedExecutionError('CONVERSATION_TASK_EXECUTION_CHANGED',
        '当前任务或源码授权已变化，请以当前对话请求重新准备任务。', 409);
    }
    if (minimumGeneration !== undefined && previous !== undefined) {
      throw new ProtectedExecutionError(
        'EXECUTION_GENERATION_SEED_DENIED',
        'An existing protected execution cannot be seeded again.',
        409,
      );
    }
    assertStoredIdentity(previous, projectSlug, taskMetadata, input);
    const abandonedReplay = previous?.tombstones.find((entry) => (
      entry.rpcId === input.rpcId && entry.dshSessionId === input.dshSessionId
    ));
    if (abandonedReplay !== undefined) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_ABANDONED',
        'A terminal no-resend tombstone permanently rejects this recovered RPC.',
        409,
      );
    }
    const replaysCurrent = previous && sameMessage(previous.current, input)
      && previous.current.policyVersion === policy.policyVersion
      && previous.current.authorityClass === authority.authorityClass
      && previous.current.testOnly === authority.testOnly
      && previous.current.workflowId === authority.workflowId
      && previous.current.phaseId === authority.phaseId
      && previous.current.phaseIndex === authority.phaseIndex
      && previous.current.phaseCatalogVersion === authority.phaseCatalogVersion
      && previous.current.phaseCatalogDigest === authority.phaseCatalogDigest
      && (previous.current.productionAuthorityDigest ?? null) === authority.productionAuthorityDigest
      && (previous.current.controllerGrantDigest ?? null) === authority.controllerGrantDigest
      && (previous.current.workspaceFingerprint ?? null) === authority.workspaceFingerprint
      && previous.current.contractId === contract.contractId;
    if (replaysCurrent) {
      if (Date.parse(previous.current.expiresAt) <= now) {
        throw new ProtectedExecutionError('EXECUTION_CONTEXT_EXPIRED', 'Protected execution lease expired.', 409);
      }
      if (previous.lifecycle.status === 'submission-attempted'
        && previous.recovery?.status === 'submission-attempted') {
        throw new ProtectedExecutionError(
          'EXECUTION_RECOVERY_REQUIRES_RUNNER',
          'A claimed recovery requires the fixed runner second readback before ingress can be forwarded.',
          409,
        );
      }
      if (['ingress-forwarded', 'consumed', 'abandoned'].includes(previous.lifecycle.status)) {
        throw new ProtectedExecutionError(
          'EXECUTION_CONTEXT_REPLAY_REQUIRES_READBACK',
          'A submitted execution RPC cannot be forwarded again; reconcile it from session history.',
          409,
        );
      }
      if (previous.recovery !== null) {
        throw new ProtectedExecutionError(
          'EXECUTION_RECOVERY_NOT_CLAIMED',
          'A recovery permit cannot authorize ingress until the fixed runner records submissionAttempted.',
          409,
        );
      }
      return Object.freeze({ ...previous.current, idempotent: true, refreshed: false });
    }
    if (previous !== undefined && previous.recovery !== null
      && !['consumed', 'abandoned'].includes(previous.lifecycle.status)) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_IN_PROGRESS',
        'A different prompt cannot replace an execution while exact-context recovery is unresolved.',
        409,
      );
    }

    const generation = previous === undefined && minimumGeneration !== undefined
      ? minimumGeneration : (previous?.generation ?? 0) + 1;
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + EXECUTION_CONTEXT_TTL_MS).toISOString();
    const current = {
      schemaVersion: PROTECTED_EXECUTION_SCHEMA_VERSION,
      issuer: 'forge-conversation-gateway',
      audience: 'forge-phase-budget-guard',
      executionId: crypto.randomUUID(),
      claimId: crypto.randomUUID(),
      projectSlug,
      taskId: taskMetadata.taskId,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      conversationId: input.conversationId,
      generation,
      route: input.route,
      classification: input.classification,
      rpcId: input.rpcId,
      dshSessionId: input.dshSessionId,
      mode: input.mode,
      bodyDigest: input.bodyDigest,
      textDigest: input.textDigest,
      bodyBytes: input.bodyBytes,
      promptDigest: input.textDigest,
      policyVersion: policy.policyVersion,
      authorityClass: authority.authorityClass,
      testOnly: authority.testOnly,
      sourceCommit: authority.sourceCommit,
      workspaceFingerprint: authority.workspaceFingerprint,
      caseFamily: authority.caseFamily,
      productionAuthorityId: authority.productionAuthorityId,
      productionAuthorityDigest: authority.productionAuthorityDigest,
      controllerGrantDigest: authority.controllerGrantDigest,
      workflowId: authority.workflowId,
      phaseId: authority.phaseId,
      phaseIndex: authority.phaseIndex,
      phaseCatalogVersion: authority.phaseCatalogVersion,
      phaseCatalogDigest: authority.phaseCatalogDigest,
      contractId: contract.contractId,
      contractDigest: contract.contractId,
      actionCeiling: contract.actionCeiling,
      ownedPaths: [...contract.ownedPaths],
      requiredProfiles: [...contract.requiredVerificationProfiles],
      contract,
      requestId: input.requestId,
      ...(authority.crossLayerPreparation === undefined ? {} : { crossLayerPreparation: authority.crossLayerPreparation, preparationBinding: authority.preparationBinding }),
      ...(historicalCompletion === undefined ? {} : { previousCompletion: historicalCompletion }),
      issuedAt,
      expiresAt,
    };
    validateProtectedExecutionContext(current, now);
    const state = {
      schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
      revision: previous === undefined ? generation : previous.revision + 1,
      generation,
      projectSlug,
      taskId: taskMetadata.taskId,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      conversationId: input.conversationId,
      current,
      updatedAt: issuedAt,
      lifecycle: { status: 'prepared', consumedAt: null },
      recovery: null,
      tombstones: [...(previous?.tombstones ?? [])],
    };
    validateStoredState(state);
    await atomicWriteJson(statePath, state);
    return Object.freeze({ ...current, idempotent: false, refreshed: false });
  });
}

export async function issueProtectedExecutionRecoveryPermit({
  projectRoot,
  projectSlug,
  taskMetadata,
  request,
  phaseAttempt,
  recovery,
  now = Date.now(),
  policyPath,
  trustedPolicyInput,
}) {
  const { input, policy, authority, contract } = await resolveProtectedExecutionPreparation({
    projectRoot, projectSlug, taskMetadata, request, policyPath, trustedPolicyInput,
  });
  const expected = validateRecoveryRequest(recovery);
  const active = validatePhaseAttemptBinding(phaseAttempt);
  const statePath = executionStatePath(projectRoot, taskMetadata.taskId);
  return withExecutionStateLock(statePath, async () => {
    const raw = await readState(statePath);
    if (raw === undefined) {
      throw new ProtectedExecutionError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution can be recovered.', 409);
    }
    const state = validateStoredState(raw);
    assertStoredIdentity(state, projectSlug, taskMetadata, input);
    const context = state.current;
    const recoveryDeadline = absoluteRecoveryDeadline(context, state.recovery);
    if (!Number.isFinite(recoveryDeadline) || now >= recoveryDeadline) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_AUTHORIZATION_EXPIRED',
        'The absolute recovery window for this original execution has expired.',
        409,
      );
    }
    const replaysCurrent = sameMessage(context, input)
      && context.policyVersion === policy.policyVersion
      && context.authorityClass === authority.authorityClass
      && context.testOnly === authority.testOnly
      && context.contractId === contract.contractId;
    if (!replaysCurrent || context.testOnly !== true || context.authorityClass !== 'test-shadow-writer'
      || context.phaseId === null) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_DENIED',
        'Only the exact expired phased test-shadow execution can receive a recovery permit.',
        409,
      );
    }
    if (state.recovery === null && Date.parse(context.expiresAt) > now) {
      throw new ProtectedExecutionError('EXECUTION_RECOVERY_NOT_REQUIRED', 'A live execution cannot be recovered.', 409);
    }
    if (expected.expectedPhaseAttemptId !== active.attemptId
      || expected.expectedExecutionId !== context.executionId
      || expected.expectedClaimId !== context.claimId
      || expected.expectedGeneration !== context.generation
      || expected.expectedContractId !== context.contractId
      || active.phaseId !== context.phaseId || active.rpcId !== context.rpcId
      || active.promptDigest !== context.promptDigest
      || active.executionGeneration !== context.generation) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_MISMATCH',
        'Recovery identity does not match the active phase attempt and protected context.',
        409,
      );
    }
    if (state.recovery !== null) {
      if (state.recovery.operationId !== expected.operationId) {
        throw new ProtectedExecutionError(
          'EXECUTION_RECOVERY_ALREADY_ISSUED',
          'This execution generation already has a recovery permit.',
          409,
        );
      }
      if (state.recovery.status === 'consumed' || state.lifecycle.status === 'consumed') {
        throw new ProtectedExecutionError('EXECUTION_RECOVERY_CONSUMED', 'A consumed execution cannot be recovered.', 409);
      }
      if (state.recovery.status === 'permitted') {
        if (!['prepared', 'legacy-unverified'].includes(state.lifecycle.status)) {
          throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Pending recovery lifecycle is inconsistent.', 503);
        }
        if (Date.parse(state.recovery.permitExpiresAt) <= now) {
          const renewedAt = new Date(now).toISOString();
          const renewed = {
            ...state.recovery,
            permitIssuedAt: renewedAt,
            permitExpiresAt: new Date(Math.min(
              now + EXECUTION_RECOVERY_PERMIT_TTL_MS,
              recoveryDeadline,
            )).toISOString(),
          };
          const next = {
            ...state,
            revision: state.revision + 1,
            updatedAt: renewedAt,
            recovery: renewed,
          };
          validateStoredState(next);
          await atomicWriteJson(statePath, next);
          return Object.freeze({ ...context, idempotent: true, recoveryPermit: structuredClone(renewed) });
        }
      }
      if (['permitted', 'submission-attempted', 'ingress-forwarded'].includes(state.recovery.status)) {
        return Object.freeze({
          ...context,
          idempotent: true,
          recoveryPermit: structuredClone(state.recovery),
        });
      }
      throw new ProtectedExecutionError('EXECUTION_RECOVERY_CONSUMED', 'A consumed execution cannot be recovered.', 409);
    }
    if (!['prepared', 'legacy-unverified'].includes(state.lifecycle.status)) {
      throw new ProtectedExecutionError('EXECUTION_RECOVERY_CONSUMED', 'A consumed execution cannot be recovered.', 409);
    }
    const permitIssuedAt = new Date(now).toISOString();
    const permit = {
      mode: expected.mode,
      operationId: expected.operationId,
      authorizationReference: expected.authorizationReference,
      phaseAttemptId: active.attemptId,
      generation: context.generation,
      executionId: context.executionId,
      claimId: context.claimId,
      rpcId: context.rpcId,
      promptDigest: context.promptDigest,
      contractId: context.contractId,
      permitIssuedAt,
      permitExpiresAt: new Date(Math.min(
        now + EXECUTION_RECOVERY_PERMIT_TTL_MS,
        recoveryDeadline,
      )).toISOString(),
      originalIssuedAt: context.issuedAt,
      originalExpiresAt: context.expiresAt,
      status: 'permitted',
      readbackSeq: null,
      readbackDigest: null,
      refreshedAt: null,
    };
    const next = {
      ...state,
      schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
      revision: state.revision + 1,
      updatedAt: permitIssuedAt,
      recovery: permit,
    };
    validateStoredState(next);
    await atomicWriteJson(statePath, next);
    return Object.freeze({ ...context, idempotent: false, recoveryPermit: structuredClone(permit) });
  });
}

export async function claimProtectedExecutionRecovery({
  projectRoot,
  taskId,
  operationId,
  readback,
  now = Date.now(),
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Project root is invalid.', 503);
  }
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  requiredString(operationId, ACTOR_USER_ID_PATTERN, 'recovery operationId');
  const observed = validateRecoveryReadback(readback, now);
  const statePath = executionStatePath(projectRoot, taskId);
  return withExecutionStateLock(statePath, async () => {
    const raw = await readState(statePath);
    if (raw === undefined) {
      throw new ProtectedExecutionError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution can be recovered.', 409);
    }
    const state = validateStoredState(raw);
    const context = state.current;
    const permit = state.recovery;
    if (permit === null || permit.operationId !== operationId) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_NOT_PERMITTED',
        'No matching unused execution recovery permit exists.',
        409,
      );
    }
    const recoveryDeadline = absoluteRecoveryDeadline(context, permit);
    if (!Number.isFinite(recoveryDeadline) || now >= recoveryDeadline) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_AUTHORIZATION_EXPIRED',
        'The absolute recovery window for this original execution has expired.',
        409,
      );
    }
    if (permit.status === 'submission-attempted'
      && state.lifecycle.status === 'submission-attempted') {
      if (observed.sessionId !== context.dshSessionId || observed.rpcId !== context.rpcId
        || observed.textDigest !== context.textDigest
        || observed.observedSeq !== permit.readbackSeq
        || observed.eventDigest !== permit.readbackDigest) {
        throw new ProtectedExecutionError(
          'EXECUTION_RECOVERY_READBACK_MISMATCH',
          'A repeated recovery claim must prove the same idle session snapshot.',
          409,
        );
      }
      if (Date.parse(context.expiresAt) <= now) {
        const refreshedAt = new Date(now).toISOString();
        const current = {
          ...context,
          issuedAt: refreshedAt,
          expiresAt: new Date(Math.min(now + EXECUTION_CONTEXT_TTL_MS, recoveryDeadline)).toISOString(),
        };
        const next = {
          ...state,
          revision: state.revision + 1,
          current,
          updatedAt: refreshedAt,
          recovery: { ...permit, refreshedAt },
        };
        validateStoredState(next);
        await atomicWriteJson(statePath, next);
        return Object.freeze({
          ...current,
          recoveryMode: PROTECTED_EXECUTION_RECOVERY_MODE,
          recoveryOperationId: operationId,
          readbackDigest: observed.eventDigest,
          idempotent: true,
          refreshed: true,
        });
      }
      return Object.freeze({
        ...context,
        recoveryMode: PROTECTED_EXECUTION_RECOVERY_MODE,
        recoveryOperationId: operationId,
        readbackDigest: observed.eventDigest,
        idempotent: true,
        refreshed: false,
      });
    }
    if (permit.status !== 'permitted') {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_NOT_PERMITTED',
        'No matching unused execution recovery permit exists.',
        409,
      );
    }
    if (!['prepared', 'legacy-unverified'].includes(state.lifecycle.status)
      || Date.parse(permit.permitExpiresAt) <= now
      || Date.parse(context.expiresAt) > now) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_NOT_PERMITTED',
        'Execution recovery permit is expired, consumed, or no longer applicable.',
        409,
      );
    }
    if (observed.sessionId !== context.dshSessionId || observed.rpcId !== context.rpcId
      || observed.textDigest !== context.textDigest) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_READBACK_MISMATCH',
        'Protected session readback does not match the permitted execution.',
        409,
      );
    }
    const refreshedAt = new Date(now).toISOString();
    const current = {
      ...context,
      issuedAt: refreshedAt,
      expiresAt: new Date(Math.min(now + EXECUTION_CONTEXT_TTL_MS, recoveryDeadline)).toISOString(),
    };
    validateProtectedExecutionContext(current, now);
    const next = {
      ...state,
      revision: state.revision + 1,
      current,
      updatedAt: refreshedAt,
      lifecycle: { status: 'submission-attempted', consumedAt: null },
      recovery: {
        ...permit,
        status: 'submission-attempted',
        readbackSeq: observed.observedSeq,
        readbackDigest: observed.eventDigest,
        refreshedAt,
      },
    };
    validateStoredState(next);
    await atomicWriteJson(statePath, next);
    return Object.freeze({
      ...current,
      recoveryMode: PROTECTED_EXECUTION_RECOVERY_MODE,
      recoveryOperationId: operationId,
      readbackDigest: observed.eventDigest,
      idempotent: false,
    });
  });
}

export async function forwardClaimedProtectedExecutionRecovery({
  projectRoot,
  taskId,
  operationId,
  readback,
  now = Date.now(),
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Project root is invalid.', 503);
  }
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  requiredString(operationId, ACTOR_USER_ID_PATTERN, 'recovery operationId');
  const observed = validateRecoveryReadback(readback, now);
  const statePath = executionStatePath(projectRoot, taskId);
  return withExecutionStateLock(statePath, async () => {
    const raw = await readState(statePath);
    if (raw === undefined) {
      throw new ProtectedExecutionError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution can be recovered.', 409);
    }
    const state = validateStoredState(raw);
    const context = state.current;
    const permit = state.recovery;
    if (permit === null || permit.operationId !== operationId
      || observed.sessionId !== context.dshSessionId || observed.rpcId !== context.rpcId
      || observed.textDigest !== context.textDigest
      || observed.observedSeq !== permit.readbackSeq
      || observed.eventDigest !== permit.readbackDigest) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_READBACK_MISMATCH',
        'The second session readback does not match the claimed recovery snapshot.',
        409,
      );
    }
    if (permit.status === 'ingress-forwarded' && state.lifecycle.status === 'ingress-forwarded') {
      if (Date.parse(context.expiresAt) <= now) {
        throw new ProtectedExecutionError('EXECUTION_CONTEXT_EXPIRED', 'Protected execution lease expired.', 409);
      }
      return Object.freeze({
        ...context,
        recoveryMode: PROTECTED_EXECUTION_RECOVERY_MODE,
        recoveryOperationId: operationId,
        readbackDigest: observed.eventDigest,
        recoveryIngressAuthorized: false,
        idempotent: true,
      });
    }
    if (permit.status !== 'submission-attempted'
      || state.lifecycle.status !== 'submission-attempted'
      || Date.parse(context.expiresAt) <= now) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_NOT_CLAIMED',
        'Only a live claimed recovery can be forwarded to ingress.',
        409,
      );
    }
    const forwardedAt = new Date(now).toISOString();
    const next = {
      ...state,
      revision: state.revision + 1,
      updatedAt: forwardedAt,
      lifecycle: { status: 'ingress-forwarded', consumedAt: null },
      recovery: { ...permit, status: 'ingress-forwarded' },
    };
    validateStoredState(next);
    await atomicWriteJson(statePath, next);
    return Object.freeze({
      ...context,
      recoveryMode: PROTECTED_EXECUTION_RECOVERY_MODE,
      recoveryOperationId: operationId,
      readbackDigest: observed.eventDigest,
      recoveryIngressAuthorized: true,
      idempotent: false,
    });
  });
}

function validateRecoveryAbandonmentReadback(value, now) {
  exactKeys(value, [
    'sessionId', 'rpcId', 'textDigest', 'observedSeq', 'eventDigest', 'historyComplete',
    'requestObserved', 'turnOpen', 'sessionRunning', 'observedAt',
    'baselineSeq', 'baselineDigest',
  ], 'protected execution abandonment readback');
  const observedAt = Date.parse(value.observedAt);
  if (!Number.isSafeInteger(value.observedSeq) || value.observedSeq < 0
    || !SHA256_PATTERN.test(value.eventDigest ?? '')
    || value.historyComplete !== true || typeof value.requestObserved !== 'boolean'
    || value.turnOpen !== false || value.sessionRunning !== false
    || !((value.baselineSeq === null && value.baselineDigest === null)
      || (Number.isSafeInteger(value.baselineSeq) && value.baselineSeq >= 0
        && SHA256_PATTERN.test(value.baselineDigest ?? '')))
    || !Number.isFinite(observedAt) || observedAt > now + 5_000
    || now - observedAt > MAX_RECOVERY_READBACK_AGE_MS) {
    throw new ProtectedExecutionError(
      'EXECUTION_RECOVERY_ABANDONMENT_INVALID',
      'Recovery abandonment requires a fresh, complete, stable idle session readback.',
      409,
    );
  }
  return Object.freeze({
    sessionId: requiredString(value.sessionId, DSH_ID_PATTERN, 'abandonment sessionId'),
    rpcId: requiredString(value.rpcId, RPC_ID_PATTERN, 'abandonment rpcId'),
    textDigest: requiredString(value.textDigest, SHA256_PATTERN, 'abandonment textDigest'),
    observedSeq: value.observedSeq,
    eventDigest: value.eventDigest,
    historyComplete: true,
    requestObserved: value.requestObserved,
    turnOpen: false,
    sessionRunning: false,
    observedAt: value.observedAt,
    baselineSeq: value.baselineSeq,
    baselineDigest: value.baselineDigest,
  });
}

export async function abandonClaimedProtectedExecutionRecovery({
  projectRoot,
  taskId,
  operationId,
  executionId,
  claimId,
  generation,
  contractId,
  phaseAttemptId,
  readback,
  reason = 'stable-idle-unconsumed-no-resend',
  now = Date.now(),
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Project root is invalid.', 503);
  }
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  for (const [label, value] of [
    ['recovery operationId', operationId], ['executionId', executionId],
    ['claimId', claimId], ['phaseAttemptId', phaseAttemptId],
  ]) requiredString(value, ACTOR_USER_ID_PATTERN, label);
  requiredString(contractId, SHA256_PATTERN, 'contractId');
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution generation is invalid.', 503);
  }
  if (![
    'stable-idle-unconsumed-no-resend',
    'stable-idle-pre-ingress-cancelled-no-resend',
  ].includes(reason)) {
    throw new ProtectedExecutionError(
      'EXECUTION_RECOVERY_ABANDONMENT_INVALID',
      'Recovery abandonment reason is invalid.',
      409,
    );
  }
  const observation = validateRecoveryAbandonmentReadback(readback, now);
  const statePath = executionStatePath(projectRoot, taskId);
  return withExecutionStateLock(statePath, async () => {
    const raw = await readState(statePath);
    if (raw === undefined) {
      throw new ProtectedExecutionError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution can be abandoned.', 409);
    }
    const state = validateStoredState(raw);
    const permit = state.recovery;
    const exactIdentity = state.taskId === taskId && state.current.executionId === executionId
      && state.current.claimId === claimId && state.current.generation === generation
      && state.current.contractId === contractId && permit !== null
      && permit.operationId === operationId && permit.phaseAttemptId === phaseAttemptId
      && permit.executionId === executionId && permit.claimId === claimId
      && permit.generation === generation && permit.contractId === contractId
      && state.current.dshSessionId === observation.sessionId
      && state.current.rpcId === observation.rpcId
      && state.current.textDigest === observation.textDigest
      && ((permit.readbackSeq === null && observation.baselineSeq === null
        && observation.baselineDigest === null)
        || (permit.readbackSeq === observation.baselineSeq
          && permit.readbackDigest === observation.baselineDigest));
    if (!exactIdentity) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_STATUS_MISMATCH',
        'Protected execution abandonment drifted from the exact recovery identity.',
        409,
      );
    }
    const existing = state.tombstones.find((entry) => (
      entry.operationId === operationId && entry.executionId === executionId
    ));
    if (state.lifecycle.status === 'abandoned' && permit.status === 'abandoned') {
      if (existing === undefined || existing.reason !== reason) {
        throw new ProtectedExecutionError('EXECUTION_STATE_INVALID', 'Abandoned recovery lost its tombstone.', 503);
      }
      return Object.freeze({
        lifecycleStatus: 'abandoned', recoveryStatus: 'abandoned', exactIdentity: true,
        idempotent: true, tombstone: existing,
      });
    }
    const abandonable = (
      ['submission-attempted', 'ingress-forwarded'].includes(state.lifecycle.status)
      && permit.status === state.lifecycle.status
    ) || (
      ['prepared', 'legacy-unverified'].includes(state.lifecycle.status)
      && permit.status === 'permitted'
    );
    if (!abandonable) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_NOT_ABANDONABLE',
        'Only an exact unconsumed recovery can be terminalized after stable idle readback.',
        409,
      );
    }
    if (state.tombstones.length >= MAX_EXECUTION_RECOVERY_TOMBSTONES) {
      throw new ProtectedExecutionError(
        'EXECUTION_RECOVERY_TOMBSTONE_LIMIT',
        'The permanent no-resend tombstone capacity is exhausted.',
        409,
      );
    }
    const abandonedAt = new Date(now).toISOString();
    const tombstone = {
      operationId,
      phaseAttemptId,
      executionId,
      claimId,
      generation,
      contractId,
      rpcId: observation.rpcId,
      dshSessionId: observation.sessionId,
      textDigest: observation.textDigest,
      abandonedAt,
      reason,
      requestObserved: observation.requestObserved,
      observedSeq: observation.observedSeq,
      eventDigest: observation.eventDigest,
    };
    validateExecutionRecoveryTombstone(tombstone);
    const next = {
      ...state,
      schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
      revision: state.revision + 1,
      updatedAt: abandonedAt,
      lifecycle: { status: 'abandoned', consumedAt: null },
      recovery: { ...permit, status: 'abandoned' },
      tombstones: [...state.tombstones, tombstone],
    };
    validateStoredState(next);
    await atomicWriteJson(statePath, next);
    return Object.freeze({
      lifecycleStatus: 'abandoned', recoveryStatus: 'abandoned', exactIdentity: true,
      idempotent: false, tombstone: Object.freeze({ ...tombstone }),
    });
  });
}

export async function readProtectedExecutionRecoveryStatus({
  projectRoot,
  taskId,
  operationId,
  executionId,
  claimId,
  generation,
  contractId,
  phaseAttemptId,
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new ProtectedExecutionError('EXECUTION_STATE_UNAVAILABLE', 'Project root is invalid.', 503);
  }
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  for (const [label, value] of [
    ['recovery operationId', operationId],
    ['executionId', executionId],
    ['claimId', claimId],
    ['phaseAttemptId', phaseAttemptId],
  ]) requiredString(value, ACTOR_USER_ID_PATTERN, label);
  requiredString(contractId, SHA256_PATTERN, 'contractId');
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution generation is invalid.', 503);
  }
  const statePath = executionStatePath(projectRoot, taskId);
  const raw = await readStateStableReadOnly(statePath);
  if (raw === undefined) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution can be observed.', 409);
  }
  const state = validateStoredState(raw);
  const permit = state.recovery;
  if (state.taskId !== taskId || state.current.executionId !== executionId
    || state.current.claimId !== claimId || state.current.generation !== generation
    || state.current.contractId !== contractId || permit === null
    || permit.operationId !== operationId || permit.phaseAttemptId !== phaseAttemptId
    || permit.executionId !== executionId || permit.claimId !== claimId
    || permit.generation !== generation || permit.contractId !== contractId) {
    throw new ProtectedExecutionError(
      'EXECUTION_RECOVERY_STATUS_MISMATCH',
      'Protected execution recovery status drifted from the exact recovery identity.',
      409,
    );
  }
  const consumed = state.lifecycle.status === 'consumed' && permit.status === 'consumed';
  const terminalTombstone = state.lifecycle.status === 'abandoned' && permit.status === 'abandoned'
    ? state.tombstones.find((entry) => (
        entry.operationId === operationId && entry.executionId === executionId
      )) ?? null
    : null;
  return Object.freeze({
    schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
    revision: state.revision,
    taskId,
    operationId,
    executionId,
    claimId,
    generation,
    contractId,
    phaseAttemptId,
    lifecycleStatus: state.lifecycle.status,
    recoveryStatus: permit.status,
    consumed,
    consumedAt: consumed ? state.lifecycle.consumedAt : null,
    recoveryReadbackSeq: permit.readbackSeq,
    recoveryReadbackDigest: permit.readbackDigest,
    terminalTombstone,
  });
}

export function validateProtectedExecutionContext(value, now = undefined) {
  exactKeys(value, [
    'schemaVersion', 'issuer', 'audience', 'executionId', 'claimId', 'projectSlug', 'taskId',
    'actorUserId', 'actorUsername', 'conversationId', 'generation', 'route', 'classification',
    'rpcId', 'dshSessionId', 'mode', 'bodyDigest', 'textDigest', 'bodyBytes', 'promptDigest',
    'policyVersion', 'authorityClass', 'testOnly', 'sourceCommit', 'workspaceFingerprint', 'caseFamily',
    'productionAuthorityId', 'productionAuthorityDigest', 'controllerGrantDigest',
    'workflowId', 'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest',
    'contractId', 'contractDigest', 'actionCeiling', 'ownedPaths',
    'requiredProfiles', 'contract', 'requestId', 'issuedAt', 'expiresAt',
    ...(Object.hasOwn(value, 'previousCompletion') ? ['previousCompletion'] : []),
    ...(Object.hasOwn(value, 'crossLayerPreparation') ? ['crossLayerPreparation', 'preparationBinding'] : []),
  ], 'protected execution context');
  if (value.schemaVersion !== PROTECTED_EXECUTION_SCHEMA_VERSION
    || value.issuer !== 'forge-conversation-gateway'
    || value.audience !== 'forge-phase-budget-guard'
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !DSH_PROMPT_ROUTES.has(value.route)
    || !EXECUTION_CLASSIFICATIONS.has(value.classification)
    || !Number.isSafeInteger(value.bodyBytes) || value.bodyBytes < 0) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution context envelope is invalid.', 503);
  }
  for (const [entry, pattern] of [
    [value.executionId, ACTOR_USER_ID_PATTERN], [value.claimId, ACTOR_USER_ID_PATTERN],
    [value.projectSlug, PROJECT_SLUG_PATTERN], [value.taskId, TASK_ID_PATTERN],
    [value.actorUserId, ACTOR_USER_ID_PATTERN], [value.actorUsername, ACTOR_ID_PATTERN],
    [value.conversationId, CONVERSATION_ID_PATTERN], [value.requestId, REQUEST_ID_PATTERN],
  ]) requiredString(entry, pattern, 'protected execution identity');
  optionalString(value.rpcId, RPC_ID_PATTERN, 'context rpcId');
  optionalString(value.dshSessionId, DSH_ID_PATTERN, 'context dshSessionId');
  optionalString(value.bodyDigest, SHA256_PATTERN, 'context bodyDigest');
  optionalString(value.textDigest, SHA256_PATTERN, 'context textDigest');
  optionalString(value.promptDigest, SHA256_PATTERN, 'context promptDigest');
  const previousCompletion = validatePreviousCompletion(value.previousCompletion, value.projectSlug, {
    taskId: value.taskId,
  }, {
    actorUserId: value.actorUserId,
    actorUsername: value.actorUsername,
    conversationId: value.conversationId,
    dshSessionId: value.dshSessionId,
  });
  if (typeof value.policyVersion !== 'string' || value.policyVersion.length < 1 || value.policyVersion.length > 128
    || value.contractId !== value.contractDigest || !SHA256_PATTERN.test(value.contractId)
    || !['production-read-only', 'production-task-writer', 'test-shadow-writer'].includes(value.authorityClass)
    || typeof value.testOnly !== 'boolean'
    || !Array.isArray(value.ownedPaths)
    || !Array.isArray(value.requiredProfiles)) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution authority is invalid.', 503);
  }
  if (value.crossLayerPreparation !== undefined) {
    const binding = value.preparationBinding;
    exactKeys(binding, ['stateDigest', 'acceptedArtifactDigests', 'baseSourceCommit', 'workspaceFingerprint'], 'cross-layer preparation binding');
    const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation', 'ui-interaction-contract',
      'backend-implementation', 'frontend-implementation', 'access-wiring-implementation'];
    exactKeys(binding.acceptedArtifactDigests, kinds, 'cross-layer accepted artifacts');
    if (value.crossLayerPreparation !== true || value.authorityClass !== 'production-read-only' || value.testOnly
      || value.workflowId !== 'crud-production' || value.phaseId !== 'cross-layer-acceptance' || value.phaseIndex !== 7
      || value.actionCeiling !== 'read-only' || value.ownedPaths.length !== 0 || value.requiredProfiles.length !== 0
      || binding.baseSourceCommit !== value.sourceCommit || !SHA256_PATTERN.test(binding.stateDigest ?? '')
      || !SHA256_PATTERN.test(binding.workspaceFingerprint ?? '')
      || !Object.values(binding.acceptedArtifactDigests).every(digest => SHA256_PATTERN.test(digest))) {
      throw new ProtectedExecutionError('EXECUTION_PHASE_AUTHORITY_INVALID', 'Cross-layer preparation must retain its readonly accepted source binding.', 409);
    }
  }
  const hasPhase = value.phaseId !== null;
  const productionAuthorityFieldsAbsent = [
    value.productionAuthorityId,
    value.productionAuthorityDigest,
    value.controllerGrantDigest,
    value.workspaceFingerprint,
  ].every((entry) => entry === null || entry === undefined);
  if ((hasPhase && (typeof value.workflowId !== 'string'
      || typeof value.phaseId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(value.phaseId)
      || !Number.isSafeInteger(value.phaseIndex) || value.phaseIndex < 0
      || typeof value.phaseCatalogVersion !== 'string' || value.phaseCatalogVersion.length < 1
      || typeof value.phaseCatalogDigest !== 'string' || !SHA256_PATTERN.test(value.phaseCatalogDigest)))
    || (!hasPhase && [value.workflowId, value.phaseIndex, value.phaseCatalogVersion, value.phaseCatalogDigest]
      .some((entry) => entry !== null))) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution phase binding is invalid.', 503);
  }
  if ((value.authorityClass === 'production-read-only'
      && (value.testOnly || (hasPhase
        ? !SOURCE_COMMIT_PATTERN.test(value.sourceCommit ?? '') || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(value.caseFamily ?? '')
        : value.sourceCommit !== null || value.caseFamily !== null)
        || !productionAuthorityFieldsAbsent
        || value.actionCeiling !== 'read-only' || value.ownedPaths.length !== 0))
    || (value.authorityClass === 'production-task-writer'
      && (value.testOnly || !/^[0-9a-f]{40}$/u.test(value.sourceCommit ?? '')
        || !SHA256_PATTERN.test(value.workspaceFingerprint ?? '')
        || typeof value.caseFamily !== 'string'
        || !ACTOR_USER_ID_PATTERN.test(value.productionAuthorityId ?? '')
        || !SHA256_PATTERN.test(value.productionAuthorityDigest ?? '')
        || !SHA256_PATTERN.test(value.controllerGrantDigest ?? '')
        || !PRODUCTION_TASK_ACTION_CEILINGS.has(value.actionCeiling) || value.ownedPaths.length < 1))
    || (value.authorityClass === 'test-shadow-writer'
      && (!value.testOnly || !/^[0-9a-f]{40}$/u.test(value.sourceCommit)
        || !productionAuthorityFieldsAbsent
        || typeof value.caseFamily !== 'string'
        || (!hasPhase && (value.actionCeiling !== 'workspace-write' || value.ownedPaths.length < 1))
        || (hasPhase && !['read-only', 'workspace-write'].includes(value.actionCeiling))
        || (hasPhase && value.actionCeiling === 'read-only' && value.ownedPaths.length !== 0)
        || (hasPhase && value.actionCeiling === 'workspace-write' && value.ownedPaths.length < 1)))) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution authority class is inconsistent.', 503);
  }
  if (previousCompletion !== undefined && (value.authorityClass !== 'production-read-only'
    || value.classification !== 'claimable-text' || value.route !== 'session.prompt'
    || value.actionCeiling !== 'read-only' || value.ownedPaths.length !== 0
    || Date.parse(previousCompletion.acceptedAt) > Date.parse(value.issuedAt))) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Historical completion is inconsistent with this read-only context.', 503);
  }
  const contract = validateForgeTaskExecutionContract(value.contract);
  if (contract.contractId !== value.contractId || contract.actionCeiling !== value.actionCeiling
    || JSON.stringify(contract.ownedPaths) !== JSON.stringify(value.ownedPaths)
    || JSON.stringify(contract.requiredVerificationProfiles) !== JSON.stringify(value.requiredProfiles)) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution contract binding is invalid.', 503);
  }
  if (value.authorityClass === 'production-task-writer'
    && value.productionAuthorityDigest !== digestProductionTaskAuthorityBinding({
      projectSlug: value.projectSlug,
      taskId: value.taskId,
      actorUserId: value.actorUserId,
      actorUsername: value.actorUsername,
      conversationId: value.conversationId,
      dshSessionId: value.dshSessionId,
      route: value.route,
      rpcId: value.rpcId,
      promptDigest: value.promptDigest,
      sourceCommit: value.sourceCommit,
      workspaceFingerprint: value.workspaceFingerprint,
      caseFamily: value.caseFamily,
      productionAuthorityId: value.productionAuthorityId,
      controllerGrantDigest: value.controllerGrantDigest,
      contractId: value.contractId,
      actionCeiling: value.actionCeiling,
      ownedPaths: value.ownedPaths,
    })) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected production authority binding is invalid.', 503);
  }
  const issuedAtMs = Date.parse(value.issuedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > EXECUTION_CONTEXT_TTL_MS) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_INVALID', 'Protected execution lease is invalid.', 503);
  }
  if (now !== undefined && expiresAtMs <= now) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_EXPIRED', 'Protected execution lease expired.', 409);
  }
  return value;
}

function currentSourceTransition(value, context) {
  if (value === undefined || value === null) return null;
  let transition;
  try { transition = validateSourceTransition(value); } catch { return null; }
  if (!['checkpointed', 'integrated'].includes(transition.phase) || transition.from.head !== context.sourceCommit
    || transition.from.head === transition.to.head
    || (transition.phase === 'checkpointed' && transition.from.fingerprint !== transition.to.fingerprint)
    || (transition.phase === 'integrated' && !['git-checkpoint', 'release'].includes(context.actionCeiling))
    || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
      .every((key) => transition.task[key] === context[key])
    || !['executionId', 'generation', 'contractId', 'productionAuthorityDigest', 'controllerGrantDigest',
      'actionCeiling', 'issuedAt', 'expiresAt'].every((key) => transition.sourceAuthority[key] === context[key])) return null;
  return transition;
}

export function isDatabasePhaseWriter(context) {
  return context?.authorityClass === 'production-task-writer' && context.testOnly === false
    && context.workflowId === 'crud-production' && context.phaseId === 'database' && context.phaseIndex === 2
    && context.actionCeiling === 'workspace-write' && Array.isArray(context.ownedPaths) && context.ownedPaths.length > 0;
}

export function isDatabaseOrBackendPhaseWriter(context) {
  return isDatabasePhaseWriter(context) || (context?.authorityClass === 'production-task-writer' && context.testOnly === false
    && context.workflowId === 'crud-production' && context.phaseId === 'backend' && context.phaseIndex === 4
    && context.actionCeiling === 'workspace-write' && Array.isArray(context.ownedPaths) && context.ownedPaths.length > 0);
}

export function isRenewableWorkflowPhaseWriter(context) {
  return isDatabaseOrBackendPhaseWriter(context) || (context?.authorityClass === 'production-task-writer' && context.testOnly === false
    && context.workflowId === 'crud-production'
    && ((context.phaseId === 'frontend' && context.phaseIndex === 5) || (context.phaseId === 'access-wiring' && context.phaseIndex === 6))
    && context.actionCeiling === 'workspace-write' && Array.isArray(context.ownedPaths) && context.ownedPaths.length > 0);
}

export async function readProtectedExecutionContext({ projectRoot, taskMetadata, lookup, renew, sourceTransition, now = Date.now() }) {
  const statePath = executionStatePath(projectRoot, taskMetadata.taskId);
  return withExecutionStateLock(statePath, async () => {
    const stored = await readState(statePath);
    if (stored === undefined) {
      throw new ProtectedExecutionError(
        'EXECUTION_CONTEXT_UNAVAILABLE',
        'No protected execution context has been prepared for this TaskSpace.',
        409,
      );
    }
    let state = validateStoredState(stored);
    let context = state.current;
    if (state.projectSlug !== taskMetadata.projectSlug || state.taskId !== taskMetadata.taskId
      || state.actorUserId !== taskMetadata.actorUserId || state.actorUsername !== taskMetadata.actorId
      || state.conversationId !== taskMetadata.conversationId
      || context.projectSlug !== lookup.projectSlug || context.taskId !== lookup.taskId
      || context.conversationId !== lookup.conversationId || context.actorUserId !== lookup.actorUserId
      || context.dshSessionId !== lookup.dshSessionId || context.rpcId !== lookup.rpcId
      || context.textDigest !== lookup.textDigest) {
      throw new ProtectedExecutionError('EXECUTION_CONTEXT_MISMATCH', 'Protected execution context does not match the current direct user message.', 409);
    }
    const checkpointTransition = currentSourceTransition(sourceTransition, context);
    const integrated = checkpointTransition?.phase === 'integrated';
    if (typeof renew === 'function' && (Date.parse(context.expiresAt) <= now + 30_000 || checkpointTransition !== null)
      && state.lifecycle.status === 'consumed' && state.recovery === null
      && taskMetadata.status === 'active' && taskMetadata.accessMode === 'conversation'
      && context.authorityClass === 'production-task-writer' && ['workspace-write', 'git-checkpoint', 'release'].includes(context.actionCeiling)
      && (context.workflowId === null || (isRenewableWorkflowPhaseWriter(context) && checkpointTransition === null)) && context.testOnly === false) {
      const result = await renew(Object.freeze({ ...context }), checkpointTransition);
      const authority = result?.authority;
      const identity = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
        'dshSessionId', 'rpcId', 'promptDigest', 'contractId', 'actionCeiling'];
      let confirmedTransition = null;
      if (checkpointTransition !== null) {
        try { confirmedTransition = validateSourceTransition(result?.sourceTransition); } catch { /* Reject below. */ }
      }
      let renewedContract;
      if (Object.hasOwn(result?.trustedPolicyInput?.taskAuthority ?? {}, 'contract')) {
        try { renewedContract = validateForgeTaskExecutionContract(result.trustedPolicyInput.taskAuthority.contract); }
        catch { throw new ProtectedExecutionError('EXECUTION_RENEWAL_MISMATCH', 'Renewed task contract is invalid.', 409); }
      }
      if (!authority || !identity.every((key) => authority[key] === context[key])
        || authority.sourceCommit !== (checkpointTransition?.to.head ?? context.sourceCommit)
        || (isRenewableWorkflowPhaseWriter(context) && authority.workspaceFingerprint !== context.workspaceFingerprint)
        || (checkpointTransition !== null && (confirmedTransition?.digest !== checkpointTransition.digest
          || authority.workspaceFingerprint !== checkpointTransition.to.fingerprint))
        || canonicalStringify(authority.ownedPaths) !== canonicalStringify(context.ownedPaths)
        || result.trustedPolicyInput?.profile !== 'production-controller'
        || result.trustedPolicyInput?.expectedContractId !== context.contractId
        || result.trustedPolicyInput?.taskAuthority?.actionCeiling !== context.actionCeiling
        || !sameSemanticResourceBinding(renewedContract, context.contract)
        || (renewedContract !== undefined && renewedContract.contractId !== context.contractId)
        || Date.parse(authority.expiresAt) <= now) {
        throw new ProtectedExecutionError('EXECUTION_RENEWAL_MISMATCH', 'Renewed authority does not match the active draft task.', 409);
      }
      context = { ...context, sourceCommit: authority.sourceCommit, workspaceFingerprint: authority.workspaceFingerprint,
        productionAuthorityId: authority.authorityId, productionAuthorityDigest: authority.productionAuthorityDigest,
        controllerGrantDigest: authority.controllerGrantDigest, issuedAt: authority.issuedAt, expiresAt: authority.expiresAt };
      if (integrated) {
        // A merged source is a fresh execution of the same authorized task. It
        // never carries the previous candidate's completion or verification state.
        context = { ...context, executionId: crypto.randomUUID(), claimId: crypto.randomUUID(), generation: context.generation + 1 };
        delete context.previousCompletion;
      }
      validateProtectedExecutionContext(context, now);
      state = { ...state, current: context, generation: context.generation, revision: state.revision + 1, updatedAt: new Date(now).toISOString() };
      validateStoredState(state);
      await atomicWriteJson(statePath, state);
    }
    validateProtectedExecutionContext(context, now);
    if (state.lifecycle.status !== 'consumed') {
      if (state.recovery !== null && state.recovery.status !== 'ingress-forwarded') {
        throw new ProtectedExecutionError(
          'EXECUTION_RECOVERY_NOT_FORWARDED',
          'A recovered execution must pass its one-shot ingress transition before prompt consumption.',
          409,
        );
      }
      const consumedAt = new Date(now).toISOString();
      const next = {
        ...state,
        schemaVersion: PROTECTED_EXECUTION_STATE_SCHEMA_VERSION,
        revision: state.revision + 1,
        updatedAt: consumedAt,
        lifecycle: { status: 'consumed', consumedAt },
        recovery: state.recovery === null ? null : { ...state.recovery, status: 'consumed' },
      };
      validateStoredState(next);
      await atomicWriteJson(statePath, next);
    }
    return Object.freeze({ ...context });
  });
}

export async function readCurrentProtectedExecutionContextForTask({ projectRoot, taskMetadata, now = Date.now(), allowExpiredForRenewal = false }) {
  const stored = await readState(executionStatePath(projectRoot, taskMetadata.taskId));
  if (stored === undefined) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution context has been prepared for this TaskSpace.', 409);
  }
  const state = validateStoredState(stored);
  const context = validateProtectedExecutionContext(state.current, allowExpiredForRenewal ? undefined : now);
  if (state.projectSlug !== taskMetadata.projectSlug || state.taskId !== taskMetadata.taskId
    || state.actorUserId !== taskMetadata.actorUserId || state.actorUsername !== taskMetadata.actorId
    || state.conversationId !== taskMetadata.conversationId) {
    throw new ProtectedExecutionError('EXECUTION_CONTEXT_MISMATCH', 'Protected execution context does not match the authenticated TaskSpace.', 409);
  }
  if (allowExpiredForRenewal && (state.lifecycle.status !== 'consumed' || state.recovery !== null
    || taskMetadata.status !== 'active' || taskMetadata.accessMode !== 'conversation'
    || context.authorityClass !== 'production-task-writer' || !['workspace-write', 'git-checkpoint', 'release'].includes(context.actionCeiling)
    || (context.workflowId !== null && !isRenewableWorkflowPhaseWriter(context)) || context.testOnly !== false)) {
    throw new ProtectedExecutionError('EXECUTION_RENEWAL_DENIED', 'Only the currently consumed ordinary writer context can request renewal.', 409);
  }
  return Object.freeze({ ...context });
}
