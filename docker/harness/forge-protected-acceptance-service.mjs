#!/usr/bin/env node

import crypto from 'node:crypto';
import { ManagedFileError, loadManagedFileTargets, validateManagedFileTargets, managedFileIntentForPrompt, authorizeManagedFileRequest } from './forge-managed-files.mjs';
import {
  REVIEWED_RECEIPT_SOURCE_PROJECTION, reviewedReceiptPolicyDigest, reviewedReceiptGovernanceBindingDigest,
  validateReviewedReceiptSourcePolicy, validateReviewedReceiptSourceBinding,
} from './forge-host-verification-receipt.mjs';
import http from 'node:http';
import path from 'node:path';
import {
  chmod, lstat, mkdir, open, opendir, readFile, rename, rm,
} from 'node:fs/promises';
import {
  ACCEPTANCE_DOCUMENT_TYPES,
  ACCEPTANCE_DIAGNOSTIC_RECEIPT_TYPE,
  aggregateAcceptance,
  canonicalSha256,
  signAcceptanceDocument,
  validateAcceptanceContract,
  validateAcceptanceTrustPolicy,
  verifyAcceptanceEvidenceReceipt,
  verifyAcceptanceDiagnosticReceipt,
} from './forge-acceptance-aggregator.mjs';
import { forgeReviewFindingDigest, validateForgeDualReviewEvidence, validateForgeReviewPredecessor } from './forge-change-contract.mjs';
import {
  advanceForgeObligationLedgerSource,
  createForgeObligationLedger,
  restoreForgeObligationLedger,
  serializeForgeObligationLedger,
  summarizeForgeObligationLedger,
} from './forge-obligation-ledger.mjs';
import {
  applyProtectedIssuerReceipt,
  evaluateProtectedLedgerCompletion,
  ForgeProtectedIssuerAdapterError,
} from './forge-protected-issuer-adapter.mjs';
import {
  validateHostExecutionAdmissionReceipt,
  isHostRunReceipt,
  validateHostRunReceipt,
} from './forge-host-verification-receipt.mjs';
import { hostVerificationCommand } from './host-verify-policy.mjs';
import { VERIFY_PROFILE_NAMES, frontendTestScopeFilters, selectorDigest, verificationCommand, governanceTaskScopeForContract, governanceTaskScopeArguments, revalidatedGovernanceTaskArguments, governanceRoleGrantPolicyForContract, governanceRoleGrantArguments, governanceSourceProvenanceArguments, normalizeAcceptedApiContract, governanceAcceptedApiContractArguments } from './verify-policy.mjs';
import { normalizeReferenceProvenancePolicy } from './forge-reference-provenance.mjs';
import {
  digestProductionTaskAuthorityBinding,
  digestDirectUserTextContent,
  hasGlobalReadOnlyIntent,
  hasDirectControlledPreparationIntent,
  CHANGED_VERIFICATION_CLAUSE,
  QUESTION_REQUEST,
  ATTRIBUTED_RELEASE_SENTENCE,
  hasDirectSubmitIntegrateRelease,
  hasUiInteractionWriteIntent,
} from './forge-execution-context.mjs';
import {
  compileForgeTaskExecutionContract,
  normalizeForgeDualReviewBinding,
  normalizeForgeRoleGrantDecisions,
  normalizeForgeTaskOwnedPaths,
  backendTestSelectorsForContract,
  deriveForgeTaskIntent,
  isForgeTaskOwnedPath,
  TASK_PROFILES,
  H5_TEST_FILE_PATTERN,
  validateForgeTaskExecutionContract,
  verificationScopeForContract,
} from './forge-task-execution-contract.mjs';
import { compileConversationTaskProposal, conversationWriterScopeOwnsPath, isCurrentProjectWriterScope } from './forge-conversation-task-proposal.mjs';
import { normalizeForgeSemanticResources } from './forge-semantic-resource-lease.mjs';
import {
  createProductionTaskGrant,
  rebindProductionTaskGrantAfterIntegration,
  renewProductionTaskGrant,
  ProductionTaskGrantError,
  productionTaskGrantFile,
  sealProductionTaskGrantClaim,
  validateProductionTaskGrant,
  validateProductionTaskGrantRecord,
} from './forge-production-task-grant.mjs';
import { validateSourceTransition } from './taskspace-policy.mjs';
import { explicitRoleGrantRecipients } from './forge-governance.mjs';

const SERVICE_TYPE = 'forge-protected-acceptance-service/v1';
const RECORD_TYPE = 'forge-protected-acceptance-record/v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TASK_ID = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ACTOR_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTOR_USERNAME = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const DSH_ID = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID = /^[^\0\r\n]{1,256}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PRODUCTION_AUTHORITY_TYPE = 'forge-protected-execution/production-task-authority/v1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SEMANTIC_REVIEW_SUMMARY_BYTES = 32 * 1024;
const REVIEW_FEEDBACK_MARKER = '独审事实反馈：';
const REVIEW_FEEDBACK_ID = /^review-[0-9a-f]{64}$/u;
const REVIEW_FEEDBACK_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|(?:password|passwd|secret|token|api[_-]?key|密码)\s*[:=]\s*\S/iu;
const CONTINUE_TASK = /^(?:(?:确认|确定|同意)(?:执行|实施|修改|开始)?|执行|继续(?:执行|实施|修改|完成)?|开始执行)[。！!\s]*$/u;
const CONFIRM_CURRENT_SCOPE = /^(?:请)?(?:确认|确定|同意|继续|直接)(?:执行|实施)(?:该|这个|当前|本次|上述)(?:任务)?范围(?:并(?<action>提交(?:代码)?|发布|发版|部署|上线))?[。！!\s]*$/u;
const DIRECT_EXECUTION_AFTER_CONFIRMATION = /^(?:无需|不需要|不用)(?:再|反复|重复)?确认[，,]\s*(?:请)?直接执行(?:[，,]\s*我(?:需要|希望)(?:尽快)?看到(?:页面)?变化)?[。！!\s]*$/u;
const CONFIRM_SAVED_SCOPE = /^(?:请)?(?:确认|确定|同意)(?:执行|实施)?(?:已保存|已登记)的?(?:任务)?范围[。！!\s]*$/u;
const CONFIRM_SAVED_PRODUCTION_PLAN = /^(?:请)?(?:确认|确定|同意)(?:执行|实施)(?:当前|本次)(?:已(?:经)?)?(?:准备|保存)的?(?:发布|发版|部署|上线)方案(?=[，,。；;！？!?\r\n]|$)/u;
const CONFIRM_FIELD_VALUE = /^(?:确认|确定|同意)[，,]\s*[^，,。；;！？!?\r\n]{1,32}字段(?:取值)?(?:为|是)[^，,。；;！？!?\r\n]{1,96}[。！!\s]*$/u;
const DIRECT_CURRENT_CHANGE = /^(?:请)?直接(?:改动|修改)(?:[，,]\s*然后(?<action>发布|发版|部署|上线))?(?:[，,]\s*(?:不要(?:再|在)?反复确认|权限直接给到最高))*[。！!\s]*$/u;

function isBareTaskContinuation(prompt) {
  // This explicit confirmation resumes the saved task; it does not request release authority.
  if (/^确认放行[，,]\s*继续执行[。！!\s]*$/u.test(prompt)) return true;
  const clauses = prompt.split(/[，,。；;！!\s]+/u).filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => CONTINUE_TASK.test(clause));
}
// A follow-up about verifying the current task consumes its stored scope;
// an explicit new page/module request must still derive its own task profile.
const CONTINUE_TASK_VERIFICATION = /^(?:(?:确认|确定|同意)(?:执行|实施|修改|开始)?|执行|继续(?:执行|实施|修改|完成)?|开始执行)[，,\s]+(?:并\s*)?(?:(?:完成|补充|补齐|执行)\s*)?(?:当前|本次|本)(?:改动|任务)的?(?:必要)?(?:验证|测试)[。！!\s]*$/u;
const CONTINUE_CURRENT_TASK = /^(?:请\s*)?(?:(?:确认|确定|同意)(?:执行|实施)?[，,。！!\s]+)?继续(?:执行|实施|完成|处理)?(?:上一轮(?:已经|已)?(?:明确|确认)的)?(?:(?:原|当前|本次|这个)的?任务|(?:原来|之前|刚才|当前)的[^，,。；;！？!?\r\n]{1,80}(?:任务|需求|重构|修改))(?=[的、，,。；;：:！？!?“\s]|$)/u;
const CONTINUE_UNFINISHED_CONTROLLED_RELEASE = /^(?:请\s*)?接续刚才未完成的受控发布(?=[：:，,。；;！？!?\s]|$)/u;
const CURRENT_CANDIDATE_FEEDBACK = /^(?:请\s*)?(?:补充|处理|修复)(?:当前|本次)(?:候选|任务)的?(?:验收)?反馈(?=[：:，,。；;！？!?\s]|$)/u;
const RECOVERED_CONNECTION_PREFIX = /^(?:(?:刚才这一轮|上一轮)在(?:模型)?连接阶段失败[，,]\s*尚未执行业务工具[。.]\s*)?(?:当前|现在)?(?:原)?(?:工作舱)?(?:模型出口)?(?:连接|网络)(?:已经|已)?(?:恢复|修复)[，,。]\s*/u;
const CONTINUATION_NEW_SCOPE = /(?:^|[，,。；;：:！？!?\r\n])\s*(?:另外|另行|同时|再|还要|新增|新建|改为|切换到)[^，,。；;！？!?\r\n]{0,80}(?:页面|接口|模块|功能)/u;
const CONTINUE_TASK_CLARIFICATION_PREFIX = /^(?:(?:确认|确定|同意)(?:执行|实施|修改|开始)?|执行|继续(?:执行|实施|修改|完成)?|开始执行)[，,。！!]\s*/u;
const CONTINUE_TASK_CLARIFICATION_REFERENCE = /(?:其余|其他|剩余)(?:事项)?(?:均|都)?按(?:刚才|此前|前述|上述|先前)(?:已经|已)?(?:确认|约定|说明)?的?[^。；;！？!?\r\n]{0,48}(?:执行|实施|完成)[。！!\s]*$/u;
const EXPLICIT_NEW_TASK_AFTER_CONFIRMATION = /(?:^|[。；;！？!?\r\n])\s*(?:另|另外|另行|同时|再|还要|新增|新建|改为|切换到)[^，,。；;！？!?\r\n]{0,48}(?:页面|接口|模块|功能)/u;
const REVALIDATE_CURRENT_TASK = /^(?:请\s*)?(?:重新|继续)(?:验证|测试)(?:(?:当前|本次|本)的?(?:改动|任务|修改))?(?=[，,。；;！!\s]|$)/u;

function compileConversationAcceptanceSpec(contract) {
  const verificationProfiles = contract.requiredVerificationProfiles.filter((profile) => profile !== 'governance');
  const scopedUtility = Object.hasOwn(contract, 'suspendedReviewObligations') && contract.tddRequired === false
    && contract.taskProfiles.includes('frontend-admin')
    && !contract.requiredObligations.some(id => /(?:test-first|browser|responsive|loading|busy)/u.test(id));
  const finalVerificationProfile = scopedUtility
    ? verificationProfiles.find(profile => /(?:-test|-test-class)$/u.test(profile)) ?? verificationProfiles[0]
    : verificationProfiles[0];
  const workflowTestProfile = verificationProfiles.find(profile => /(?:-test|-test-class)$/u.test(profile));
  const obligations = contract.requiredObligations.map((id) => {
    if (['workflow-state-transition-tests', 'idempotent-workflow-callbacks'].includes(id)
      && workflowTestProfile !== undefined) {
      return { id, dimension: 'execution', evidenceType: 'verification', profile: workflowTestProfile };
    }
    if (/(?:test|verification|browser|responsive|loading|busy)/u.test(id.toLowerCase())
      && verificationProfiles.length > 0) {
      return { id, dimension: 'execution', evidenceType: 'verification',
        profile: id === 'final-verification' ? finalVerificationProfile : verificationProfiles[0] };
    }
    if (id === 'spec-and-quality-review' || /(?:owner|crud|dictionary|api-error|workflow-state)/u.test(id.toLowerCase())) {
      return { id, dimension: 'semantic', evidenceType: 'semantic-review', profile: null };
    }
    return { id, dimension: 'implemented', evidenceType: 'governance', profile: null };
  });
  const dimensions = ['implemented'];
  if (obligations.some((item) => item.dimension === 'execution')) dimensions.push('execution');
  if (obligations.some((item) => item.dimension === 'semantic')) dimensions.push('semantic');
  return { requiredDimensions: dimensions, requiredObligations: obligations };
}
function reviewCompilerOptions(input, dualReview) {
  const ordinaryTask = input.independentReviewSuspensionSupported === true && input.controllerPhase === undefined;
  return { independentReview: ordinaryTask ? 'suspended' : 'required',
    ...(dualReview === undefined ? {} : { dualReview }),
    verificationScope: input.changedVerificationSupported === true && input.controllerPhase === undefined ? 'changed' : 'legacy',
    focusedBackendVerification: input.focusedBackendVerificationSupported === true && input.controllerPhase === undefined,
    ordinaryFinalVerification: input.ordinaryFinalVerificationSupported === true && input.controllerPhase === undefined };
}

function protectedReviewTestReceipts(record, trustPolicy, evaluatedAt) {
  return currentAcceptanceEvidence(record.receipts).verificationReceipts
    .filter(receipt => receipt.status === 'passed' && /(?:^|-)test(?:-|$)/u.test(receipt.profile))
    .map(receipt => {
      verifyAcceptanceEvidenceReceipt({ contract: record.acceptanceContract, trustPolicy, receipt, kind: 'verification', evaluatedAt });
      return { receiptId: receipt.receiptId, profile: receipt.profile,
        canonicalSha256: receipt.integrity.canonicalSha256,
        logSha256: receipt.execution.logSha256.startsWith('sha256:') ? receipt.execution.logSha256 : `sha256:${receipt.execution.logSha256}` };
    }).sort((a, b) => a.receiptId.localeCompare(b.receiptId, 'en'));
}
const WRITE_REQUEST = /(?:创建|实施|实现|修复|修改|更新|调整|新增|增加|删除|去掉|移除|替换|重构|开发|改成|改为|补齐|完成)|\b(?:implement|fix|change|add|remove|delete|replace|refactor)\b/iu;
function hasTaskWriteIntent(prompt) {
  const direct = prompt.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  const desiredBehavior = !/[？?]/u.test(direct) && !QUESTION_REQUEST.test(direct.trim())
    && !ATTRIBUTED_RELEASE_SENTENCE.test(direct.trim())
    && /(?:^|[，,。；;\r\n])\s*[^，,。；;！？!?\r\n]{1,80}也需要(?!不|取消)[^，,。；;！？!?\r\n]{1,80}/u.test(direct);
  return WRITE_REQUEST.test(prompt) || hasUiInteractionWriteIntent(prompt) || desiredBehavior;
}
const CANCEL_TASK = /^(?:取消(?:(?:当前)?任务|执行|修改)?|停止(?:(?:所有|全部)工作|执行|修改)?|算了|不用(?:改|修改|执行)了)[。！!\s]*$/u;
// "先限定测试范围再分析影响" describes verification execution, not a
// request to wait for a plan. Analysis must itself be the requested first step.
const PLAN_REQUEST = /(?:先[^，,。；;：:！？!?\r\n]{0,80}(?:方案|计划)|先\s*(?:(?:帮我|给我|做|进行|只|仅)\s*)*分析|先(?:对|把)[^。；，,\n]{0,80}分析|(?:方案|计划).{0,12}(?:确认|再执行|再实现))|\bplan (?:first|before)\b/iu;

function hasPlanningRequest(prompt) {
  // An explicit denial of a planning round is not a request to wait for one.
  // Leave every other clause intact so an actual plan-first request still wins.
  const directText = prompt.replace(/(?:^|[，,。；;！？!?\r\n])\s*(?:当前|本轮|这轮|本次)?(?:不是|并非)(?:方案|计划)(?:评审)?轮(?=[，,。；;！？!?\s]|$)/gu, ' ')
    // Following an already authorized plan's confirmation semantics is not a
    // request for another planning round. Actual plan-first clauses still win.
    .replace(/(沿(?:当前|本次|本轮|既有)?已(?:经)?(?:完整)?授权(?:的)?(?:方案|计划))的确认语义(?=处理|继续|执行)/gu, '$1的续接语义')
    .replace(/((?:方案|计划)(?:须|应)?依据)已(?:经)?确认的(?=[^，,。；;！？!?\r\n]{0,24}需求)/gu, '$1既有的')
    // Reading a named reference is not requesting a planning round. Keep the
    // rest of the clause intact so an actual request to create a plan still wins.
    .replace(/(先(?:完整)?阅读[^，,。；;：:！？!?\r\n《》]{0,80})《[^《》\r\n]{1,160}》/gu, '$1《资料》');
  return PLAN_REQUEST.test(directText);
}
const AMBIGUOUS_PERMISSION_REQUEST = /^(?:(?:给你|授予你|开放|提供)(?:相应|本次|当前)?|申请)?(?:执行|写入|修改)?权限[。！!\s]*$/u;
const PRODUCTION_ACTIONS = ['workspace-write', 'git-checkpoint', 'release'];
const CONVERSATION_TASK_REQUEST_TTL_MS = 900 * 1000;
const BARE_CHECKPOINT_OR_RELEASE = /^(?:请|现在请)?(?:(?:继续|确认|确定|同意)[，,\s]*)?(?:提交(?:代码)?(?:并(?:发版|发布|部署|上线))?|(?:前端|后端)?(?:发版|发布|部署|上线))[。！!：:\s]*$/u;
const CONTROLLED_RELEASE_ROUTE = /^(?:请|现在请)?(?:(?:继续|确认|确定|同意)\s*)?(?:走|通过|按)\s*受控(?:入口|流程)?\s*(?:发版|发布|部署|上线)[。！!：:\s]*$/u;
const DIRECT_CURRENT_TASK_PRODUCTION_ACTION = /^(?:请|现在请)?(?:(?:继续|确认|确定|同意)(?:(?:执行)?(?:并|和))?[，,\s]*)?(?:先\s*)?(?:受控\s*)?(?<action>本地提交(?:代码)?|提交(?:代码)?(?:并(?:发版|发布|部署|上线))?|发版|发布|部署|上线)(?<target>[^，,。；;！？!?\r\n]{1,96})(?=[，,。；;！!\r\n]|$)/u;
// Object-first submission is the same explicit action, not a fresh write task.
const DIRECT_OBJECT_FIRST_PRODUCTION_ACTION = /^(?:请|现在请)?(?:把|将)(?<target>[^，,。；;！？!?“”‘’「」『』"'\r\n]{1,160}?)(?<action>提交(?:代码)?(?:[，,\s]*(?:并|然后)\s*(?:直接)?(?:受控)?(?:发版|发布|部署|上线))?|发版|发布|部署|上线)(?:(?:当前|本次)(?:前端|后端)?范围)?(?:到|至)?\s*(?:[A-Za-z0-9][A-Za-z0-9._/-]{0,63})?(?=[。；;！!\r\n]|$)/u;
const DIRECT_SCOPED_EXECUTION_RELEASE = /^(?:请\s*)?(?:现在\s*)?(?:由你\s*)?(?:在(?:当前|本|这个)(?:原)?\s*(?:Harness\s*)?(?:会话|对话)中\s*)?执行(?<target>[^，,。；;！？!?“”‘’「」『』"'\r\n]{1,128}?)的?(?:正常)?受控(?<action>发布|发版|部署|上线)(?=[。；;！!\r\n]|$)/u;
// A named completed version is explicit only with its fixed commit; unrelated tasks stay excluded.
// A completed or merged candidate in this conversation keeps that same binding.
const CURRENT_TASK_OBJECT = /(?:(?:这次|本次|当前|本轮)已(?:经)?授权的[^，,。；;！？!?\r\n]{1,64}|(?:这次|本次|当前|本轮)[^，,。；;！？!?\r\n]{0,48}(?:改动|修改|变更|任务|修复|候选|模块|功能)|(?:这个|本次|当前)(?:已(?:准备|保存)的?)?(?:任务)?范围)|^(?:已经|已)完成的(?![^，,。；;！？!?\r\n]{0,64}(?:其他|其它|另一|另外)(?:个)?(?:任务|项目|会话))[^，,。；;！？!?\r\n]{1,48}(?:版本|候选)\s*(?:`[0-9a-f]{40}`|[0-9a-f]{40})\s*$|^本对话已(?:经)?(?:完成|(?:受控)?合流)的(?![^，,。；;！？!?\r\n]{0,64}(?:其他|其它|另一|另外)(?:个)?(?:任务|项目|会话|对话))[^，,。；;！？!?“”‘’「」『』"'\r\n]{1,64}候选\s*$/u;
const DIRECT_CONDITIONAL_RELEASE = /(?:^|[，,。；;！!\r\n])\s*(?:请\s*)?(?:检查|验证|测试)通过后(?:再|完成)?(?:发布|发版|部署|上线)[。！!\s]*$/u;
const ATTRIBUTED_CONDITIONAL_RELEASE = /(?:引用|示例|文档|日志|工具(?:输出|结果)?|提示(?:文字|文案)?)[^。；;！？!?\r\n]*(?:检查|验证|测试)通过后(?:再|完成)?(?:发布|发版|部署|上线)[”"'’」』）)]*[。！!\s]*$/u;
const ATTRIBUTED_NEXT_LINE_CONDITIONAL_RELEASE = /(?:引用|示例|文档|日志|工具(?:输出|结果)?|提示(?:文字|文案)?)[^。；;！？!?\r\n]*[：:][ \t]*\r?\n[ \t]*(?:全部\s*)?(?:检查|验证|测试)通过后(?:再|完成)?(?:发布|发版|部署|上线)[”"'’」』）)]*[。！!\s]*$/u;
const DIRECT_RELEASE_SENTENCE = /(?:(?:继续|请)?(?:完成|实施|修改|修复|补(?:充|齐)?|去掉|移除|同步)[^。；;！？!?\r\n]*(?:并|后再|(?:和|以及|、)(?=(?:必要组件)?(?:受控)?(?:发布|发版|部署|上线)(?=[，,。；;！!\s]|$)))(?:按(?:我|我们)(?:此前|之前|刚才)的(?:要求|授权))?(?:直接)?(?:完成)?(?:必要组件)?(?:受控)?(?:发布|发版|部署|上线|提交(?:代码)?(?:并|和|、)(?:发布|发版|部署|上线)(?:(?:当前|本次)(?:前端|后端)?范围)?(?=[，,。；;！!\s]|$))|(?:请\s*)?把[^。；;！？!?\r\n]*(?:完成|补齐|执行)(?:当前|本次)?(?:必要)?(?:验证|测试)[，,\s]*(?:并\s*)?(?:通过受控入口\s*)?(?:完成)?(?:发布|发版|部署|上线)|(?:全部\s*)?(?:检查|验证|测试)(?:均|都|全部)?通过后(?:再|完成)?(?:发布|发版|部署|上线))/u;
// A complete action clause also covers "修改发版" and "修改后直接发版";
// the trailing boundary keeps UI nouns such as "修改发版按钮" as edits only.
const DIRECT_EDIT_RELEASE_CLAUSE = /(?:^|[，,。；;！!\r\n])\s*(?:请\s*)?(?:(?!(?:不要|不得|禁止|暂不|先不|无需|不必))[^，,。；;！？!?\r\n]{1,96}的)?(?:修改|修复|调整|改好)(?:后(?:直接|再)?|并|然后)?(?:发布|发版|部署|上线)(?:当前(?:前端)?范围)?(?=[，,。；;！!\s]|$)/u;
const DIRECT_COMMA_EDIT_RELEASE_SENTENCE = /^(?=[^，,。；;！？!?\r\n]{0,160}(?:修改|修复|调整))[^，,。；;！？!?\r\n]{1,160}[，,]\s*(?:请\s*)?(?:直接)?(?:发布|发版|部署|上线)[。！!\s]*$/u;
// A coordinated implementation, commit and release may name its task directly.
const DIRECT_COMBINED_EDIT_RELEASE_SENTENCE = /^(?:请\s*)?(?:继续\s*)?(?:实现|实施|完成|修改|修复|调整)(?:并|然后)提交(?:代码)?(?:并|和|、)(?:发布|发版|部署|上线)(?!(?:按钮|文案|文字|文本|提示|示例))[^，,。；;！？!?“”‘’「」『』"'\r\n]{1,96}(?=[，,。；;！!]|$)/u;
const DIRECT_AUTHORIZED_RELEASE_CLAUSE = /(?:^|[，,。；;！!\r\n])\s*(?:请\s*)?(?:直接)?完成(?:此前|当前|本轮)已授权的(?:受控)?(?:发布|发版|部署|上线)(?=[，,。；;！!\s]|$)/u;
const DIRECT_CANDIDATE_CONTROLLED_RELEASE = /^(?:请\s*)?(?:在(?:当前|本|这个)(?:会话|对话)\s*)?(?:继续(?:执行|完成)?|完成|执行)(?:当前|本次|本轮|原)[^，,。；;！？!?“”‘’"'\r\n]{0,64}?候选(?:的)?(?:剩余)?(?:验收(?:与|和|及))?受控(?:发布|发版|部署|上线)(?:(?:和|以及)(?:后台)?终态回收)?(?=[，,。；;：:！!\s]|$)/u;
// A direct prepare/save/merge instruction also authorizes its explicit UI release step.
const DIRECT_CONTROLLED_SAVE_UI_RELEASE = /^(?:请\s*)?通过正常\s*prepare_task(?![^。；;！？!?\r\n]*(?:如果|假如|假设|不要|不得|禁止|暂不|先不|无需|不必|不允许|不授权))[^。；;！？!?“”‘’"'\r\n]{0,80}?受控(?:工具)?保存[^。；;！？!?“”‘’"'\r\n]{0,80}?[，,、](?:再)?完成\s*(?:canonical\s+)?main\s*推送(?:及|和|并)(?:仅)?\s*forge-ui\s*(?:发布|发版)(?=[。；;！!\s]|$)/u;
const CONFIRMED_CURRENT_SCOPE_RELEASE = /^(?:请\s*)?(?:现在\s*)?(?:确认|同意|确定)(?:并|并且)执行(?:当前|本次|本轮)(?:已(?:经)?(?:确认|授权)的)?(?:候选|范围)(?:的)?(?:正常)?受控(?:发布|发版|部署|上线)(?=[，,。；;！!\s]|$)/u;
const ONLY_INSPECTION_SENTENCE = /^(?:请\s*)?(?:只|仅)(?:做|进行)?(?:检查|验证|测试)/u;
// Explicit batch authorization and the normal three-action closeout list are
// equivalent to an authorized release; exclusions of other batches stay scoped.
const EXPLICIT_BATCH_RELEASE_AUTHORIZATION = /^(?:我)?(?:明确|这里明确)?授权(?:这|本)(?:第[一二三四五六七八九十\d]{1,3})?批(?:的)?(?:必要)?(?:(?:实施|修改|检查|验证|测试|提交|集成)(?:、|和|并))+(?:受控)?(?:发布|发版|部署|上线)(?=[，,。！!\s]|$)/u;
const EXPLICIT_CURRENT_RELEASE_AUTHORIZATION = /(?:^|[，,])\s*(?:(?:(?:我)?(?:确认|同意)继续[，,]\s*并)?(?:我)?(?:明确|这里明确)?授权(?:本轮|本次|当前)?(?:必要)?(?:(?:保存|提交(?:代码)?)(?:和|并|、))?(?:受控)?(?:发布|发版|部署|上线)|整个范围和(?:受控)?(?:发布|发版|部署|上线)已授权)(?=[，,。；;！!\s]|$)/u;

function hasCancellationClause(prompt) {
  return prompt.split(/[，,。；;：:！？!?\r\n]+/u).some((clause) => CANCEL_TASK.test(clause.trim()));
}

function hasProductionActionDenial(prompt) {
  const request = DIRECT_SCOPED_EXECUTION_RELEASE.exec(prompt)
    ?? DIRECT_OBJECT_FIRST_PRODUCTION_ACTION.exec(prompt)
    ?? DIRECT_CURRENT_TASK_PRODUCTION_ACTION.exec(prompt);
  const target = request?.groups.target ?? '';
  const currentRelease = request !== null && /(?:发版|发布|部署|上线)/u.test(request.groups.action)
    && (CURRENT_TASK_OBJECT.test(target) || /(?:当前|本次|本轮|本批)/u.test(target));
  const namedCurrent = /(?:本批|本次|本轮|当前)\s*(?!候选|任务|范围|改动|修改|变更|已|上述|这个|那个)(?:[A-Za-z][A-Za-z0-9_-]*|[\u3400-\u9fff]{2,24})/u.test(target);
  return prompt.split(/[，,。；;！？!?\r\n]+/u).some(clause => {
    const denial = /(?:不要|不得|禁止|暂不|先不|无需|不必|不)\s*(?:受控\s*)?(?:提交|发版|发布|部署|上线)/u.exec(clause);
    if (denial === null) return false;
    const subject = clause.slice(0, denial.index).trim();
    if (currentRelease && /^(?:其他|其它|另外的|另一)(?:候选|任务)$/u.test(subject)) return false;
    const named = /^(?<names>[^，,。；;！？!?\r\n]{1,80}?)(?:候选|任务)$/u.exec(subject);
    if (!currentRelease || !namedCurrent || named === null) return true;
    // Only explicit distinct names narrow a denial; pronouns and global/unknown subjects do not.
    const names = named.groups.names.split(/\s*(?:与|和|及|、)\s*/u);
    return names.some(name => !/^(?:[A-Za-z][A-Za-z0-9_-]*|[\u3400-\u9fff]{2,24})$/u.test(name)
      || /^(?:当前|本次|本轮|本批|上述|前述|所有|全部|任何|同一|该|这|那|其)/u.test(name)
      || target.replace(/\s+/gu, '').includes(name));
  });
}

function hasCurrentProductionActionRestriction(prompt) {
  if (hasProductionActionDenial(prompt)) return true;
  // Qualify the leading current-task request; later clauses never create authority.
  const sentences = prompt.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ')
    .split(/[。；;！？!?]+/u);
  return sentences.some((sentence) => {
    const directText = sentence.trim();
    if (/^(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志(?:示例|显示|记录|输出)?|工具(?:输出|结果)|提示(?:文字|文案)?)(?:为|是|中|称|写着|提到|显示|记录|说明|[：:，,])/u.test(directText)) return false;
    return directText.split(/[，,\r\n]+/u).some((clause) => {
      const text = clause.trim();
      // A bounded correction names what to verify, not a limit on separately
      // authorized publication. An explicit test-only or no-publication clause wins.
      const correctionVerification = /^(?:请\s*)?(?:只|仅)(?:检查|验证|测试)(?:这|本)(?:项|次)(?:修正|修复)(?:(?:及|和|与)(?:当前|本次)(?:合同)?(?:必需|必要)范围)?$/u.test(text);
      return /(?:不要|不得|禁止|暂不|先不|无需|不必)\s*本地提交/u.test(text)
        || (/^(?:(?:但|但是|不过)\s*)?(?:(?:本轮|本次|当前|现在|这轮|此次)\s*)?(?:请\s*)?(?:先\s*)?(?:只|仅)(?:是)?(?:做|进行)?(?:预检|检查|验证|测试)/u.test(text)
          && !((CHANGED_VERIFICATION_CLAUSE.test(text) || correctionVerification) && !hasGlobalReadOnlyIntent(prompt)))
        || /(?:提交|发版|发布|部署|上线)[^，,。；;！？!?\r\n]{0,16}(?:留待|推迟到|放到|安排在)(?:下一轮|下轮|下一步)|^(?:这(?:只是|是)|只是|仅是)(?:下一轮|下轮|下一步)(?:的)?(?:计划|步骤)/u.test(text);
    });
  });
}

function requestedCurrentTaskProductionAction(prompt) {
  if (hasGlobalReadOnlyIntent(prompt) || hasCancellationClause(prompt)
    || QUESTION_REQUEST.test(prompt) || ATTRIBUTED_RELEASE_SENTENCE.test(prompt)
    || EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(prompt)
    || hasProductionActionDenial(prompt)) return null;
  const firstSentence = prompt.match(/^[^。；;！？!?\r\n]*(?:[。；;！？!?]|$)/u)?.[0] ?? '';
  if (/[？?]\s*$/u.test(firstSentence)) return null;
  if (CONFIRM_SAVED_PRODUCTION_PLAN.test(prompt)) {
    return hasPlanningRequest(prompt) || hasCurrentProductionActionRestriction(prompt) ? null : 'release';
  }
  const objectFirst = DIRECT_OBJECT_FIRST_PRODUCTION_ACTION.exec(prompt);
  if (objectFirst !== null
    && /(?:文案|文字|文本)[^，,。；;！？!?\r\n]{0,48}(?:改为|改成|修改为|修改成|替换为)\s*$/u.test(objectFirst.groups.target)) return null;
  const scopedExecution = DIRECT_SCOPED_EXECUTION_RELEASE.exec(prompt);
  const match = objectFirst ?? scopedExecution ?? DIRECT_CURRENT_TASK_PRODUCTION_ACTION.exec(prompt);
  if (match === null) return null;
  if (scopedExecution !== null && !/(?:当前|本次|本轮|本批)/u.test(match.groups.target)) return null;
  if (scopedExecution === null && (objectFirst === null || !/提交/u.test(match.groups.action))
    && !CURRENT_TASK_OBJECT.test(match.groups.target)) return null;
  if (hasCurrentProductionActionRestriction(prompt)) return null;
  return /(?:发版|发布|部署|上线)/u.test(match.groups.action) ? 'release' : 'git-checkpoint';
}

function confirmsCurrentTaskWithClarifications(prompt) {
  return CONTINUE_TASK_CLARIFICATION_PREFIX.test(prompt)
    && CONTINUE_TASK_CLARIFICATION_REFERENCE.test(prompt)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(prompt)
    && !hasCancellationClause(prompt)
    && !hasGlobalReadOnlyIntent(prompt);
}

function continuesCurrentTaskWithNotes(prompt) {
  // A factual connection-recovery preface is not a fresh task or a planning
  // round. Only the following explicit current-task request inherits scope;
  // restrictions in the complete prompt still apply below.
  const directRequest = prompt.replace(RECOVERED_CONNECTION_PREFIX, '');
  const continuation = directRequest.replace(/^(?:请\s*)?(?:确认|确定|同意)(?:执行|实施)?[，,。！!\s]+/u, '');
  const firstSentence = continuation.match(/^[^。；;！？!?\r\n]*(?:[。；;！？!?]|$)/u)?.[0] ?? '';
  return (CONTINUE_CURRENT_TASK.test(directRequest) || CONTINUE_UNFINISHED_CONTROLLED_RELEASE.test(directRequest)
    || CURRENT_CANDIDATE_FEEDBACK.test(directRequest))
    && !/[？?]\s*$/u.test(firstSentence)
    && !hasGlobalReadOnlyIntent(prompt)
    && !hasPlanningRequest(prompt)
    && !hasCancellationClause(prompt)
    && !hasCurrentProductionActionRestriction(prompt)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(prompt)
    && !CONTINUATION_NEW_SCOPE.test(prompt);
}

function hasDirectReleaseSentence(prompt) {
  const sentences = [...prompt.matchAll(/[^。；;！？!?\r\n]+(?:[。；;！？!?]|$)/gu)];
  return sentences.some((match) => {
    const sentence = match[0];
    // A newline after an attribution label does not turn its example into
    // an instruction. Keep the original offset when splitting sentences.
    const preceding = prompt.slice(0, match.index).split(/[。；;！？!?]/u).at(-1) ?? '';
    if (/(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志(?:显示|记录|输出)?|工具(?:输出|结果)|提示(?:文字|文案)?)[^\r\n]*[：:][ \t]*\r?\n[ \t]*$/u.test(preceding)) return false;
    const directText = sentence.trim().replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
    return !/[？?]\s*$/u.test(sentence)
      && !QUESTION_REQUEST.test(directText)
      && !ONLY_INSPECTION_SENTENCE.test(directText)
      && !ATTRIBUTED_RELEASE_SENTENCE.test(directText)
      && (DIRECT_RELEASE_SENTENCE.test(directText)
        || ((DIRECT_EDIT_RELEASE_CLAUSE.test(directText) || DIRECT_COMMA_EDIT_RELEASE_SENTENCE.test(directText)
          || DIRECT_COMBINED_EDIT_RELEASE_SENTENCE.test(directText)
          || DIRECT_AUTHORIZED_RELEASE_CLAUSE.test(directText)
          || DIRECT_CANDIDATE_CONTROLLED_RELEASE.test(directText)
          || DIRECT_CONTROLLED_SAVE_UI_RELEASE.test(directText)
          || CONFIRMED_CURRENT_SCOPE_RELEASE.test(directText))
          && !hasCurrentProductionActionRestriction(prompt))
        || ((EXPLICIT_CURRENT_RELEASE_AUTHORIZATION.test(directText)
          || EXPLICIT_BATCH_RELEASE_AUTHORIZATION.test(directText)
          || hasDirectSubmitIntegrateRelease(directText))
          && !hasCurrentProductionActionRestriction(prompt)));
  });
}

// Only an explicit leading action requests elevated authority. A mention in
// an explanation, tool result, question or negative instruction does not.
function requestsCheckpointWithoutPublication(prompt) {
  const unquoted = prompt.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  const direct = [...unquoted.matchAll(/[^。；;！？!?\r\n]+/gu)]
    .filter((match) => {
      const preceding = unquoted.slice(0, match.index).split(/[。；;！？!?]/u).at(-1) ?? '';
      if (/(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志(?:显示|记录|输出)?|工具(?:输出|结果)|提示(?:文字|文案)?)[^\r\n]*[：:][ \t]*\r?\n[ \t]*$/u.test(preceding)) return false;
      return !/^(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志(?:示例|显示|记录|输出)?|工具(?:输出|结果)|提示(?:文字|文案)?)[：:，,为是中称]/u.test(match[0].trim());
    })
    .map((match) => match[0])
    .join('。');
  const noPublication = /(?:不要|不得|禁止|暂不|先不|无需|不必|不)\s*(?:受控\s*)?(?:发版|发布|部署|上线)(?:上线)?/gu;
  if (!noPublication.test(direct) || !hasProductionActionDenial(prompt) || hasGlobalReadOnlyIntent(prompt)
    || hasCancellationClause(prompt) || hasPlanningRequest(prompt) || QUESTION_REQUEST.test(prompt)
    || /[？?]/u.test(prompt)) return false;
  const checkpointRequest = direct.replace(noPublication, '');
  if (hasCurrentProductionActionRestriction(checkpointRequest)) return false;
  // Reuse the existing current-task commit grammar after retaining all commit bans.
  if (requestedCurrentTaskProductionAction(checkpointRequest) === 'git-checkpoint') return true;
  // Authorizing the supported local checkpoint command requests the same
  // existing ceiling as submitting code; it never requests publication.
  if (/(?:^|[，,。；;\r\n])\s*(?:(?:我)?(?:明确)?授权(?:使用)?|允许使用)\s*(?:受保护的\s*)?forge-release\s+checkpoint(?=[\s，,。；;]|$)/u.test(checkpointRequest)) return true;
  return /(?:^|[，,。；;\r\n])\s*(?:请|现在请)?\s*(?:(?:然后|接着|最后|再|并)\s*|完成[^，,。；;！？!?\r\n]{0,40}(?:检查|验证|测试)(?:后|并))?(?:受控\s*)?提交(?:(?:当前|本批|本轮|本次)[^，,。；;！？!?\r\n]{0,32}?)?代码(?:[（(][^）)\r\n]{0,48}[）)])?(?=[，,。；;\s]|$)/u.test(checkpointRequest);
}

const CURRENT_CANDIDATE_CONTINUATION_PREFIX = /^(?:请\s*)?继续(?:完成)?(?:同一|当前|本次|本轮)[^，,。；;！？!?\r\n]{0,64}候选(?:的)?(?:收尾)?(?=[，,。；;\s]|$)/u;

function requestsExplicitTaskLocalCheckpoint(prompt) {
  if (hasGlobalReadOnlyIntent(prompt) || hasCancellationClause(prompt) || hasPlanningRequest(prompt)
    || QUESTION_REQUEST.test(prompt) || /[？?]/u.test(prompt)) return false;
  const unquoted = prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  // A ban on publication does not deny an explicitly authorized local commit.
  // Keep commit prohibitions intact, including a plain "本轮不提交" clause.
  const checkpointRequest = unquoted.replace(/(?:不要|不得|禁止|暂不|先不|无需|不必|不)\s*(?:受控\s*)?(?:发起\s*(?:forge-ui\s*)?)?(?:发版|发布|部署|上线)(?:上线)?/gu, '')
    // A new test's subject limits that test, not an explicit own-task commit.
    // Preserve standalone verification-only instructions and all commit bans.
    .replace(/((?:^|[。；;\r\n])\s*(?:新增|本次新增|当前新增)测试[^。；;！？!?\r\n]{0,160}[，,]\s*)(?:只|仅)验证(?=(?:实际|原|当前|现有)[^，,。；;！？!?\r\n]{0,64}(?:行为|映射|响应|接口|逻辑))/gu, '$1验证')
    // A demonstrative changed-file scope has the same bounded verification
    // meaning as "当前改动"; it does not restrict the whole task to testing.
    .replace(/((?:^|[。；;\r\n])\s*(?:请\s*)?(?:只|仅)(?:检查|验证|测试))(?:这些|这项)(?=(?:改动|变更)(?:及|和|与|[，,。；;\r\n]|$))/gu, '$1当前')
    // "Existing FooTest although ..., but only checks ..." describes a test's
    // current coverage; preserve independent instructions such as "本轮只测试".
    .replace(/((?:^|[。；;\r\n])\s*(?:(?:另外|此外)[，,]\s*)?(?:(?:本轮|本次|当前|已有|现有)\s*)?[A-Za-z_$][\w.$]{0,120}(?:Test|Tests)\s*虽[^，,。；;！？!?\r\n]{1,80}[，,]\s*但)只(?=(?:检查|验证|测试))/gu, '$1');
  if (hasCurrentProductionActionRestriction(checkpointRequest)
    || /(?:^|[，,。；;\r\n])\s*(?:(?:本轮|本次|当前|现在)\s*)?(?:请\s*)?(?:只|仅)(?:写|修改|修复)(?:代码|源码)(?=[，,。；;\s]|$)/u.test(checkpointRequest)
    || /(?:不要|不得|禁止|暂不|先不|无需|不必|不允许|不授权|不)\s*(?:(?:继续|再)\s*)?(?:(?:完成|执行|创建|建立|形成|保存)\s*)?(?:(?:一个|新的)\s*)?(?:本地\s*(?:Git\s*)?(?:提交|检查点)|(?:受控\s*)?(?:可追溯\s*)?(?:Git\s*)?checkpoint|(?:(?:正常|受控)\s*){0,2}(?:保存\s*)?检查点)/iu.test(checkpointRequest)
    || /(?:^|[，,。；;\r\n])\s*(?:(?:但|但是|不过)\s*)?(?:(?:本轮|本次|当前|现在)\s*)?不提交(?:代码|当前候选)?(?=[，,。；;\s]|$)/u.test(checkpointRequest)) return false;
  return [...checkpointRequest.matchAll(/[^。；;！？!?\r\n]+/gu)].some((match) => {
    const preceding = checkpointRequest.slice(0, match.index).split(/[。；;！？!?]/u).at(-1) ?? '';
    if (/(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志|工具(?:输出|结果)|提示(?:文字|文案)|假设|假如|设想|如果)[^\r\n]*[：:][ \t]*\r?\n[ \t]*$/u.test(preceding)) return false;
    let clause = match[0].trim();
    // A current save instruction may follow another instruction in the same
    // sentence. Do not turn attributed text or hypothetical examples into it.
    if (!/^(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志|工具(?:输出|结果)|提示(?:文字|文案)|假设|假如|设想)[：:，,为是]/u.test(clause)
      && !/(?:不要|不得|禁止|暂不|先不|无需|不必|不允许|不授权|不形成|不保存|假设|假如|如果)/u.test(clause)
      && clause.split(/[，,]/u).some(part => {
        const action = part.trim();
        return /^(?:请\s*)?(?:并|然后|接着|最后|再)?\s*(?:执行|完成)\s*受控\s*(?:Git\s+)?checkpoint\s+保存(?:它们|这些文件|上述文件|当前候选|本次改动)(?=[，,。；;\s]|$)/iu.test(action)
          || /^(?:请\s*)?(?:并|然后|接着|最后|再)?\s*通过正常受控入口(?:创建|保存)本地\s*(?:Git\s*)?检查点\s*$/iu.test(action)
          // The permission condition retains the server's account ceiling; it
          // does not ask the model to create permission or authorize a release.
          || /^(?:原|当前|现有)工具(?:合法)?保存(?:若|如)(?:已)?具备权限(?:则)?可(?:以)?受控\s*(?:Git\s+)?checkpoint(?=[，,。；;\s]|$)/iu.test(action);
      })) return true;
    if (/(?:不要|不得|禁止|暂不|先不|无需|不必|不允许|不授权|不形成|不保存|假设|假如|如果)/u.test(clause)) return false;
    // A current-candidate continuation may introduce its action with a comma.
    // Strip only that already-supported leading clause, after denial/attribution checks.
    const continuation = CURRENT_CANDIDATE_CONTINUATION_PREFIX.exec(clause);
    const following = continuation === null ? '' : clause.slice(continuation[0].length).trimStart();
    if (/^[，,]/u.test(following)) clause = following.slice(1).trimStart();
    // A direct local-commit action can name code or a completed document. It
    // selects checkpoint only; the prepared paths and account ceiling still apply.
    return /^(?:现在)?(?:本轮|本次|当前)(?:明确)?授权\s*[：:]\s*(?:只|仅)在(?:你自己的|当前任务的|本任务的)\s*(?:TaskSpace|工作区|工作舱)[^，,。；;！？!?\r\n]{0,64}?(?:[，,]\s*(?:然后|接着|再)\s*)?(?:形成|保存)(?:一个)?(?:新的)?(?:最终)?候选提交(?=[，,。；;\s]|并(?:取得|完成)[^，,。；;！？!?\r\n]{0,32}(?:验证|审查|review)|$)/u.test(clause)
      || /^(?:现在)?(?:请\s*)?(?:继续(?:完成|执行)?|完成|执行|创建|建立|形成|保存)\s*(?:(?:当前|本次|本轮|本任务|这次)(?:的)?\s*)?(?:(?:已经|已|此前)?授权(?:的)?\s*)?(?:(?:一个|新的)\s*)?本地\s*(?:Git\s*)?提交(?=[，,。；;\s]|$)/iu.test(clause)
      || /^(?:继续(?:原|当前|本次|本轮)?[^，,。；;！？!?\r\n]{0,40}(?:任务[，,]\s*|(?:任务|整改)并))?(?:请\s*)?(?:只|仅)?(?:完成|执行|创建|建立|形成|保存)\s*(?:(?:当前|本次|本轮|本任务|这次)(?:的)?\s*)?(?:(?:已经|已|此前)?授权(?:的)?\s*)?(?:候选(?:的)?\s*)?受控\s*(?:Git\s+)?checkpoint(?!\s*提交保存[^，,。；;\s])(?:\s*提交保存)?(?=[，,。；;\s]|$)/iu.test(clause)
      || /^(?:(?:请\s*)?(?:完成|结束)[^，,。；;！？!?\r\n]{0,80}后[^。；;！？!?\r\n]{0,240}[，,]\s*)?(?:请\s*)?(?:然后|接着|最后|再)?\s*(?:在(?:原|当前|本次|本轮|本任务)(?:对话|任务|工作舱|工作区)(?:中)?\s*)?(?:正常|受控)?\s*(?:Git\s*)?checkpoint\s*提交\s*(?:(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\/){1,12}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.md\s+)?(?:这(?:一)?(?:份|个)|当前|本次|本轮|本任务|已完成的|已验证的)[^，,。；;！？!?\r\n]{0,120}(?:文档|文件|spec|过程资料|候选|改动|代码)(?=[，,。；;\s]|$)/iu.test(clause)
      || /^(?:现在)?(?:请\s*)?(?:把|将)(?:当前|本次|本轮|本任务|这次|你自己的)[^，,。；;！？!?\r\n]{1,240}?(?:创建|建立|形成|保存)\s*(?:(?:一个|新的)\s*)?本地\s*(?:Git\s*)?提交(?=[，,。；;\s]|$)/iu.test(clause)
      || /^(?:现在)?(?:请\s*)?(?:把|将)(?:当前|本次|本轮|本任务|这次|你自己的)[^，,。；;！？!?\r\n]{0,160}(?:候选|改动|代码|文件|文档)\s*本地\s*(?:Git\s*)?提交(?=[，,。；;\s]|$)/iu.test(clause)
      // A coordinated repair/save and a colon-delimited scope still request only a local checkpoint.
      || /^(?:(?:请\s*)?(?:修改|修复)[^，,。；;！？!?“”‘’"'\r\n]{1,80}[，,]\s*)?(?:请\s*)?(?:(?:完成|结束)[^，,。；;！？!?\r\n]{0,80}后[，,]?\s*)?(?:请\s*)?(?:(?:修改|修复|调整)并)?(?:(?:正常|受控)\s*){0,2}(?:保存|建立|创建)\s*(?:(?:当前|本次|本轮)(?:候选)?(?:的)?\s*)?(?:可追溯\s*)?(?:Git\s*)?(?:检查点|checkpoint)(?=[，,。；;：:\s]|$)/iu.test(clause)
      || /^(?:(?:(?:请\s*)?(?:完成|执行|运行|只执行)[^，,。；;！？!?\r\n]{0,80}(?:检查|验证|测试)(?:后)?|(?:必要)?(?:检查|验证|测试)(?:实际)?满足后)[，,]\s*)?(?:请\s*)?(?:沿|通过)\s*(?:正常|现有|受控)(?:的)?\s*(?:受控工具完成(?:新的)?\s*)?(?:Git\s*)?checkpoint\s*(?:提交)?保存(?=[，,。；;\s]|$)/iu.test(clause)
      || /^(?:(?:请\s*)?先(?:通过|沿)(?:当前|现有)?(?:正常|受控)?\s*prepare_task[^，,。；;！？!?\r\n]{0,160}保存范围(?:[（(][^）)\r\n]{0,80}[）)])?[，,]\s*)?(?:请\s*)?(?:按|通过|沿)(?:已有|现有|当前)?(?:正常|受控)?\s*forge-release\s+checkpoint\s*(?:入口)?\s*保存(?:当前|本次|本轮)(?:可审查)?候选(?=[，,。；;\s]|$)/iu.test(clause)
      // A task's explicit save instruction can be one item in its work list.
      // It still authorizes only the current candidate, never publication.
      || /^(?:请\s*)?(?:在(?:当前|原|本次|本轮)\s*(?:Harness\s*)?(?:对话|工作舱|工作区|任务)(?:\s*(?:与|和)\s*GPT-[\d.]+\s*)?(?:中)?\s*)?(?:直接)?完成(?:本批|本轮|本次|当前)(?:业务|后端)?(?:修改|修复)(?:、(?:必要)?(?:业务)?(?:测试|验证|检查))?(?:和|及|并)(?:正常)?(?:受控)?保存检查点(?=[，,。；;\s]|$)/iu.test(clause)
      || /^(?:请\s*)?(?:本批|本轮|本次|当前任务)(?:结束|完成)时(?:沿|通过)(?:现有)?(?:正常|受控)?保存检查点保存(?:当前)?(?:可审查)?候选(?=[，,。；;\s]|$)/u.test(clause)
      // Candidate closeout may describe the saved commit without saying "Git".
      || /^(?:达到(?:此前|之前|当前|本次|本轮)?候选要求后[，,]\s*)?(?:请\s*)?(?:完成|执行|创建|建立|形成|保存)\s*(?:受控\s*)?可追溯\s*(?:Git\s*)?checkpoint(?=[，,。；;\s]|$)/iu.test(clause);
  });
}

function requestsExplicitTaskLocalIntegration(prompt) {
  if (hasGlobalReadOnlyIntent(prompt) || hasCancellationClause(prompt) || hasPlanningRequest(prompt)
    || QUESTION_REQUEST.test(prompt) || /[？?]/u.test(prompt)) return false;
  const direct = prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  // Denying publication does not deny candidate-local integration. Integration
  // itself must be a current, direct request; a later denial still wins.
  if (/(?:不要|不得|禁止|暂不|先不|无需|不必|不允许|不授权|不)\s*(?:(?:继续|再)\s*)?(?:(?:执行|完成)\s*)?(?:受控\s*)?(?:Git\s*)?(?:集成|同步|合入|并入|forge-(?:release|git)\s+integrate)/iu.test(direct)
    || /(?:集成|同步|合入|并入)[^。；;！？!?\r\n]{0,24}(?:留待|留到|等到|推迟到)(?:下|后|以后|之后)/u.test(direct)) return false;
  return [...direct.matchAll(/[^。；;！？!?\r\n]+/gu)].some(match => {
    const preceding = direct.slice(0, match.index).split(/[。；;！？!?]/u).at(-1) ?? '';
    if (/(?:引用(?:内容)?|示例|文档(?:示例|说明)?|日志|工具(?:输出|结果)|提示(?:文字|文案)|假设|假如|设想|如果)[^\r\n]*[：:][ \t]*\r?\n[ \t]*$/u.test(preceding)) return false;
    const clause = match[0].trim();
    // A completed task candidate may name submission, integration and push in
    // one direct action. This authorizes checkpoint/integration only.
    if (/^(?:请\s*)?(?:继续(?:原|当前|本次|本轮)[^，,。；;！？!?\r\n]{1,80}任务[，,]\s*)?(?:把|将)(?:(?:本|当前|原)(?:工作舱|任务|对话|会话)(?:的)?)?已(?:经)?完成的[^，,。；;！？!?\r\n]{0,48}候选(?:通过|沿)(?:正常|现有)?受控工具提交(?:、|并)集成并推送到(?:项目\s*)?(?:canonical\s+)?main\s*$/u.test(clause)) return true;
    return /^(?:现在)?(?:请\s*)?(?:把|将)(?:当前(?:项目)?的?)?(?:共享主线|canonical|主线)[^，,。；;！？!?\r\n]{0,80}?(?:通过|沿)\s*(?:正常|现有)?受控\s*(?:Git\s*)?集成(?:入口|流程)?(?:合入|并入)(?:当前|本|本次|本轮)(?:任务的)?候选(?=[，,\s]|$)/iu.test(clause)
      || /^(?:现在)?(?:请\s*)?(?:执行|完成|继续(?:执行|完成)?)(?:这一次|本次|当前|本轮)?(?:的)?受控\s*(?:Git\s*)?集成(?=[，,\s]|$)/iu.test(clause)
      || /^(?:现在)?(?:请\s*)?(?:执行|完成)\s*(?:一次\s*)?forge-(?:release|git)\s+integrate(?=[，,\s]|$)/iu.test(clause);
  });
}

function requestedProductionAction(prompt) {
  if (requestsExplicitTaskLocalCheckpoint(prompt)) return 'git-checkpoint';
  if (requestsCheckpointWithoutPublication(prompt)) return 'git-checkpoint';
  const integration = requestsExplicitTaskLocalIntegration(prompt);
  if (hasProductionActionDenial(prompt)) return integration ? 'git-checkpoint' : null;
  const compoundAuthorization = directCompoundTaskAuthorization(prompt);
  if (compoundAuthorization !== null) return compoundAuthorization.actionCeiling;
  if (BARE_CHECKPOINT_OR_RELEASE.test(prompt)) return /(?:发版|发布|部署|上线)/u.test(prompt) ? 'release' : 'git-checkpoint';
  if (DIRECT_CURRENT_CHANGE.exec(prompt)?.groups?.action !== undefined) return 'release';
  const confirmedAction = CONFIRM_CURRENT_SCOPE.exec(prompt)?.groups?.action;
  if (confirmedAction !== undefined) return confirmedAction.startsWith('提交') ? 'git-checkpoint' : 'release';
  const currentTaskMatch = DIRECT_CURRENT_TASK_PRODUCTION_ACTION.exec(prompt);
  if ((currentTaskMatch !== null && CURRENT_TASK_OBJECT.test(currentTaskMatch.groups.target))
    || DIRECT_OBJECT_FIRST_PRODUCTION_ACTION.test(prompt) || DIRECT_SCOPED_EXECUTION_RELEASE.test(prompt)
    || CONFIRM_SAVED_PRODUCTION_PLAN.test(prompt)) {
    // A denied current-task request must not fall through to a later release mention.
    return requestedCurrentTaskProductionAction(prompt);
  }
  if (CONTROLLED_RELEASE_ROUTE.test(prompt)
    || /^(?:请|现在请)?(?:提交(?:代码)?并)?(?:发版|发布|部署|上线)(?=[\s:：，,。！!]|$)/u.test(prompt)) return 'release';
  if (!ATTRIBUTED_CONDITIONAL_RELEASE.test(prompt)
    && !ATTRIBUTED_NEXT_LINE_CONDITIONAL_RELEASE.test(prompt)
    && DIRECT_CONDITIONAL_RELEASE.test(prompt)) return 'release';
  if (!ATTRIBUTED_NEXT_LINE_CONDITIONAL_RELEASE.test(prompt) && hasDirectReleaseSentence(prompt)) return 'release';
  if (/^(?:请|现在请)?提交(?:代码)?(?=[\s:：，,。！!]|$)/u.test(prompt)) return 'git-checkpoint';
  return integration ? 'git-checkpoint' : null;
}

// An affirmative request can authorize a concrete scope and its closeout in
// one sentence. Registration is a compilation step, not another user decision.
// Keep named-file requests separate from continuations: their exact proposal
// must be checked before any old grant is inherited.
function directCompoundTaskAuthorization(prompt) {
  if (hasGlobalReadOnlyIntent(prompt) || hasPlanningRequest(prompt) || hasCancellationClause(prompt)
    || QUESTION_REQUEST.test(prompt) || /[？?]/u.test(prompt)
    || hasCurrentProductionActionRestriction(prompt)
    || EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(prompt) || CONTINUATION_NEW_SCOPE.test(prompt)) return null;
  const unquoted = prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`/gu, ' ')
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, ' ');
  // Keep this new entry safe on older consumers whose restriction helper does
  // not recognize a bare "不发布/不提交" clause after the affirmative sentence.
  if (/(?:^|[，,。；;！!\r\n])\s*(?:(?:但|但是|不过)\s*)?(?:(?:本轮|本次|当前|现在|这轮|此次)\s*)?(?:请\s*)?不(?:再|继续)?\s*(?:受控\s*)?(?:提交(?:代码)?|发布|发版|部署|上线)(?=[，,。；;！!\s]|$)/u.test(unquoted)) return null;
  const direct = unquoted.split(/[。；;！!\r\n]/u)[0].trim();
  if (!/^(?:请\s*)?(?:(?:我)?(?:确认|同意|允许|授权)|继续(?:执行|实施)?|执行)/u.test(direct)
    || /(?:不要|不得|禁止|暂不|先不|取消|撤回|假设|假如|如果)/u.test(direct)) return null;
  const clauses = direct.split(/[，,]/u).map(clause => clause.trim());
  const closeouts = clauses.map(clause => /(?:^|并且|然后|接着|并|和|及|再)\s*(?:请\s*)?(?:继续(?:执行|完成)?|直接|完成|执行)?\s*(?:受控)?(?<action>发布|发版|部署|上线|(?:建立|保存)(?:受控)?检查点|提交(?:代码)?)$/u.exec(clause))
    .filter(match => match !== null);
  if (closeouts.length === 0) return null;
  return {
    actionCeiling: closeouts.some(match => /(?:发布|发版|部署|上线)/u.test(match.groups.action)) ? 'release' : 'git-checkpoint',
    prepareScope: clauses.some(clause => /(?:文件|路径)/u.test(clause)),
  };
}

function conversationTaskWritableEligible(prompt) {
  const normalized = prompt.trim();
  return !hasGlobalReadOnlyIntent(normalized)
    && !hasPlanningRequest(normalized)
    && !CANCEL_TASK.test(normalized)
    && !AMBIGUOUS_PERMISSION_REQUEST.test(normalized)
    && (hasTaskWriteIntent(normalized)
      || isForgeConversationTaskContinuation(normalized)
      || requestedProductionAction(normalized) !== null);
}

function requestsConversationScopePreparation(prompt) {
  if (!conversationTaskWritableEligible(prompt)) return false;
  const direct = prompt.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\r\n]*"|'[^'\r\n]*'/gu, ' ');
  return direct.split(/[，,。；;！？!?\r\n]+/u).some(clause => {
    const text = clause.trim();
    return /^(?:请\s*)?(?:(?:本轮|本次|这次|当前)\s*)?(?:重新\s*(?:准备|确定|申请)|调整|更新|变更)[^，,。；;！？!?\r\n]{0,40}(?:文件|路径|任务)(?:的)?(?:修改|写入|授权)?范围/u.test(text)
      || /^(?:本轮|本次|这次|当前)(?:必要且)?(?:明确)?(?:授权|允许|需要|需)(?:的|修改|修复|调整|变更){0,2}(?:精确|具体)?(?:文件|路径|范围)(?:为|是|如下|包括)/u.test(text);
  });
}

export function isForgeConversationTaskContinuation(prompt) {
  if (typeof prompt !== 'string') return false;
  const normalized = prompt.trim();
  const compoundAuthorization = directCompoundTaskAuthorization(normalized);
  if (compoundAuthorization !== null) return !compoundAuthorization.prepareScope;
  const requestedAction = requestedProductionAction(normalized);
  return isBareTaskContinuation(normalized) || CONFIRM_CURRENT_SCOPE.test(normalized)
    || (requestedAction === 'git-checkpoint'
      && CURRENT_CANDIDATE_CONTINUATION_PREFIX.test(normalized)
      && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(normalized) && !CONTINUATION_NEW_SCOPE.test(normalized))
    || (requestsCheckpointWithoutPublication(normalized)
      && /^(?:请|现在请)?(?:(?:受控\s*)?提交|继续(?:完成)?当前|完成(?:本批|本轮|本次|当前))/u.test(normalized)
      && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(normalized) && !CONTINUATION_NEW_SCOPE.test(normalized))
    || CONFIRM_SAVED_SCOPE.test(normalized) || CONFIRM_FIELD_VALUE.test(normalized)
    || DIRECT_CURRENT_CHANGE.test(normalized)
    || DIRECT_EXECUTION_AFTER_CONFIRMATION.test(normalized) || CONTINUE_TASK_VERIFICATION.test(normalized)
    || confirmsCurrentTaskWithClarifications(normalized)
    || continuesCurrentTaskWithNotes(normalized)
    || isForgeConversationRepairContinuation(normalized)
    || (REVALIDATE_CURRENT_TASK.test(normalized) && permitsCurrentTaskContinuationNotes(normalized))
    || (requestedAction !== null && (BARE_CHECKPOINT_OR_RELEASE.test(normalized) || CONTROLLED_RELEASE_ROUTE.test(normalized)))
    || requestedCurrentTaskProductionAction(normalized) !== null;
}

function permitsCurrentTaskContinuationNotes(text, { allowCurrentTaskRelease = false } = {}) {
  return !/[？?]/u.test(text) && !QUESTION_REQUEST.test(text)
    && !hasGlobalReadOnlyIntent(text) && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !/(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:先\s*)?只读(?:分析|检查|审查|核对|查看|读取|诊断)/u.test(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && text.split(/[，,。；;！？!?\r\n]+/u).every(clause => {
      const direct = clause.trim().replace(/^(?:然后|再|并且|并|同时)\s*/u, '');
      const action = requestedProductionAction(direct);
      return action === null || (allowCurrentTaskRelease
        && (requestedCurrentTaskProductionAction(direct) === action
          || /^(?:本轮|本次|当前)(?:明确)?授权(?:(?:实施|修改|检查|验证|测试|(?:受控)?提交|集成)(?:、|和|并)?)+(?:受控)?(?:发布|发版|部署|上线)$/u.test(direct)));
    });
}

export function isForgeConversationRepairContinuation(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return /^(?:请\s*)?继续修改(?:(?:原|当前|本次|这个)的?任务)?(?=[，,。；;！!\s]|$)/u.test(text)
    && !/(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:不要|不得|禁止|暂不|先不|不能)\s*(?:再|继续)?\s*(?:修改|修复|改动)(?:(?:原|当前|本次|这个)的?任务)?(?=[，,。；;！？!?\s]|$)/u.test(text)
    && permitsCurrentTaskContinuationNotes(text, { allowCurrentTaskRelease: true });
}

export function isForgeAccessWiringMigrationRepairContinuation(prompt, phase) {
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || !((phase.phaseId === 'cross-layer-acceptance' && phase.phaseIndex === 7 && phase.actionCeiling === 'read-only')
      || (phase.phaseId === 'access-wiring' && phase.phaseIndex === 6 && phase.actionCeiling === 'workspace-write'))) return false;
  const text = prompt.trim();
  // Prohibiting a substitute workflow preserves the named managed repair.
  // Remove only that complete local clause from withdrawal detection; every
  // other restriction still sees the unchanged original request below.
  const withdrawalText = text.replace(/(^|[，,。；;！？!?\r\n])\s*(?:不要|不得|禁止)\s*(?:用|使用)[^，,。；;！？!?\r\n]{1,64}?(?:替代|取代)(?:受管|受控)(?:阶段)?(?:修复|修正)(?=[，,。；;！？!?\s]|$)/gu, '$1');
  return /(?:^|[。；;\n])\s*(?:请\s*)?(?:继续)?(?:修复|修正|纠正)[^。；;!?！？\n]{0,100}(?:权限|接线|迁移)/u.test(text)
    && !/(?:撤回|取消|不要|禁止|暂不|先不)[^。；;\n]{0,24}(?:修复|修正|修改)/u.test(withdrawalText)
    && permitsCurrentTaskContinuationNotes(text);
}

export function isForgeBackendRuntimeRepairContinuation(prompt, phase) {
  if (phase?.workflowId !== 'crud-production'
    || !((phase.phaseId === 'cross-layer-acceptance' && phase.phaseIndex === 7 && phase.actionCeiling === 'read-only')
      || (phase.phaseId === 'backend' && phase.phaseIndex === 4 && phase.actionCeiling === 'workspace-write'
        && Array.isArray(phase.ownedPaths) && phase.ownedPaths.length > 0))) return false;
  return isForgeConversationRepairContinuation(prompt)
    && /(?:后端|backend)/iu.test(prompt) && /(?:修复|修正|纠正)/u.test(prompt)
    && permitsCurrentTaskContinuationNotes(prompt);
}

export function isForgeAccessWiringRuntimeRepairContinuation(prompt, phase) {
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || !((phase.phaseId === 'cross-layer-acceptance' && phase.phaseIndex === 7 && phase.actionCeiling === 'read-only')
      || (phase.phaseId === 'access-wiring' && phase.phaseIndex === 6 && phase.actionCeiling === 'workspace-write'))) return false;
  const text = prompt.trim();
  // This recognizes the user's current repair request, not a runtime failure proof.
  // The Controller must still derive the repair phase from its protected observation.
  if (!/^(?:请\s*)?(?:现在\s*)?(?:继续\s*)?(?:修复|修正|补齐|纠正)(?:当前|本次|原)[^，,。；;！？!?\r\n]{0,64}(?:权限|接线)/u.test(text)) return false;
  // A conditional later publication is not authority to publish during this repair.
  // Keep every independent immediate action and every global read-only ban intact.
  const currentText = text.replace(/(^|[，,。；;\r\n])\s*(?:(?:检查|验证|验收)?通过|满足)后\s*(?:再|继续)?\s*(?:按)?(?:原|现有|已有|既有)?(?:受控)?(?:发布|发版|部署|上线)(?=[，,。；;！!\s]|$)/gu, '$1');
  return permitsCurrentTaskContinuationNotes(currentText)
    && !/(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:撤回|取消)\s*(?:(?:当前|本次|原|这次)的?)?(?:权限接线)?(?:修复|修改)(?:请求|授权)?(?=[，,。；;！!\s]|$)/u.test(currentText)
    && !/(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:不要|不得|禁止|暂不|先不|停止|不再)\s*(?:再|继续)?\s*(?:修复|修改|修正|补齐|纠正)(?:(?:当前|本次|原|这个)的?[^，,。；;！？!?\r\n]{0,64})?(?=[，,。；;！!\s]|$)/u.test(currentText)
    && !/(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:(?:立即|现在|直接|同时|并|然后|再)\s*)*(?:受控\s*)?(?:发布|发版|部署|上线|提交)(?=[^\r\n]|$)/u.test(currentText);
}

function hasCurrentRuntimeProbeWithdrawal(text) {
  // Withdrawing the current task also withdraws its runtime probes.
  if (/(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:不要|不得|禁止|暂不|先不|不能|不再|停止|取消|撤回)\s*(?:再)?(?:(?:继续|执行)(?:(?:原|当前|本次|这个)的?任务)?|(?:原|当前|本次|这个)的?任务)(?=[，,。；;！？!?\s]|$)/u.test(text)) return true;
  return text.split(/[，,。；;：:！？!?\r\n]+/u).some(clause => {
    const negatives = [...clause.matchAll(/撤回|取消|暂不|先不|停止|不要|不得|禁止|不再/gu)];
    return negatives.some((negative, index) => {
      // Each negative action owns only its following object, never a later withdrawal.
      const request = clause.slice(negative.index + negative[0].length, negatives[index + 1]?.index)
        .trim().replace(/^(?:次)?(?:再(?:次)?)?\s*/u, '');
      // A negative list keeps each action with its own object, including historical checks.
      return request.split(/、|(?:和|及|或|并)(?=(?:重新执行|重复|重跑|重做|执行|进行|补充|补齐|做|探测|检查|验证|验收|扩展|打磨))/u).some(item => {
        if (!/^[^，,。；;！？!?\r\n]{0,16}(?:补充|补齐|重新执行|探测|检查|验证|验收)/u.test(item)) return false;
        const action = /^(?<only>只)?\s*(?<verb>重新执行|重复|重跑|重做|执行|进行|补充|补齐|做)\s*(?<object>.*)$/u.exec(item.trim());
        // Limiting verification to a repeated check is different from stopping verification.
        if (action?.groups.only && /^(?:重复|重跑|重做|做)$/u.test(action.groups.verb)) return false;
        const object = action?.groups.object ?? item;
        // Only explicitly completed or historical targets are excluded; unknown targets still withdraw.
        return /(?:当前|本轮|本次|尚未|未通过|未完成)/u.test(object)
          || !/^(?:已(?:经)?(?:通过|完成)(?:的)?|旧(?:的)?|历史)[^，,。；;：:！？!?\r\n、和及与或并]{0,24}(?:检查|验证|探测)\s*$/u.test(object);
      });
    });
  });
}

export function isForgeCrossLayerRuntimeReprobeContinuation(prompt, phase) {
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || phase.phaseId !== 'cross-layer-acceptance' || phase.phaseIndex !== 7
    || phase.actionCeiling !== 'read-only') return false;
  // Conditional later repair/release is not authority for either action now.
  // The returned continuation still grants only the Controller-bound readonly preparation.
  const text = prompt.trim()
    .replace(/(?:^|[。；;\r\n])\s*(?:如果|若)[^。；;！？!?\r\n]{0,100}(?:缺口|问题|缺陷)[^。；;！？!?\r\n]{0,100}(?:受控修复|修复路径)[^。；;！？!?\r\n]*(?=[。；;\r\n]|$)/gu, '')
    .replace(/(?:^|[。；;\r\n])\s*(?:完成|通过)[^。；;！？!?\r\n]{0,64}(?:验收|验证|检查)后[^。；;！？!?\r\n]{0,40}受控(?:发布|发版|部署|上线)(?=[。；;！!\s]|$)/gu, '');
  return (/(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:并\s*)?(?:继续\s*)?(?:补充|补齐|重新执行)(?:(?:当前|本次|原|这次)[^，,。；;！？!?\r\n]{0,40}候选的?)?(?:必要的?|当前的?|本次的?)?(?:真实的?)?(?:受控)?(?:运行检查|运行验证|探测)(?=[，,。；;！!\s]|$)/u.test(text)
      || /(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:继续(?:完成)?(?:当前|本次|原)?[^，,。；;！？!?\r\n]{0,48}跨层(?:验收|验证)(?:的角色权限(?:验证|检查))?|(?:回到|恢复|继续)(?:原|当前|本次)?受控(?:运行)?检查(?:入口)?|(?:由你\s*)?(?:制定并)?(?:执行|进行)(?:最小的?|必要的?)?(?:真实的?)?(?:认证(?:与|和|及)?(?:业务)?|业务)检查)(?=[，,。；;！!\s]|$)/u.test(text)
      || /(?:^|[，,。；;\r\n])\s*(?:请\s*)?继续(?:执行|完成)?(?:当前|本次|原)(?:受阻|未完成)?的?\s*跨层(?:运行证据)?准备(?:和|及|与|并)(?:受控)?运行(?:检查|验证)(?=[，,。；;！!\s]|$)/u.test(text))
    && permitsCurrentTaskContinuationNotes(text)
    && !/(?:^|\n)\s*(?:>|```|(?:引用|示例|日志|工具输出|工具结果)[：:])/u.test(text)
    && !hasCurrentRuntimeProbeWithdrawal(text)
    && !/(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:(?:立即|现在|直接|同时|并|然后|再)\s*)*(?:发布|发版|部署|上线|提交|修改|修复|改写|删除|重建|迁移)/u.test(text);
}

export function isForgeCrossLayerPreparationContinuation(prompt, phase) {
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || phase.phaseId !== 'cross-layer-acceptance' || phase.phaseIndex !== 7
    || phase.actionCeiling !== 'read-only') return false;
  const text = prompt.trim();
  // A later release remains conditional on actual cross-layer verification.
  // Only this existing preparation scope may consume the continuation.
  const directPreparation = hasDirectControlledPreparationIntent(text);
  let currentText = text.replace(/(?:完成|通过)(?:实际)?(?:候选运行(?:和|及))?跨层(?:验证|验收)后[，,]\s*(?:再)?按(?:原授权|已有|现有)(?:继续)?受控发布(?=[。；;！!\s]|$)/gu, '');
  // An explicit preparation may carry past publication facts. The existing
  // action classifier still rejects a present release request; a later handoff
  // route is scoped only after an explicit successful verification condition.
  const afterVerification = /(?:真实)?准备通过后|(?:完成|通过)跨层(?:验证|验收)后/u.exec(currentText);
  if (directPreparation && afterVerification !== null) {
    currentText = currentText.replace(/(^|[，,。；;\r\n])\s*沿(?:现有|已有)(?:正常)?(?:交接|流程|路径)(?:推进|继续)受控(?:发布|发版|部署|上线)(?=[，,。；;！!\s]|$)/gu,
      (clause, boundary, offset) => offset > afterVerification.index ? `${boundary}后续交付按既有交接` : clause);
  }
  if (!permitsCurrentTaskContinuationNotes(currentText)
    || (!directPreparation && /(?:发布|发版|部署|上线|提交)/u.test(currentText))
    || /\b(?:checkpoint|integrate|promote)\b|forge-release\s+release\b/iu.test(currentText)
    || /(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:(?:立即|现在|直接|马上|同时|并|然后|再)\s*)*(?:发布|发版|部署|上线|提交)(?=[^\r\n]|$)/u.test(currentText)
    || /(?:^|\n)\s*(?:>|```|(?:引用|示例|日志|工具输出|工具结果)[：:])/u.test(currentText)
    || /(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:不要|不得|禁止|暂不|先不|不能|不再)\s*(?:再)?(?:继续|执行)(?:(?:原|当前|本次|这个)的?任务)?(?=[，,。；;！？!?\s]|$)/u.test(currentText)
    || /(?:不要|不得|禁止|暂不|先不|停止|取消|撤回|不再)\s*(?:再|继续|执行)?\s*(?:当前|刚才|此前|原)?的?\s*(?:受控\s*)?(?:跨层(?:运行证据)?准备|(?:forge-release\s+)?prepare)/u.test(currentText)
    || /(?:撤回|取消)[^，,。；;！？!?\r\n]{0,24}(?:准备|prepare)/u.test(currentText)) return false;
  return directPreparation || isForgeConversationTaskContinuation(currentText)
    || /(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:继续(?:执行)?(?:当前|本次|原|刚才|此前)(?:受阻|未完成)?的?\s*(?:跨层(?:运行证据)?准备|forge-release\s+prepare)|从(?:刚才|此前|当前)(?:受阻|未完成)的?\s*forge-release\s+prepare\s*继续)(?=[，,。；;！!\s]|$)/u.test(currentText);
}

export function isForgeCrossLayerPhaseCompletion(prompt, phase) {
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || phase.phaseId !== 'cross-layer-acceptance' || phase.phaseIndex !== 7
    || phase.actionCeiling !== 'read-only') return false;
  const text = prompt.trim();
  return /^(?:请\s*)?(?:确认|认可|验收)(?:当前|本次|本轮)?跨层验收(?:阶段)?(?:产物|候选|结果)?(?=[，,。；;！!\s]|$)/u.test(text)
    && permitsCurrentTaskContinuationNotes(text)
    && !/(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:(?:立即|现在|直接|马上|同时|并|然后|再)\s*)?(?:发布|发版|部署|上线|提交)/u.test(text)
    && !/(?:撤回|取消)\s*(?:当前|本次)?\s*(?:确认|验收)|(?:不要|不得|禁止|暂不|先不|不能|不再)\s*(?:确认|接受|验收|推进|进入|继续)|(?:先|继续)\s*(?:修复|修正|修改|纠正)/u.test(text);
}

export function isForgeAccessWiringPhaseCompletion(prompt, phase) {
  const current = phase?.phaseId === 'access-wiring' && phase.phaseIndex === 6 && phase.actionCeiling === 'workspace-write';
  const next = phase?.phaseId === 'cross-layer-acceptance' && phase.phaseIndex === 7 && phase.actionCeiling === 'read-only';
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production' || (!current && !next)) return false;
  const text = prompt.trim();
  const opening = /^(?:请\s*)?(?:确认|认可|验收)(?:当前|本次|本轮)?[^，,。；;！？!?“”‘’"'`\r\n]{0,80}权限接线(?:(?:(?:修复(?:后的?)?)?候选|阶段(?:产物)?)(?:已完成|完成|通过)?|(?:候选修复|修复(?:(?:后的?)?候选)?)(?:结果|(?:及|和|与)(?:当前源码的)?(?:已经通过的|已通过的)?(?:治理(?:检查)?[、和及与])?(?:后端(?:模块)?)?验证结果))[，,。]/u;
  const adjacent = /(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:(?:通过后)?(?:接受|验收)权限接线阶段(?:并|后))?(?:(?:(?:并\s*)?进入|推进到)(?:并完成)?|继续(?:完成)?(?:(?:原|当前|本次|本轮)[^，,。；;！？!?“”‘’"'`\r\n]{0,40}任务的?)?)跨层验收(?:阶段)?(?=[。！!\s]|$)/u;
  // A later controlled delivery depends on cross-layer acceptance. It neither
  // grants release now nor changes the read-only ceiling of the adjacent phase.
  const currentText = text.replace(/(?:完成|通过)跨层验收后[，,]\s*再按(?:已有|现有)受控发布路径交付(?=[。；;！!\s]|$)/gu, '');
  return opening.test(text) && adjacent.test(text) && permitsCurrentTaskContinuationNotes(currentText)
    && !/(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:(?:立即|现在|直接|马上|同时|并|然后|再)\s*)?(?:发布|发版|部署|上线|提交)/u.test(currentText)
    && !/(?:撤回|取消)\s*(?:当前|本次)?\s*(?:确认|验收)|(?:不要|不得|禁止|暂不|先不|不能|不再)\s*(?:确认|接受|验收|推进|进入|继续)|(?:先|继续)\s*(?:修复|修正|修改|纠正)/u.test(currentText);
}

export function isForgeFrontendPhaseCompletion(prompt, phase) {
  const currentFrontend = phase?.phaseId === 'frontend' && phase.phaseIndex === 5;
  const nextAccessWiring = phase?.phaseId === 'access-wiring' && phase.phaseIndex === 6;
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || (!currentFrontend && !nextAccessWiring) || phase.actionCeiling !== 'workspace-write') return false;
  const text = prompt.trim();
  const opening = /^(?:请\s*)?(?:确认|认可|验收)(?:当前|本次|本轮)?[^，,。；;！？!?“”‘’"'`\r\n]{0,80}前端阶段(?:已完成|完成|通过)?[，,。]\s*(?:请\s*)?(?:进入|推进(?:到)?)(?:并完成)?权限接线阶段(?=[。！!\s]|$)/u;
  return opening.test(text) && permitsCurrentTaskContinuationNotes(text)
    && !/(?:撤回|取消)\s*(?:当前|本次)?\s*(?:确认|验收)|(?:不要|不得|禁止|暂不|先不|不能|不再)\s*(?:确认|接受|验收|推进|进入|继续)|(?:先|继续)\s*(?:修复|修正|修改|纠正)/u.test(text);
}

export function isForgeBackendPhaseCompletion(prompt, phase) {
  const currentBackend = phase?.phaseId === 'backend' && phase.phaseIndex === 4;
  const nextFrontend = phase?.phaseId === 'frontend' && phase.phaseIndex === 5;
  const returnedCrossLayer = phase?.phaseId === 'cross-layer-acceptance' && phase.phaseIndex === 7
    && phase.actionCeiling === 'read-only';
  if (typeof prompt === 'string' && phase?.workflowId === 'crud-production'
    && ((currentBackend && phase.actionCeiling === 'workspace-write') || returnedCrossLayer)) {
    const text = prompt.trim();
    const confirmsBackend = /^(?:请\s*)?(?:确认|认可|验收)(?:当前|本次|本轮)?[^，,。；;！？!?“”‘’"'`\r\n]{0,40}后端阶段(?:(?:修复|实现)(?:后的?)?)?(?:产物|候选|结果)(?:已完成|完成|通过)?[，,。]/u;
    const returnsCrossLayer = /(?:^|[，,。；;\r\n])\s*(?:请\s*)?(?:(?:进入|推进到)|继续(?:完成)?(?:(?:原|当前|本次|本轮)[^，,。；;！？!?\r\n]{0,40}任务的?)?)跨层验收(?:阶段)?(?=[。！!\s]|$)/u;
    if (confirmsBackend.test(text) && returnsCrossLayer.test(text)) {
      return permitsCurrentTaskContinuationNotes(text)
        && !/(?:撤回|取消)\s*(?:当前|本次)?\s*(?:确认|验收)|(?:不要|不得|禁止|暂不|先不|不能)\s*(?:再|继续)?\s*(?:确认|接受|验收|推进|进入)|(?:不要|不得|禁止|暂不|先不|不能)\s*继续\s*(?:当前任务|原任务|跨层验收)/u.test(text);
    }
  }
  if (typeof prompt !== 'string' || phase?.workflowId !== 'crud-production'
    || (!currentBackend && !nextFrontend) || phase.actionCeiling !== 'workspace-write') return false;
  const text = prompt.trim();
  const opening = /^(?:请\s*)?继续完成[^，,。；;！？!?“”‘’"'`\r\n]{0,80}[，,]\s*(?:推进|进入)(?:到)?前端阶段(?=[。！!\s]|$)/u;
  if (!opening.test(text) || hasGlobalReadOnlyIntent(text) || /[？?]/u.test(text)
    || /(?:不要|不得|禁止|暂不|先不|不能)\s*(?:接受|验收|推进|进入|继续)/u.test(text)
    || /(?:先|继续)\s*(?:修复|修正|修改|纠正)/u.test(text)) return false;
  // Classify the explicit named-task continuation with the existing full-text
  // restrictions. The original request remains the issuer's bound input.
  const continuation = text.replace(/^(?:请\s*)?继续完成[^，,。；;！？!?\r\n]*/u, '继续完成当前任务');
  return isForgeConversationTaskContinuation(continuation);
}

// Domain contract continuation inherits the existing task scope while its
// Controller authority remains read-only. It is not a general write-intent rule.
export function isForgeDomainContractContinuation(prompt, phase) {
  if (phase?.phaseId !== 'domain-contract' || phase.phaseIndex !== 1 || phase.actionCeiling !== 'read-only'
    || !Array.isArray(phase.ownedPaths) || phase.ownedPaths.length !== 0 || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  const firstSentence = text.match(/^[^。；;！？!?\r\n]*(?:[。；;！？!?]|$)/u)?.[0] ?? '';
  const domainRequest = /^(?:请\s*)?(?:继续|接着)(?:完成|处理|生成|修订|完善)?(?:当前|本轮|这个)?的?(?:领域(?:(?:与|和|及|\/)(?:接口|API))?|接口|API)合同(?=[，,。；;！!\s]|$)/u.test(text);
  return (domainRequest || isForgeConversationTaskContinuation(text))
    && !/[？?]\s*$/u.test(firstSentence) && !hasGlobalReadOnlyIntent(text)
    && !QUESTION_REQUEST.test(firstSentence) && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && requestedProductionAction(text) === null
    && text.split(/[。；;！？!?\r\n]+/u).every((clause) => requestedProductionAction(clause.trim()) === null);
}

export function isForgeDatabaseLeaseContinuation(prompt, phase) {
  if (phase?.phaseId !== 'database' || phase.phaseIndex !== 2 || phase.actionCeiling !== 'workspace-write'
    || !Array.isArray(phase.ownedPaths) || phase.ownedPaths.length === 0 || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return (/^(?:请\s*)?(?:继续|接着)(?:完成|处理|生成)?(?:当前|本轮|这个)?的?数据库阶段(?=[。！!，,\s]|$)/u.test(text)
    || isForgeConversationTaskContinuation(text))
    && !/[？?]/u.test(text) && !hasGlobalReadOnlyIntent(text) && !QUESTION_REQUEST.test(text)
    && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && requestedProductionAction(text) === null
    && text.split(/[。；;！？!?\r\n]+/u).every(clause => requestedProductionAction(clause.trim()) === null);
}

export function isForgeBackendLeaseContinuation(prompt, phase) {
  if (phase?.phaseId !== 'backend' || phase.phaseIndex !== 4 || phase.actionCeiling !== 'workspace-write'
    || !Array.isArray(phase.ownedPaths) || phase.ownedPaths.length === 0 || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return (/^(?:请\s*)?(?:继续|接着)(?:完成|处理|生成)?(?:当前|本轮|这个)?的?后端阶段(?=[。！!，,\s]|$)/u.test(text)
    || isForgeConversationTaskContinuation(text))
    && !/[？?]/u.test(text) && !hasGlobalReadOnlyIntent(text) && !QUESTION_REQUEST.test(text)
    && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && requestedProductionAction(text) === null
    && text.split(/[。；;！？!?\r\n]+/u).every(clause => requestedProductionAction(clause.trim()) === null);
}

export function isForgeAccessWiringLeaseContinuation(prompt, phase) {
  if (phase?.workflowId !== 'crud-production' || phase.phaseId !== 'access-wiring' || phase.phaseIndex !== 6
    || phase.actionCeiling !== 'workspace-write' || !Array.isArray(phase.ownedPaths)
    || phase.ownedPaths.length === 0 || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return (/^(?:请\s*)?(?:从[^，,。；;！？!?“”‘’"'`\r\n]{0,24}(?:中断|暂停)(?:的)?(?:位置|处)\s*)?(?:继续|接着)(?:完成|处理|修复|修改)?(?:当前|本轮|这个)?[^，,。；;！？!?“”‘’"'`\r\n]{0,80}权限接线(?:阶段|修复)(?=[。！!，,\s]|$)/u.test(text)
    || isForgeConversationTaskContinuation(text)
    || isForgeAccessWiringMigrationRepairContinuation(text, phase))
    && permitsCurrentTaskContinuationNotes(text)
    && !/(?:撤回|取消)\s*(?:本次|本轮|当前)?\s*(?:修改|执行|写入)?授权|(?:不要|不得|禁止|暂不|先不|不能)\s*(?:继续|修复|修改|执行)/u.test(text);
}

export function isForgeFrontendLeaseContinuation(prompt, phase) {
  if (phase?.workflowId !== 'crud-production' || phase.phaseId !== 'frontend' || phase.phaseIndex !== 5
    || phase.actionCeiling !== 'workspace-write' || !Array.isArray(phase.ownedPaths)
    || phase.ownedPaths.length === 0 || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return (/^(?:请\s*)?(?:继续|接着)(?:完成|处理|修复|修改)?(?:当前|本轮|这个)?的?前端阶段(?=[。！!，,\s]|$)/u.test(text)
    || isForgeConversationTaskContinuation(text))
    && !/[？?]/u.test(text) && !hasGlobalReadOnlyIntent(text) && !QUESTION_REQUEST.test(text)
    && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && requestedProductionAction(text) === null
    && text.split(/[。；;！？!?\r\n]+/u).every(clause => requestedProductionAction(clause.trim()) === null);
}

// Only the active database phase can inherit scope for missing evidence feedback.
export function isForgeDatabaseEvidenceContinuation(prompt, phase) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return (isForgeDatabaseLeaseContinuation(text, phase)
    || (/^(?:请\s*)?(?:补齐|补充|完善|核对|复用)/u.test(text) && /(?:回执|证据)/u.test(text)))
    && isForgeDatabaseLeaseContinuation(`继续当前数据库阶段。${text}`, phase)
    && text.split(/[，,。；;！？!?\r\n]+/u).every(clause =>
      requestedProductionAction(clause.trim().replace(/^(?:然后|再|并且|并|同时)\s*/u, '')) === null);
}

export function isForgeBackendEvidenceContinuation(prompt, phase) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trim();
  return (isForgeBackendLeaseContinuation(text, phase)
    || (/^(?:请\s*)?(?:补齐|补充|完善|核对|复用)/u.test(text) && /(?:回执|证据)/u.test(text)))
    && isForgeBackendLeaseContinuation(`继续当前后端阶段。${text}`, phase)
    && text.split(/[，,。；;！？!?\r\n]+/u).every(clause =>
      requestedProductionAction(clause.trim().replace(/^(?:然后|再|并且|并|同时)\s*/u, '')) === null);
}

// A human correction of a completed domain candidate retains the same read-only
// contract scope. Acceptance, release, and unrelated tasks remain separate.
function hasDomainCandidateCorrectionRequest(text) {
  return /(?:^|[，,。；;！？!?\r\n])\s*(?:请\s*)?(?:先\s*)?(?:修正|修改|修订|纠正|完善)(?:当前|本轮|这个)?的?(?:领域(?:(?:与|和|及|\/)(?:接口|API))?|接口|API)合同/u.test(text);
}

export function isForgeDomainCandidateCorrection(prompt, phase) {
  if (phase?.phaseId !== 'domain-contract' || phase.phaseIndex !== 1 || phase.actionCeiling !== 'read-only'
    || !Array.isArray(phase.ownedPaths) || phase.ownedPaths.length !== 0 || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  const firstSentence = text.match(/^[^。；;！？!?\r\n]*(?:[。；;！？!?]|$)/u)?.[0] ?? '';
  return hasDomainCandidateCorrectionRequest(text)
    && !/[？?]\s*$/u.test(firstSentence) && !hasGlobalReadOnlyIntent(text)
    && !QUESTION_REQUEST.test(firstSentence) && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && requestedProductionAction(text) === null
    && text.split(/[。；;！？!?\r\n]+/u).every((clause) => requestedProductionAction(clause.trim()) === null);
}

// Explicit acceptance of the current domain contract can include existing-rule
// notes. Preserve existing scope and carry only the explicit adjacent database authorization.
export function isForgeDomainAcceptanceContinuation(prompt, phase) {
  if (typeof prompt !== 'string' || !Array.isArray(phase?.ownedPaths)) return false;
  const currentDomain = phase.phaseId === 'domain-contract' && phase.phaseIndex === 1
    && phase.actionCeiling === 'read-only' && phase.ownedPaths.length === 0;
  const nextDatabase = phase.phaseId === 'database' && phase.phaseIndex === 2
    && phase.actionCeiling === 'workspace-write' && phase.ownedPaths.length > 0;
  if (!currentDomain && !nextDatabase) return false;
  const text = prompt.trim();
  const confirmation = /^(?:(?:请\s*)?继续完成[。！!\s]*)?(?:请\s*)?(?:(?:当前|本轮|这个)?的?(?:领域(?:(?:与|和|及|\/)(?:接口|API))?|接口|API)合同(?:已确认|已通过|确认无误)|(?:我已|已经|已)?(?:确认|接受)(?:当前|本轮|这个)?的?(?:领域(?:(?:与|和|及|\/)(?:接口|API))?|接口|API)合同)[，,。；;！!\s]*(?:(?:并且|并|然后|接着)\s*)?(?:请\s*)?(?:继续|进入|开始|推进到|转入)(?:到)?(?:下一)?数据库(?:阶段)?(?=[。；;！!，,\s]|$)/u;
  return confirmation.test(text) && !hasDomainCandidateCorrectionRequest(text) && !hasGlobalReadOnlyIntent(text)
    && !/[？?]/u.test(text) && !/(?:不要|不得|禁止|暂不|先不|尚未|未)\s*(?:确认|接受|进入|开始|推进)/u.test(text)
    && !QUESTION_REQUEST.test(text) && !hasPlanningRequest(text) && !hasCancellationClause(text)
    && !EXPLICIT_NEW_TASK_AFTER_CONFIRMATION.test(text) && !CONTINUATION_NEW_SCOPE.test(text)
    && requestedProductionAction(text) === null
    && text.split(/[。；;！？!?\r\n]+/u).every(clause => requestedProductionAction(clause.trim()) === null);
}

class AcceptanceServiceError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = 'AcceptanceServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new AcceptanceServiceError(code, message, statusCode);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail('ACCEPTANCE_SCHEMA_INVALID', `${label} has unsupported or missing fields.`);
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('ACCEPTANCE_SCHEMA_INVALID', `${label} is invalid.`);
  return value;
}

function validateReviewFeedback(value, stored = false) {
  exactKeys(value, ['reviewId', 'explanation', ...(stored ? ['summarySha256'] : [])], 'review feedback');
  if (typeof value.reviewId !== 'string' || !REVIEW_FEEDBACK_ID.test(value.reviewId)
    || typeof value.explanation !== 'string' || value.explanation.trim().length === 0
    || Buffer.byteLength(value.explanation, 'utf8') > 4096
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value.explanation)
    || REVIEW_FEEDBACK_SECRET.test(value.explanation)
    || (stored && (typeof value.summarySha256 !== 'string' || !SHA256.test(value.summarySha256)))) {
    fail('ACCEPTANCE_REVIEW_FEEDBACK_INVALID', '独审事实反馈格式无效、超出4KiB或包含疑似凭据。', 422);
  }
  return value;
}

function directReviewFeedback(promptText) {
  const lines = promptText.split(/\r?\n/u).filter((line) => line.trimStart().startsWith('独审事实反馈'));
  if (lines.length === 0) return undefined;
  if (lines.length !== 1 || !lines[0].trim().startsWith(REVIEW_FEEDBACK_MARKER)) {
    fail('ACCEPTANCE_REVIEW_FEEDBACK_INVALID', '独审事实反馈必须使用唯一的中文标记及单行JSON。', 422);
  }
  let value;
  try { value = JSON.parse(lines[0].trim().slice(REVIEW_FEEDBACK_MARKER.length)); } catch {
    fail('ACCEPTANCE_REVIEW_FEEDBACK_INVALID', '独审事实反馈必须使用唯一的中文标记及单行JSON。', 422);
  }
  return validateReviewFeedback(value);
}

function uniqueStrings(value, pattern, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || !pattern.test(item))
    || new Set(value).size !== value.length) fail('ACCEPTANCE_SCHEMA_INVALID', `${label} is invalid.`);
  return [...value];
}

function signerDescriptor(privateKeyPem, keyId, subjectId = undefined) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('ACCEPTANCE_KEY_INVALID', 'Only Ed25519 keys are accepted.', 503);
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return {
    signer: { keyId, privateKey },
    descriptor: { keyId, ...(subjectId === undefined ? {} : { subjectId }), publicKeyPem },
  };
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
  return /^sha256:[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function coversExplicitFrontendContract(taskContract, selected, testsOnly) {
  const owned = taskContract.ownedPaths.filter(file => file.startsWith('forge-admin-ui/'));
  // A file-scoped task can finish with its own selected checks. Directory
  // contracts still need their affected scope; do not call a subset complete.
  if (owned.length === 0 || owned.some(file => !/\.(?:js|jsx|ts|tsx|vue)$/u.test(file))) return false;
  const required = owned.filter(file => testsOnly ? /\.(?:spec|test)\.(?:js|jsx|ts|tsx)$/u.test(file)
    : file.startsWith('forge-admin-ui/src/'));
  // Additional actually executed regression tests do not reduce coverage of
  // the owned tests. Lint still requires the exact file-scoped selection.
  return required.length > 0 && required.every(file => selected.includes(file))
    && (testsOnly || selected.every(file => required.includes(file)));
}

function validateBackendTestClassExecution(raw) {
  try {
    const selectors = raw.request.selectors;
    if (raw.request.selectorsSha256 !== selectorDigest(selectors)) throw new Error('selector digest mismatch');
    let expected;
    let actual;
    if (isHostRunReceipt(raw)) {
      const jobRoot = path.join(raw.isolation.taskStateRoot, 'jobs', raw.jobId);
      expected = hostVerificationCommand('backend-test-class', selectors, raw.source.head, {
        snapshotRoot: path.join(jobRoot, 'workspace'), outputRoot: path.join(jobRoot, 'output'),
        mavenSettings: path.join(jobRoot, 'config', 'maven-settings.xml'), cacheRoot: raw.isolation.cacheRoot,
      }, { maven: raw.toolchain.executables.maven.resolvedPath }).steps;
      actual = raw.execution.steps.map(step => ({ cwd: step.cwd, executable: step.executable,
        // Host can use the prepared repository without network access.
        argv: step.argv[0] === '--offline' ? step.argv.slice(1) : step.argv }));
    } else {
      expected = verificationCommand('backend-test-class', selectors, raw.source.head).steps;
      actual = raw.execution.steps.map(step => ({ cwd: step.cwd, argv: step.argv }));
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('test command mismatch');
    if (raw.status === 'passed' && !(raw.results?.executed > 0 && raw.results.failed === 0
      && raw.results.zeroTestsRejected === false)) throw new Error('no successful test execution');
  } catch {
    fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Backend class execution must match its module/test selectors and actual test outcome.');
  }
}

function coversExplicitBackendContract(taskContract, selected) {
  const required = backendTestSelectorsForContract(taskContract);
  if (required === null) return false;
  const selectedTests = selected.tests.map(test => {
    if (required.tests.includes(test)) return test;
    const matches = required.tests.filter(name => name.split('.').at(-1) === test);
    return matches.length === 1 ? matches[0] : test;
  });
  const exact = (actual, expected) => actual.length === expected.length
    && new Set(actual).size === actual.length && expected.every(value => actual.includes(value));
  if (!exact(selectedTests, required.tests)) return false;
  if (exact(selected.modules, required.modules)) return true;
  // The validated class execution always uses Maven -am. A prepared integration
  // binding proves these direct compile dependencies from the hashed POMs, so
  // selecting the test's reactor root already builds them from this snapshot.
  // This does not apply to unbound tests or independent test modules.
  const bindings = taskContract.backendTestBindings;
  return bindings?.length === 1 && bindings[0].moduleDependencies?.length > 0
    && exact(selected.modules, [bindings[0].module]);
}

function isBoundBackendMethodDiagnostic(taskContract, selected) {
  if (!selected.tests.every(test => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*#[A-Za-z_$][\w$]*$/u.test(test))) return false;
  return coversExplicitBackendContract(taskContract, {
    modules: selected.modules, tests: [...new Set(selected.tests.map(test => test.split('#')[0]))],
  });
}

function validateH5TestExecution(raw) {
  try {
    const selectors = raw.request.selectors;
    if (raw.request.selectorsSha256 !== selectorDigest(selectors)) throw new Error('selector digest mismatch');
    let expected;
    let actual;
    if (isHostRunReceipt(raw)) {
      const jobRoot = path.join(raw.isolation.taskStateRoot, 'jobs', raw.jobId);
      expected = hostVerificationCommand('frontend-h5-test', selectors, raw.source.head, {
        snapshotRoot: path.join(jobRoot, 'workspace'), outputRoot: path.join(jobRoot, 'output'),
      }, { node: raw.toolchain.executables.node.resolvedPath }).steps;
      actual = raw.execution.steps.map(step => ({ cwd: step.cwd, executable: step.executable, argv: step.argv }));
    } else {
      expected = verificationCommand('frontend-h5-test', selectors, raw.source.head).steps;
      actual = raw.execution.steps.map(step => ({ cwd: step.cwd, argv: step.argv }));
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('H5 test command mismatch');
    if (raw.status === 'passed' && !(raw.results.executed > 0 && raw.results.failed === 0
      && raw.results.reportFiles === 1 && raw.results.zeroTestsRejected === false)) throw new Error('no actual H5 test success');
  } catch {
    fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'H5 tests must match their exact selectors, Node execution and actual results.');
  }
}

function validateFrontendAdminTestExecution(raw) {
  try {
    const selectors = raw.request.selectors;
    if (raw.request.selectorsSha256 !== selectorDigest(selectors)) {
      fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Frontend test selector digest is invalid.');
    }
    const changedArgument = raw.execution.steps.at(-1)?.argv.find(arg => arg.startsWith('--changed='));
    const reviewBase = changedArgument?.slice('--changed='.length);
    if (reviewBase !== undefined && !/^[0-9a-f]{40}$/u.test(reviewBase)) {
      fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Frontend changed-test base is invalid.');
    }
    const testArgv = raw.execution.steps.at(-1)?.argv ?? [];
    const filterArguments = changedArgument === undefined ? []
      : testArgv.slice(isHostRunReceipt(raw) ? 1 : 2, testArgv.indexOf(changedArgument));
    const testFilters = filterArguments.length === 0 ? undefined
      : filterArguments.length === 1 && filterArguments[0] === '__forge_no_changed_frontend_tests__/' ? [] : filterArguments;
    frontendTestScopeFilters(testFilters);
    // Historical whole-suite receipts remain factual evidence. New default
    // receipts prove the affected scope, including a truthful zero-test result.
    const historicalPlan = steps => steps.map(step => ({ ...step, argv: changedArgument === undefined
      ? step.argv.filter(arg => !arg.startsWith('--changed=') && arg !== '--passWithNoTests') : step.argv }));
    let expectedSteps;
    if (isHostRunReceipt(raw)) {
      const jobRoot = path.join(raw.isolation.taskStateRoot, 'jobs', raw.jobId);
      expectedSteps = hostVerificationCommand('frontend-admin-test', selectors, raw.source.head, {
        snapshotRoot: path.join(jobRoot, 'workspace'),
        outputRoot: path.join(jobRoot, 'output'),
        cacheRoot: raw.isolation.cacheRoot,
      }, {
        pnpm: raw.toolchain.executables.pnpm.resolvedPath,
      }, reviewBase, undefined, testFilters).steps;
      expectedSteps = historicalPlan(expectedSteps);
      const actualSteps = raw.execution.steps.map((step) => ({
        cwd: step.cwd, executable: step.executable, argv: step.argv,
      }));
      // Host can reuse protected installed dependencies and omit preparation.
      // The complete test command, working directory and selectors still match.
      // A failed installation is instead a factual prefix: no test ran or passed.
      if (actualSteps.length === 1) {
        const failedInstall = raw.status !== 'passed' && raw.execution.steps[0].exitCode !== 0
          && raw.results.executed === 0 && raw.results.reportFiles === 0
          && JSON.stringify(actualSteps) === JSON.stringify(expectedSteps.slice(0, 1));
        expectedSteps = failedInstall ? expectedSteps.slice(0, 1) : expectedSteps.slice(1);
      }
      if (JSON.stringify(actualSteps) !== JSON.stringify(expectedSteps)) {
        fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Host frontend test execution does not match its selectors.');
      }
    } else {
      expectedSteps = historicalPlan(verificationCommand('frontend-admin-test', selectors, raw.source.head, undefined, reviewBase, testFilters).steps);
      const actualSteps = raw.execution.steps.map((step) => ({ cwd: step.cwd, argv: step.argv }));
      if (JSON.stringify(actualSteps) !== JSON.stringify(expectedSteps)) {
        fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Container frontend test execution does not match its selectors.');
      }
    }
    return Object.hasOwn(selectors, 'testFiles');
  } catch (error) {
    if (error instanceof AcceptanceServiceError) throw error;
    fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Frontend test execution selectors or command are invalid.');
  }
}

function currentAcceptanceEvidence(receipts) {
  const latest = new Map();
  for (const item of receipts) {
    if (item.kind === 'governance' || item.kind === 'verification') {
      latest.set(`${item.kind}:${item.receipt.profile}`, item);
    }
  }
  const governance = latest.get('governance:governance');
  return {
    // Keep the passing receipt referenced by the existing ledger closure.
    governanceReceipt: (governance?.receipt.status === 'passed'
      ? receipts.find(item => item.kind === 'governance' && item.receipt.status === 'passed')
      : governance)?.receipt ?? null,
    verificationReceipts: receipts.filter(item => item.kind === 'verification'
      && (item.receipt.status === 'passed'
        || latest.get(`verification:${item.receipt.profile}`)?.receipt.status !== 'passed'))
      .map(item => item.receipt),
    // A technical rerun cannot supersede an independent semantic rejection.
    semanticReviewReceipts: receipts.filter(item => item.kind === 'semanticReview').map(item => item.receipt),
  };
}

function recordPayload(record) {
  const { recordDigest, ...payload } = record;
  return payload;
}

function sealRecord(payload) {
  return { ...payload, recordDigest: canonicalSha256(payload) };
}

function validateStoredSourceAuthorityBinding(binding) {
  if (binding === null) return;
  exactKeys(binding, [
    'actionCeiling', 'actorUserId', 'actorUsername', 'authorityClass',
    'authorityWorkspaceFingerprint', 'contractId', 'controllerGrantDigest',
    'conversationId', 'dshSessionId', 'executionId', 'generation', 'productionAuthorityDigest',
    'productionAuthorityId', 'projectSlug', 'rpcId', 'sourceCommit', 'taskId',
  ], 'acceptance source authority binding');
  if (binding.authorityClass !== 'production-task-writer'
    || !PRODUCTION_ACTIONS.includes(binding.actionCeiling)
    || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    fail('ACCEPTANCE_STATE_INVALID', 'Protected source authority binding is invalid.', 503);
  }
  for (const [value, pattern] of [
    [binding.projectSlug, SAFE_ID], [binding.taskId, TASK_ID], [binding.actorUserId, ACTOR_USER_ID],
    [binding.actorUsername, ACTOR_USERNAME], [binding.conversationId, CONVERSATION_ID],
    [binding.dshSessionId, DSH_ID], [binding.executionId, ACTOR_USER_ID], [binding.rpcId, RPC_ID],
    [binding.contractId, SHA256], [binding.sourceCommit, SOURCE_COMMIT],
    [binding.authorityWorkspaceFingerprint, SHA256], [binding.productionAuthorityId, ACTOR_USER_ID],
    [binding.productionAuthorityDigest, SHA256], [binding.controllerGrantDigest, SHA256],
  ]) requiredString(value, pattern, 'acceptance source authority binding field');
}

function validateRecord(record) {
  exactKeys(record, [
    'acceptanceContract', 'ledger', 'receipts', 'recordDigest', 'recordType', 'schemaVersion',
    'signedVerdict', 'taskContract', 'taskId', 'updatedAt',
    ...(Object.hasOwn(record, 'sourceAuthorityBinding') ? ['sourceAuthorityBinding'] : []),
    ...(Object.hasOwn(record, 'diagnosticReceipts') ? ['diagnosticReceipts'] : []),
    ...(Object.hasOwn(record, 'acceptedApiContract') ? ['acceptedApiContract'] : []),
  ], 'acceptance record');
  if (record.schemaVersion !== 1 || record.recordType !== RECORD_TYPE
    || record.recordDigest !== canonicalSha256(recordPayload(record))) {
    fail('ACCEPTANCE_STATE_INVALID', 'Protected acceptance state integrity failed.', 503);
  }
  if (Object.hasOwn(record, 'sourceAuthorityBinding')) {
    validateStoredSourceAuthorityBinding(record.sourceAuthorityBinding);
  }
  if (record.acceptedApiContract !== undefined) {
    const api = normalizeAcceptedApiContract(record.acceptedApiContract);
    if (api.taskId !== record.taskId || api.sourceCommit !== record.acceptanceContract.candidate.source.head) {
      fail('ACCEPTANCE_STATE_INVALID', 'Accepted APIs do not match the protected candidate.', 503);
    }
  }
  if (Object.hasOwn(record, 'diagnosticReceipts') && (!Array.isArray(record.diagnosticReceipts)
    || record.diagnosticReceipts.some(receipt => receipt?.receiptType !== ACCEPTANCE_DIAGNOSTIC_RECEIPT_TYPE)
    || new Set(record.diagnosticReceipts.map(receipt => receipt.receiptId)).size !== record.diagnosticReceipts.length)) {
    fail('ACCEPTANCE_STATE_INVALID', 'Protected diagnostic evidence is invalid.', 503);
  }
  restoreForgeObligationLedger(record.ledger, record.taskContract, record.acceptanceContract);
  return record;
}

function publicError(error) {
  if (error instanceof ManagedFileError && ['MANAGED_FILE_SCHEMA', 'MANAGED_FILE_PATH', 'MANAGED_FILE_CONFIG',
    'MANAGED_FILE_AUTHORITY', 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED'].includes(error.code)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AcceptanceServiceError) return { code: error.code, message: error.message,
    ...(error.retryable === true ? { retryable: true } : {}) };
  return { code: 'ACCEPTANCE_SERVICE_FAILED', message: 'Protected acceptance service failed closed.' };
}

function renewalAuthorityUnavailable() {
  return Object.assign(new AcceptanceServiceError('CONVERSATION_EXECUTION_AUTHORITY_UNAVAILABLE',
    '当前账号权限核验暂时不可用；保留原任务，服务恢复后可续接同一请求。', 503), { retryable: true });
}

export async function readCurrentExecutionRenewalAuthority(socketPath, input) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) throw renewalAuthorityUnavailable();
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(input));
    const request = http.request({ socketPath, path: '/v1/execution-renewal-authority', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 16_384) { request.destroy(renewalAuthorityUnavailable()); return; }
        chunks.push(chunk);
      });
      response.on('error', () => reject(renewalAuthorityUnavailable()));
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode === 403 || response.statusCode === 409) {
          reject(new AcceptanceServiceError('CONVERSATION_EXECUTION_RENEWAL_DENIED',
            '当前账号、会话或任务授权已经变化，不能续用旧授权。', 403));
          return;
        }
        try {
          if (response.statusCode !== 200) throw renewalAuthorityUnavailable();
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch { reject(renewalAuthorityUnavailable()); }
      });
    });
    const timer = setTimeout(() => request.destroy(renewalAuthorityUnavailable()), 5000);
    request.once('error', () => { clearTimeout(timer); reject(renewalAuthorityUnavailable()); });
    request.end(payload);
  });
}

export class ProtectedAcceptanceService {
  constructor(options) {
    exactKeys(options, [
      'config', 'governanceKeyPem', 'platformKeyPem', 'semanticKeyPem', 'verdictKeyPem',
      'verificationKeyPem', ...(Object.hasOwn(options, 'clock') ? ['clock'] : []),
      ...(Object.hasOwn(options, 'currentExecutionAuthority') ? ['currentExecutionAuthority'] : []),
      ...(Object.hasOwn(options, 'managedFileTargets') ? ['managedFileTargets'] : []),
    ], 'service options');
    this.config = this.#validateConfig(options.config);
    this.clock = options.clock ?? (() => new Date());
    if (Object.hasOwn(options, 'currentExecutionAuthority') && typeof options.currentExecutionAuthority !== 'function') {
      fail('ACCEPTANCE_SCHEMA_INVALID', 'currentExecutionAuthority must be a trusted callback.');
    }
    this.currentExecutionAuthority = options.currentExecutionAuthority;
    this.managedFileTargets = () => validateManagedFileTargets(options.managedFileTargets
      ? options.managedFileTargets() : loadManagedFileTargets(this.config.projectSlug), this.config.projectSlug);
    this.taskQueues = new Map();
    const platform = signerDescriptor(options.platformKeyPem, this.config.keys.platform.keyId);
    const governance = signerDescriptor(options.governanceKeyPem, this.config.keys.governance.keyId, this.config.keys.governance.subjectId);
    const verification = signerDescriptor(options.verificationKeyPem, this.config.keys.verification.keyId, this.config.keys.verification.subjectId);
    const semantic = signerDescriptor(options.semanticKeyPem, this.config.keys.semanticReview.keyId, this.config.keys.semanticReview.subjectId);
    const verdict = signerDescriptor(options.verdictKeyPem, this.config.keys.verdict.keyId);
    this.signers = {
      platform: platform.signer,
      governance: governance.signer,
      verification: verification.signer,
      semanticReview: semantic.signer,
      verdict: verdict.signer,
    };
    this.trustPolicy = validateAcceptanceTrustPolicy({
      schemaVersion: 1,
      policyType: ACCEPTANCE_DOCUMENT_TYPES.trustPolicy,
      policyId: this.config.policyId,
      platformContractSigner: platform.descriptor,
      issuers: {
        governance: [governance.descriptor],
        verification: [verification.descriptor],
        semanticReview: [semantic.descriptor],
      },
      verdictSigner: verdict.descriptor,
      issuedAt: this.config.trustWindow.issuedAt,
      expiresAt: this.config.trustWindow.expiresAt,
    }, this.clock().getTime());
  }

  #validateConfig(config) {
    exactKeys(config, [
      'allowedVerificationProfiles', 'contractTtlSeconds', 'keys', 'policyId', 'projectSlug',
      'schemaVersion', 'serviceType', 'stateRoot', 'trustWindow',
      ...(Object.hasOwn(config, 'conversationWriterScopes') ? ['conversationWriterScopes'] : []),
      ...(Object.hasOwn(config, 'conversationSemanticResourceScopes') ? ['conversationSemanticResourceScopes'] : []),
      ...(Object.hasOwn(config, 'conversationTaskPreparation') ? ['conversationTaskPreparation'] : []),
      ...(Object.hasOwn(config, 'roleDecisionTaskIds') ? ['roleDecisionTaskIds'] : []),
      ...(Object.hasOwn(config, 'sourceProvenancePolicies') ? ['sourceProvenancePolicies'] : []),
      ...(Object.hasOwn(config, 'reviewedReceiptSourceProjections') ? ['reviewedReceiptSourceProjections'] : []),
      ...(Object.hasOwn(config, 'workflowInventoryPolicies') ? ['workflowInventoryPolicies'] : []),
    ], 'service config');
    if (config.schemaVersion !== 1 || config.serviceType !== SERVICE_TYPE) fail('ACCEPTANCE_CONFIG_INVALID', 'Service config version is unsupported.', 503);
    requiredString(config.projectSlug, SAFE_ID, 'config.projectSlug');
    requiredString(config.policyId, SAFE_ID, 'config.policyId');
    if (!path.isAbsolute(config.stateRoot)) fail('ACCEPTANCE_CONFIG_INVALID', 'State root must be absolute.', 503);
    uniqueStrings(config.allowedVerificationProfiles, SAFE_ID, 'config.allowedVerificationProfiles');
    if (!Number.isSafeInteger(config.contractTtlSeconds) || config.contractTtlSeconds < 60 || config.contractTtlSeconds > 3600) fail('ACCEPTANCE_CONFIG_INVALID', 'Contract TTL is invalid.', 503);
    if (config.conversationTaskPreparation !== undefined
      && typeof config.conversationTaskPreparation !== 'boolean') {
      fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation task preparation must be boolean.', 503);
    }
    if (config.roleDecisionTaskIds !== undefined) {
      uniqueStrings(config.roleDecisionTaskIds, TASK_ID, 'config.roleDecisionTaskIds', true);
      if (config.roleDecisionTaskIds.length > 256 || config.conversationTaskPreparation !== true) {
        fail('ACCEPTANCE_CONFIG_INVALID', 'Role decisions require bounded conversation task preparation.', 503);
      }
    }
    if (config.sourceProvenancePolicies !== undefined) {
      if (!Array.isArray(config.sourceProvenancePolicies) || config.sourceProvenancePolicies.length > 32) {
        fail('ACCEPTANCE_CONFIG_INVALID', 'Source provenance reviews must be a bounded array.', 503);
      }
      const tasks = new Set();
      for (const item of config.sourceProvenancePolicies) {
        exactKeys(item, ['taskId', 'policy',
          ...(Object.hasOwn(item ?? {}, 'contractBinding') ? ['contractBinding'] : [])], 'source provenance review');
        requiredString(item.taskId, TASK_ID, 'source provenance review.taskId');
        if (Object.hasOwn(item, 'contractBinding') && item.contractBinding !== 'reviewed-files') {
          fail('ACCEPTANCE_CONFIG_INVALID', 'Source provenance contract binding must be reviewed-files when configured.', 503);
        }
        let policy;
        try { policy = normalizeReferenceProvenancePolicy(item.policy); }
        catch { fail('ACCEPTANCE_CONFIG_INVALID', 'Source provenance review is invalid.', 503); }
        if (tasks.has(item.taskId) || policy.repository !== config.projectSlug) {
          fail('ACCEPTANCE_CONFIG_INVALID', 'Source provenance reviews must target distinct tasks in this project.', 503);
        }
        tasks.add(item.taskId);
      }
    }
    if (config.reviewedReceiptSourceProjections !== undefined) {
      const policies = config.reviewedReceiptSourceProjections;
      if (!Array.isArray(policies) || policies.length > 2) fail('ACCEPTANCE_CONFIG_INVALID', 'Reviewed receipt source policies must be bounded.', 503);
      const receipts = new Set();
      for (const policy of policies) {
        try { validateReviewedReceiptSourcePolicy(policy); }
        catch (error) { fail('ACCEPTANCE_CONFIG_INVALID', error.message, 503); }
        if (policy.projectSlug !== config.projectSlug || receipts.has(policy.receiptId)) {
          fail('ACCEPTANCE_CONFIG_INVALID', 'Reviewed receipt policies must bind distinct original receipts in this project.', 503);
        }
        receipts.add(policy.receiptId);
      }
    }
    if (config.workflowInventoryPolicies !== undefined) {
      if (!Array.isArray(config.workflowInventoryPolicies) || config.workflowInventoryPolicies.length > 32) {
        fail('ACCEPTANCE_CONFIG_INVALID', 'Workflow inventory policies must be a bounded array.', 503);
      }
      const bindings = new Set();
      for (const item of config.workflowInventoryPolicies) {
        exactKeys(item, ['policyId', 'taskId', 'sourceFingerprint', 'module', 'testSelector'], 'workflow inventory policy');
        requiredString(item.policyId, SAFE_ID, 'workflow inventory policyId');
        requiredString(item.taskId, TASK_ID, 'workflow inventory taskId');
        requiredString(item.sourceFingerprint, SHA256, 'workflow inventory sourceFingerprint');
        requiredString(item.module, /^forge-server(?:\/[A-Za-z0-9_.-]+)+$/u, 'workflow inventory module');
        requiredString(item.testSelector, /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*#[A-Za-z_$][\w$]*$/u, 'workflow inventory testSelector');
        const binding = `${item.taskId}\0${item.module}\0${item.testSelector}`;
        if (item.module.split('/').some(part => part === '.' || part === '..') || bindings.has(binding)) {
          fail('ACCEPTANCE_CONFIG_INVALID', 'Workflow inventory policies must have distinct exact method bindings.', 503);
        }
        bindings.add(binding);
      }
    }
    if (config.conversationTaskPreparation === true
      && !Object.hasOwn(config, 'conversationWriterScopes')) {
      fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation task preparation requires configured writer scopes.', 503);
    }
    if (config.conversationWriterScopes !== undefined) {
      if (!Array.isArray(config.conversationWriterScopes)) fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation writer scopes must be an array.', 503);
      const profiles = new Set();
      for (const scope of config.conversationWriterScopes) {
        exactKeys(scope, ['taskProfile', 'ownedPaths', ...(Object.hasOwn(scope, 'scopeRoot') ? ['scopeRoot'] : [])], 'conversation writer scope');
        if (!TASK_PROFILES.includes(scope.taskProfile) || scope.taskProfile === 'read-only-review' || profiles.has(scope.taskProfile)) {
          fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation writer scope profile is invalid or duplicated.', 503);
        }
        profiles.add(scope.taskProfile);
        if (Object.hasOwn(scope, 'scopeRoot')) {
          if (!isCurrentProjectWriterScope(scope)) fail('ACCEPTANCE_CONFIG_INVALID', 'Only project-files can grant the current project root.', 503);
          continue;
        }
        const contract = compileForgeTaskExecutionContract({ prompt: 'Configured workspace source scope', actionCeiling: 'workspace-write',
          ownedPaths: scope.ownedPaths, taskProfiles: [scope.taskProfile] });
        if (JSON.stringify(contract.ownedPaths) !== JSON.stringify(scope.ownedPaths)) {
          fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation writer paths must be canonical.', 503);
        }
      }
    }
    if (config.conversationSemanticResourceScopes !== undefined) {
      const scopes = config.conversationSemanticResourceScopes;
      if (!Array.isArray(scopes) || scopes.length > 256) {
        fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation semantic resource scopes must be a bounded array.', 503);
      }
      for (const scope of scopes) {
        exactKeys(scope, ['ownedPaths', 'resources'], 'conversation semantic resource scope');
        try {
          const paths = normalizeForgeTaskOwnedPaths(scope.ownedPaths);
          const resources = normalizeForgeSemanticResources(scope.resources);
          if (paths.length === 0 || canonicalSha256(paths) !== canonicalSha256(scope.ownedPaths)
            || canonicalSha256(resources) !== canonicalSha256(scope.resources)
            || paths.some(candidate => !(config.conversationWriterScopes ?? []).some(writer =>
              conversationWriterScopeOwnsPath(writer, candidate)))) {
            fail('ACCEPTANCE_CONFIG_INVALID', 'Semantic resource scopes must be canonical and inside configured writer scopes.', 503);
          }
        } catch (error) {
          if (error instanceof AcceptanceServiceError) throw error;
          fail('ACCEPTANCE_CONFIG_INVALID', 'Conversation semantic resource scope is invalid.', 503);
        }
      }
    }
    exactKeys(config.trustWindow, ['expiresAt', 'issuedAt'], 'config.trustWindow');
    for (const name of ['issuedAt', 'expiresAt']) if (!Number.isFinite(Date.parse(config.trustWindow[name]))) fail('ACCEPTANCE_CONFIG_INVALID', 'Trust timestamps are invalid.', 503);
    exactKeys(config.keys, ['governance', 'platform', 'semanticReview', 'verdict', 'verification'], 'config.keys');
    for (const [role, value] of Object.entries(config.keys)) {
      exactKeys(value, role === 'platform' || role === 'verdict' ? ['keyId'] : ['keyId', 'subjectId'], `config.keys.${role}`);
      requiredString(value.keyId, SAFE_ID, `config.keys.${role}.keyId`);
      if (value.subjectId !== undefined) requiredString(value.subjectId, SAFE_ID, `config.keys.${role}.subjectId`);
    }
    return structuredClone(config);
  }

  recordFile(taskId) {
    return path.join(this.config.stateRoot, 'tasks', `${requiredString(taskId, TASK_ID, 'taskId')}.json`);
  }

  async readRecord(taskId) {
    const file = this.recordFile(taskId);
    const stat = await lstat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('ACCEPTANCE_RECORD_NOT_FOUND', 'No protected acceptance record exists.', 404);
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { fail('ACCEPTANCE_STATE_INVALID', 'Protected acceptance state is unreadable.', 503); }
    return validateRecord(value);
  }

  async writeRecord(record) {
    const file = this.recordFile(record.taskId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }

  async readProductionTaskGrant(taskId, { allowExpired = false } = {}) {
    const file = productionTaskGrantFile(this.config.stateRoot, taskId);
    const information = await lstat(file).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (information === null) return null;
    if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1
      || information.size < 2 || information.size > MAX_BODY_BYTES) {
      fail('EXECUTION_AUTHORITY_GRANT_INVALID', 'Production task grant state is invalid.', 503);
    }
    try {
      return validateProductionTaskGrantRecord(
        JSON.parse(await readFile(file, 'utf8')),
        this.clock().getTime(),
        { allowExpired },
      ).grant;
    } catch (error) {
      if (error instanceof ProductionTaskGrantError) {
        const expired = error.code === 'PRODUCTION_TASK_GRANT_EXPIRED';
        if (expired) return null;
        fail(
          'EXECUTION_AUTHORITY_GRANT_INVALID',
          'Production task grant validation failed.',
          503,
        );
      }
      fail('EXECUTION_AUTHORITY_GRANT_INVALID', 'Production task grant state is unreadable.', 503);
    }
  }

  async writeProductionTaskGrant(record) {
    const file = productionTaskGrantFile(this.config.stateRoot, record.taskId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }

  async #exclusive(taskId, operation) {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => current);
    this.taskQueues.set(taskId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.taskQueues.get(taskId) === queued) this.taskQueues.delete(taskId);
    }
  }

  #writerScopesDigest() {
    if (this.config.conversationSemanticResourceScopes?.length) {
      return canonicalSha256({ writerScopes: this.config.conversationWriterScopes ?? [],
        semanticResourceScopes: this.config.conversationSemanticResourceScopes });
    }
    return canonicalSha256(this.config.conversationWriterScopes ?? []);
  }

  #semanticResourceOptions(ownedPaths) {
    // Resource identity comes only from operator-owned policy. The proposal
    // selects writable paths; it cannot supply or remove semantic claims.
    const paths = normalizeForgeTaskOwnedPaths(ownedPaths, { allowEmpty: true });
    const resources = new Map();
    for (const scope of this.config.conversationSemanticResourceScopes ?? []) {
      if (!paths.some(candidate => scope.ownedPaths.some(root =>
        isForgeTaskOwnedPath(candidate, root) || isForgeTaskOwnedPath(root, candidate)))) continue;
      for (const resource of scope.resources) resources.set(`${resource.type}\0${resource.key}`, resource);
    }
    return resources.size ? { semanticResources: normalizeForgeSemanticResources([...resources.values()]) } : {};
  }

  async #readConversationTaskRequest(taskId) {
    const file = path.join(this.config.stateRoot, 'conversation-task-requests', `${taskId}.json`);
    const info = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.size < 2 || info.size > MAX_BODY_BYTES) {
      fail('CONVERSATION_TASK_REQUEST_INVALID', 'Stored conversation task request is invalid.', 503);
    }
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); } catch {
      fail('CONVERSATION_TASK_REQUEST_INVALID', 'Stored conversation task request is unreadable.', 503);
    }
    exactKeys(record, [
      'schemaVersion', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
      'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest', 'source',
      'workspaceWriteAuthorized', 'authorizedActionCeiling', 'writableEligible',
      'conversationTaskPreparationSupported', 'expiresAt', 'writerScopesDigest', 'recordDigest',
      ...(Object.hasOwn(record, 'conversationFormatMaintenanceSupported') ? ['conversationFormatMaintenanceSupported'] : []),
      ...(Object.hasOwn(record, 'reviewFeedback') ? ['reviewFeedback'] : []),
      ...(Object.hasOwn(record, 'independentReviewSuspensionSupported') ? ['independentReviewSuspensionSupported'] : []),
      ...(Object.hasOwn(record, 'changedVerificationSupported') ? ['changedVerificationSupported'] : []),
      ...(Object.hasOwn(record, 'focusedBackendVerificationSupported') ? ['focusedBackendVerificationSupported'] : []),
      ...(Object.hasOwn(record, 'ordinaryFinalVerificationSupported') ? ['ordinaryFinalVerificationSupported'] : []),
      ...(Object.hasOwn(record, 'completedApiContract') ? ['completedApiContract'] : []),
      ...(Object.hasOwn(record, 'managedFileIntent') ? ['managedFileIntent'] : []),
    ], 'conversation task request');
    exactKeys(record.source, ['head', 'fingerprint'], 'conversation task request.source');
    const expiresAt = Date.parse(record.expiresAt);
    if (record.schemaVersion !== 1
      || typeof record.workspaceWriteAuthorized !== 'boolean'
      || record.conversationTaskPreparationSupported !== true
      || (Object.hasOwn(record, 'conversationFormatMaintenanceSupported')
        && typeof record.conversationFormatMaintenanceSupported !== 'boolean')
      || typeof record.writableEligible !== 'boolean'
      || (Object.hasOwn(record, 'independentReviewSuspensionSupported')
        && typeof record.independentReviewSuspensionSupported !== 'boolean')
      || (Object.hasOwn(record, 'changedVerificationSupported') && typeof record.changedVerificationSupported !== 'boolean')
      || (Object.hasOwn(record, 'focusedBackendVerificationSupported') && typeof record.focusedBackendVerificationSupported !== 'boolean')
      || (Object.hasOwn(record, 'ordinaryFinalVerificationSupported') && typeof record.ordinaryFinalVerificationSupported !== 'boolean')
      || (record.workspaceWriteAuthorized ? !PRODUCTION_ACTIONS.includes(record.authorizedActionCeiling)
        : record.authorizedActionCeiling !== 'read-only' || record.writableEligible !== false)
      || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== record.expiresAt
      || record.recordDigest !== canonicalSha256(recordPayload(record))) {
      fail('CONVERSATION_TASK_REQUEST_INVALID', 'Stored conversation task request integrity failed.', 503);
    }
    requiredString(record.projectSlug, TASK_ID, 'conversation task request.projectSlug');
    requiredString(record.taskId, TASK_ID, 'conversation task request.taskId');
    requiredString(record.actorUserId, ACTOR_USER_ID, 'conversation task request.actorUserId');
    requiredString(record.actorUsername, ACTOR_USERNAME, 'conversation task request.actorUsername');
    requiredString(record.conversationId, CONVERSATION_ID, 'conversation task request.conversationId');
    requiredString(record.dshSessionId, DSH_ID, 'conversation task request.dshSessionId');
    requiredString(record.rpcId, RPC_ID, 'conversation task request.rpcId');
    requiredString(record.promptTextDigest, SHA256, 'conversation task request.promptTextDigest');
    requiredString(record.source.head, SOURCE_COMMIT, 'conversation task request.source.head');
    requiredString(record.source.fingerprint, SHA256, 'conversation task request.source.fingerprint');
    requiredString(record.writerScopesDigest, PREFIXED_SHA256, 'conversation task request.writerScopesDigest');
    if (record.completedApiContract !== undefined) {
      const api = normalizeAcceptedApiContract(record.completedApiContract);
      if (api.taskId !== record.taskId || api.sourceCommit !== record.source.head) {
        fail('CONVERSATION_TASK_REQUEST_INVALID', 'Stored completed API contract does not match this request.', 503);
      }
    }
    if (Object.hasOwn(record, 'reviewFeedback')) validateReviewFeedback(record.reviewFeedback, true);
    return record;
  }

  async *#archivedTaskRecords(taskId) {
    const directory = path.join(this.config.stateRoot, 'tasks-history');
    const entries = await opendir(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entries === null) return;
    for await (const entry of entries) {
      if (!entry.name.startsWith(`${taskId}.`)
        || !/^[a-f0-9]{64}\.json$/u.test(entry.name.slice(taskId.length + 1))) continue;
      const file = path.join(directory, entry.name);
      const information = await lstat(file);
      if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1) {
        fail('ACCEPTANCE_STATE_INVALID', 'Protected acceptance history is not a regular file.', 503);
      }
      let record;
      try { record = JSON.parse(await readFile(file, 'utf8')); } catch {
        fail('ACCEPTANCE_STATE_INVALID', 'Protected acceptance history is unreadable.', 503);
      }
      validateRecord(record);
      if (record.taskId !== taskId
        || entry.name !== `${taskId}.${record.recordDigest.replace(/^sha256:/u, '')}.json`) {
        fail('ACCEPTANCE_STATE_INVALID', 'Protected acceptance history identity is invalid.', 503);
      }
      yield record;
    }
  }

  async #readArchivedReviewRecord(taskId, reviewId) {
    for await (const record of this.#archivedTaskRecords(taskId)) {
      if (record.receipts.some((item) => item.kind === 'semanticReview' && item.receipt.receiptId === reviewId)) return record;
    }
    return null;
  }

  async #bindReviewFeedback(input, taskId, previous) {
    const feedback = directReviewFeedback(input.promptText);
    if (feedback === undefined) return undefined;
    let record = await this.readRecord(taskId).catch((error) => {
      if (error.code === 'ACCEPTANCE_RECORD_NOT_FOUND') return null;
      throw error;
    });
    const sameRequestIdentity = previous !== null
      && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every((key) => previous[key] === input[key]);
    // Renewing a contract archives its signed rejection before the user may have
    // supplied feedback. Look up that original record without restoring it as current acceptance.
    if (sameRequestIdentity && !record?.receipts.some((item) => item.kind === 'semanticReview'
      && item.receipt.receiptId === feedback.reviewId)) {
      record = await this.#readArchivedReviewRecord(taskId, feedback.reviewId) ?? record;
    }
    const receipt = record?.receipts.find((item) => item.kind === 'semanticReview'
      && item.receipt.receiptId === feedback.reviewId)?.receipt;
    if (receipt !== undefined) {
      if (record.taskId !== taskId || receipt.taskId !== taskId || receipt.projectSlug !== input.projectSlug
        || record.acceptanceContract.candidate.authorId !== input.actorUserId
        || receipt.review.decision !== 'rejected' || receipt.status !== 'failed'
        || receipt.source.head !== input.source.head || receipt.source.fingerprint !== input.source.fingerprint) {
        fail('ACCEPTANCE_REVIEW_FEEDBACK_REFERENCE_INVALID', '反馈必须引用当前任务、作者及同一候选的真实独审拒绝。', 409);
      }
      // The old receipt may have expired; verify its signature at issuance, not as current acceptance.
      verifyAcceptanceEvidenceReceipt({
        contract: record.acceptanceContract, trustPolicy: this.trustPolicy,
        receipt, kind: 'semanticReview', evaluatedAt: receipt.issuedAt,
      });
      return { ...feedback, summarySha256: receipt.review.summarySha256 };
    }
    const sameRequestOwner = sameRequestIdentity
      && previous.source.head === input.source.head && previous.source.fingerprint === input.source.fingerprint;
    if (sameRequestOwner && previous.reviewFeedback?.reviewId === feedback.reviewId) {
      return { ...feedback, summarySha256: previous.reviewFeedback.summarySha256 };
    }
    fail('ACCEPTANCE_REVIEW_FEEDBACK_REFERENCE_INVALID', '未找到同一候选的受保护独审拒绝引用；不能自报原审查事实。', 409);
  }

  async #rememberConversationTaskRequest(input, taskId) {
    const managedFileIntent = managedFileIntentForPrompt(input.promptText, this.managedFileTargets(), input.actorUserId);
    const previous = await this.#readConversationTaskRequest(taskId);
    if (previous?.rpcId === input.rpcId) {
      const same = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
        'dshSessionId', 'promptTextDigest'].every((key) => previous[key] === input[key])
        && canonicalSha256(previous.source) === canonicalSha256(input.source)
        && previous.workspaceWriteAuthorized === input.workspaceWriteAuthorized
        && previous.conversationTaskPreparationSupported === input.conversationTaskPreparationSupported
        && (previous.conversationFormatMaintenanceSupported === true) === (input.conversationFormatMaintenanceSupported === true)
        && (previous.independentReviewSuspensionSupported === true) === (input.independentReviewSuspensionSupported === true)
        && (previous.changedVerificationSupported === true) === (input.changedVerificationSupported === true)
        && (previous.focusedBackendVerificationSupported === true) === (input.focusedBackendVerificationSupported === true)
        && (previous.ordinaryFinalVerificationSupported === true) === (input.ordinaryFinalVerificationSupported === true)
        && canonicalSha256(previous.completedApiContract ?? null) === canonicalSha256(
          input.completedApiContract === undefined ? null : normalizeAcceptedApiContract(input.completedApiContract))
        && previous.authorizedActionCeiling === (input.workspaceWriteAuthorized === false ? 'read-only' : input.authorizedActionCeiling ?? 'workspace-write')
        && previous.writerScopesDigest === this.#writerScopesDigest()
        && canonicalSha256(previous.managedFileIntent ?? []) === canonicalSha256(managedFileIntent);
      if (!same) {
        fail('CONVERSATION_TASK_REQUEST_CONFLICT', '同一请求标识不能绑定不同的用户、内容、源码或权限。', 409);
      }
      return previous;
    }
    const reviewFeedback = await this.#bindReviewFeedback(input, taskId, previous);
    if (previous !== null) {
      await this.#saveConversationRecord(
        'conversation-task-request-history',
        `${taskId}.${crypto.createHash('sha256').update(previous.rpcId).digest('hex')}.${previous.recordDigest}`,
        previous,
        { archive: true },
      );
    }
    const writableEligible = input.workspaceWriteAuthorized === true && conversationTaskWritableEligible(input.promptText);
    const record = sealRecord({
      schemaVersion: 1,
      projectSlug: input.projectSlug,
      taskId,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      conversationId: input.conversationId,
      dshSessionId: input.dshSessionId,
      rpcId: input.rpcId,
      promptTextDigest: input.promptTextDigest,
      source: { head: input.source.head, fingerprint: input.source.fingerprint },
      workspaceWriteAuthorized: input.workspaceWriteAuthorized === true,
      conversationTaskPreparationSupported: true,
      conversationFormatMaintenanceSupported: input.conversationFormatMaintenanceSupported === true,
      ...(input.independentReviewSuspensionSupported === true ? { independentReviewSuspensionSupported: true } : {}),
      ...(input.changedVerificationSupported === true ? { changedVerificationSupported: true } : {}),
      ...(input.focusedBackendVerificationSupported === true ? { focusedBackendVerificationSupported: true } : {}),
      ...(input.ordinaryFinalVerificationSupported === true ? { ordinaryFinalVerificationSupported: true } : {}),
      ...(input.completedApiContract === undefined ? {} : {
        completedApiContract: normalizeAcceptedApiContract(input.completedApiContract),
      }),
      authorizedActionCeiling: input.workspaceWriteAuthorized === false ? 'read-only' : input.authorizedActionCeiling ?? 'workspace-write',
      writableEligible,
      ...(managedFileIntent.length ? { managedFileIntent } : {}),
      expiresAt: new Date(this.clock().getTime() + CONVERSATION_TASK_REQUEST_TTL_MS).toISOString(),
      writerScopesDigest: this.#writerScopesDigest(),
      ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
    });
    await this.#saveConversationRecord('conversation-task-requests', taskId, record);
    return record;
  }

  async authorizeManagedFileOperation(input) {
    requiredString(input?.taskId, TASK_ID, 'managed file taskId');
    return this.#exclusive(input.taskId, async () => authorizeManagedFileRequest({ input,
      record: await this.#readConversationTaskRequest(input.taskId), config: this.managedFileTargets(), now: this.clock().getTime(),
    }));
  }

  async #readConversationScope(taskId, file = path.join(this.config.stateRoot, 'conversation-task-scopes', `${taskId}.json`)) {
    const info = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BODY_BYTES) {
      fail('CONVERSATION_WRITE_SCOPE_INVALID', 'Stored conversation task scope is invalid.', 503);
    }
    const scope = JSON.parse(await readFile(file, 'utf8'));
    exactKeys(scope, ['schemaVersion', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
      'dshSessionId', 'sourceCommit', 'ownedPaths', 'taskProfiles', 'promptTextDigest', 'recordDigest',
      'implementationRequested', 'rpcId', 'requestDigest', 'grantId',
      ...(Object.hasOwn(scope, 'goal') ? ['goal'] : []),
      ...(Object.hasOwn(scope, 'dualReview') ? ['dualReview'] : []),
      ...(Object.hasOwn(scope, 'roleGrantDecisions') ? ['roleGrantDecisions'] : []),
      ...(Object.hasOwn(scope, 'acceptedApiContract') ? ['acceptedApiContract'] : []),
      ...(Object.hasOwn(scope, 'actionCeiling') ? ['actionCeiling'] : []),
      ...(Object.hasOwn(scope, 'sourceTransition') ? ['sourceTransition'] : []),
      ...(Object.hasOwn(scope, 'sourceTransitionDigest') ? ['sourceTransitionDigest', 'sourceTransitionFromFingerprint'] : [])], 'conversation task scope');
    if (scope.schemaVersion !== 1 || typeof scope.implementationRequested !== 'boolean'
      || (Object.hasOwn(scope, 'goal')
        && (typeof scope.goal !== 'string' || scope.goal.length < 1
          || Buffer.byteLength(scope.goal, 'utf8') > 1024 * 1024))
      || (Object.hasOwn(scope, 'actionCeiling') && !PRODUCTION_ACTIONS.includes(scope.actionCeiling))
      || (Object.hasOwn(scope, 'sourceTransitionDigest')
        && (!SHA256.test(scope.sourceTransitionDigest) || !SHA256.test(scope.sourceTransitionFromFingerprint)))
      || scope.recordDigest !== canonicalSha256(recordPayload(scope))) {
      fail('CONVERSATION_WRITE_SCOPE_INVALID', 'Stored conversation task scope integrity failed.', 503);
    }
    if (scope.sourceTransition !== undefined) {
      let transition;
      try { transition = validateSourceTransition(scope.sourceTransition); } catch {
        fail('CONVERSATION_WRITE_SCOPE_INVALID', 'Stored checkpoint transition is invalid.', 503);
      }
      if (!['checkpointed', 'integrated'].includes(transition.phase) || transition.digest !== scope.sourceTransitionDigest
        || transition.to.head !== scope.sourceCommit || transition.from.fingerprint !== scope.sourceTransitionFromFingerprint
        || (transition.phase === 'checkpointed' && transition.from.fingerprint !== transition.to.fingerprint)
        || (transition.phase === 'integrated' && !['git-checkpoint', 'release'].includes(scope.actionCeiling))
        || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => transition.task[key] === scope[key])) {
        fail('CONVERSATION_WRITE_SCOPE_INVALID', 'Stored checkpoint transition does not match its protected scope.', 503);
      }
    }
    if (scope.dualReview !== undefined) normalizeForgeDualReviewBinding(scope.dualReview);
    if (scope.roleGrantDecisions !== undefined) {
      const normalized = normalizeForgeRoleGrantDecisions(scope.roleGrantDecisions, scope.ownedPaths);
      if (canonicalSha256(normalized) !== canonicalSha256(scope.roleGrantDecisions)) {
        fail('CONVERSATION_WRITE_SCOPE_INVALID', 'Stored role decisions are not canonical.', 503);
      }
    }
    return scope;
  }

  async #checkpointScopeEvidence(input, scope, contract, actionCeiling) {
    const matches = (candidate) => candidate?.implementationRequested === true && candidate.grantId !== null
      && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every(key => candidate[key] === input[key])
      && candidate.sourceCommit === input.source.head
      && canonicalSha256(candidate.ownedPaths) === canonicalSha256(contract.ownedPaths)
      && canonicalSha256(candidate.taskProfiles) === canonicalSha256(contract.taskProfiles)
      && (candidate.sourceTransition?.phase === 'checkpointed'
        || (candidate.sourceTransition?.phase === 'integrated' && ['git-checkpoint', 'release'].includes(actionCeiling)))
      && candidate.sourceTransition.from.fingerprint === candidate.sourceTransition.to.fingerprint
      && candidate.sourceTransition.to.head === input.source.head
      && candidate.sourceTransition.to.fingerprint === input.source.fingerprint;
    if (matches(scope)) return scope;
    if (scope === null || scope.implementationRequested !== true || scope.grantId === null
      || canonicalSha256(scope.ownedPaths) !== canonicalSha256(contract.ownedPaths)) return null;
    // Recover only a fact already accepted by this issuer for this exact
    // candidate and proposed scope. A corrected inferred profile on the current
    // scope cannot erase matching historical proof or grant new authority.
    const directory = path.join(this.config.stateRoot, 'conversation-task-scope-history');
    const entries = await opendir(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (entries === null) return null;
    let found = null;
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${input.taskId}.`) || !entry.name.endsWith('.json')) continue;
      const previous = await this.#readConversationScope(input.taskId, path.join(directory, entry.name));
      if (!matches(previous)) continue;
      if (found !== null && found.sourceTransitionDigest !== previous.sourceTransitionDigest) return null;
      found = previous;
    }
    return found;
  }

  async #restoresHistoricalFrontendScope(input, scope, contract, requestedAction) {
    if (requestedAction !== 'release' || scope?.rpcId !== input.rpcId
      || scope.implementationRequested !== true || scope.grantId === null
      || scope.actionCeiling !== 'release' || scope.sourceCommit !== input.source.head
      || canonicalSha256(scope.taskProfiles) !== canonicalSha256(['database', 'frontend-admin'])
      || canonicalSha256(contract.taskProfiles) !== canonicalSha256(['frontend-admin'])
      || canonicalSha256(scope.ownedPaths) !== canonicalSha256(contract.ownedPaths)
      || !contract.ownedPaths.every(relative => relative.startsWith('forge-admin-ui/src/'))) return false;
    const identity = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId'];
    if (!identity.every(key => scope[key] === input[key])) return false;
    // A fresh compiler result cannot itself erase an earlier obligation. Restore
    // only the same UI scope already granted by this issuer, on this candidate
    // or its linked accepted integration predecessors. This is scope proof,
    // never permission to reuse tests across changed source fingerprints.
    const directory = path.join(this.config.stateRoot, 'conversation-task-scope-history');
    const entries = await opendir(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (entries === null) return false;
    const scopes = [scope];
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${input.taskId}.`) || !entry.name.endsWith('.json')) continue;
      const previous = await this.#readConversationScope(input.taskId, path.join(directory, entry.name));
      if (previous?.implementationRequested === true && previous.grantId !== null
        && previous.actionCeiling === 'release'
        && identity.every(key => previous[key] === input[key])
        && canonicalSha256(previous.ownedPaths) === canonicalSha256(contract.ownedPaths)) scopes.push(previous);
    }
    let source = input.source;
    const visited = new Set();
    while (!visited.has(`${source.head}:${source.fingerprint}`)) {
      visited.add(`${source.head}:${source.fingerprint}`);
      const candidates = scopes.filter(previous => previous.sourceCommit === source.head);
      // Dictionary ownership on an earlier UI contract does not establish DB
      // ownership. The current contract can still lose only its database profile.
      if (candidates.some(previous => previous.taskProfiles.includes('frontend-admin')
        && previous.taskProfiles.every(profile => ['dictionary', 'frontend-admin'].includes(profile)))) return true;
      const transitions = candidates.map(previous => previous.sourceTransition).filter(transition =>
        transition?.phase === 'integrated' && transition.to.head === source.head
        && transition.to.fingerprint === source.fingerprint
        && identity.every(key => transition.task[key] === input[key]));
      if (transitions.length === 0 || transitions.some(transition =>
        canonicalSha256(transition.from) !== canonicalSha256(transitions[0].from))) return false;
      source = transitions[0].from;
    }
    return false;
  }

  async #saveConversationRecord(directory, name, value, { archive = false } = {}) {
    const parent = path.join(this.config.stateRoot, directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = path.join(parent, `${name}.json`);
    if (archive) {
      const handle = await open(file, 'wx', 0o600).catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        const previous = JSON.parse(await readFile(file, 'utf8'));
        if (canonicalSha256(previous) !== canonicalSha256(value)) {
          fail('CONVERSATION_WRITE_HISTORY_CONFLICT', 'Existing task history differs from the current record.', 409);
        }
        return null;
      });
      if (handle) try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
      return;
    }
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  }

  async #saveConversationScope(taskId, scope) {
    const previous = await this.#readConversationScope(taskId);
    if (previous !== null && canonicalSha256(previous) !== canonicalSha256(scope)) {
      await this.#saveConversationRecord(
        'conversation-task-scope-history',
        `${taskId}.${crypto.createHash('sha256').update(previous.rpcId).digest('hex')}.${previous.recordDigest}`,
        previous,
        { archive: true },
      );
    }
    await this.#saveConversationRecord('conversation-task-scopes', taskId, scope);
  }

  #conversationScopeAllowed(scope) {
    const configured = this.config.conversationWriterScopes ?? [];
    const writers = configured.filter((item) => isCurrentProjectWriterScope(item) || scope.taskProfiles.includes(item.taskProfile));
    return scope.ownedPaths.length > 0 && scope.ownedPaths.every((candidate) =>
      writers.some(writer => conversationWriterScopeOwnsPath(writer, candidate)));
  }

  async #coversPreviouslyAuthorizedWork(input, taskId, currentScope, contract) {
    if (!currentScope.ownedPaths.every((owned) => contract.ownedPaths.includes(owned))
      || !currentScope.taskProfiles.every((profile) => contract.taskProfiles.includes(profile))) return false;
    const missingPaths = new Set(contract.ownedPaths.filter((owned) => !currentScope.ownedPaths.includes(owned)));
    const missingProfiles = new Set(contract.taskProfiles.filter((profile) => !currentScope.taskProfiles.includes(profile)));
    if (missingPaths.size === 0) return false;
    const directory = path.join(this.config.stateRoot, 'production-task-grants-history');
    const entries = await opendir(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entries === null) return false;
    for await (const entry of entries) {
      if (!entry.name.startsWith(`${taskId}.`) || !entry.name.endsWith('.json') || !entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BODY_BYTES) continue;
      let grant;
      try {
        grant = validateProductionTaskGrantRecord(JSON.parse(await readFile(file, 'utf8')),
          this.clock().getTime(), { allowExpired: true }).grant;
      } catch { continue; }
      if (grant.claim === null || grant.sourceCommit !== input.source.head
        || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => grant[key] === input[key])) continue;
      // Recover only explicitly recorded paths, never every dirty file or all
      // descendants of an old directory grant. Current policy is checked by
      // the proposal compiler before this historical evidence is considered.
      for (const owned of grant.ownedPaths) missingPaths.delete(owned);
      for (const profile of grant.taskProfiles) missingProfiles.delete(profile);
      if (missingPaths.size === 0 && missingProfiles.size === 0) return true;
    }
    return false;
  }

  async #readPreviousCompletion(input, taskId, scope, previous, now) {
    if (scope?.actionCeiling !== 'workspace-write' || previous?.claim === null
      || scope?.grantId !== previous?.grantId || scope?.rpcId !== previous?.claim?.rpcId
      || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every((key) => scope?.[key] === previous?.[key] && previous?.[key] === input[key])
      || previous.sourceCommit !== input.source.head) return null;

    let record;
    try {
      record = await this.readRecord(taskId);
    } catch (error) {
      if (error instanceof AcceptanceServiceError && error.code === 'ACCEPTANCE_RECORD_NOT_FOUND') return null;
      throw error;
    }
    const candidate = record.acceptanceContract?.candidate;
    const acceptedAt = record.signedVerdict?.evaluatedAt;
    const acceptedAtMs = Date.parse(acceptedAt);
    const updatedAtMs = Date.parse(record.updatedAt);
    if (record.signedVerdict?.verdict !== 'accepted'
      || canonicalSha256(record.taskContract) !== canonicalSha256(previous.taskContract)
      || candidate?.authorId !== input.actorUserId
      || candidate?.source?.head !== input.source.head
      || candidate?.source?.fingerprint !== input.source.fingerprint
      || record.taskContract?.contractId !== previous.taskContract?.contractId
      || previous.sourceCommit !== candidate?.source?.head
      || !Number.isFinite(acceptedAtMs) || !Number.isFinite(updatedAtMs)
      || acceptedAtMs > now || acceptedAtMs > updatedAtMs) return null;

    let completion;
    try {
      completion = evaluateProtectedLedgerCompletion({
        ledger: restoreForgeObligationLedger(record.ledger, record.taskContract, record.acceptanceContract),
        taskContract: record.taskContract,
        acceptanceContract: record.acceptanceContract,
        trustPolicy: this.trustPolicy,
        signedReceipts: record.receipts,
        signedVerdict: record.signedVerdict,
        current: {
          sourceFingerprint: candidate.source.fingerprint,
          candidateDiffSha256: candidate.diffSha256,
          evaluatedAt: acceptedAt,
        },
      });
    } catch (error) {
      if (error instanceof ForgeProtectedIssuerAdapterError) return null;
      throw error;
    }
    const counts = completion.ledgerSummary?.counts;
    if (completion.outcome !== 'READY' || completion.maximumTerminalOutcome !== 'COMPLETE'
      || completion.signedVerdictVerified !== true || completion.blockers.length !== 0
      || !Number.isSafeInteger(counts?.total) || counts.total < 1
      || counts.open !== 0 || counts.stale !== 0 || counts.closed !== counts.total
      || completion.ledgerSummary.open.length !== 0 || completion.ledgerSummary.stale.length !== 0
      || completion.ledgerSummary.closed.length !== counts.total) return null;
    return Object.freeze({
      schemaVersion: 1,
      kind: 'historical-code-acceptance',
      projectSlug: input.projectSlug,
      taskId,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      conversationId: input.conversationId,
      dshSessionId: input.dshSessionId,
      sourceCommit: input.source.head,
      workspaceFingerprint: input.source.fingerprint,
      contractId: record.taskContract.contractId,
      acceptedAt,
      recordDigest: record.recordDigest,
      verdictDigest: canonicalSha256(record.signedVerdict),
      gateDigest: completion.gateDigest,
    });
  }

  async #migrateConversationScope(input, taskId, scope, previous) {
    if (input.sourceTransition === undefined) {
      fail('CONVERSATION_WRITE_SCOPE_REQUIRED', '继续执行缺少当前用户、会话和源码版本匹配的任务范围，请重新说明要实施的具体任务。', 409);
    }
    let transition;
    try { transition = validateSourceTransition(input.sourceTransition); } catch {
      fail('CONVERSATION_SOURCE_TRANSITION_MISMATCH', '源码迁移事实与原授权、任务身份或当前受控源码不一致。', 409);
    }
    if (previous === null || previous.claim === null) {
      fail('CONVERSATION_SOURCE_TRANSITION_MISMATCH', '源码迁移事实缺少原受保护授权。', 409);
    }
    const record = await this.readRecord(taskId).catch((error) => {
      if (error instanceof AcceptanceServiceError && error.code === 'ACCEPTANCE_RECORD_NOT_FOUND') return null;
      throw error;
    });
    const binding = record?.sourceAuthorityBinding;
    const candidateSource = record?.acceptanceContract?.candidate?.source;
    const identityKeys = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId'];
    const transitionCeilingAllowed = ['git-checkpoint', 'release'].includes(scope.actionCeiling);
    const exactCandidate = identityKeys.every((key) => transition.task[key] === input[key]
        && previous[key] === input[key])
      && transition.from.head === scope.sourceCommit
      && transition.from.head === previous.sourceCommit
      && transition.from.head === candidateSource?.head
      && transition.from.fingerprint === candidateSource?.fingerprint
      && transition.to.head === input.source.head
      && transition.to.fingerprint === input.source.fingerprint
      && transitionCeilingAllowed
      && previous.actionCeiling === scope.actionCeiling
      && transition.sourceAuthority.actionCeiling === scope.actionCeiling
      && transition.sourceAuthority.contractId === previous.taskContract?.contractId
      && transition.sourceAuthority.contractId === record?.taskContract?.contractId
      && transition.sourceAuthority.productionAuthorityDigest === previous.claim.productionAuthorityDigest
      && transition.sourceAuthority.controllerGrantDigest === previous.grantDigest;
    const sameBoundAuthority = identityKeys.every((key) => binding?.[key] === input[key])
      && binding?.authorityClass === 'production-task-writer'
      && binding?.actionCeiling === scope.actionCeiling
      && binding?.sourceCommit === transition.from.head
      && binding?.contractId === record?.taskContract?.contractId
      && transition.sourceAuthority.executionId === binding?.executionId
      && transition.sourceAuthority.generation === binding?.generation
      && transition.sourceAuthority.productionAuthorityDigest === binding?.productionAuthorityDigest
      && transition.sourceAuthority.controllerGrantDigest === binding?.controllerGrantDigest
      && binding?.authorityWorkspaceFingerprint === previous.workspaceFingerprint;
    const currentClaimedMergeAuthority = previous.grantId === scope.grantId
      && previous.claim.rpcId === scope.rpcId
      && previous.promptTextDigest === scope.promptTextDigest
      && previous.workspaceFingerprint === transition.from.fingerprint;
    if (!exactCandidate || (!sameBoundAuthority && !currentClaimedMergeAuthority)) {
      fail('CONVERSATION_SOURCE_TRANSITION_MISMATCH', '源码迁移事实与原授权、任务身份或当前受控源码不一致。', 409);
    }
    const { sourceTransition: _previousTransition, acceptedApiContract, ...originalScope } = scope;
    return {
      ...originalScope,
      sourceCommit: transition.to.head,
      ...(acceptedApiContract !== undefined && transition.from.fingerprint === transition.to.fingerprint
        && acceptedApiContract.sourceCommit === transition.from.head ? {
          acceptedApiContract: normalizeAcceptedApiContract({ ...acceptedApiContract, sourceCommit: transition.to.head }),
        } : {}),
      sourceTransitionDigest: transition.digest,
      sourceTransitionFromFingerprint: transition.from.fingerprint,
      ...((transition.phase === 'checkpointed' && transition.from.fingerprint === transition.to.fingerprint)
        || transition.phase === 'integrated'
        ? { sourceTransition: structuredClone(transition) } : {}),
    };
  }

  async #currentContinuationContract(input, taskId, grant, compiledContract) {
    if (input.conversationContractContinuationSupported !== true || input.controllerPhase !== undefined
      || !isForgeConversationTaskContinuation(input.promptText) || grant === null
      || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every((key) => grant[key] === input[key])
      || grant.sourceCommit !== input.source.head || grant.workspaceFingerprint !== input.source.fingerprint) return null;
    const scope = await this.#readConversationScope(taskId);
    // A pending proposal can replace the goal while retaining the old grant
    // for history. Only the scope currently bound to this grant may continue it.
    if (scope === null || scope.grantId !== grant.grantId || scope.implementationRequested !== true
      || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'sourceCommit']
        .every((key) => scope[key] === grant[key])
      || (scope.actionCeiling ?? 'workspace-write') !== grant.actionCeiling
      || canonicalSha256(scope.ownedPaths) !== canonicalSha256(grant.ownedPaths)
      || canonicalSha256(scope.taskProfiles) !== canonicalSha256(grant.taskProfiles)) return null;
    const record = await this.readRecord(taskId).catch((error) => {
      if (error instanceof AcceptanceServiceError && error.code === 'ACCEPTANCE_RECORD_NOT_FOUND') return null;
      throw error;
    });
    if (record === null) return null;
    const acceptance = validateAcceptanceContract(record.acceptanceContract, this.trustPolicy);
    const contract = validateForgeTaskExecutionContract(record.taskContract);
    const now = this.clock().getTime();
    if (contract.contractId !== grant.taskContract.contractId || acceptance.contractId !== contract.contractId
      || acceptance.projectSlug !== input.projectSlug || acceptance.taskId !== taskId
      || acceptance.candidate.authorId !== input.actorUserId
      || acceptance.candidate.source.head !== input.source.head
      || acceptance.candidate.source.fingerprint !== input.source.fingerprint
      || acceptance.candidate.diffSha256 !== canonicalSha256({ head: input.source.head, workspaceFingerprint: input.source.fingerprint })
      || Date.parse(acceptance.issuedAt) > now || Date.parse(acceptance.expiresAt) <= now) return null;
    // Only wording may differ. Compare every compiled requirement, including
    // scope, action ceiling, profiles, Skills and obligations, before retaining identity.
    const unchanged = canonicalSha256(contract.semanticResources ?? null)
      === canonicalSha256(compiledContract.semanticResources ?? null) && Object.keys(compiledContract)
      .filter((key) => !['contractId', 'sourceFingerprint'].includes(key))
      .every((key) => Object.hasOwn(contract, key)
        && canonicalSha256(contract[key]) === canonicalSha256(compiledContract[key]));
    const spec = compileConversationAcceptanceSpec(compiledContract);
    if (!unchanged || acceptance.requiredGovernanceProfile !== 'governance'
      || canonicalSha256(acceptance.requiredProfiles)
        !== canonicalSha256(compiledContract.requiredVerificationProfiles.filter((profile) => profile !== 'governance'))
      || canonicalSha256(acceptance.requiredObligations) !== canonicalSha256(spec.requiredObligations)
      || canonicalSha256(acceptance.requiredDimensions) !== canonicalSha256(spec.requiredDimensions)) return null;
    return contract;
  }

  #conversationRoleOptions(scope, grant, input, ownedPaths, continuation) {
    const holder = scope?.roleGrantDecisions === undefined ? grant : scope;
    const decisions = scope?.roleGrantDecisions ?? grant?.taskContract?.roleGrantDecisions;
    if (decisions === undefined) return this.config.roleDecisionTaskIds?.includes(input.taskId)
      ? { roleGrantDecisions: [] } : {};
    if (!['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
      .every((key) => holder[key] === input[key])) {
      // A separately authorized native session can propose a new task in the
      // same conversation. Keep explicit role confirmation mandatory, but do
      // not transfer the other session's approvals (including an empty policy).
      // A continuation still requires its original complete session identity.
      const newSessionTask = continuation === false
        && input.workspaceWriteAuthorized !== false
        && !isForgeConversationTaskContinuation(input.promptText)
        && conversationTaskWritableEligible(input.promptText)
        && holder.dshSessionId !== input.dshSessionId
        && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId']
          .every((key) => holder[key] === input[key]);
      if (newSessionTask) return { roleGrantDecisions: [] };
      fail('CONVERSATION_ROLE_POLICY_MISMATCH', '角色决定不属于当前用户和对话任务。', 403);
    }
    // A new task keeps the requirement for explicit role decisions, never the
    // previous task's authorization. Exact file/statement hashes remain bound
    // during continuation, so editing the SQL still invalidates its approval.
    const preserve = holder.sourceCommit === input.source.head
      && (continuation || holder.promptTextDigest === input.promptTextDigest);
    return { roleGrantDecisions: preserve
      ? decisions.filter(decision => Array.isArray(ownedPaths)
        && ownedPaths.some(owned => typeof owned === 'string' && isForgeTaskOwnedPath(decision.path, owned))) : [] };
  }

  async #prepareConversationGrant(input, taskId) {
    const now = this.clock().getTime();
    // An expired grant can supply historical task scope, never current authority.
    const previous = await this.readProductionTaskGrant(taskId, { allowExpired: true });
    const previousScope = await this.#readConversationScope(taskId);
    const requestDigest = canonicalSha256(input);
    const requestHistory = `conversation-task-requests/${taskId}`;
    const requestName = (rpcId) => crypto.createHash('sha256').update(rpcId).digest('hex');
    const superseded = await lstat(path.join(this.config.stateRoot, requestHistory, `${requestName(input.rpcId)}.json`))
      .catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (superseded !== null) fail('CONVERSATION_REQUEST_REPLAY', '这条请求已被后续消息替代，不能再次执行；请发送新的继续请求。', 409);
    if (previousScope?.rpcId === input.rpcId && previousScope.requestDigest !== requestDigest) {
      fail('CONVERSATION_REQUEST_CONFLICT', '同一请求标识不能绑定不同的用户、内容或源码。', 409);
    }
    if (previousScope?.rpcId === input.rpcId && previousScope.grantId === null) {
      return { grant: null, previousCompletion: null };
    }
    if (previousScope?.rpcId === input.rpcId && previousScope.grantId !== previous?.grantId) {
      fail('CONVERSATION_WRITE_SCOPE_INVALID', '当前请求的授权记录不一致。', 503);
    }
    if (previous?.claim?.rpcId === input.rpcId || previousScope?.rpcId === input.rpcId) {
      if (!this.#conversationScopeAllowed(previous)) fail('CONVERSATION_WRITE_SCOPE_REVOKED', '此前任务范围不再属于当前项目允许修改的源码范围。', 403);
      const current = await this.readProductionTaskGrant(taskId);
      if (current === null) fail('CONVERSATION_REQUEST_EXPIRED', '原请求授权已过期，请发送新的继续请求。', 409);
      return { grant: current, previousCompletion: null };
    }
    // The user's text determines task scope. A Controller prompt is execution
    // input, never a second request from which to infer broader permissions.
    const prompt = (input.controllerPhase?.originalPromptText ?? input.promptText).trim();
    const crossLayerPreparationContinuation = isForgeCrossLayerPreparationContinuation(prompt, input.controllerPhase?.phaseAuthority);
    const runtimeAccessRepairContinuation = isForgeAccessWiringRuntimeRepairContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeBackendRuntimeRepairContinuation(prompt, input.controllerPhase?.phaseAuthority);
    const requestedAction = crossLayerPreparationContinuation || runtimeAccessRepairContinuation ? null : requestedProductionAction(prompt);
    const bareContinuation = isBareTaskContinuation(prompt);
    const permissionContinuation = this.config.conversationTaskPreparation === true
      && AMBIGUOUS_PERMISSION_REQUEST.test(prompt)
      && typeof previousScope?.goal === 'string';
    const continuation = isForgeConversationTaskContinuation(prompt) || permissionContinuation
      || isForgeDomainContractContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeDatabaseLeaseContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeBackendLeaseContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeFrontendLeaseContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeAccessWiringLeaseContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeDatabaseEvidenceContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeBackendEvidenceContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeBackendPhaseCompletion(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeFrontendPhaseCompletion(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeAccessWiringPhaseCompletion(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeCrossLayerPhaseCompletion(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeAccessWiringMigrationRepairContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || runtimeAccessRepairContinuation
      || crossLayerPreparationContinuation
      || isForgeCrossLayerRuntimeReprobeContinuation(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeDomainCandidateCorrection(prompt, input.controllerPhase?.phaseAuthority)
      || isForgeDomainAcceptanceContinuation(prompt, input.controllerPhase?.phaseAuthority);
    const planning = hasPlanningRequest(prompt);
    const globalReadOnly = hasGlobalReadOnlyIntent(prompt);
    const readOnly = globalReadOnly || QUESTION_REQUEST.test(prompt) || CANCEL_TASK.test(prompt) || planning;
    const requestedWrite = !readOnly && (continuation || hasTaskWriteIntent(prompt) || requestedAction !== null);
    const proposedWrite = planning || (QUESTION_REQUEST.test(prompt) && hasTaskWriteIntent(prompt) && !globalReadOnly);

    let scope;
    if (continuation) {
      const sameLegacyBlankScope = previousScope !== null
        && previousScope.implementationRequested === false
        && previousScope.grantId === null
        && previousScope.ownedPaths.length === 0
        && previousScope.taskProfiles.length === 0
        && !Object.hasOwn(previousScope, 'goal')
        && !Object.hasOwn(previousScope, 'sourceTransitionDigest')
        && (previousScope.actionCeiling ?? 'workspace-write') === 'workspace-write'
        && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => previousScope[key] === input[key])
        && previousScope.sourceCommit === input.source.head;
      if (this.config.conversationTaskPreparation === true
        && input.conversationTaskPreparationSupported === true
        && input.workspaceWriteAuthorized === true
        && input.controllerPhase === undefined
        && conversationTaskWritableEligible(prompt)
        && previous === null
        && (previousScope === null || sameLegacyBlankScope)) {
        return { grant: null, previousCompletion: null };
      }
      scope = previousScope ?? previous;
      if (scope === null || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every((key) => scope[key] === input[key])
        || (scope.implementationRequested === false
          && !(this.config.conversationTaskPreparation === true && typeof scope.goal === 'string'))) {
        fail('CONVERSATION_WRITE_SCOPE_REQUIRED', '继续执行缺少当前用户、会话和源码版本匹配的任务范围，请重新说明要实施的具体任务。', 409);
      }
      if (scope.implementationRequested === false) scope = { ...scope, implementationRequested: true };
      if (scope.sourceCommit !== input.source.head) {
        scope = await this.#migrateConversationScope(input, taskId, scope, previous);
      }
      if (!this.#conversationScopeAllowed(scope)) {
        fail('CONVERSATION_WRITE_SCOPE_REVOKED', '此前任务范围不再属于当前项目允许修改的源码范围。', 403);
      }
      const phase = input.controllerPhase?.phaseAuthority;
      const adjacentDatabase = phase?.phaseId === 'database' && phase.phaseIndex === 2
        && isForgeDomainAcceptanceContinuation(prompt, phase);
      const adjacentFrontend = phase?.workflowId === 'crud-production' && phase.phaseId === 'frontend'
        && phase.phaseIndex === 5 && phase.actionCeiling === 'workspace-write'
        && (isForgeConversationTaskContinuation(prompt) || isForgeBackendPhaseCompletion(prompt, phase));
      const runtimeAccessRepair = phase?.phaseId === 'access-wiring' && phase.phaseIndex === 6
        && phase.actionCeiling === 'workspace-write' && runtimeAccessRepairContinuation;
      if (adjacentDatabase || adjacentFrontend || runtimeAccessRepair) {
        if (input.workspaceWriteAuthorized !== true) {
          fail('PHASE_USER_SCOPE_REQUIRED', '进入下一实施阶段需要当前用户的工作区写入授权。', 403);
        }
        // The trusted Controller selects the adjacent phase or bounded runtime repair;
        // an ordinary user continuation retains the original delivery scope.
        // Add only configured paths inside that canonical phase; the
        // actual execution grant is intersected with this phase below.
        const phasePaths = [...new Set(this.config.conversationWriterScopes.flatMap(item =>
          item.ownedPaths.flatMap(allowed => phase.ownedPaths.flatMap(owned =>
            allowed === owned || allowed.startsWith(`${owned}/`) ? [allowed]
              : owned.startsWith(`${allowed}/`) ? [owned] : []))))].sort();
        const phaseProfiles = runtimeAccessRepair && phasePaths.length > 0
          ? compileForgeTaskExecutionContract({ prompt: input.promptText, actionCeiling: phase.actionCeiling,
            ownedPaths: phasePaths, taskProfiles: phase.taskProfiles }).taskProfiles
          : phase.taskProfiles;
        const paths = [...new Set([...scope.ownedPaths, ...phasePaths])].sort();
        scope = { ...scope,
          ownedPaths: paths.filter(candidate => !paths.some(root => candidate !== root && candidate.startsWith(`${root}/`))),
          taskProfiles: [...new Set([...scope.taskProfiles, ...phaseProfiles])].sort() };
        if (!this.#conversationScopeAllowed(scope)) {
          fail('PHASE_USER_SCOPE_REQUIRED', '阶段授权路径必须保持在当前项目配置范围内。', 403);
        }
      }
    } else {
      const intent = deriveForgeTaskIntent({ prompt, actionCeiling: 'read-only' });
      const profiles = intent.taskProfiles.filter((profile) => profile !== 'read-only-review');
      const selected = this.config.conversationWriterScopes.filter((item) => profiles.includes(item.taskProfile));
      const selectedProfiles = selected.map((item) => item.taskProfile);
      const roots = [...new Set(selected.flatMap((item) => item.ownedPaths))].sort();
      const ownedPaths = roots.filter((candidate) => !roots.some((root) => candidate !== root && candidate.startsWith(`${root}/`)));
      if (ownedPaths.length === 0 && requestedWrite) {
        fail('CONVERSATION_WRITE_SCOPE_REQUIRED', '当前请求未匹配项目允许的代码任务范围，请说明目标页面、接口或模块。', 409);
      }
      if (!requestedWrite && !planning && profiles.length === 0) {
        // A general question does not replace the business task being discussed.
        scope = previousScope ?? previous;
        if (globalReadOnly || CANCEL_TASK.test(prompt)) scope = null;
        if (scope !== null && (!['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => scope[key] === input[key]) || scope.sourceCommit !== input.source.head)) scope = null;
      } else if (ownedPaths.length > 0) {
        const contract = compileForgeTaskExecutionContract({ prompt, actionCeiling: 'workspace-write', ownedPaths, taskProfiles: selectedProfiles });
        scope = { ownedPaths: contract.ownedPaths, taskProfiles: contract.taskProfiles,
          implementationRequested: requestedWrite || proposedWrite };
      } else scope = null;
    }
    const actionCeiling = requestedAction ?? (continuation ? scope?.actionCeiling : undefined) ?? 'workspace-write';
    if (requestedWrite && PRODUCTION_ACTIONS.indexOf(actionCeiling)
      > PRODUCTION_ACTIONS.indexOf(input.authorizedActionCeiling ?? 'workspace-write')) {
      fail('CONVERSATION_ACTION_NOT_AUTHORIZED', '当前用户没有本次提交或发版所需的权限。', 403);
    }
    if (scope !== null && scope !== undefined) scope = { ...scope, actionCeiling };
    if (input.controllerPhase === undefined && bareContinuation && requestedAction === null && actionCeiling === 'workspace-write') {
      const previousCompletion = await this.#readPreviousCompletion(input, taskId, scope, previous, now);
      if (previousCompletion !== null) return { grant: null, previousCompletion };
    }
    const phase = input.controllerPhase?.phaseAuthority;
    let grantScope = scope;
    let grantRequested = requestedWrite;
    if (phase !== undefined) {
      if (!requestedWrite || scope === null || scope === undefined) {
        fail('PHASE_USER_INTENT_REQUIRED', '当前消息没有授权继续业务交付，阶段没有启动。', 409);
      }
      grantRequested = phase.actionCeiling !== 'read-only';
      const intersections = [...new Set(scope.ownedPaths.flatMap((allowed) => phase.ownedPaths.flatMap((owned) =>
        allowed === owned || allowed.startsWith(`${owned}/`) ? [allowed]
          : owned.startsWith(`${allowed}/`) ? [owned] : [])))].sort();
      const ownedPaths = intersections.filter((candidate) => !intersections.some((root) =>
        candidate !== root && candidate.startsWith(`${root}/`)));
      const taskProfiles = scope.taskProfiles.filter((profile) => phase.taskProfiles.includes(profile));
      if (grantRequested && (ownedPaths.length === 0 || taskProfiles.length === 0)) {
        fail('PHASE_USER_SCOPE_REQUIRED', '当前业务任务的授权范围不足以执行这一阶段，代码尚未修改。', 403);
      }
      if (grantRequested) {
        const normalized = compileForgeTaskExecutionContract({
          prompt: input.promptText,
          actionCeiling: phase.actionCeiling,
          ownedPaths,
          taskProfiles,
        });
        if (normalized.taskProfiles.some((profile) => !scope.taskProfiles.includes(profile))) {
          fail('PHASE_USER_SCOPE_REQUIRED', '当前业务任务的授权范围不足以执行这一阶段，代码尚未修改。', 403);
        }
        grantScope = { ownedPaths: normalized.ownedPaths, taskProfiles: normalized.taskProfiles };
      } else {
        grantScope = { ownedPaths, taskProfiles };
      }
    }
    const roleOptions = this.#conversationRoleOptions(previousScope, previous, input,
      grantScope?.ownedPaths ?? [], continuation || (!requestedWrite && scope !== null));
    const semanticOptions = this.#semanticResourceOptions(grantScope?.ownedPaths ?? []);
    // A release confirmation recompiles the action ceiling, not the prepared
    // source evidence. Reuse only this scope's trusted, byte-bound test mapping.
    const backendOptions = continuation && phase === undefined
      && input.changedVerificationSupported === true && input.focusedBackendVerificationSupported === true
      && previous?.taskContract.backendTestBindings !== undefined
      && previousScope?.grantId === previous.grantId && previousScope.implementationRequested === true
      && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every((key) => previous[key] === input[key])
      && previous.sourceCommit === input.source.head && previous.workspaceFingerprint === input.source.fingerprint
      && canonicalSha256(previous.ownedPaths) === canonicalSha256(grantScope?.ownedPaths)
      && canonicalSha256(previous.taskProfiles) === canonicalSha256(grantScope?.taskProfiles)
      ? { backendTestBindings: previous.taskContract.backendTestBindings } : {};
    let grant = null;
    if (previous !== null && previous.claim === null && Date.parse(previous.expiresAt) > now) {
      // Preserve an explicitly prepared one-shot grant until it is consumed.
      if (grantRequested) {
        if (!this.#conversationScopeAllowed(previous)) fail('CONVERSATION_WRITE_SCOPE_REVOKED', '预备授权已超出当前项目允许修改的源码范围。', 403);
        const sameExecution = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'promptTextDigest']
          .every((key) => previous[key] === input[key]) && previous.sourceCommit === input.source.head
          && previous.workspaceFingerprint === input.source.fingerprint;
        const samePhaseScope = phase === undefined || (previous.actionCeiling === phase.actionCeiling
          && JSON.stringify(previous.ownedPaths) === JSON.stringify(grantScope.ownedPaths)
          && JSON.stringify(previous.taskProfiles) === JSON.stringify(grantScope.taskProfiles));
        if (phase === undefined && !sameExecution) {
          fail('EXECUTION_AUTHORITY_GRANT_MISMATCH', 'Production task grant does not match this execution.', 409);
        }
        if (sameExecution && samePhaseScope) grant = previous;
      }
    }
    if (grantRequested && grant === null) {
      const continuationContract = continuation && phase === undefined
        ? await this.#currentContinuationContract(input, taskId, previous, compileForgeTaskExecutionContract({
          prompt: input.promptText, ownedPaths: grantScope.ownedPaths,
          taskProfiles: grantScope.taskProfiles, actionCeiling,
        }, { ...reviewCompilerOptions(input, previousScope?.dualReview), ...roleOptions, ...semanticOptions, ...backendOptions })) : null;
      const issued = createProductionTaskGrant({ now, ...reviewCompilerOptions(input, continuation ? previousScope?.dualReview : undefined), ...roleOptions, ...semanticOptions, ...backendOptions, spec: { schemaVersion: 1, projectSlug: input.projectSlug, taskId,
      actorUserId: input.actorUserId, actorUsername: input.actorUsername, conversationId: input.conversationId,
      dshSessionId: input.dshSessionId, promptText: input.promptText, sourceCommit: input.source.head,
      workspaceFingerprint: input.source.fingerprint, ownedPaths: grantScope.ownedPaths, taskProfiles: grantScope.taskProfiles,
      ...((phase?.actionCeiling ?? actionCeiling) === 'workspace-write' ? {} : { actionCeiling }),
      ttlSeconds: Math.min(900, this.config.contractTtlSeconds) },
      ...(continuationContract === null ? {} : { continuationContract }) });
      if (input.conversationContractContinuationSupported === true && continuation && previous !== null
        && (previousScope?.grantId !== previous.grantId || previousScope?.implementationRequested !== true)
        && issued.grant.taskContract.contractId === previous.taskContract.contractId) {
        fail('CONVERSATION_TASK_PROPOSAL_CONFLICT',
          '当前新任务的确认文字与旧任务相同，不能沿用旧验收。请在确认中明确当前新任务目标后继续执行。', 409);
      }
      if (previous !== null) {
        await this.#saveConversationRecord('production-task-grants-history', `${taskId}.${previous.grantId}.${previous.recordDigest}`, previous, { archive: true });
      }
      await this.#saveConversationRecord('production-task-grant-receipts', issued.grant.grantId, issued.receipt, { archive: true });
      await this.writeProductionTaskGrant(issued.grant);
      grant = issued.grant;
    }
    // Retire only superseded message IDs, including read-only plans. This is
    // per-task request idempotency, not an additional source of write authority.
    for (const rpcId of new Set([previousScope?.rpcId, previous?.claim?.rpcId].filter((id) => id && id !== input.rpcId))) {
      await this.#saveConversationRecord(requestHistory, requestName(rpcId), { schemaVersion: 1, taskId, rpcId }, { archive: true });
    }
    const acceptedApiContract = input.controllerPhase?.acceptedApiContract
      ?? input.completedApiContract
      ?? (input.controllerPhase === undefined && continuation && scope?.acceptedApiContract !== undefined
        && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every(key => scope[key] === input[key])
        && scope.sourceCommit === input.source.head ? scope.acceptedApiContract : undefined);
    await this.#saveConversationScope(taskId, sealRecord({
      schemaVersion: 1, projectSlug: input.projectSlug, taskId, actorUserId: input.actorUserId,
      actorUsername: input.actorUsername, conversationId: input.conversationId, dshSessionId: input.dshSessionId,
      sourceCommit: input.source.head, ownedPaths: scope?.ownedPaths ?? [], taskProfiles: scope?.taskProfiles ?? [],
      implementationRequested: scope !== null && scope.implementationRequested !== false,
      actionCeiling: scope?.actionCeiling ?? 'workspace-write',
      promptTextDigest: input.promptTextDigest, rpcId: input.rpcId, requestDigest, grantId: grant?.grantId ?? null,
      ...(typeof scope?.goal === 'string' ? { goal: scope.goal } : {}),
      ...(scope?.dualReview === undefined ? {} : { dualReview: scope.dualReview }),
      ...(acceptedApiContract === undefined ? {} : {
        acceptedApiContract: normalizeAcceptedApiContract(acceptedApiContract),
      }),
      ...roleOptions,
      ...(scope?.sourceTransitionDigest === undefined ? {} : {
        sourceTransitionDigest: scope.sourceTransitionDigest,
        sourceTransitionFromFingerprint: scope.sourceTransitionFromFingerprint,
      }),
      ...(scope?.sourceTransition === undefined ? {} : { sourceTransition: scope.sourceTransition }),
    }));
    return { grant, previousCompletion: null };
  }

  async issueExecutionAuthority(input) {
    exactKeys(input, [
      'projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
      'dshSessionId', 'route', 'rpcId', 'promptText', 'promptTextDigest', 'source',
      ...(Object.hasOwn(input, 'workspaceWriteAuthorized') ? ['workspaceWriteAuthorized'] : []),
      ...(Object.hasOwn(input, 'authorizedActionCeiling') ? ['authorizedActionCeiling'] : []),
      ...(Object.hasOwn(input, 'conversationTaskPreparationSupported') ? ['conversationTaskPreparationSupported'] : []),
      ...(Object.hasOwn(input, 'conversationFormatMaintenanceSupported') ? ['conversationFormatMaintenanceSupported'] : []),
      ...(Object.hasOwn(input, 'conversationContractContinuationSupported') ? ['conversationContractContinuationSupported'] : []),
      ...(Object.hasOwn(input, 'independentReviewSuspensionSupported') ? ['independentReviewSuspensionSupported'] : []),
      ...(Object.hasOwn(input, 'changedVerificationSupported') ? ['changedVerificationSupported'] : []),
      ...(Object.hasOwn(input, 'focusedBackendVerificationSupported') ? ['focusedBackendVerificationSupported'] : []),
      ...(Object.hasOwn(input, 'ordinaryFinalVerificationSupported') ? ['ordinaryFinalVerificationSupported'] : []),
      ...(Object.hasOwn(input, 'sourceTransition') ? ['sourceTransition'] : []),
      ...(Object.hasOwn(input, 'controllerPhase') ? ['controllerPhase'] : []),
      ...(Object.hasOwn(input, 'completedApiContract') ? ['completedApiContract'] : []),
    ], 'execution authority request');
    if (Object.hasOwn(input, 'ordinaryFinalVerificationSupported') && typeof input.ordinaryFinalVerificationSupported !== 'boolean') {
      fail('EXECUTION_RUNTIME_CAPABILITY_INVALID', 'Ordinary final verification support must come from the trusted runtime.', 422);
    }
    if (Object.hasOwn(input, 'focusedBackendVerificationSupported') && typeof input.focusedBackendVerificationSupported !== 'boolean') {
      fail('EXECUTION_RUNTIME_CAPABILITY_INVALID', 'Focused backend verification support must come from the trusted runtime.', 422);
    }
    if (Object.hasOwn(input, 'changedVerificationSupported') && typeof input.changedVerificationSupported !== 'boolean') {
      fail('EXECUTION_RUNTIME_CAPABILITY_INVALID', 'Changed verification support must come from the trusted runtime.', 422);
    }
    if (Object.hasOwn(input, 'independentReviewSuspensionSupported') && typeof input.independentReviewSuspensionSupported !== 'boolean') {
      fail('EXECUTION_RUNTIME_CAPABILITY_INVALID', '工作舱独审兼容能力必须由可信运行配置提供。', 422);
    }
    if (Object.hasOwn(input, 'workspaceWriteAuthorized') && typeof input.workspaceWriteAuthorized !== 'boolean') {
      fail('EXECUTION_AUTHORITY_REQUEST_INVALID', 'Workspace write capability must be a server-owned boolean.', 422);
    }
    if (Object.hasOwn(input, 'conversationTaskPreparationSupported')
      && typeof input.conversationTaskPreparationSupported !== 'boolean') {
      fail('EXECUTION_AUTHORITY_REQUEST_INVALID', 'Conversation task preparation support must be a server-owned boolean.', 422);
    }
    if (Object.hasOwn(input, 'conversationFormatMaintenanceSupported')
      && typeof input.conversationFormatMaintenanceSupported !== 'boolean') {
      fail('EXECUTION_AUTHORITY_REQUEST_INVALID', 'Conversation format maintenance support must be a server-owned boolean.', 422);
    }
    if (Object.hasOwn(input, 'conversationContractContinuationSupported')
      && typeof input.conversationContractContinuationSupported !== 'boolean') {
      fail('EXECUTION_AUTHORITY_REQUEST_INVALID', 'Conversation contract continuation support must be a server-owned boolean.', 422);
    }
    if (Object.hasOwn(input, 'authorizedActionCeiling')
      && (!PRODUCTION_ACTIONS.includes(input.authorizedActionCeiling) || input.workspaceWriteAuthorized !== true)) {
      fail('EXECUTION_AUTHORITY_REQUEST_INVALID', 'Action ceiling must come from the authenticated writer capability.', 422);
    }
    if (Object.hasOwn(input, 'sourceTransition')) {
      try { validateSourceTransition(input.sourceTransition); } catch {
        fail('SOURCE_TRANSITION_INVALID', '可信源码迁移事实无效。', 409);
      }
    }
    if (input.completedApiContract !== undefined) {
      const api = normalizeAcceptedApiContract(input.completedApiContract);
      if (input.controllerPhase !== undefined || api.taskId !== input.taskId || api.sourceCommit !== input.source?.head) {
        fail('EXECUTION_PHASE_AUTHORITY_INVALID', 'Completed API contract must bind this ordinary request and current source.', 409);
      }
    }
    if (input.controllerPhase !== undefined) {
      const phaseInput = input.controllerPhase;
      exactKeys(phaseInput, ['originalPromptText', 'originalPromptTextDigest', 'phaseAuthority',
        ...(Object.hasOwn(phaseInput, 'acceptedApiContract') ? ['acceptedApiContract'] : [])], 'Controller phase input');
      const phase = phaseInput.phaseAuthority;
      if (phaseInput.acceptedApiContract !== undefined) {
        const api = normalizeAcceptedApiContract(phaseInput.acceptedApiContract);
        if (api.taskId !== input.taskId || api.workflowId !== phase.workflowId || api.sourceCommit !== input.source.head) {
          fail('EXECUTION_PHASE_AUTHORITY_INVALID', 'Accepted APIs do not match the controlled task, workflow and source.', 409);
        }
      }
      exactKeys(phase, [
        'workflowId', 'phaseId', 'phaseIndex', 'catalogVersion', 'catalogDigest',
        'actionCeiling', 'ownedPaths', 'taskProfiles', 'requiredProfiles',
      ], 'Controller phase authority');
      const canonicalTaskProfiles = Array.isArray(phase.taskProfiles)
        ? TASK_PROFILES.filter((profile) => phase.taskProfiles.includes(profile)) : [];
      const canonicalRequiredProfiles = Array.isArray(phase.requiredProfiles)
        ? VERIFY_PROFILE_NAMES.filter((profile) => phase.requiredProfiles.includes(profile)) : [];
      if (typeof phaseInput.originalPromptText !== 'string' || phaseInput.originalPromptText.length === 0
        || Buffer.byteLength(phaseInput.originalPromptText, 'utf8') > 1024 * 1024
        || digestDirectUserTextContent([{ type: 'text', text: phaseInput.originalPromptText }]) !== phaseInput.originalPromptTextDigest
        || !['read-only', 'workspace-write'].includes(phase.actionCeiling)
        || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(phase.workflowId ?? '')
        || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(phase.phaseId ?? '')
        || !Number.isSafeInteger(phase.phaseIndex) || phase.phaseIndex < 0
        || typeof phase.catalogVersion !== 'string' || phase.catalogVersion.length === 0
        || !SHA256.test(phase.catalogDigest ?? '')
        || !Array.isArray(phase.ownedPaths) || !Array.isArray(phase.taskProfiles)
        || !Array.isArray(phase.requiredProfiles)
        || phase.ownedPaths.some((entry) => typeof entry !== 'string' || entry.length === 0
          || entry.includes('\\') || entry.includes('\0') || path.isAbsolute(entry)
          || entry.split('/').some((part) => part === '..' || part === '.' || part === ''))
        || canonicalTaskProfiles.length !== phase.taskProfiles.length
        || canonicalTaskProfiles.some((entry, index) => entry !== phase.taskProfiles[index])
        || canonicalRequiredProfiles.length !== phase.requiredProfiles.length
        || canonicalRequiredProfiles.some((entry, index) => entry !== phase.requiredProfiles[index])
        || (phase.actionCeiling === 'read-only' && phase.ownedPaths.length !== 0)
        || (phase.actionCeiling === 'workspace-write' && phase.ownedPaths.length === 0)
        || input.workspaceWriteAuthorized !== true || !Object.hasOwn(this.config, 'conversationWriterScopes')) {
        fail('EXECUTION_PHASE_AUTHORITY_INVALID', '阶段请求未绑定当前用户意图和受控修改范围。', 409);
      }
    }
    const taskId = requiredString(input.taskId, TASK_ID, 'execution authority request.taskId');
    return this.#exclusive(taskId, () => this.#issueExecutionAuthorityUnlocked(input, taskId));
  }

  async #issueExecutionAuthorityUnlocked(input, taskId) {
    requiredString(input.projectSlug, TASK_ID, 'execution authority request.projectSlug');
    requiredString(input.actorUserId, ACTOR_USER_ID, 'execution authority request.actorUserId');
    requiredString(input.actorUsername, ACTOR_USERNAME, 'execution authority request.actorUsername');
    requiredString(input.conversationId, CONVERSATION_ID, 'execution authority request.conversationId');
    requiredString(input.dshSessionId, DSH_ID, 'execution authority request.dshSessionId');
    requiredString(input.rpcId, RPC_ID, 'execution authority request.rpcId');
    requiredString(input.promptTextDigest, SHA256, 'execution authority request.promptTextDigest');
    exactKeys(input.source, ['fingerprint', 'head'], 'execution authority request.source');
    requiredString(input.source.head, SOURCE_COMMIT, 'execution authority request.source.head');
    requiredString(input.source.fingerprint, SHA256, 'execution authority request.source.fingerprint');
    if (input.projectSlug !== this.config.projectSlug || input.route !== 'session.prompt'
      || typeof input.promptText !== 'string' || input.promptText.length === 0
      || Buffer.byteLength(input.promptText, 'utf8') > 1024 * 1024) {
      fail('EXECUTION_AUTHORITY_REQUEST_INVALID', 'Execution authority request is invalid.', 409);
    }
    if (digestDirectUserTextContent([{ type: 'text', text: input.promptText }]) !== input.promptTextDigest) {
      fail('EXECUTION_AUTHORITY_PROMPT_DIGEST_MISMATCH', 'Execution authority prompt digest does not match the received text.', 409);
    }

    if (input.workspaceWriteAuthorized === false) {
      if (this.managedFileTargets().targets.length && input.controllerPhase === undefined) await this.#rememberConversationTaskRequest(input, taskId);
      return { authority: null, trustedPolicyInput: null, idempotent: false };
    }
    if (this.config.conversationTaskPreparation === true
      && input.conversationTaskPreparationSupported === true
      && input.workspaceWriteAuthorized === true
      && input.controllerPhase === undefined) {
      const priorRequest = await this.#readConversationTaskRequest(taskId);
      const priorScope = await this.#readConversationScope(taskId);
      const requestedAction = requestedProductionAction(input.promptText.trim());
      if (requestedAction !== null && PRODUCTION_ACTIONS.indexOf(requestedAction)
        > PRODUCTION_ACTIONS.indexOf(input.authorizedActionCeiling ?? 'workspace-write')) {
        fail('CONVERSATION_ACTION_NOT_AUTHORIZED', '当前用户没有本次提交或发版所需的权限。', 403);
      }
      // A new writable request may not have reached propose yet. A subsequent
      // confirmation must prepare that request, not revive an older release.
      const unpreparedRequest = priorRequest?.writableEligible === true
        && typeof priorScope?.goal === 'string' && priorRequest.rpcId !== priorScope.rpcId
        && priorRequest.source.head === input.source.head && priorScope.sourceCommit === input.source.head
        && priorRequest.source.fingerprint === input.source.fingerprint
        && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => priorRequest[key] === input[key] && priorScope[key] === input[key]);
      // An explicit file-scope request needs a fresh proposal, even when it
      // starts with "continue". Keep the prior scope and grant bound to their
      // original RPC instead of inheriting its release authority before propose.
      const prepareNewScope = requestedAction === null && typeof priorScope?.goal === 'string'
        && priorScope.rpcId !== input.rpcId
        && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => priorScope[key] === input[key])
        && requestsConversationScopePreparation(input.promptText);
      await this.#rememberConversationTaskRequest(input, taskId);
      if (unpreparedRequest || prepareNewScope || (!isForgeConversationTaskContinuation(input.promptText)
        && !AMBIGUOUS_PERMISSION_REQUEST.test(input.promptText.trim()))) {
        return { authority: null, trustedPolicyInput: null, idempotent: false };
      }
    }
    const automatic = input.workspaceWriteAuthorized === true && Object.hasOwn(this.config, 'conversationWriterScopes');
    const preparedGrant = automatic
      ? await this.#prepareConversationGrant(input, taskId)
      : await this.readProductionTaskGrant(taskId);
    const grant = automatic ? preparedGrant.grant : preparedGrant;
    const previousCompletion = automatic ? preparedGrant.previousCompletion : null;
    if (previousCompletion !== null) {
      return { authority: null, trustedPolicyInput: null, previousCompletion, idempotent: false };
    }
    if (grant === null) return { authority: null, trustedPolicyInput: null, idempotent: false };
    if (automatic && PRODUCTION_ACTIONS.indexOf(grant.actionCeiling)
      > PRODUCTION_ACTIONS.indexOf(input.authorizedActionCeiling ?? 'workspace-write')) {
      fail('CONVERSATION_ACTION_NOT_AUTHORIZED', '当前用户没有本次提交或发版所需的权限。', 403);
    }
    if (grant.claim !== null && grant.claim.rpcId !== input.rpcId) {
      return { authority: null, trustedPolicyInput: null, idempotent: false };
    }
    if (grant.projectSlug !== input.projectSlug || grant.taskId !== taskId
      || grant.actorUserId !== input.actorUserId || grant.actorUsername !== input.actorUsername
      || grant.conversationId !== input.conversationId || grant.dshSessionId !== input.dshSessionId
      || grant.route !== input.route || grant.promptTextDigest !== input.promptTextDigest
      || grant.sourceCommit !== input.source.head
      || grant.workspaceFingerprint !== input.source.fingerprint) {
      fail('EXECUTION_AUTHORITY_GRANT_MISMATCH', 'Production task grant does not match this execution.', 409);
    }
    const compiledContract = compileForgeTaskExecutionContract({
      prompt: input.promptText,
      ownedPaths: grant.ownedPaths,
      actionCeiling: grant.actionCeiling,
      taskProfiles: grant.taskProfiles,
    }, { independentReview: Object.hasOwn(grant.taskContract, 'suspendedReviewObligations') ? 'suspended' : 'required',
      verificationScope: verificationScopeForContract(grant.taskContract),
      focusedBackendVerification: grant.taskContract.requiredVerificationProfiles.includes('backend-test-class'),
      ordinaryFinalVerification: grant.taskContract.tddRequired === false,
      backendTestBindings: grant.taskContract.backendTestBindings,
      dualReview: grant.taskContract.dualReview,
      roleGrantDecisions: grant.taskContract.roleGrantDecisions,
      ...this.#semanticResourceOptions(grant.ownedPaths) });
    const continuationContract = compiledContract.contractId === grant.taskContract.contractId ? null
      : await this.#currentContinuationContract(input, taskId, grant, compiledContract);
    const taskContract = continuationContract ?? compiledContract;
    if (taskContract.contractId !== grant.taskContract.contractId) {
      fail('EXECUTION_AUTHORITY_CONTRACT_MISMATCH', 'Production task grant contract does not match this prompt.', 409);
    }

    return this.#signTaskGrant(input, taskId, grant, taskContract, continuationContract);
  }

  async #signTaskGrant(input, taskId, grant, taskContract, continuationContract = taskContract) {
    let claimed = grant;
    let idempotent = grant.claim !== null;
    if (grant.claim === null) {
      const claimTime = this.clock();
      const productionAuthorityId = crypto.randomUUID();
      const productionAuthorityDigest = digestProductionTaskAuthorityBinding({
        projectSlug: input.projectSlug,
        taskId,
        actorUserId: input.actorUserId,
        actorUsername: input.actorUsername,
        conversationId: input.conversationId,
        dshSessionId: input.dshSessionId,
        route: input.route,
        rpcId: input.rpcId,
        promptDigest: input.promptTextDigest,
        sourceCommit: grant.sourceCommit,
        workspaceFingerprint: grant.workspaceFingerprint,
        caseFamily: grant.caseFamily,
        productionAuthorityId,
        controllerGrantDigest: grant.grantDigest,
        contractId: taskContract.contractId,
        actionCeiling: taskContract.actionCeiling,
        ownedPaths: taskContract.ownedPaths,
      });
      claimed = sealProductionTaskGrantClaim(grant, {
        claimId: crypto.randomUUID(),
        rpcId: input.rpcId,
        productionAuthorityId,
        productionAuthorityDigest,
        claimedAt: claimTime.toISOString(),
      }, claimTime.getTime());
      await this.writeProductionTaskGrant(claimed);
      idempotent = false;
    }

    const authority = signAcceptanceDocument({
      schemaVersion: 1,
      authorityType: PRODUCTION_AUTHORITY_TYPE,
      authorityId: claimed.claim.productionAuthorityId,
      issuer: 'forge-protected-acceptance',
      audience: 'forge-conversation-manager',
      projectSlug: input.projectSlug,
      taskId,
      actorUserId: input.actorUserId,
      actorUsername: input.actorUsername,
      conversationId: input.conversationId,
      dshSessionId: input.dshSessionId,
      route: input.route,
      rpcId: input.rpcId,
      promptDigest: input.promptTextDigest,
      sourceCommit: claimed.sourceCommit,
      workspaceFingerprint: claimed.workspaceFingerprint,
      caseFamily: claimed.caseFamily,
      controllerGrantId: claimed.grantId,
      controllerGrantDigest: claimed.grantDigest,
      productionAuthorityDigest: claimed.claim.productionAuthorityDigest,
      contractId: claimed.taskContract.contractId,
      actionCeiling: claimed.actionCeiling,
      ownedPaths: claimed.ownedPaths,
      taskProfiles: claimed.taskProfiles,
      issuedAt: claimed.claim.claimedAt,
      expiresAt: claimed.expiresAt,
    }, this.signers.platform);
    return {
      authority,
      trustedPolicyInput: {
        profile: 'production-controller',
        sourceCommit: claimed.sourceCommit,
        workspaceFingerprint: claimed.workspaceFingerprint,
        caseFamily: claimed.caseFamily,
        productionAuthorityId: claimed.claim.productionAuthorityId,
        productionAuthorityDigest: claimed.claim.productionAuthorityDigest,
        controllerGrantDigest: claimed.grantDigest,
        expectedContractId: claimed.taskContract.contractId,
        taskAuthority: {
          actionCeiling: claimed.actionCeiling,
          ownedPaths: claimed.ownedPaths,
          taskProfiles: claimed.taskProfiles,
          ...(continuationContract !== null ? { contract: continuationContract }
            : Object.hasOwn(taskContract, 'roleGrantDecisions')
              || Object.hasOwn(taskContract, 'semanticResources')
              || Object.hasOwn(taskContract, 'suspendedReviewObligations') || verificationScopeForContract(taskContract) === 'changed'
              ? { contract: taskContract } : {}),
        },
      },
      idempotent,
    };
  }


  async renewConversationExecution(input) {
    exactKeys(input, ['projectSlug', 'taskId', 'actorUserId', 'actorUsername',
      'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest', 'contractId', 'source',
      ...(Object.hasOwn(input, 'sourceTransition') ? ['sourceTransition'] : [])], 'execution renewal');
    const taskId = requiredString(input.taskId, TASK_ID, 'execution renewal.taskId');
    exactKeys(input.source, ['head', 'fingerprint'], 'execution renewal.source');
    requiredString(input.source.head, SOURCE_COMMIT, 'execution renewal.source.head');
    requiredString(input.source.fingerprint, SHA256, 'execution renewal.source.fingerprint');
    return this.#exclusive(taskId, async () => {
      const request = await this.#readConversationTaskRequest(taskId);
      let scope = await this.#readConversationScope(taskId);
      let grant = await this.readProductionTaskGrant(taskId, { allowExpired: true });
      let transition;
      if (input.sourceTransition !== undefined) {
        try { transition = validateSourceTransition(input.sourceTransition); } catch {
          fail('CONVERSATION_SOURCE_TRANSITION_MISMATCH', '提交续接缺少有效的受控提交事实。', 409);
        }
        if (!['checkpointed', 'integrated'].includes(transition.phase)
          || (transition.phase === 'checkpointed' && transition.from.fingerprint !== transition.to.fingerprint)
          || (transition.phase === 'integrated'
            && !['git-checkpoint', 'release'].includes(transition.sourceAuthority.actionCeiling))
          || transition.from.head === transition.to.head || transition.to.head !== input.source.head
          || transition.to.fingerprint !== input.source.fingerprint) {
          fail('CONVERSATION_SOURCE_TRANSITION_MISMATCH', '当前请求只能续接受保护的同内容提交或已完成集成事实。', 409);
        }
      }
      const checkpointAlreadyApplied = transition !== undefined
        && scope?.sourceTransition !== undefined
        && canonicalSha256(scope.sourceTransition) === canonicalSha256(transition)
        && scope.grantId === grant?.grantId && scope.sourceCommit === input.source.head
        && grant?.sourceCommit === input.source.head && grant.workspaceFingerprint === input.source.fingerprint;
      const expectedHead = checkpointAlreadyApplied ? input.source.head : (transition?.from.head ?? input.source.head);
      const identity = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'promptTextDigest'];
      const scopeMatches = scope !== null && grant !== null
        && canonicalSha256(scope.ownedPaths) === canonicalSha256(grant.ownedPaths)
        && canonicalSha256(scope.taskProfiles) === canonicalSha256(grant.taskProfiles);
      const authorityRequest = { schemaVersion: 1,
        ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
          'dshSessionId', 'rpcId', 'contractId'].map((key) => [key, input[key]])), actionCeiling: grant?.actionCeiling };
      let current;
      if ((!scopeMatches || request === null) && transition === undefined && scope !== null && grant !== null
        && grant.actionCeiling === 'workspace-write'
        && identity.every((key) => grant[key] === input[key] && scope[key] === input[key])) {
        if (typeof this.currentExecutionAuthority !== 'function') throw renewalAuthorityUnavailable();
        try { current = await this.currentExecutionAuthority(authorityRequest); }
        catch (error) {
          if (error?.code === 'CONVERSATION_EXECUTION_RENEWAL_DENIED' || [403, 409].includes(error?.statusCode)) {
            fail('CONVERSATION_EXECUTION_RENEWAL_DENIED', '当前账号、会话或任务授权已经变化，不能续用旧授权。', 403);
          }
          throw renewalAuthorityUnavailable();
        }
      }
      const phase = current?.phaseAuthority;
      const currentAuthorityValid = plainObject(current)
        && Object.entries(authorityRequest).every(([key, value]) => current[key] === value)
        && PRODUCTION_ACTIONS.includes(current.authorizedActionCeiling)
        && PRODUCTION_ACTIONS.indexOf(current.authorizedActionCeiling) >= PRODUCTION_ACTIONS.indexOf(grant.actionCeiling)
        && Number.isFinite(Date.parse(current.checkedAt)) && Math.abs(Date.parse(current.checkedAt) - this.clock().getTime()) <= 30_000;
      const intersections = phase?.ownedPaths && scope?.ownedPaths ? [...new Set(scope.ownedPaths.flatMap(allowed =>
        phase.ownedPaths.flatMap(owned => allowed === owned || allowed.startsWith(`${owned}/`) ? [allowed]
          : owned.startsWith(`${allowed}/`) ? [owned] : [])))].sort() : [];
      const phaseProfiles = intersections.length > 0 && Array.isArray(phase?.taskProfiles)
        ? compileForgeTaskExecutionContract({ prompt: `Continue the current ${phase.phaseId} phase.`, actionCeiling: 'workspace-write',
          ownedPaths: intersections, taskProfiles: scope.taskProfiles.filter(profile => phase.taskProfiles.includes(profile)) }).taskProfiles : [];
      const phaseScopeMatches = currentAuthorityValid && phase?.workflowId === 'crud-production'
        && ((phase.phaseId === 'database' && phase.phaseIndex === 2) || (phase.phaseId === 'backend' && phase.phaseIndex === 4)
          || (phase.phaseId === 'frontend' && phase.phaseIndex === 5) || (phase.phaseId === 'access-wiring' && phase.phaseIndex === 6))
        && transition === undefined && grant?.actionCeiling === 'workspace-write'
        && phase.sourceCommit === input.source.head && phase.draftSource?.head === input.source.head
        && phase.draftSource.fingerprint === input.source.fingerprint
        && Array.isArray(phase.draftSource.changedPaths) && phase.draftSource.changedPaths.every(candidate =>
          typeof candidate === 'string' && intersections.some(owned => isForgeTaskOwnedPath(candidate, owned)))
        && grant.sourceCommit === phase.sourceCommit && grant.workspaceFingerprint === phase.workspaceFingerprint
        && SHA256.test(phase.catalogDigest ?? '') && SHA256.test(phase.stateDigest ?? '')
        && typeof phase.attemptId === 'string' && typeof phase.executionId === 'string' && Number.isSafeInteger(phase.generation)
        && canonicalSha256(intersections) === canonicalSha256(grant.ownedPaths)
        && canonicalSha256(grant.taskProfiles) === canonicalSha256(phaseProfiles)
        && grant.taskProfiles.every(profile => scope.taskProfiles.includes(profile));
      if (scope === null || grant === null
        || !identity.every((key) => grant[key] === input[key] && scope[key] === input[key])
        || scope.rpcId !== input.rpcId || grant.claim?.rpcId !== input.rpcId
        || scope.implementationRequested !== true
        || (!scopeMatches && !phaseScopeMatches)
        || (scope.actionCeiling ?? 'workspace-write') !== grant.actionCeiling
        || grant.taskContract.contractId !== input.contractId || !PRODUCTION_ACTIONS.includes(grant.actionCeiling)
        || (phaseScopeMatches ? !this.#conversationScopeAllowed(scope)
          : this.config.conversationTaskPreparation !== true || request === null
            || !identity.every((key) => request[key] === input[key]) || request.rpcId !== input.rpcId
            || request.workspaceWriteAuthorized !== true || !PRODUCTION_ACTIONS.includes(request.authorizedActionCeiling)
            || PRODUCTION_ACTIONS.indexOf(grant.actionCeiling) > PRODUCTION_ACTIONS.indexOf(request.authorizedActionCeiling)
            || request.writerScopesDigest !== this.#writerScopesDigest() || !this.#conversationScopeAllowed(grant))
        || grant.sourceCommit !== expectedHead || scope.sourceCommit !== expectedHead) {
        fail('CONVERSATION_EXECUTION_RENEWAL_DENIED', '当前用户、对话、任务范围或源码基线已经变化，不能续用旧写入授权。', 409);
      }
      if (transition !== undefined && !checkpointAlreadyApplied) scope = await this.#migrateConversationScope(input, taskId, scope, grant);
      const now = this.clock().getTime();
      // This is lease renewal of the original DB execution, not candidate verification
      // or source rebinding. Broker live inventory must match Manager's independent
      // scoped-draft observation above; the signed execution baseline stays intact.
      const renewalSource = phaseScopeMatches
        ? { head: grant.sourceCommit, fingerprint: grant.workspaceFingerprint } : input.source;
      if ((transition !== undefined && !checkpointAlreadyApplied)
        || Date.parse(grant.expiresAt) <= now + 30_000 || grant.workspaceFingerprint !== renewalSource.fingerprint) {
        if (typeof this.currentExecutionAuthority !== 'function') throw renewalAuthorityUnavailable();
        try { current ??= await this.currentExecutionAuthority(authorityRequest); }
        catch (error) {
          if (error?.code === 'CONVERSATION_EXECUTION_RENEWAL_DENIED' || [403, 409].includes(error?.statusCode)) {
            fail('CONVERSATION_EXECUTION_RENEWAL_DENIED', '当前账号、会话或任务授权已经变化，不能续用旧授权。', 403);
          }
          throw renewalAuthorityUnavailable();
        }
        const keys = [...Object.keys(authorityRequest), 'authorizedActionCeiling', 'checkedAt',
          ...(current?.phaseAuthority === undefined ? [] : ['phaseAuthority'])];
        if (!plainObject(current) || Object.keys(current).sort().join() !== keys.sort().join()
          || !Object.entries(authorityRequest).every(([key, value]) => current[key] === value)
          || !PRODUCTION_ACTIONS.includes(current.authorizedActionCeiling)
          || !Number.isFinite(Date.parse(current.checkedAt)) || Math.abs(Date.parse(current.checkedAt) - this.clock().getTime()) > 30_000) {
          throw renewalAuthorityUnavailable();
        }
        if (PRODUCTION_ACTIONS.indexOf(grant.actionCeiling) > PRODUCTION_ACTIONS.indexOf(current.authorizedActionCeiling)) {
          fail('CONVERSATION_EXECUTION_RENEWAL_DENIED', '当前账号权限已不足以续用原任务授权。', 403);
        }
        const previous = grant;
        grant = transition?.phase === 'integrated' && !checkpointAlreadyApplied
          ? rebindProductionTaskGrantAfterIntegration(previous, input.source, now, { sourceTransition: transition })
          : renewProductionTaskGrant(previous, renewalSource, now,
            { sourceTransition: checkpointAlreadyApplied ? undefined : transition });
        await this.#saveConversationRecord('production-task-grants-history',
          taskId + '.' + previous.grantId + '.' + previous.recordDigest, previous, { archive: true });
        // Claim first, then publish the matching scope; failures cannot grant broader rights.
        const result = await this.#signTaskGrant({ ...input, route: 'session.prompt' }, taskId, grant, grant.taskContract);
        if (transition !== undefined && !checkpointAlreadyApplied) {
          await this.#replaceExistingCandidate(await this.readRecord(taskId), input.source, `${transition.phase}:${transition.digest}`,
            null, { acceptedApiContract: scope.acceptedApiContract });
        }
        await this.#saveConversationScope(taskId, sealRecord({ ...recordPayload(scope), grantId: grant.grantId }));
        return { ...result, ...(transition === undefined ? {} : { sourceTransition: structuredClone(transition) }) };
      }
      const result = await this.#signTaskGrant({ ...input, route: 'session.prompt' }, taskId, grant, grant.taskContract);
      if (scope.grantId !== grant.grantId) {
        await this.#saveConversationScope(taskId, sealRecord({ ...recordPayload(scope), grantId: grant.grantId }));
      }
      return { ...result, ...(transition === undefined ? {} : { sourceTransition: structuredClone(transition) }) };
    });
  }

  #conversationTaskView(scope) {
    if (scope === null || typeof scope.goal !== 'string') return null;
    return {
      goal: scope.goal,
      ownedPaths: [...scope.ownedPaths],
      taskProfiles: [...scope.taskProfiles],
    };
  }

  async #bindPreparedConversationContract(input, taskId, contract, authorityResult) {
    const authority = authorityResult?.authority;
    const trusted = authorityResult?.trustedPolicyInput;
    if (authority?.authorityType !== PRODUCTION_AUTHORITY_TYPE
      || authority.projectSlug !== input.projectSlug || authority.taskId !== taskId
      || authority.actorUserId !== input.actorUserId || authority.actorUsername !== input.actorUsername
      || authority.conversationId !== input.conversationId || authority.dshSessionId !== input.dshSessionId
      || authority.rpcId !== input.rpcId || authority.promptDigest !== input.promptTextDigest
      || authority.sourceCommit !== input.source.head || authority.workspaceFingerprint !== input.source.fingerprint
      || authority.contractId !== contract.contractId || !PRODUCTION_ACTIONS.includes(contract.actionCeiling)
      || authority.actionCeiling !== contract.actionCeiling
      || trusted?.profile !== 'production-controller'
      || trusted.expectedContractId !== contract.contractId
      || trusted.taskAuthority?.actionCeiling !== contract.actionCeiling) {
      fail('CONVERSATION_TASK_AUTHORITY_INVALID', 'Prepared task grant did not produce matching writer authority.', 503);
    }
    const acceptance = await this.#issueContractUnlocked({
      taskId,
      authorId: input.actorUserId,
      taskContract: contract,
      acceptanceSpec: compileConversationAcceptanceSpec(contract),
      source: structuredClone(input.source),
      executionAuthority: {
        rpcId: input.rpcId,
        productionAuthorityId: trusted.productionAuthorityId,
        productionAuthorityDigest: trusted.productionAuthorityDigest,
        controllerGrantDigest: trusted.controllerGrantDigest,
      },
    }, taskId);
    if (acceptance?.acceptanceContract?.contractId !== contract.contractId) {
      fail('CONVERSATION_TASK_ACCEPTANCE_BINDING_INVALID', 'Prepared task acceptance contract does not match the writer contract.', 503);
    }
  }

  async confirmConversationRoles(input) {
    exactKeys(input, ['operation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
      'conversationId', 'dshSessionId', 'executionId', 'generation', 'contractId', 'source', 'grants',
      ...(input.operation === 'confirm' ? ['previewId', 'previewDigest'] : [])], 'role decision request');
    const taskId = requiredString(input.taskId, TASK_ID, 'role decision taskId');
    if (!['preview', 'confirm'].includes(input.operation)) fail('ROLE_DECISION_INVALID', 'Role decision operation is invalid.', 422);
    requiredString(input.executionId, ACTOR_USER_ID, 'role decision executionId');
    requiredString(input.contractId, SHA256, 'role decision contractId');
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) fail('ROLE_DECISION_INVALID', 'Execution generation is invalid.', 422);
    exactKeys(input.source, ['head', 'fingerprint'], 'role decision source');
    requiredString(input.source.head, SOURCE_COMMIT, 'role decision source.head');
    requiredString(input.source.fingerprint, SHA256, 'role decision source.fingerprint');
    return this.#exclusive(taskId, async () => {
      const scope = await this.#readConversationScope(taskId);
      const grant = await this.readProductionTaskGrant(taskId);
      const identities = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId'];
      if (scope === null || grant === null || scope.implementationRequested !== true
        || scope.grantId !== grant.grantId || grant.taskContract.contractId !== input.contractId
        || !identities.every(key => scope[key] === input[key] && grant[key] === input[key])
        || scope.sourceCommit !== input.source.head || grant.sourceCommit !== input.source.head) {
        fail('ROLE_DECISION_SCOPE_CHANGED', '角色确认必须属于当前用户、对话和已准备的任务；请重新准备并预览。', 409);
      }
      if (!Object.hasOwn(grant.taskContract, 'roleGrantDecisions')) {
        fail('ROLE_DECISION_NOT_ENABLED', '当前任务尚未启用受保护角色确认。', 409);
      }
      if (!Array.isArray(input.grants) || input.grants.length > 64
        || Buffer.byteLength(JSON.stringify(input.grants)) > 64 * 1024) {
        fail('ROLE_DECISION_INVALID', 'Role preview size is invalid.', 422);
      }
      for (const item of input.grants) {
        exactKeys(item, ['path', 'line', 'fileSha256', 'statementSha256', 'statement', 'roleKeys'], 'role preview grant');
        if (typeof item.statement !== 'string' || item.statement.length === 0
          || !Number.isSafeInteger(item.line) || item.line < 1
          || item.statementSha256 !== crypto.createHash('sha256').update(item.statement).digest('hex')
          || canonicalSha256(item.roleKeys) !== canonicalSha256(explicitRoleGrantRecipients(item.statement))) {
          fail('ROLE_DECISION_INVALID', 'Role preview does not match its SQL statement.', 422);
        }
        // An opaque statement may be displayed, but can never be approved.
        normalizeForgeRoleGrantDecisions([{ path: item.path, fileSha256: item.fileSha256,
          statementSha256: item.statementSha256, roleKeys: item.roleKeys ?? ['unresolved'] }], scope.ownedPaths);
      }
      const binding = { projectSlug: input.projectSlug, taskId, actorUserId: input.actorUserId,
        actorUsername: input.actorUsername, conversationId: input.conversationId, dshSessionId: input.dshSessionId,
        executionId: input.executionId, generation: input.generation, contractId: input.contractId,
        source: input.source, grants: input.grants, scopeDigest: scope.recordDigest };
      const digest = canonicalSha256(binding);
      if (input.operation === 'preview') {
        const preview = { schemaVersion: 1, ...binding, previewId: crypto.randomUUID(), previewDigest: digest,
          expiresAt: new Date(Math.min(this.clock().getTime() + 600_000, Date.parse(grant.expiresAt))).toISOString(),
          consumedAt: null };
        await this.#saveConversationRecord('conversation-role-previews', taskId, preview);
        return { status: 'needs-confirmation', previewId: preview.previewId, previewDigest: digest,
          expiresAt: preview.expiresAt, grants: structuredClone(input.grants),
          approvable: input.grants.length > 0 && input.grants.every(item => item.roleKeys !== null) };
      }
      requiredString(input.previewId, ACTOR_USER_ID, 'role decision previewId');
      requiredString(input.previewDigest, PREFIXED_SHA256, 'role decision previewDigest');
      const file = path.join(this.config.stateRoot, 'conversation-role-previews', `${taskId}.json`);
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BODY_BYTES) {
        fail('ROLE_PREVIEW_REQUIRED', '请先预览本次角色授权。', 409);
      }
      const preview = JSON.parse(await readFile(file, 'utf8'));
      if (preview.consumedAt !== null || !Number.isFinite(Date.parse(preview.expiresAt))
        || Date.parse(preview.expiresAt) <= this.clock().getTime()
        || preview.previewId !== input.previewId || preview.previewDigest !== input.previewDigest
        || digest !== input.previewDigest
        || canonicalSha256(Object.fromEntries(Object.keys(binding).map(key => [key, preview[key]]))) !== digest) {
        fail('ROLE_PREVIEW_STALE', '任务、源码或角色预览已变化或确认已使用，请重新预览。', 409);
      }
      if (input.grants.length === 0 || input.grants.some(item => item.roleKeys === null)) {
        fail('ROLE_RECIPIENTS_UNRESOLVED', '无法确定全部有限角色，请先在对话中修正候选 SQL。', 409);
      }
      const roleGrantDecisions = normalizeForgeRoleGrantDecisions(input.grants.map(({ path: filePath,
        fileSha256, statementSha256, roleKeys }) => ({ path: filePath, fileSha256, statementSha256, roleKeys })), scope.ownedPaths);
      const updated = { ...scope, roleGrantDecisions };
      updated.recordDigest = canonicalSha256(recordPayload(updated));
      await this.#saveConversationScope(taskId, updated);
      const consumed = { ...preview, consumedAt: this.clock().toISOString() };
      await this.#saveConversationRecord('conversation-role-previews', taskId, consumed);
      await this.#saveConversationRecord('conversation-role-decision-history', preview.previewId, consumed, { archive: true });
      return { status: 'confirmed', previewId: preview.previewId, roleGrantDecisions,
        message: '已确认预览中的角色与 SQL。请回到原对话继续；候选变化后需要重新确认。' };
    });
  }

  async prepareConversationTask(input) {
    exactKeys(input, [
      'operation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
      'conversationId', 'dshSessionId', 'rpcId', 'promptText', 'promptTextDigest',
      'source', 'expectedExecutionId', 'expectedGeneration',
      ...(Object.hasOwn(input, 'proposal') ? ['proposal'] : []),
      ...(Object.hasOwn(input, 'backendTestBindings') ? ['backendTestBindings'] : []),
    ], 'conversation task preparation request');
    if (!['inspect', 'propose'].includes(input.operation)
      || (input.operation === 'inspect' && (Object.hasOwn(input, 'proposal') || Object.hasOwn(input, 'backendTestBindings')))
      || (input.operation === 'propose' && !Object.hasOwn(input, 'proposal'))) {
      fail('CONVERSATION_TASK_PREPARATION_INVALID', 'Conversation task operation and proposal do not match.', 422);
    }
    const taskId = requiredString(input.taskId, TASK_ID, 'conversation task preparation request.taskId');
    return this.#exclusive(taskId, async () => {
      if (this.config.conversationTaskPreparation !== true) {
        fail('CONVERSATION_TASK_PREPARATION_DISABLED', 'Conversation task preparation is not enabled.', 404);
      }
      requiredString(input.projectSlug, TASK_ID, 'conversation task preparation request.projectSlug');
      requiredString(input.actorUserId, ACTOR_USER_ID, 'conversation task preparation request.actorUserId');
      requiredString(input.actorUsername, ACTOR_USERNAME, 'conversation task preparation request.actorUsername');
      requiredString(input.conversationId, CONVERSATION_ID, 'conversation task preparation request.conversationId');
      requiredString(input.dshSessionId, DSH_ID, 'conversation task preparation request.dshSessionId');
      requiredString(input.rpcId, RPC_ID, 'conversation task preparation request.rpcId');
      requiredString(input.promptTextDigest, SHA256, 'conversation task preparation request.promptTextDigest');
      requiredString(input.expectedExecutionId, ACTOR_USER_ID, 'conversation task preparation request.expectedExecutionId');
      if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
        fail('CONVERSATION_TASK_PREPARATION_INVALID', 'expectedGeneration must be a non-negative integer.', 422);
      }
      exactKeys(input.source, ['head', 'fingerprint'], 'conversation task preparation request.source');
      requiredString(input.source.head, SOURCE_COMMIT, 'conversation task preparation request.source.head');
      requiredString(input.source.fingerprint, SHA256, 'conversation task preparation request.source.fingerprint');
      if (typeof input.promptText !== 'string' || input.promptText.length < 1
        || Buffer.byteLength(input.promptText, 'utf8') > 1024 * 1024
        || digestDirectUserTextContent([{ type: 'text', text: input.promptText }]) !== input.promptTextDigest) {
        fail('CONVERSATION_TASK_REQUEST_MISMATCH', 'Conversation task text does not match its trusted digest.', 409);
      }

      const request = await this.#readConversationTaskRequest(taskId);
      if (request === null) {
        fail('CONVERSATION_TASK_REQUEST_REQUIRED', 'No current server-authorized conversation request can prepare a task.', 409);
      }
      const identityKeys = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest'];
      if (!identityKeys.every((key) => request[key] === input[key])) {
        fail('CONVERSATION_TASK_REQUEST_MISMATCH', 'Conversation task request identity does not match the original RPC.', 409);
      }
      if (request.workspaceWriteAuthorized !== true
        || !PRODUCTION_ACTIONS.includes(request.authorizedActionCeiling)) {
        fail('CONVERSATION_TASK_CAPABILITY_DENIED', 'The original RPC did not have workspace write capability.', 403);
      }
      if (request.writableEligible !== conversationTaskWritableEligible(input.promptText)) {
        fail('CONVERSATION_TASK_REQUEST_INVALID', 'Stored conversation task eligibility does not match the original RPC.', 503);
      }
      if (request.source.head !== input.source.head) {
        fail('CONVERSATION_TASK_SOURCE_CHANGED', 'Conversation task source changed after the original RPC.', 409);
      }
      if (request.writerScopesDigest !== this.#writerScopesDigest()) {
        fail('CONVERSATION_TASK_POLICY_CHANGED', 'Conversation writer scopes changed after the original RPC.', 409);
      }
      if (Date.parse(request.expiresAt) <= this.clock().getTime()) {
        fail('CONVERSATION_TASK_REQUEST_EXPIRED', 'Conversation task preparation request has expired.', 409);
      }

      const storedScope = await this.#readConversationScope(taskId);
      let sameTaskScope = storedScope !== null
        && ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
          .every((key) => storedScope[key] === input[key])
        && storedScope.sourceCommit === input.source.head
        ? storedScope : null;
      const sourceChanged = request.source.fingerprint !== input.source.fingerprint;
      // Inspect only describes the existing scope; it does not rebind the writer
      // or authorize the edited candidate. Proposals still require the RPC source.
      const inspectPreparedScope = input.operation === 'inspect'
        && sameTaskScope?.rpcId === input.rpcId
        && sameTaskScope.promptTextDigest === input.promptTextDigest
        && sameTaskScope.implementationRequested === true
        && sameTaskScope.grantId !== null;
      if (sourceChanged && !inspectPreparedScope) {
        fail('CONVERSATION_TASK_SOURCE_CHANGED', 'Conversation task source changed after the original RPC.', 409);
      }
      const common = {
        summary: sameTaskScope === null
          ? '当前没有已准备的普通代码任务。'
          : `当前普通代码任务：${sameTaskScope.goal ?? '已保存的兼容任务范围'}`,
        currentTask: this.#conversationTaskView(sameTaskScope),
        availableScopes: structuredClone(this.config.conversationWriterScopes),
      };
      if (sourceChanged) {
        common.summary += ' 工作区源码已变化；本次仅只读查看已准备的任务范围，未刷新执行授权、源码绑定或检查准入。提交、集成和发布仍须核对当前候选及有效检查。';
      }
      if (input.operation === 'inspect') return { status: 'inspected', ...common };

      const prompt = input.promptText.trim();
      const planning = hasPlanningRequest(prompt);
      if (hasGlobalReadOnlyIntent(prompt) || CANCEL_TASK.test(prompt)) {
        fail('CONVERSATION_TASK_READ_ONLY', '当前请求明确限制为只读，不能准备代码写入。', 409);
      }
      const requestedAction = planning ? null : requestedProductionAction(prompt);
      const inheritedAction = !planning && isForgeConversationTaskContinuation(prompt)
        && sameTaskScope?.rpcId === input.rpcId
        ? sameTaskScope?.actionCeiling : undefined;
      const actionCeiling = requestedAction ?? inheritedAction ?? 'workspace-write';
      if (PRODUCTION_ACTIONS.indexOf(actionCeiling) > PRODUCTION_ACTIONS.indexOf(request.authorizedActionCeiling)) {
        fail('CONVERSATION_ACTION_NOT_AUTHORIZED', '当前用户没有本次提交或发版所需的权限。', 403);
      }
      const previousGrant = await this.readProductionTaskGrant(taskId, { allowExpired: true });
      const roleOptions = this.#conversationRoleOptions(sameTaskScope, previousGrant, input,
        input.proposal.ownedPaths, isForgeConversationTaskContinuation(prompt));
      let compiled;
      try {
        compiled = compileConversationTaskProposal({
          proposal: input.proposal,
          writerScopes: this.config.conversationWriterScopes,
          promptText: input.promptText,
          actionCeiling,
          formatMaintenanceSupported: request.conversationFormatMaintenanceSupported === true,
        }, { ...reviewCompilerOptions(request, isForgeConversationTaskContinuation(prompt) ? sameTaskScope?.dualReview : undefined),
          ...roleOptions,
          ...this.#semanticResourceOptions(input.proposal.ownedPaths),
          ...(input.backendTestBindings === undefined || request.focusedBackendVerificationSupported !== true
            || request.changedVerificationSupported !== true ? {} : { backendTestBindings: input.backendTestBindings }) });
      } catch (error) {
        fail(
          error?.code ?? 'CONVERSATION_TASK_PROPOSAL_INVALID',
          error instanceof Error ? error.message : 'Conversation task proposal is invalid.',
          error?.code === 'CONVERSATION_TASK_SCOPE_DENIED' ? 403 : 422,
        );
      }

      const checkpointScope = !planning && request.writableEligible
        ? await this.#checkpointScopeEvidence(input, sameTaskScope, compiled.contract, actionCeiling) : null;
      if (checkpointScope !== null && sameTaskScope?.sourceTransition === undefined) {
        sameTaskScope = sealRecord({ ...recordPayload(sameTaskScope),
          sourceTransition: structuredClone(checkpointScope.sourceTransition),
          sourceTransitionDigest: checkpointScope.sourceTransitionDigest,
          sourceTransitionFromFingerprint: checkpointScope.sourceTransitionFromFingerprint });
        await this.#saveConversationScope(taskId, sameTaskScope);
      }
      const restoreCheckpointScope = ['git-checkpoint', 'release'].includes(requestedAction)
        && checkpointScope !== null
        && canonicalSha256(sameTaskScope.taskProfiles) !== canonicalSha256(compiled.contract.taskProfiles);
      const restoreFrontendScope = !planning
        && await this.#restoresHistoricalFrontendScope(input, sameTaskScope, compiled.contract, requestedAction);

      // A continuation already has a claimed contract. Re-proposing files it
      // covers is a no-op, not a new contract or an attempt to widen authority.
      // Keep its requirements and accepted evidence instead of rejecting a
      // smaller repair proposal because its wording or path list differs.
      if (!planning && !restoreCheckpointScope && !restoreFrontendScope && isForgeConversationTaskContinuation(prompt)
        && sameTaskScope?.rpcId === input.rpcId && sameTaskScope.grantId !== null
        && sameTaskScope.actionCeiling === actionCeiling
        && canonicalSha256(compiled.contract.dualReview ?? null) === canonicalSha256(sameTaskScope.dualReview ?? null)
        && compiled.contract.ownedPaths.every((candidate) =>
          sameTaskScope.ownedPaths.some((root) => isForgeTaskOwnedPath(candidate, root)))
        && compiled.contract.taskProfiles.every((profile) => sameTaskScope.taskProfiles.includes(profile))) {
        const grant = await this.readProductionTaskGrant(taskId);
        if (grant?.grantId === sameTaskScope.grantId
          && compiled.contract.requiredVerificationProfiles.every((profile) =>
            grant.taskContract.requiredVerificationProfiles.includes(profile))) {
          const authorityResult = await this.#issueExecutionAuthorityUnlocked({
            projectSlug: input.projectSlug, taskId, actorUserId: input.actorUserId,
            actorUsername: input.actorUsername, conversationId: input.conversationId,
            dshSessionId: input.dshSessionId, route: 'session.prompt', rpcId: input.rpcId,
            promptText: input.promptText, promptTextDigest: input.promptTextDigest, source: input.source,
            conversationContractContinuationSupported: true,
          }, taskId);
          return {
            status: 'prepared',
            summary: '当前任务已覆盖本次修复文件，沿用原授权范围和验收要求，可直接继续。',
            currentTask: this.#conversationTaskView(sameTaskScope),
            availableScopes: common.availableScopes,
            proposalDigest: compiled.proposalDigest,
            authorityResult,
          };
        }
      }

      if (requestedAction === null && actionCeiling !== 'workspace-write'
        && (compiled.goal !== sameTaskScope?.goal
          || canonicalSha256(compiled.contract.ownedPaths) !== canonicalSha256(sameTaskScope?.ownedPaths)
          || canonicalSha256(compiled.contract.taskProfiles) !== canonicalSha256(sameTaskScope?.taskProfiles))) {
        fail('CONVERSATION_TASK_SCOPE_DENIED', '续接提交或发布必须保留当前已确认的任务目标和文件范围。', 403);
      }

      const restorePriorWork = !planning && ['git-checkpoint', 'release'].includes(requestedAction)
        && sameTaskScope?.rpcId === input.rpcId && sameTaskScope.grantId !== null
        && sameTaskScope.actionCeiling === actionCeiling
        && await this.#coversPreviouslyAuthorizedWork(input, taskId, sameTaskScope, compiled.contract);
      if (sameTaskScope?.rpcId === input.rpcId && !restorePriorWork && !restoreCheckpointScope && !restoreFrontendScope) {
        if (sameTaskScope.requestDigest !== compiled.proposalDigest
          || sameTaskScope.sourceCommit !== input.source.head) {
          fail('CONVERSATION_TASK_PROPOSAL_CONFLICT', '同一请求已经绑定不同的任务范围提案。', 409);
        }
        if (sameTaskScope.grantId === null) {
          return {
            status: 'needs-confirmation',
            summary: '已保存任务范围方案，等待用户明确确认执行。',
            currentTask: this.#conversationTaskView(sameTaskScope),
            availableScopes: common.availableScopes,
            proposalDigest: compiled.proposalDigest,
            idempotent: true,
          };
        }
        const authorityResult = await this.#issueExecutionAuthorityUnlocked({
          projectSlug: input.projectSlug,
          taskId,
          actorUserId: input.actorUserId,
          actorUsername: input.actorUsername,
          conversationId: input.conversationId,
          dshSessionId: input.dshSessionId,
          route: 'session.prompt',
          rpcId: input.rpcId,
          promptText: input.promptText,
          promptTextDigest: input.promptTextDigest,
          source: input.source,
        }, taskId);
        await this.#bindPreparedConversationContract(input, taskId, compiled.contract, authorityResult);
        return {
          status: 'prepared',
          summary: '已按实际文件准备普通代码任务写入授权。',
          currentTask: this.#conversationTaskView(sameTaskScope),
          availableScopes: common.availableScopes,
          proposalDigest: compiled.proposalDigest,
          authorityResult,
        };
      }

      const needsConfirmation = planning || !request.writableEligible;
      // This is existing issuer-bound source evidence, not new release authority.
      // Re-proposing the exact candidate must not discard its same-content proof.
      const checkpoint = checkpointScope?.sourceTransition;
      const retainCheckpoint = !needsConfirmation && sameTaskScope?.implementationRequested === true
        && sameTaskScope.grantId !== null && checkpointScope !== null
        && canonicalSha256(sameTaskScope.ownedPaths) === canonicalSha256(compiled.contract.ownedPaths)
        && canonicalSha256(checkpointScope.taskProfiles) === canonicalSha256(compiled.contract.taskProfiles)
        && ['checkpointed', 'integrated'].includes(checkpoint?.phase)
        && checkpoint.from.fingerprint === checkpoint.to.fingerprint
        && checkpoint.to.head === input.source.head && checkpoint.to.fingerprint === input.source.fingerprint;
      const acceptedApiContract = request.completedApiContract ?? sameTaskScope?.acceptedApiContract;
      const scope = sealRecord({
        schemaVersion: 1,
        projectSlug: input.projectSlug,
        taskId,
        actorUserId: input.actorUserId,
        actorUsername: input.actorUsername,
        conversationId: input.conversationId,
        dshSessionId: input.dshSessionId,
        sourceCommit: input.source.head,
        ownedPaths: [...compiled.contract.ownedPaths],
        taskProfiles: [...compiled.contract.taskProfiles],
        ...(compiled.contract.dualReview === undefined ? {} : { dualReview: compiled.contract.dualReview }),
        ...(compiled.contract.roleGrantDecisions === undefined ? {} : { roleGrantDecisions: compiled.contract.roleGrantDecisions }),
        implementationRequested: !needsConfirmation,
        actionCeiling,
        promptTextDigest: input.promptTextDigest,
        rpcId: input.rpcId,
        requestDigest: compiled.proposalDigest,
        grantId: null,
        goal: compiled.goal,
        ...(acceptedApiContract === undefined ? {} : { acceptedApiContract: normalizeAcceptedApiContract(acceptedApiContract) }),
        ...(retainCheckpoint ? {
          sourceTransition: structuredClone(checkpoint),
          sourceTransitionDigest: sameTaskScope.sourceTransitionDigest,
          sourceTransitionFromFingerprint: sameTaskScope.sourceTransitionFromFingerprint,
        } : {}),
      });
      if (needsConfirmation) {
        await this.#saveConversationScope(taskId, scope);
        return {
          status: 'needs-confirmation',
          summary: '已保存任务范围方案，等待用户明确确认执行。',
          currentTask: this.#conversationTaskView(scope),
          availableScopes: common.availableScopes,
          proposalDigest: compiled.proposalDigest,
          idempotent: false,
        };
      }

      const issued = createProductionTaskGrant({
        now: this.clock().getTime(),
        ...reviewCompilerOptions(request),
        ...(compiled.contract.semanticResources === undefined ? {} : { semanticResources: compiled.contract.semanticResources }),
        ...(compiled.contract.dualReview === undefined ? {} : { dualReview: compiled.contract.dualReview }),
        ...(compiled.contract.roleGrantDecisions === undefined ? {} : { roleGrantDecisions: compiled.contract.roleGrantDecisions }),
        ...(compiled.contract.backendTestBindings === undefined ? {} : { backendTestBindings: compiled.contract.backendTestBindings }),
        spec: {
          schemaVersion: 1,
          projectSlug: input.projectSlug,
          taskId,
          actorUserId: input.actorUserId,
          actorUsername: input.actorUsername,
          conversationId: input.conversationId,
          dshSessionId: input.dshSessionId,
          promptText: input.promptText,
          sourceCommit: input.source.head,
          workspaceFingerprint: input.source.fingerprint,
          ownedPaths: compiled.contract.ownedPaths,
          taskProfiles: compiled.contract.taskProfiles,
          actionCeiling,
          ttlSeconds: Math.min(900, this.config.contractTtlSeconds),
        },
      });
      if (previousGrant !== null) {
        await this.#saveConversationRecord(
          'production-task-grants-history',
          `${taskId}.${previousGrant.grantId}.${previousGrant.recordDigest}`,
          previousGrant,
          { archive: true },
        );
      }
      await this.#saveConversationRecord(
        'production-task-grant-receipts',
        issued.grant.grantId,
        issued.receipt,
        { archive: true },
      );
      await this.writeProductionTaskGrant(issued.grant);
      const preparedScope = sealRecord({ ...recordPayload(scope), grantId: issued.grant.grantId });
      await this.#saveConversationScope(taskId, preparedScope);
      const authorityResult = await this.#issueExecutionAuthorityUnlocked({
        projectSlug: input.projectSlug,
        taskId,
        actorUserId: input.actorUserId,
        actorUsername: input.actorUsername,
        conversationId: input.conversationId,
        dshSessionId: input.dshSessionId,
        route: 'session.prompt',
        rpcId: input.rpcId,
        promptText: input.promptText,
        promptTextDigest: input.promptTextDigest,
        source: input.source,
      }, taskId);
      if (authorityResult.authority === null
        || authorityResult.trustedPolicyInput?.profile !== 'production-controller'
        || authorityResult.trustedPolicyInput?.taskAuthority?.actionCeiling !== actionCeiling) {
        fail('CONVERSATION_TASK_AUTHORITY_INVALID', 'Prepared task grant did not produce writer authority.', 503);
      }
      await this.#bindPreparedConversationContract(input, taskId, compiled.contract, authorityResult);
      return {
        status: 'prepared',
        summary: '已按实际文件准备普通代码任务写入授权。',
        currentTask: this.#conversationTaskView(preparedScope),
        availableScopes: common.availableScopes,
        proposalDigest: compiled.proposalDigest,
        authorityResult,
      };
    });
  }

  async issueContract(input) {
    const hasExecutionAuthority = Object.hasOwn(input, 'executionAuthority');
    exactKeys(input, [
      'acceptanceSpec', 'authorId', 'source', 'taskContract', 'taskId',
      ...(hasExecutionAuthority ? ['executionAuthority'] : []),
    ], 'contract request');
    if (hasExecutionAuthority) {
      exactKeys(input.executionAuthority, [
        'controllerGrantDigest', 'productionAuthorityDigest', 'productionAuthorityId', 'rpcId',
      ], 'contract request.executionAuthority');
      requiredString(input.executionAuthority.rpcId, RPC_ID, 'contract request.executionAuthority.rpcId');
      requiredString(input.executionAuthority.productionAuthorityId, ACTOR_USER_ID, 'contract request.executionAuthority.productionAuthorityId');
      requiredString(input.executionAuthority.productionAuthorityDigest, SHA256, 'contract request.executionAuthority.productionAuthorityDigest');
      requiredString(input.executionAuthority.controllerGrantDigest, SHA256, 'contract request.executionAuthority.controllerGrantDigest');
    }
    const taskId = requiredString(input.taskId, TASK_ID, 'contract request.taskId');
    return this.#exclusive(taskId, () => this.#issueContractUnlocked(input, taskId));
  }

  async #authorizedRebindGrant(existing, input, taskId) {
    const renewableCandidate = input.executionAuthority !== undefined
      && canonicalSha256(existing.taskContract) === canonicalSha256(input.taskContract)
      && existing.acceptanceContract.candidate.authorId === input.authorId
      && canonicalSha256(existing.acceptanceContract.requiredObligations) === canonicalSha256(input.acceptanceSpec.requiredObligations)
      && canonicalSha256(existing.acceptanceContract.requiredDimensions) === canonicalSha256(input.acceptanceSpec.requiredDimensions)
      && (existing.acceptanceContract.candidate.source.head !== input.source.head
        || existing.acceptanceContract.candidate.source.fingerprint !== input.source.fingerprint
        || Date.parse(existing.acceptanceContract.expiresAt) <= this.clock().getTime());
    if (!renewableCandidate) return null;

    const grant = await this.readProductionTaskGrant(taskId);
    const exactCurrentClaim = grant !== null
      && grant.claim !== null
      && grant.projectSlug === this.config.projectSlug
      && grant.taskId === taskId
      && grant.actorUserId === input.authorId
      && grant.sourceCommit === input.source.head
      && grant.workspaceFingerprint === input.source.fingerprint
      && grant.claim.rpcId === input.executionAuthority.rpcId
      && grant.claim.productionAuthorityId === input.executionAuthority.productionAuthorityId
      && grant.claim.productionAuthorityDigest === input.executionAuthority.productionAuthorityDigest
      && grant.grantDigest === input.executionAuthority.controllerGrantDigest
      && Date.parse(grant.claim.claimedAt) >= Date.parse(existing.acceptanceContract.issuedAt)
      && canonicalSha256(grant.taskContract) === canonicalSha256(input.taskContract);
    return exactCurrentClaim ? grant : null;
  }

  #sourceProvenancePolicy(record) {
    // Only operator-owned service configuration can supply reviewed origins.
    // Neither a model selector nor the writable task tree is an authority.
    const item = this.config.sourceProvenancePolicies?.find(item => item.taskId === record.taskId);
    if (item === undefined) return undefined;
    const policy = normalizeReferenceProvenancePolicy(item.policy);
    const reviewedFiles = item.contractBinding === 'reviewed-files';
    const exactReviewedScope = record.taskContract.actionCeiling === 'workspace-write'
      && canonicalSha256([...record.taskContract.ownedPaths].sort())
        === canonicalSha256(policy.files.map(file => file.path).sort());
    if ((!reviewedFiles && policy.contractId !== record.taskContract.contractId)
      || (reviewedFiles && !exactReviewedScope)
      || policy.head !== record.acceptanceContract.candidate.source.head
      || governanceTaskScopeForContract(record.taskContract) === undefined) {
      fail('ACCEPTANCE_SOURCE_PROVENANCE_STALE', 'The configured source review must be refreshed for this protected task candidate.', 409);
    }
    // An explicit operator review can follow a new request for the exact files.
    // Retain the original review, origin/licence decisions, base and byte hashes;
    // Host governance must still verify all of them against the actual snapshot.
    // This does not turn a matching path or HEAD into proof that content passed.
    return reviewedFiles ? { ...policy, contractId: record.taskContract.contractId } : policy;
  }

  #reviewedReceiptSourcePolicies(record) {
    const binding = {
      governanceTaskScope: governanceTaskScopeForContract(record.taskContract),
      governanceRoleGrantPolicy: governanceRoleGrantPolicyForContract(record.taskContract),
      governanceSourceProvenancePolicy: this.#sourceProvenancePolicy(record),
      governanceAcceptedApiContract: record.acceptedApiContract,
    };
    const source = record.acceptanceContract.candidate.source;
    return (this.config.reviewedReceiptSourceProjections ?? []).filter(policy => {
      validateReviewedReceiptSourcePolicy(policy);
      return policy.projectSlug === this.config.projectSlug && policy.taskId === record.taskId
        && policy.head === source.head && policy.currentFingerprint === source.fingerprint
        && policy.governanceBindingSha256 === reviewedReceiptGovernanceBindingDigest(binding)
        && canonicalSha256(policy.scopeFiles.map(item => item.path)) === canonicalSha256(binding.governanceTaskScope?.ownedPaths ?? null);
    });
  }

  #candidateResult(record, idempotent) {
    const governanceTaskScope = governanceTaskScopeForContract(record.taskContract);
    const governanceRoleGrantPolicy = governanceRoleGrantPolicyForContract(record.taskContract);
    const governanceSourceProvenancePolicy = this.#sourceProvenancePolicy(record);
    const reviewedReceiptSourceProjections = this.#reviewedReceiptSourcePolicies(record);
    return {
      acceptanceContract: record.acceptanceContract,
      ...(governanceTaskScope === undefined ? {} : { governanceTaskScope }),
      ...(governanceRoleGrantPolicy === undefined ? {} : { governanceRoleGrantPolicy }),
      ...(governanceSourceProvenancePolicy === undefined ? {} : { governanceSourceProvenancePolicy }),
      ...(record.acceptedApiContract === undefined ? {} : { governanceAcceptedApiContract: record.acceptedApiContract }),
      ...(reviewedReceiptSourceProjections.length === 0 ? {} : { reviewedReceiptSourceProjections: structuredClone(reviewedReceiptSourceProjections) }),
      trustPolicy: this.trustPolicy,
      ledgerSummary: summarizeForgeObligationLedger(
        restoreForgeObligationLedger(record.ledger, record.taskContract, record.acceptanceContract),
      ),
      idempotent,
    };
  }

  #nextReviewPredecessor(existing, taskContract, authorId) {
    if (existing?.acceptanceContract.dualReview === undefined) return undefined;
    validateAcceptanceContract(existing.acceptanceContract, this.trustPolicy);
    const reviews = existing.receipts.filter(item => item.kind === 'semanticReview' && item.receipt.review.dualReview !== undefined);
    const rejection = reviews.filter(item => item.receipt.review.decision === 'rejected').at(-1)?.receipt;
    let previousReview = existing.acceptanceContract.previousReview;
    if (rejection !== undefined) {
      verifyAcceptanceEvidenceReceipt({ contract: existing.acceptanceContract, trustPolicy: this.trustPolicy,
        receipt: rejection, kind: 'semanticReview', evaluatedAt: rejection.issuedAt });
      const proof = rejection.review.dualReview;
      const findings = new Map(proof.findings.filter(finding => finding.severity === 'blocking')
        .map(finding => [forgeReviewFindingDigest(finding), finding]));
      for (const resolution of proof.findingResolutions.filter(item => item.status === 'open')) {
        const original = previousReview?.findings.find(item => item.findingSha256 === resolution.findingSha256);
        if (original === undefined) fail('ACCEPTANCE_STATE_INVALID', 'Unresolved review finding lost its protected source.', 503);
        findings.set(original.findingSha256, original.finding);
      }
      const entries = [...findings].sort(([a], [b]) => a.localeCompare(b, 'en'));
      previousReview = validateForgeReviewPredecessor({ binding: { reviewId: rejection.receiptId,
        packageSha256: proof.package.integrity.canonicalSha256, head: rejection.source.head,
        blockingFindings: entries.map(([id]) => id) },
      findings: entries.map(([findingSha256, finding]) => ({ findingSha256, finding })) });
    } else if (reviews.length > 0) {
      for (const { receipt } of reviews) verifyAcceptanceEvidenceReceipt({ contract: existing.acceptanceContract,
        trustPolicy: this.trustPolicy, receipt, kind: 'semanticReview', evaluatedAt: receipt.issuedAt });
      previousReview = undefined;
    }
    if (previousReview !== undefined && (taskContract.dualReview === undefined
      || existing.acceptanceContract.candidate.authorId !== authorId)) {
      fail('ACCEPTANCE_REVIEW_REPAIR_REQUIRED', '当前任务尚有真实独审拒绝，不能通过去掉双评审或替换作者跳过原问题。', 409);
    }
    return previousReview === undefined ? undefined : structuredClone(previousReview);
  }

  async #reviewPredecessorForTask(taskId, existing, taskContract, authorId) {
    // A chat can move to an unrelated task while a rejected candidate remains
    // in its protected history. Read that history again when its scope returns.
    const records = existing === null ? [] : [existing];
    for await (const record of this.#archivedTaskRecords(taskId)) records.push(record);
    const reviews = new Map();
    for (const record of records) {
      if (record.acceptanceContract.dualReview === undefined) continue;
      validateAcceptanceContract(record.acceptanceContract, this.trustPolicy);
      for (const { kind, receipt } of record.receipts) {
        if (kind !== 'semanticReview') continue;
        verifyAcceptanceEvidenceReceipt({ contract: record.acceptanceContract, trustPolicy: this.trustPolicy,
          receipt, kind, evaluatedAt: receipt.issuedAt });
        if (receipt.review.dualReview === undefined) continue;
        const prior = reviews.get(receipt.receiptId);
        if (prior !== undefined && canonicalSha256(prior.receipt) !== canonicalSha256(receipt)) {
          fail('ACCEPTANCE_STATE_INVALID', 'Protected review history contains conflicting receipts.', 503);
        }
        reviews.set(receipt.receiptId, { record, receipt });
      }
    }
    const superseded = new Set();
    for (const { receipt } of reviews.values()) {
      const predecessor = receipt.review.dualReview.package.previousReview;
      if (predecessor === null) continue;
      const prior = reviews.get(predecessor.reviewId)?.receipt;
      if (prior === undefined || prior.review.dualReview.package.integrity.canonicalSha256 !== predecessor.packageSha256) {
        fail('ACCEPTANCE_STATE_INVALID', 'Protected review predecessor is missing or inconsistent.', 503);
      }
      superseded.add(predecessor.reviewId);
    }
    const overlapping = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    const relevant = new Map();
    for (const { record, receipt } of reviews.values()) {
      if (receipt.review.decision !== 'rejected' || superseded.has(receipt.receiptId)) continue;
      const predecessor = this.#nextReviewPredecessor(record, record.taskContract, record.acceptanceContract.candidate.authorId);
      if (predecessor === undefined) continue;
      const previousPaths = [...record.taskContract.ownedPaths, ...predecessor.findings.map(item => item.finding.path)];
      const sameBinding = taskContract.dualReview?.sourcePath === record.acceptanceContract.dualReview.sourcePath;
      if (sameBinding || taskContract.ownedPaths.length === 0 || record.taskContract.ownedPaths.length === 0
        || taskContract.ownedPaths.some(current => previousPaths.some(previous => overlapping(current, previous)))) {
        relevant.set(predecessor.binding.reviewId, record);
      }
    }
    if (relevant.size > 1) {
      fail('ACCEPTANCE_REVIEW_REPAIR_REQUIRED', '本次范围涉及多个尚未关闭的独审拒绝，请分别续接原修复任务；不能丢弃其中的问题。', 409);
    }
    return relevant.size === 0 ? undefined : this.#nextReviewPredecessor(relevant.values().next().value, taskContract, authorId);
  }

  async #replaceExistingCandidate(existing, source, mutationId, sourceAuthorityBinding = null, apiOverride) {
    let ledger = createForgeObligationLedger(existing.taskContract);
    if (source.fingerprint !== ledger.sourceFingerprint) {
      ledger = advanceForgeObligationLedgerSource(ledger, {
        sourceFingerprint: source.fingerprint,
        mutationId,
      });
    }
    const now = this.clock();
    const expiresAt = new Date(Math.min(
      now.getTime() + this.config.contractTtlSeconds * 1000,
      Date.parse(this.trustPolicy.expiresAt) - 1,
    ));
    const previousContract = existing.acceptanceContract;
    const previousReview = this.#nextReviewPredecessor(existing, existing.taskContract, previousContract.candidate.authorId);
    const acceptanceContract = signAcceptanceDocument({
      schemaVersion: 1,
      contractType: ACCEPTANCE_DOCUMENT_TYPES.contract,
      contractId: previousContract.contractId,
      projectSlug: this.config.projectSlug,
      taskId: existing.taskId,
      candidate: {
        authorId: previousContract.candidate.authorId,
        source: structuredClone(source),
        diffSha256: canonicalSha256({ head: source.head, workspaceFingerprint: source.fingerprint }),
      },
      requiredGovernanceProfile: previousContract.requiredGovernanceProfile,
      requiredProfiles: previousContract.requiredProfiles,
      requiredObligations: previousContract.requiredObligations,
      requiredDimensions: previousContract.requiredDimensions,
      ...(previousContract.dualReview === undefined ? {} : { dualReview: previousContract.dualReview }),
      ...(previousReview === undefined ? {} : { previousReview }),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }, this.signers.platform);
    validateAcceptanceContract(acceptanceContract, this.trustPolicy);
    const retained = recordPayload(existing);
    if (apiOverride !== undefined) {
      delete retained.acceptedApiContract;
      if (apiOverride.acceptedApiContract !== undefined) retained.acceptedApiContract = apiOverride.acceptedApiContract;
    }
    const record = sealRecord({
      ...retained,
      acceptanceContract,
      ledger: serializeForgeObligationLedger(ledger),
      receipts: [],
      ...(Object.hasOwn(existing, 'diagnosticReceipts') ? { diagnosticReceipts: [] } : {}),
      signedVerdict: null,
      sourceAuthorityBinding,
      updatedAt: now.toISOString(),
    });
    await this.#saveConversationRecord(
      'tasks-history',
      `${existing.taskId}.${existing.recordDigest.replace(/^sha256:/u, '')}`,
      existing,
      { archive: true },
    );
    await this.writeRecord(record);
    return this.#candidateResult(record, false);
  }

  async bindCandidate(input) {
    exactKeys(input, ['admissionReceipt', 'candidateBinding', 'contractId', 'taskId'], 'candidate binding request');
    const taskId = requiredString(input.taskId, TASK_ID, 'candidate binding request.taskId');
    return this.#exclusive(taskId, async () => {
      const result = await this.#bindCandidateUnlocked(input, taskId);
      const sourceTransition = await this.#checkpointTransitionForBinding(taskId, input.candidateBinding, input.admissionReceipt.source);
      return { ...result, ...(sourceTransition === null ? {} : { sourceTransition }) };
    });
  }

  async #checkpointTransitionForBinding(taskId, binding, source) {
    const scope = await this.#readConversationScope(taskId);
    const transition = scope?.sourceTransition;
    if (transition === undefined || !['checkpointed', 'integrated'].includes(transition.phase)
      || transition.from.fingerprint !== transition.to.fingerprint || binding === null || binding === undefined
      || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId']
        .every((key) => scope[key] === binding[key])
      || scope.sourceCommit !== source.head || transition.to.head !== source.head
      || transition.to.fingerprint !== source.workspaceFingerprint
      || scope.actionCeiling !== binding.actionCeiling) return null;
    return structuredClone(transition);
  }

  async #bindCandidateUnlocked(input, taskId) {
    requiredString(input.contractId, SHA256, 'candidate binding request.contractId');
    const binding = input.candidateBinding;
    exactKeys(binding, [
      'actionCeiling', 'actorUserId', 'actorUsername', 'authorityClass',
      'authorityWorkspaceFingerprint', 'contractId', 'controllerGrantDigest',
      'conversationId', 'dshSessionId', 'executionId', 'generation', 'productionAuthorityDigest',
      'productionAuthorityId', 'projectSlug', 'rpcId', 'sourceCommit', 'taskId',
    ], 'candidateBinding');
    requiredString(binding.projectSlug, SAFE_ID, 'candidateBinding.projectSlug');
    requiredString(binding.taskId, TASK_ID, 'candidateBinding.taskId');
    requiredString(binding.actorUserId, ACTOR_USER_ID, 'candidateBinding.actorUserId');
    requiredString(binding.actorUsername, ACTOR_USERNAME, 'candidateBinding.actorUsername');
    requiredString(binding.conversationId, CONVERSATION_ID, 'candidateBinding.conversationId');
    requiredString(binding.dshSessionId, DSH_ID, 'candidateBinding.dshSessionId');
    requiredString(binding.executionId, ACTOR_USER_ID, 'candidateBinding.executionId');
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
      fail('ACCEPTANCE_SCHEMA_INVALID', 'candidateBinding.generation is invalid.');
    }
    requiredString(binding.rpcId, RPC_ID, 'candidateBinding.rpcId');
    requiredString(binding.contractId, SHA256, 'candidateBinding.contractId');
    requiredString(binding.sourceCommit, SOURCE_COMMIT, 'candidateBinding.sourceCommit');
    requiredString(binding.authorityWorkspaceFingerprint, SHA256, 'candidateBinding.authorityWorkspaceFingerprint');
    requiredString(binding.productionAuthorityId, ACTOR_USER_ID, 'candidateBinding.productionAuthorityId');
    requiredString(binding.productionAuthorityDigest, SHA256, 'candidateBinding.productionAuthorityDigest');
    requiredString(binding.controllerGrantDigest, SHA256, 'candidateBinding.controllerGrantDigest');
    if (binding.authorityClass !== 'production-task-writer' || !PRODUCTION_ACTIONS.includes(binding.actionCeiling)) {
      fail('ACCEPTANCE_CANDIDATE_BINDING_FORBIDDEN', 'Candidate binding requires production workspace-write authority.', 403);
    }

    const record = await this.readRecord(taskId);
    let admission;
    try {
      admission = validateHostExecutionAdmissionReceipt(input.admissionReceipt, {
        projectSlug: this.config.projectSlug,
        taskId,
        observedAt: this.clock().toISOString(),
      }).receipt;
    } catch (error) {
      fail('ACCEPTANCE_CANDIDATE_ADMISSION_INVALID', error?.message ?? 'Host admission receipt is invalid.');
    }
    const grant = await this.readProductionTaskGrant(taskId);
    const exactCurrentClaim = grant !== null && grant.claim !== null
      && binding.projectSlug === this.config.projectSlug
      && binding.taskId === taskId
      && input.contractId === binding.contractId
      && binding.contractId === record.acceptanceContract.contractId
      && grant.projectSlug === binding.projectSlug
      && grant.taskId === binding.taskId
      && grant.actorUserId === binding.actorUserId
      && grant.actorUsername === binding.actorUsername
      && grant.conversationId === binding.conversationId
      && grant.dshSessionId === binding.dshSessionId
      && grant.claim.rpcId === binding.rpcId
      && grant.sourceCommit === binding.sourceCommit
      && grant.workspaceFingerprint === binding.authorityWorkspaceFingerprint
      && grant.claim.productionAuthorityId === binding.productionAuthorityId
      && grant.claim.productionAuthorityDigest === binding.productionAuthorityDigest
      && grant.grantDigest === binding.controllerGrantDigest
      && grant.actionCeiling === binding.actionCeiling
      && grant.taskContract.contractId === binding.contractId
      && canonicalSha256(grant.taskContract) === canonicalSha256(record.taskContract)
      && record.acceptanceContract.candidate.authorId === binding.actorUserId
      && record.acceptanceContract.candidate.source.head === binding.sourceCommit
      && admission.source.head === binding.sourceCommit;
    if (!exactCurrentClaim) {
      fail('ACCEPTANCE_CANDIDATE_BINDING_MISMATCH', 'Candidate binding does not match the current claimed production grant.', 409);
    }

    const scope = await this.#readConversationScope(taskId);
    let acceptedApiContract;
    if (scope?.acceptedApiContract !== undefined) {
      acceptedApiContract = normalizeAcceptedApiContract(scope.acceptedApiContract);
      if (scope.grantId !== grant.grantId || acceptedApiContract.taskId !== taskId
        || acceptedApiContract.sourceCommit !== binding.sourceCommit
        || ['projectSlug', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'sourceCommit']
          .some(key => scope[key] !== grant[key])) {
        fail('ACCEPTANCE_CANDIDATE_BINDING_MISMATCH', 'Accepted APIs are not bound to the current production grant.', 409);
      }
    }
    const apiChanged = canonicalSha256(record.acceptedApiContract ?? null) !== canonicalSha256(acceptedApiContract ?? null);

    const observedAt = this.clock().getTime();
    if (observedAt < Date.parse(record.acceptanceContract.issuedAt)) {
      fail('ACCEPTANCE_CANDIDATE_CONTRACT_EXPIRED', 'Candidate binding requires a current acceptance contract.', 409);
    }
    if (observedAt >= Date.parse(record.acceptanceContract.expiresAt)) {
      if (Date.parse(admission.issuedAt) < Date.parse(record.acceptanceContract.issuedAt)) {
        fail('ACCEPTANCE_CANDIDATE_ADMISSION_STALE', 'Host admission predates the current candidate binding.', 409);
      }
      // The current claimed grant may have renewed before candidate expiry.
      // Its valid authority and current Host admission open a new candidate window;
      // expired receipts are archived, never changed into passes.
      return this.#replaceExistingCandidate(record,
        { head: admission.source.head, fingerprint: admission.source.workspaceFingerprint },
        `renewed-admission:${admission.admissionId}`, structuredClone(binding), { acceptedApiContract });
    }

    const source = { head: admission.source.head, fingerprint: admission.source.workspaceFingerprint };
    if (source.head === record.acceptanceContract.candidate.source.head
      && source.fingerprint === record.acceptanceContract.candidate.source.fingerprint) {
      const sourceAuthorityBinding = structuredClone(binding);
      if (record.sourceAuthorityBinding !== undefined
        && canonicalSha256(record.sourceAuthorityBinding) === canonicalSha256(sourceAuthorityBinding) && !apiChanged) {
        return this.#candidateResult(record, true);
      }
      const fields = recordPayload(record);
      delete fields.acceptedApiContract;
      const updated = sealRecord({
        ...fields, ...(acceptedApiContract === undefined ? {} : { acceptedApiContract }),
        sourceAuthorityBinding, updatedAt: this.clock().toISOString(),
      });
      await this.writeRecord(updated);
      return this.#candidateResult(updated, false);
    }
    if (Date.parse(admission.issuedAt) < Date.parse(record.acceptanceContract.issuedAt)) {
      fail('ACCEPTANCE_CANDIDATE_ADMISSION_STALE', 'Host admission predates the current candidate binding.', 409);
    }
    return this.#replaceExistingCandidate(
      record,
      source,
      `host-admission:${admission.admissionId}`,
      structuredClone(binding),
      { acceptedApiContract },
    );
  }

  async #issueContractUnlocked(input, taskId) {
    requiredString(input.authorId, SAFE_ID, 'contract request.authorId');
    exactKeys(input.source, ['fingerprint', 'head'], 'contract request.source');
    requiredString(input.source.head, /^[0-9a-f]{40,64}$/u, 'contract request.source.head');
    requiredString(input.source.fingerprint, SHA256, 'contract request.source.fingerprint');
    const initialLedger = createForgeObligationLedger(input.taskContract);
    if (input.taskContract.contractId !== initialLedger.taskContractId
      || input.taskContract.sourceFingerprint !== initialLedger.sourceFingerprint) fail('ACCEPTANCE_CONTRACT_MISMATCH', 'Task contract identity is inconsistent.');
    let ledger = input.source.fingerprint === initialLedger.sourceFingerprint
      ? initialLedger
      : advanceForgeObligationLedgerSource(initialLedger, {
        sourceFingerprint: input.source.fingerprint,
        mutationId: `controlled-source:${input.taskContract.contractId}`,
      });
    exactKeys(input.acceptanceSpec, ['requiredDimensions', 'requiredObligations'], 'acceptanceSpec');
    const requiredProfiles = input.taskContract.requiredVerificationProfiles.filter((item) => item !== 'governance');
    if (requiredProfiles.some((item) => !this.config.allowedVerificationProfiles.includes(item))) fail('ACCEPTANCE_PROFILE_NOT_ALLOWED', 'Task contract requests an unapproved verification profile.');
    if (!Array.isArray(input.acceptanceSpec.requiredObligations) || input.acceptanceSpec.requiredObligations.length === 0) fail('ACCEPTANCE_SCHEMA_INVALID', 'Acceptance obligations are required.');
    const expectedIds = [...input.taskContract.requiredObligations].sort();
    const actualIds = input.acceptanceSpec.requiredObligations.map((item) => item?.id).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) fail('ACCEPTANCE_CONTRACT_MISMATCH', 'Acceptance obligations must exactly match the task contract.');
    const existing = await this.readRecord(taskId).catch((error) => {
      if (error instanceof AcceptanceServiceError && error.code === 'ACCEPTANCE_RECORD_NOT_FOUND') return null;
      throw error;
    });
    if (existing?.acceptanceContract.contractId === input.taskContract.contractId) {
      const same = canonicalSha256(existing.taskContract) === canonicalSha256(input.taskContract)
        && existing.acceptanceContract.candidate.authorId === input.authorId
        && existing.acceptanceContract.candidate.source.head === input.source.head
        && existing.acceptanceContract.candidate.source.fingerprint === input.source.fingerprint
        && canonicalSha256(existing.acceptanceContract.requiredObligations) === canonicalSha256(input.acceptanceSpec.requiredObligations)
        && canonicalSha256(existing.acceptanceContract.requiredDimensions) === canonicalSha256(input.acceptanceSpec.requiredDimensions);
      if (same && Date.parse(existing.acceptanceContract.expiresAt) > this.clock().getTime()) {
        return {
          acceptanceContract: existing.acceptanceContract,
          trustPolicy: this.trustPolicy,
          ledgerSummary: summarizeForgeObligationLedger(restoreForgeObligationLedger(existing.ledger, existing.taskContract, existing.acceptanceContract)),
          idempotent: true,
        };
      }
      const rebindGrant = await this.#authorizedRebindGrant(existing, input, taskId);
      if (rebindGrant === null) {
        fail('ACCEPTANCE_CONTRACT_CONFLICT', 'An acceptance contract with this identity is already bound to different facts.', 409);
      }
      return this.#replaceExistingCandidate(
        existing,
        input.source,
        `production-authority:${rebindGrant.claim.productionAuthorityId}`,
      );
    }
    const previousReview = await this.#reviewPredecessorForTask(taskId, existing, input.taskContract, input.authorId);
    const now = this.clock();
    const expiresAt = new Date(Math.min(
      now.getTime() + this.config.contractTtlSeconds * 1000,
      Date.parse(this.trustPolicy.expiresAt) - 1,
    ));
    const acceptanceContract = signAcceptanceDocument({
      schemaVersion: 1,
      contractType: ACCEPTANCE_DOCUMENT_TYPES.contract,
      contractId: input.taskContract.contractId,
      projectSlug: this.config.projectSlug,
      taskId,
      candidate: {
        authorId: input.authorId,
        source: structuredClone(input.source),
        diffSha256: canonicalSha256({ head: input.source.head, workspaceFingerprint: input.source.fingerprint }),
      },
      requiredGovernanceProfile: 'governance',
      requiredProfiles,
      requiredObligations: input.acceptanceSpec.requiredObligations,
      requiredDimensions: input.acceptanceSpec.requiredDimensions,
      ...(input.taskContract.dualReview === undefined ? {} : { dualReview: input.taskContract.dualReview }),
      ...(previousReview === undefined ? {} : { previousReview }),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }, this.signers.platform);
    validateAcceptanceContract(acceptanceContract, this.trustPolicy);
    const record = sealRecord({
      schemaVersion: 1,
      recordType: RECORD_TYPE,
      taskId,
      taskContract: input.taskContract,
      acceptanceContract,
      ledger: serializeForgeObligationLedger(ledger),
      receipts: [],
      signedVerdict: null,
      sourceAuthorityBinding: null,
      updatedAt: now.toISOString(),
    });
    if (existing !== null) {
      // Keep prior receipts as history. Source advance makes their closures
      // stale; the new candidate starts without receipts or a signed verdict.
      await this.#saveConversationRecord('tasks-history', `${taskId}.${existing.recordDigest.replace(/^sha256:/u, '')}`, existing, { archive: true });
    }
    await this.writeRecord(record);
    return { acceptanceContract, trustPolicy: this.trustPolicy, ledgerSummary: summarizeForgeObligationLedger(ledger), idempotent: false };
  }

  async #appendReceipt(record, kind, receipt) {
    const observedAt = this.clock().getTime();
    if (observedAt < Date.parse(record.acceptanceContract.issuedAt)
      || observedAt >= Date.parse(record.acceptanceContract.expiresAt)) {
      // A completed check can outlive its candidate. Keep the original result
      // recoverable through current admission and protected revalidation.
      fail('ACCEPTANCE_CANDIDATE_CONTRACT_EXPIRED', 'Candidate binding requires a current acceptance contract.', 409);
    }
    const existing = record.receipts.some((item) => item.receipt.receiptId === receipt.receiptId);
    let ledger = restoreForgeObligationLedger(record.ledger, record.taskContract, record.acceptanceContract);
    const closedObligationIds = new Set(summarizeForgeObligationLedger(ledger).closed.map((item) => item.id));
    const obligationIds = [
      ...(kind === 'governance' ? ['verification:governance'] : [`verification:${receipt.profile}`]),
      ...receipt.obligations.map((id) => `contract:${id}`),
    ].filter((id) => ledger.definitions.some((definition) => definition.id === id)
      && !closedObligationIds.has(id));
    if (!existing && receipt.status === 'passed' && obligationIds.length > 0) {
      ledger = applyProtectedIssuerReceipt({
        ledger,
        taskContract: record.taskContract,
        acceptanceContract: record.acceptanceContract,
        trustPolicy: this.trustPolicy,
        receipt,
        kind,
        evaluatedAt: this.clock().toISOString(),
        obligationIds,
      }).ledger;
    }
    // Re-evaluate retained evidence on idempotent resubmission too, without
    // appending it or changing its order relative to a later real failure.
    const receipts = existing ? record.receipts : [...record.receipts, { kind, receipt }];
    const acceptanceInput = {
      contract: record.acceptanceContract,
      current: {
        source: record.acceptanceContract.candidate.source,
        candidateDiffSha256: record.acceptanceContract.candidate.diffSha256,
        observedAt: this.clock().toISOString(),
      },
      ...currentAcceptanceEvidence(receipts),
    };
    let signedVerdict = null;
    try {
      const verdict = aggregateAcceptance(acceptanceInput, { trustPolicy: this.trustPolicy, verdictSigner: this.signers.verdict });
      if (verdict.signature?.algorithm === 'Ed25519') signedVerdict = verdict;
    } catch {
      signedVerdict = null;
    }
    return sealRecord({
      ...recordPayload(record),
      ledger: serializeForgeObligationLedger(ledger),
      receipts,
      signedVerdict,
      updatedAt: this.clock().toISOString(),
    });
  }

  async #validateRunnerReceipt(raw, taskId, record, expectedProfile) {
    if (isHostRunReceipt(raw)) {
      try {
        validateHostRunReceipt(raw, {
          projectSlug: this.config.projectSlug,
          taskId,
          profile: expectedProfile,
          sourceFingerprint: record.acceptanceContract.candidate.source.fingerprint,
        });
      } catch (error) {
        fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', error?.message ?? 'Host Runner receipt is invalid.');
      }
      if (!this.config.allowedVerificationProfiles.includes(expectedProfile)
          || (raw.revalidation?.admissionReceipt.source.head ?? raw.source.head) !== record.acceptanceContract.candidate.source.head) {
        fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Host Runner receipt identity or profile is invalid.');
      }
      if (raw.revalidation !== undefined) {
        const review = raw.revalidation;
        const observedAt = Date.parse(review.observedAt);
        const now = this.clock().getTime();
        if (review.contractId !== record.acceptanceContract.contractId
            || observedAt < Date.parse(record.acceptanceContract.issuedAt)
            || observedAt > now || now >= Date.parse(record.acceptanceContract.expiresAt)
            || !record.sourceAuthorityBinding) {
          fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Host revalidation requires the current contract, observation and claimed source authority.');
        }
        if (review.sourceTransition !== undefined) {
          const trusted = await this.#checkpointTransitionForBinding(taskId,
            record.sourceAuthorityBinding, review.admissionReceipt.source);
          if (trusted === null || canonicalSha256(trusted) !== canonicalSha256(review.sourceTransition)) {
            fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Host checkpoint revalidation does not match the protected source transition.');
          }
        }
        if (review.previousRevalidation !== undefined) {
          const prior = review.previousRevalidation;
          let accepted = false;
          // Resolve only this task's named prior acceptance contract using the
          // existing protected archive; no new history or unsigned transition.
          for await (const previous of this.#archivedTaskRecords(taskId)) {
            if (previous.acceptanceContract.contractId !== prior.contractId) continue;
            const receipt = previous.receipts.find(item => item.kind === 'verification'
              && item.receipt.receiptId === raw.receiptId)?.receipt;
            if (receipt === undefined || receipt.status !== 'passed' || receipt.profile !== expectedProfile
              || receipt.source.head !== prior.admissionReceipt.source.head
              || receipt.source.fingerprint !== raw.source.workspaceFingerprint
              || receipt.execution.logSha256 !== normalizeDigest(raw.logs.sha256)
              || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
                .every(key => previous.sourceAuthorityBinding?.[key] === record.sourceAuthorityBinding[key])) continue;
            verifyAcceptanceEvidenceReceipt({ contract: previous.acceptanceContract, trustPolicy: this.trustPolicy,
              receipt, kind: 'verification', evaluatedAt: receipt.issuedAt });
            accepted = true;
            break;
          }
          if (!accepted) fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Checkpoint predecessor has no issuer-confirmed verification receipt.');
        }
        await this.#bindCandidateUnlocked({
          taskId, contractId: record.acceptanceContract.contractId,
          candidateBinding: record.sourceAuthorityBinding,
          admissionReceipt: review.admissionReceipt,
        }, taskId);
        if (review.sourceProjection?.kind === REVIEWED_RECEIPT_SOURCE_PROJECTION) {
          // Re-read operator-owned configuration after binding current authority.
          // A policy/digest carried by the Host request alone is not authority.
          const policy = this.#reviewedReceiptSourcePolicies(record).find(item => item.receiptId === raw.receiptId);
          try {
            if (policy === undefined || review.sourceTransition !== undefined
              || reviewedReceiptPolicyDigest(policy) !== review.sourceProjection.policySha256) throw new Error('Reviewed receipt policy is absent or changed.');
            validateReviewedReceiptSourceBinding(policy, raw, review.admissionReceipt.source, {
              governanceTaskScope: governanceTaskScopeForContract(record.taskContract),
              governanceRoleGrantPolicy: governanceRoleGrantPolicyForContract(record.taskContract),
              governanceSourceProvenancePolicy: this.#sourceProvenancePolicy(record),
              governanceAcceptedApiContract: record.acceptedApiContract,
            }, review.admissionReceipt.toolchain);
          } catch (error) { fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', error.message); }
        }
      } else if (Date.parse(raw.execution.startedAt) < Date.parse(record.acceptanceContract.issuedAt)) {
        fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Host Runner receipt predates the current candidate binding.');
      }
      const logSha256 = normalizeDigest(raw.logs.sha256);
      if (logSha256 === null) {
        fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Host Runner log digest is invalid.');
      }
      const passed = raw.status === 'passed' && raw.execution.exitCode === 0
        && raw.truth.executionProven === true && raw.truth.verificationProven === true
        && raw.isolation.cleanupProven === true
        && raw.execution.steps.every((step) => step.exitCode === 0
          && step.processEnded === true && step.timedOut === false
          && step.transportUncertain === false && step.cleanup.proven === true);
      return { logSha256, passed };
    }
    exactKeys(raw, [
      'execution', 'jobId', 'logs', 'projectSlug', 'receiptId', 'receiptType', 'request', 'results',
      'schemaVersion', 'source', 'status', 'taskId', 'truth',
    ], 'runnerReceipt');
    if (raw.schemaVersion !== 1 || raw.receiptType !== 'forge-verify/run'
      || raw.projectSlug !== this.config.projectSlug || raw.taskId !== taskId
      || raw.request?.profile !== expectedProfile
      || !this.config.allowedVerificationProfiles.includes(expectedProfile)) {
      fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Runner receipt identity or profile is invalid.');
    }
    if (raw.source?.head !== record.acceptanceContract.candidate.source.head
      || raw.source?.workspaceFingerprint !== record.acceptanceContract.candidate.source.fingerprint
      || normalizeDigest(raw.source?.snapshotSha256) !== `sha256:${record.acceptanceContract.candidate.source.fingerprint}`) {
      fail('ACCEPTANCE_SOURCE_MISMATCH', 'Runner receipt is bound to another source.');
    }
    const logSha256 = normalizeDigest(raw.logs?.sha256);
    if (logSha256 === null || !Number.isSafeInteger(raw.execution?.exitCode)
      || !Array.isArray(raw.execution?.steps)
      || typeof raw.truth?.executionProven !== 'boolean'
      || typeof raw.truth?.verificationProven !== 'boolean') {
      fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Runner receipt execution facts are incomplete.');
    }
    const passed = raw.status === 'passed' && raw.execution.exitCode === 0
      && raw.truth.executionProven === true && raw.truth.verificationProven === true
      && raw.execution.steps.every((step) => step?.exitCode === 0
        && step.timedOut === false && step.transportUncertain === false
        && step.cleanup?.proven === true);
    return { logSha256, passed };
  }

  async issueGovernance(input) {
    exactKeys(input, ['contractId', 'runnerReceipt', 'taskId'], 'governance request');
    const taskId = requiredString(input.taskId, TASK_ID, 'governance request.taskId');
    return this.#exclusive(taskId, () => this.#issueGovernanceUnlocked(input, taskId));
  }

  async #issueGovernanceUnlocked(input, taskId) {
    const record = await this.readRecord(taskId);
    if (input.contractId !== record.acceptanceContract.contractId) fail('ACCEPTANCE_CONTRACT_MISMATCH', 'Runner evidence targets another acceptance contract.', 409);
    const evidence = await this.#validateRunnerReceipt(input.runnerReceipt, taskId, record, 'governance');
    // A task-scoped Host audit must cover this exact protected workspace-write
    // contract. It cannot close another task or a complete release obligation.
    const steps = input.runnerReceipt.execution.steps;
    const rolePolicy = governanceRoleGrantPolicyForContract(record.taskContract);
    const roleSuffix = governanceRoleGrantArguments(rolePolicy);
    const originalPlan = steps.length === 1 ? steps[0].argv : [];
    let checkedPlan = originalPlan;
    if (record.acceptedApiContract !== undefined || steps.some(step => step.argv?.includes('--accepted-api-contract'))) {
      const suffix = governanceAcceptedApiContractArguments(record.acceptedApiContract);
      if (!isHostRunReceipt(input.runnerReceipt) || record.acceptedApiContract === undefined
        || checkedPlan.filter(arg => arg === '--accepted-api-contract').length !== 1
        || JSON.stringify(checkedPlan.slice(-suffix.length)) !== JSON.stringify(suffix)) {
        fail('ACCEPTANCE_GOVERNANCE_API_CONTRACT_MISMATCH', 'Governance receipt does not enforce the accepted API contract.');
      }
      checkedPlan = checkedPlan.slice(0, -suffix.length);
      if (!checkedPlan.includes('--task-contract-id')
        && !(checkedPlan[0] === 'audit' && checkedPlan[1] === '--base' && SOURCE_COMMIT.test(checkedPlan[2] ?? '')
          && (checkedPlan.length === 3 || (checkedPlan.length === 5 && checkedPlan[3] === '--expected-no-change-head'
            && checkedPlan[4] === checkedPlan[2]))
          || checkedPlan.includes('--role-grant-policy'))) {
        fail('ACCEPTANCE_GOVERNANCE_API_CONTRACT_MISMATCH', 'Accepted APIs cannot narrow a release audit.');
      }
    }
    const sourcePolicy = this.#sourceProvenancePolicy(record);
    if (sourcePolicy !== undefined || steps.some(step => step.argv?.includes('--source-provenance-policy'))) {
      const suffix = governanceSourceProvenanceArguments(sourcePolicy);
      if (!isHostRunReceipt(input.runnerReceipt) || sourcePolicy === undefined
        || checkedPlan.filter(arg => arg === '--source-provenance-policy').length !== 1
        || checkedPlan[0] !== 'audit' || checkedPlan[1] !== '--base' || checkedPlan[2] !== sourcePolicy.baseCommit
        || input.runnerReceipt.source.head !== sourcePolicy.head
        || JSON.stringify(checkedPlan.slice(-suffix.length)) !== JSON.stringify(suffix)) {
        fail('ACCEPTANCE_GOVERNANCE_SOURCE_POLICY_MISMATCH', 'Governance receipt does not enforce the current protected source review.');
      }
      checkedPlan = checkedPlan.slice(0, -suffix.length);
      const scopeOffset = checkedPlan.indexOf('--task-contract-id');
      if (scopeOffset < 0 || checkedPlan[scopeOffset + 1] !== sourcePolicy.contractId) {
        fail('ACCEPTANCE_GOVERNANCE_SOURCE_POLICY_MISMATCH', 'Source review cannot be inherited from another task contract.');
      }
    }
    if (rolePolicy !== undefined || steps.some(step => step.argv?.includes('--role-grant-policy'))) {
      const review = input.runnerReceipt.revalidation;
      if (review !== undefined && review.sourceTransition === undefined
        && (review.sourceProjection === undefined || review.sourceProjection.kind === REVIEWED_RECEIPT_SOURCE_PROJECTION)) {
        checkedPlan = revalidatedGovernanceTaskArguments(checkedPlan,
          governanceTaskScopeForContract(record.taskContract), rolePolicy) ?? checkedPlan;
      }
      if (!isHostRunReceipt(input.runnerReceipt) || rolePolicy === undefined
        || checkedPlan.filter(arg => arg === '--role-grant-policy').length !== 1
        || JSON.stringify(checkedPlan.slice(-roleSuffix.length)) !== JSON.stringify(roleSuffix)) {
        fail('ACCEPTANCE_GOVERNANCE_ROLE_POLICY_MISMATCH', 'Governance receipt does not enforce the protected role decisions.');
      }
      checkedPlan = checkedPlan.slice(0, -roleSuffix.length);
      // A role decision never narrows a checkpoint/release audit to selected paths.
      if (!checkedPlan.includes('--task-contract-id')
        && !(checkedPlan[0] === 'audit' && checkedPlan[1] === '--base' && SOURCE_COMMIT.test(checkedPlan[2] ?? '')
          && (checkedPlan.length === 3 || (checkedPlan.length === 5 && checkedPlan[3] === '--expected-no-change-head'
            && checkedPlan[4] === checkedPlan[2])))) {
        fail('ACCEPTANCE_GOVERNANCE_ROLE_POLICY_MISMATCH', 'Role decisions require the full fixed governance audit.');
      }
    }
    const scoped = steps.some(step => step.argv?.some(arg => arg === '--task-contract-id' || arg === '--task-owned-path'));
    if (scoped) {
      const scope = governanceTaskScopeForContract(record.taskContract);
      const suffix = governanceTaskScopeArguments(scope);
      const originalArgv = checkedPlan;
      const review = input.runnerReceipt.revalidation;
      const argv = review !== undefined && review.sourceTransition === undefined
        && (review.sourceProjection === undefined || review.sourceProjection.kind === REVIEWED_RECEIPT_SOURCE_PROJECTION)
        ? revalidatedGovernanceTaskArguments(originalArgv, scope) ?? originalArgv : originalArgv;
      const prefix = suffix.length > 0 ? argv.slice(0, -suffix.length) : [];
      const validBase = prefix[0] === 'audit' && prefix[1] === '--base' && SOURCE_COMMIT.test(prefix[2] ?? '')
        && (prefix.length === 3 || (prefix.length === 5 && prefix[3] === '--expected-no-change-head'
          && prefix[4] === prefix[2]));
      if (!isHostRunReceipt(input.runnerReceipt) || !scope || !validBase
        || JSON.stringify(argv.slice(-suffix.length)) !== JSON.stringify(suffix)) {
        fail('ACCEPTANCE_GOVERNANCE_SCOPE_MISMATCH', 'Governance receipt does not cover the current protected task scope.');
      }
    }
    const obligations = record.acceptanceContract.requiredObligations
      .filter((item) => item.evidenceType === 'governance').map((item) => item.id);
    const now = this.clock();
    const receipt = signAcceptanceDocument({
      schemaVersion: 1,
      receiptType: ACCEPTANCE_DOCUMENT_TYPES.receipts.governance,
      receiptId: crypto.randomUUID(),
      contractId: record.acceptanceContract.contractId,
      contractFingerprint: record.acceptanceContract.integrity.canonicalSha256,
      projectSlug: this.config.projectSlug,
      taskId,
      issuer: { keyId: this.config.keys.governance.keyId, subjectId: this.config.keys.governance.subjectId, role: 'governance-engine' },
      source: record.acceptanceContract.candidate.source,
      candidateDiffSha256: record.acceptanceContract.candidate.diffSha256,
      issuedAt: now.toISOString(),
      expiresAt: record.acceptanceContract.expiresAt,
      status: evidence.passed ? 'passed' : 'failed',
      profile: 'governance',
      obligations: evidence.passed ? obligations : [],
    }, this.signers.governance);
    const updated = await this.#appendReceipt(record, 'governance', receipt);
    await this.writeRecord(updated);
    return { receiptId: receipt.receiptId, status: receipt.status };
  }

  async issueVerification(input) {
    exactKeys(input, ['contractId', 'runnerReceipt', 'taskId'], 'verification request');
    const taskId = requiredString(input.taskId, TASK_ID, 'verification request.taskId');
    return this.#exclusive(taskId, () => this.#issueVerificationUnlocked(input, taskId));
  }

  #workflowInventoryForDiagnostic(record, raw) {
    if (raw.workflowInventoryObservation === undefined || raw.status !== 'passed') return undefined;
    const policy = (this.config.workflowInventoryPolicies ?? []).find(item => item.taskId === record.taskId
      && item.sourceFingerprint === record.acceptanceContract.candidate.source.fingerprint
      && item.sourceFingerprint === raw.source.workspaceFingerprint
      && raw.request.selectors.modules.length === 1 && raw.request.selectors.modules[0] === item.module
      && raw.request.selectors.tests.length === 1 && raw.request.selectors.tests[0] === item.testSelector);
    if (!policy) return undefined;
    return { policyId: policy.policyId, observation: structuredClone(raw.workflowInventoryObservation),
      executionStartedAt: raw.execution.startedAt, executionFinishedAt: raw.execution.finishedAt };
  }

  async #retainMethodDiagnostic(record, raw, evidence) {
    const now = this.clock();
    if (now.getTime() < Date.parse(record.acceptanceContract.issuedAt)
      || now.getTime() >= Date.parse(record.acceptanceContract.expiresAt)) {
      fail('ACCEPTANCE_CANDIDATE_CONTRACT_EXPIRED', 'Diagnostic evidence requires a current candidate binding.', 409);
    }
    const { revalidation: _revalidation, ...originalRunnerReceipt } = raw;
    const runnerReceiptSha256 = canonicalSha256(originalRunnerReceipt);
    const existing = record.diagnosticReceipts?.find(receipt => receipt.receiptId === raw.receiptId);
    if (existing) {
      if (existing.runnerReceiptSha256 !== runnerReceiptSha256) {
        fail('ACCEPTANCE_DIAGNOSTIC_RECEIPT_CONFLICT', 'Diagnostic receipt ID already binds different original execution evidence.', 409);
      }
      return { receiptId: existing.receiptId, status: existing.status, acceptanceScope: 'diagnostic-only',
        ...(existing.workflowInventory ? { workflowInventoryScope: 'recorded-integration-observation' } : {}) };
    }
    const workflowInventory = this.#workflowInventoryForDiagnostic(record, raw);
    const receipt = signAcceptanceDocument({
      schemaVersion: 1, receiptType: ACCEPTANCE_DIAGNOSTIC_RECEIPT_TYPE,
      receiptId: raw.receiptId, contractId: record.acceptanceContract.contractId,
      contractFingerprint: record.acceptanceContract.integrity.canonicalSha256,
      projectSlug: this.config.projectSlug, taskId: record.taskId,
      issuer: { keyId: this.config.keys.verification.keyId, subjectId: this.config.keys.verification.subjectId, role: 'verification-runner' },
      source: record.acceptanceContract.candidate.source,
      candidateDiffSha256: record.acceptanceContract.candidate.diffSha256,
      issuedAt: now.toISOString(), expiresAt: record.acceptanceContract.expiresAt,
      status: evidence.passed ? 'passed' : 'failed', profile: raw.request.profile,
      fullContractCovered: false, obligations: [], selectors: structuredClone(raw.request.selectors),
      results: Object.fromEntries(['executed', 'passed', 'failed', 'skipped'].map(key => [key, raw.results[key]])),
      runnerReceiptSha256,
      execution: { exitCode: raw.execution.exitCode, timedOut: raw.status === 'timed-out', logSha256: evidence.logSha256 },
      ...(workflowInventory ? { workflowInventory } : {}),
    }, this.signers.verification);
    verifyAcceptanceDiagnosticReceipt({ contract: record.acceptanceContract, trustPolicy: this.trustPolicy,
      receipt, evaluatedAt: now.toISOString() });
    // Deliberately bypass #appendReceipt: diagnostics never close obligations,
    // replace a real failure, or enter the full-contract acceptance aggregate.
    await this.writeRecord(sealRecord({ ...recordPayload(record),
      diagnosticReceipts: [...(record.diagnosticReceipts ?? []), receipt], updatedAt: now.toISOString() }));
    return { receiptId: receipt.receiptId, status: receipt.status, acceptanceScope: 'diagnostic-only',
      ...(receipt.workflowInventory ? { workflowInventoryScope: 'recorded-integration-observation' } : {}) };
  }

  async #issueVerificationUnlocked(input, taskId) {
    const record = await this.readRecord(taskId);
    if (input.contractId !== record.acceptanceContract.contractId) fail('ACCEPTANCE_CONTRACT_MISMATCH', 'Runner evidence targets another acceptance contract.', 409);
    const raw = input.runnerReceipt;
    const backendClass = raw?.request?.profile === 'backend-test-class';
    const backendCompileDiagnostic = raw?.request?.profile === 'backend-module-compile'
      && record.acceptanceContract.requiredProfiles.includes('backend-module-test');
    const requiredProfile = record.acceptanceContract.requiredProfiles.includes(raw?.request?.profile);
    if (!requiredProfile && !backendClass && !backendCompileDiagnostic) {
      fail('ACCEPTANCE_RUNNER_RECEIPT_INVALID', 'Runner receipt profile is not required by this contract.');
    }
    const evidence = await this.#validateRunnerReceipt(raw, taskId, record, raw.request.profile);
    if (backendCompileDiagnostic && !requiredProfile) {
      return { receiptId: raw.receiptId, status: evidence.passed ? 'passed' : 'failed', acceptanceScope: 'diagnostic-only' };
    }
    if (backendClass) {
      validateBackendTestClassExecution(raw);
      if (!requiredProfile || !coversExplicitBackendContract(record.taskContract, raw.request.selectors)) {
        if (isBoundBackendMethodDiagnostic(record.taskContract, raw.request.selectors)) {
          return this.#retainMethodDiagnostic(record, raw, evidence);
        }
        return { receiptId: raw.receiptId, status: evidence.passed ? 'passed' : 'failed' };
      }
    }
    if (raw.request.profile === 'frontend-h5-test') {
      validateH5TestExecution(raw);
      const required = record.taskContract.ownedPaths.filter(file => H5_TEST_FILE_PATTERN.test(file));
      const selected = raw.request.selectors.testFiles;
      if (required.length === 0 || required.length !== selected.length || !required.every(file => selected.includes(file))) {
        return { receiptId: raw.receiptId, status: evidence.passed ? 'passed' : 'failed' };
      }
    }
    if (raw.request.profile === 'frontend-admin-test') {
      const focused = validateFrontendAdminTestExecution(raw);
      if (focused && !coversExplicitFrontendContract(record.taskContract, raw.request.selectors.testFiles, true)) {
        // Keep partial or broad-scope diagnostics factual without claiming the
        // current contract's complete test obligation.
        return { receiptId: raw.receiptId, status: evidence.passed ? 'passed' : 'failed' };
      }
    }
    if (raw.request.profile === 'frontend-admin-lint' && Object.hasOwn(raw.request.selectors, 'files')
      && !coversExplicitFrontendContract(record.taskContract, raw.request.selectors.files, false)) {
      return { receiptId: raw.receiptId, status: evidence.passed ? 'passed' : 'failed' };
    }
    const obligations = record.acceptanceContract.requiredObligations
      .filter((item) => item.evidenceType === 'verification' && item.profile === raw.request.profile)
      .map((item) => item.id);
    const dimensions = record.acceptanceContract.requiredObligations
      .filter((item) => obligations.includes(item.id)).map((item) => item.dimension);
    const now = this.clock();
    const receipt = signAcceptanceDocument({
      schemaVersion: 1,
      receiptType: ACCEPTANCE_DOCUMENT_TYPES.receipts.verification,
      receiptId: raw.receiptId,
      contractId: record.acceptanceContract.contractId,
      contractFingerprint: record.acceptanceContract.integrity.canonicalSha256,
      projectSlug: this.config.projectSlug,
      taskId,
      issuer: { keyId: this.config.keys.verification.keyId, subjectId: this.config.keys.verification.subjectId, role: 'verification-runner' },
      source: record.acceptanceContract.candidate.source,
      candidateDiffSha256: record.acceptanceContract.candidate.diffSha256,
      issuedAt: now.toISOString(),
      expiresAt: record.acceptanceContract.expiresAt,
      status: evidence.passed ? 'passed' : 'failed',
      profile: raw.request.profile,
      dimension: dimensions[0] ?? 'execution',
      obligations: evidence.passed ? obligations : [],
      execution: { exitCode: raw.execution.exitCode, timedOut: !evidence.passed && raw.status === 'timed-out', logSha256: evidence.logSha256 },
    }, this.signers.verification);
    const updated = await this.#appendReceipt(record, 'verification', receipt);
    await this.writeRecord(updated);
    return { receiptId: receipt.receiptId, status: receipt.status };
  }

  async inspectSemanticReview(input) {
    exactKeys(input, ['taskId', 'contractId'], 'semantic review context request');
    requiredString(input.taskId, TASK_ID, 'semantic review context.taskId');
    requiredString(input.contractId, SHA256, 'semantic review context.contractId');
    const record = await this.readRecord(input.taskId);
    const contract = record.acceptanceContract;
    if (input.contractId !== contract.contractId) {
      fail('ACCEPTANCE_CONTRACT_MISMATCH', 'Semantic review targets another acceptance contract.', 409);
    }
    const obligations = contract.requiredObligations.filter((item) => item.evidenceType === 'semantic-review').map((item) => item.id);
    const projection = await this.resolve({ taskId: input.taskId });
    const verdict = aggregateAcceptance({
      contract,
      current: { source: contract.candidate.source, candidateDiffSha256: contract.candidate.diffSha256, observedAt: this.clock().toISOString() },
      ...currentAcceptanceEvidence(record.receipts),
    }, { trustPolicy: this.trustPolicy, verdictSigner: null });
    const existing = record.receipts.filter((item) => item.kind === 'semanticReview');
    const dualReview = contract.dualReview;
    const supported = dualReview === undefined
      ? obligations.length === 1 && obligations[0] === 'api-error-and-auth-contract'
      : obligations.includes('spec-and-quality-review')
        && obligations.every(id => ['spec-and-quality-review', 'api-error-and-auth-contract'].includes(id));
    const testReceipts = dualReview === undefined ? undefined
      : protectedReviewTestReceipts(record, this.trustPolicy, this.clock().toISOString());
    const blockingOpen = projection.ledgerSummary.open.filter(id =>
      !(projection.nonBlockingLegacyObligations ?? []).includes(id));
    const onlyReviewMissing = supported && existing.length === 0
      && (testReceipts === undefined || testReceipts.length > 0)
      && blockingOpen.length === obligations.length
      && obligations.every(id => blockingOpen.includes(`contract:${id}`))
      && projection.blockers.every((item) => ['OBLIGATION_LEDGER_OPEN', 'INDEPENDENT_VERDICT_NOT_CURRENT_ACCEPTANCE'].includes(item.code))
      && verdict.blockers.length > 0
      && verdict.blockers.every((item) => ['REQUIRED_DIMENSION_MISSING', 'REQUIRED_OBLIGATION_MISSING'].includes(item.code))
      && contract.requiredProfiles.every((profile) => verdict.acceptedProfiles.includes(profile))
      && contract.requiredObligations.filter((item) => item.evidenceType !== 'semantic-review')
        .every((item) => verdict.acceptedObligations.includes(item.id))
      && contract.requiredDimensions.filter((dimension) => dimension !== 'semantic')
        .every((dimension) => verdict.dimensions[dimension].status === 'proven');
    let reviewFeedback;
    if (onlyReviewMissing) {
      const request = await this.#readConversationTaskRequest(input.taskId);
      if (request?.reviewFeedback !== undefined) {
        if (request.taskId !== input.taskId || request.projectSlug !== contract.projectSlug
          || request.actorUserId !== contract.candidate.authorId
          || request.source.head !== contract.candidate.source.head || request.source.fingerprint !== contract.candidate.source.fingerprint
          || request.writerScopesDigest !== this.#writerScopesDigest() || Date.parse(request.expiresAt) <= this.clock().getTime()) {
          fail('ACCEPTANCE_REVIEW_FEEDBACK_STALE', '独审反馈未绑定当前用户请求与同一候选；不能沿用失效反馈。', 409);
        }
        reviewFeedback = structuredClone(request.reviewFeedback);
      }
    }
    return {
      schemaVersion: 1, contextType: 'forge-independent-semantic-review/v1',
      status: projection.outcome === 'READY' ? 'complete' : onlyReviewMissing ? 'ready' : 'blocked',
      reasonCode: projection.outcome === 'READY' ? null : onlyReviewMissing ? null
        : existing.length > 0 ? 'EXISTING_REVIEW_BLOCKED' : !supported ? 'REVIEW_SCOPE_UNSUPPORTED' : 'TECHNICAL_ACCEPTANCE_INCOMPLETE',
      projectSlug: this.config.projectSlug, taskId: input.taskId, contractId: contract.contractId,
      contractFingerprint: contract.integrity.canonicalSha256,
      issuedAt: contract.issuedAt, expiresAt: contract.expiresAt,
      source: structuredClone(contract.candidate.source), candidateDiffSha256: contract.candidate.diffSha256,
      reviewerId: this.config.keys.semanticReview.subjectId, obligations,
      existingReviewId: existing[0]?.receipt.receiptId ?? null,
      ...(dualReview === undefined ? {} : { dualReview: structuredClone(dualReview), testReceipts,
        reviewOwnedPaths: [...record.taskContract.ownedPaths] }),
      ...(contract.previousReview === undefined ? {} : { previousReview: structuredClone(contract.previousReview) }),
      ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
    };
  }

  async issueSemanticReview(input) {
    exactKeys(input, [
      'candidateDiffSha256', 'contractId', 'decision', 'obligations', 'reviewId', 'reviewerId',
      'source', 'summary', 'taskId',
      ...(Object.hasOwn(input, 'dualReview') ? ['dualReview'] : []),
    ], 'semantic review request');
    const taskId = requiredString(input.taskId, TASK_ID, 'semantic review request.taskId');
    requiredString(input.contractId, SHA256, 'semantic review request.contractId');
    requiredString(input.reviewId, SAFE_ID, 'semantic review request.reviewId');
    exactKeys(input.source, ['fingerprint', 'head'], 'semantic review request.source');
    requiredString(input.source.head, SOURCE_COMMIT, 'semantic review request.source.head');
    requiredString(input.source.fingerprint, SHA256, 'semantic review request.source.fingerprint');
    requiredString(input.candidateDiffSha256, PREFIXED_SHA256, 'semantic review request.candidateDiffSha256');
    requiredString(input.reviewerId, SAFE_ID, 'semantic review request.reviewerId');
    if (!['approved', 'rejected'].includes(input.decision)) {
      fail('ACCEPTANCE_SCHEMA_INVALID', 'semantic review request.decision is invalid.');
    }
    if (typeof input.summary !== 'string' || input.summary.trim().length === 0
      || Buffer.byteLength(input.summary, 'utf8') > MAX_SEMANTIC_REVIEW_SUMMARY_BYTES
      || Buffer.from(input.summary, 'utf8').toString('utf8') !== input.summary
      || input.summary.includes('\0')) {
      fail('ACCEPTANCE_SCHEMA_INVALID', 'semantic review request.summary is invalid.');
    }
    uniqueStrings(input.obligations, SAFE_ID, 'semantic review request.obligations');
    return this.#exclusive(taskId, () => this.#issueSemanticReviewUnlocked(input, taskId));
  }

  async #issueSemanticReviewUnlocked(input, taskId) {
    const record = await this.readRecord(taskId);
    if (input.contractId !== record.acceptanceContract.contractId) {
      fail('ACCEPTANCE_CONTRACT_MISMATCH', 'Semantic review targets another acceptance contract.', 409);
    }
    if (input.source.head !== record.acceptanceContract.candidate.source.head
      || input.source.fingerprint !== record.acceptanceContract.candidate.source.fingerprint
      || input.candidateDiffSha256 !== record.acceptanceContract.candidate.diffSha256) {
      fail('ACCEPTANCE_SOURCE_MISMATCH', 'Semantic review is bound to another source or candidate diff.', 409);
    }
    if (input.reviewerId !== this.config.keys.semanticReview.subjectId) {
      fail('ACCEPTANCE_SEMANTIC_REVIEWER_INVALID', 'Semantic review must use the configured protected reviewer identity.');
    }
    if (input.reviewerId === record.acceptanceContract.candidate.authorId) {
      fail('ACCEPTANCE_SEMANTIC_REVIEW_SELF_AUTHORED', 'The candidate author cannot review their own candidate.');
    }
    if (Object.hasOwn(record.acceptanceContract, 'dualReview') !== Object.hasOwn(input, 'dualReview')) {
      fail('ACCEPTANCE_DUAL_REVIEW_REQUIRED', '当前合同要求绑定源码与测试证据的双判定，单一decision不能签发通过。');
    }
    if (input.dualReview !== undefined) {
      validateForgeDualReviewEvidence(input.dualReview, { decision: input.decision, contract: record.acceptanceContract,
        testReceipts: protectedReviewTestReceipts(record, this.trustPolicy, this.clock().toISOString()) });
    }
    const allowedObligations = new Set(record.acceptanceContract.requiredObligations
      .filter((item) => item.evidenceType === 'semantic-review')
      .map((item) => item.id));
    if (input.obligations.some((id) => !allowedObligations.has(id))) {
      fail('ACCEPTANCE_SEMANTIC_REVIEW_OBLIGATION_INVALID', 'Semantic review claims an undeclared or incompatible obligation.');
    }
    const summarySha256 = crypto.createHash('sha256').update(input.summary, 'utf8').digest('hex');
    const existing = record.receipts.find((item) => item.receipt.receiptId === input.reviewId);
    if (existing !== undefined) {
      const same = existing.kind === 'semanticReview'
        && existing.receipt.contractId === input.contractId
        && existing.receipt.source.head === input.source.head
        && existing.receipt.source.fingerprint === input.source.fingerprint
        && existing.receipt.candidateDiffSha256 === input.candidateDiffSha256
        && existing.receipt.review.reviewerId === input.reviewerId
        && existing.receipt.review.decision === input.decision
        && existing.receipt.review.summarySha256 === summarySha256
        && canonicalSha256(existing.receipt.review.dualReview ?? null) === canonicalSha256(input.dualReview ?? null)
        && JSON.stringify(existing.receipt.obligations) === JSON.stringify(input.obligations);
      if (!same) {
        fail('ACCEPTANCE_SEMANTIC_REVIEW_CONFLICT', 'Semantic review id is already bound to different content.', 409);
      }
      verifyAcceptanceEvidenceReceipt({
        contract: record.acceptanceContract,
        trustPolicy: this.trustPolicy,
        receipt: existing.receipt,
        kind: 'semanticReview',
        evaluatedAt: this.clock().toISOString(),
      });
      return { receiptId: existing.receipt.receiptId, status: existing.receipt.status };
    }
    const now = this.clock();
    const receipt = signAcceptanceDocument({
      schemaVersion: 1,
      receiptType: ACCEPTANCE_DOCUMENT_TYPES.receipts.semanticReview,
      receiptId: input.reviewId,
      contractId: record.acceptanceContract.contractId,
      contractFingerprint: record.acceptanceContract.integrity.canonicalSha256,
      projectSlug: this.config.projectSlug,
      taskId,
      issuer: {
        keyId: this.config.keys.semanticReview.keyId,
        subjectId: this.config.keys.semanticReview.subjectId,
        role: 'independent-reviewer',
      },
      source: record.acceptanceContract.candidate.source,
      candidateDiffSha256: record.acceptanceContract.candidate.diffSha256,
      issuedAt: now.toISOString(),
      expiresAt: record.acceptanceContract.expiresAt,
      status: input.decision === 'approved' ? 'passed' : 'failed',
      obligations: input.obligations,
      review: { decision: input.decision, reviewerId: input.reviewerId, summarySha256,
        ...(input.dualReview === undefined ? {} : { dualReview: structuredClone(input.dualReview) }) },
    }, this.signers.semanticReview);
    verifyAcceptanceEvidenceReceipt({
      contract: record.acceptanceContract,
      trustPolicy: this.trustPolicy,
      receipt,
      kind: 'semanticReview',
      evaluatedAt: now.toISOString(),
    });
    const updated = await this.#appendReceipt(record, 'semanticReview', receipt);
    await this.writeRecord(updated);
    return { receiptId: receipt.receiptId, status: receipt.status };
  }

  async resolve(input) {
    exactKeys(input, ['taskId'], 'resolver request');
    const record = await this.readRecord(input.taskId);
    return evaluateProtectedLedgerCompletion({
      ledger: restoreForgeObligationLedger(record.ledger, record.taskContract, record.acceptanceContract),
      taskContract: record.taskContract,
      acceptanceContract: record.acceptanceContract,
      trustPolicy: this.trustPolicy,
      signedReceipts: record.receipts,
      signedVerdict: record.signedVerdict,
      current: {
        sourceFingerprint: record.acceptanceContract.candidate.source.fingerprint,
        candidateDiffSha256: record.acceptanceContract.candidate.diffSha256,
        evaluatedAt: this.clock().toISOString(),
      },
    });
  }

  async resolveCandidateBinding(input) {
    exactKeys(input, ['taskId'], 'candidate binding resolver request');
    const record = await this.readRecord(input.taskId);
    if (record.sourceAuthorityBinding === null || record.sourceAuthorityBinding === undefined) {
      fail('ACCEPTANCE_CANDIDATE_BINDING_UNAVAILABLE', 'No current Host-bound candidate authority exists.', 409);
    }
    return {
      schemaVersion: 1,
      projectionType: 'forge-candidate-authority-binding/v1',
      taskId: record.taskId,
      contractId: record.taskContract.contractId,
      candidate: {
        source: structuredClone(record.acceptanceContract.candidate.source),
      },
      sourceAuthorityBinding: structuredClone(record.sourceAuthorityBinding),
      recordDigest: record.recordDigest,
    };
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) fail('ACCEPTANCE_REQUEST_TOO_LARGE', 'Request exceeds the protected limit.', 413);
    chunks.push(chunk);
  }
  if (bytes === 0) fail('ACCEPTANCE_REQUEST_REQUIRED', 'JSON request body is required.', 400);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('ACCEPTANCE_SCHEMA_INVALID', 'Request body is invalid JSON.', 400); }
}

function send(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function serverFor(service, capability) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        send(response, 200, { ok: true, serviceType: SERVICE_TYPE, capability });
        return;
      }
      const routes = capability === 'control'
        ? new Map([
          ['/v1/contracts', (body) => service.issueContract(body)],
          ['/v1/execution-authority', (body) => service.issueExecutionAuthority(body)],
          ['/v1/conversation-roles', (body) => service.confirmConversationRoles(body)],
        ])
        : capability === 'scope'
          ? new Map([
            ['/v1/conversation-task', (body) => service.prepareConversationTask(body)],
            ['/v1/execution-renewal', (body) => service.renewConversationExecution(body)],
            ['/v1/managed-file', (body) => service.authorizeManagedFileOperation(body)],
          ])
        : capability === 'issuer'
          ? new Map([
             ['/v1/candidate-bindings', (body) => service.bindCandidate(body)],
             ['/v1/governance', (body) => service.issueGovernance(body)],
             ['/v1/semantic-review', (body) => service.issueSemanticReview(body)],
             ['/v1/semantic-review-context', (body) => service.inspectSemanticReview(body)],
             ['/v1/verification', (body) => service.issueVerification(body)],
          ])
          : new Map([
            ['/v1/projection', (body) => service.resolve(body)],
            ['/v1/candidate-binding', (body) => service.resolveCandidateBinding(body)],
          ]);
      const action = routes.get(request.url);
      if (request.method !== 'POST' || action === undefined) {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        send(response, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON is required.' } });
        return;
      }
      send(response, 200, { ok: true, result: await action(await readJsonBody(request)) });
    } catch (error) {
      send(response, error.statusCode ?? 422, { ok: false, error: publicError(error) });
    }
  });
}

export function createProtectedAcceptanceServers(service) {
  return {
    control: serverFor(service, 'control'),
    ...(service.config.conversationTaskPreparation === true
      ? { scope: serverFor(service, 'scope') }
      : {}),
    issuer: serverFor(service, 'issuer'),
    resolver: serverFor(service, 'resolver'),
  };
}

async function listenUnix(server, socketPath) {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
}

async function main() {
  const configFile = process.env.ACCEPTANCE_SERVICE_CONFIG ?? '/etc/forge-acceptance/service.json';
  const keyFiles = {
    platformKeyPem: process.env.ACCEPTANCE_PLATFORM_KEY_FILE ?? '/run/secrets/forge_acceptance_platform_key',
    governanceKeyPem: process.env.ACCEPTANCE_GOVERNANCE_KEY_FILE ?? '/run/secrets/forge_acceptance_governance_key',
    verificationKeyPem: process.env.ACCEPTANCE_VERIFICATION_KEY_FILE ?? '/run/secrets/forge_acceptance_verification_key',
    semanticKeyPem: process.env.ACCEPTANCE_SEMANTIC_KEY_FILE ?? '/run/secrets/forge_acceptance_semantic_key',
    verdictKeyPem: process.env.ACCEPTANCE_VERDICT_KEY_FILE ?? '/run/secrets/forge_acceptance_verdict_key',
  };
  const [config, ...keys] = await Promise.all([
    readFile(configFile, 'utf8').then(JSON.parse),
    ...Object.values(keyFiles).map((file) => readFile(file, 'utf8')),
  ]);
  const service = new ProtectedAcceptanceService({ config,
    currentExecutionAuthority: (input) => readCurrentExecutionRenewalAuthority(process.env.FORGE_CONVERSATION_MANAGER_SOCKET_FILE, input),
    ...Object.fromEntries(Object.keys(keyFiles).map((name, index) => [name, keys[index]])) });
  const servers = createProtectedAcceptanceServers(service);
  const listeners = [
    listenUnix(servers.control, process.env.ACCEPTANCE_CONTROL_SOCKET ?? '/run/forge-acceptance-control/control.sock'),
    listenUnix(servers.issuer, process.env.ACCEPTANCE_ISSUER_SOCKET ?? '/run/forge-acceptance-issuer/issuer.sock'),
    listenUnix(servers.resolver, process.env.ACCEPTANCE_RESOLVER_SOCKET ?? '/run/forge-acceptance-resolver/resolver.sock'),
  ];
  if (servers.scope !== undefined) {
    listeners.push(listenUnix(
      servers.scope,
      process.env.ACCEPTANCE_SCOPE_SOCKET ?? '/run/forge-acceptance-scope/scope.sock',
    ));
  }
  await Promise.all(listeners);
  process.stdout.write('forge protected acceptance service is ready\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${publicError(error).code}: protected acceptance service failed to start\n`);
    process.exitCode = 1;
  });
}

export { SERVICE_TYPE };
