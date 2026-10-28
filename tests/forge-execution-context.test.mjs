import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  chmod,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('historical read-only inventory: original implementation prompt is not a global restriction', async () => {
  const prompt = (await readFile(new URL('./fixtures/customer-bilingual-initial-prompt.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  assert.equal(crypto.createHash('sha256').update(prompt).digest('hex'), '8a252f3be107c19321e2aaaab3f1c231e2cf2dfc9cc6dc37b326bdaac9a38089');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n本轮只读分析，不要修改代码。`), true);
});

test('field read-only annotations in the original health implementation request do not constrain the whole turn', async () => {
  const prompt = await readFile(new URL('./fixtures/health-exposure-posts-implementation-prompt.txt', import.meta.url), 'utf8');
  assert.equal(crypto.createHash('sha256').update(prompt.replace(/\r\n/gu, '\n')).digest('hex'), 'a1e8c308dfe185a7bb80331f6bb216146a3b6c3a15a446f644b1533578a49d05');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  for (const restriction of ['本轮只读分析，不修改代码。', '只读', '不要修改代码。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
  }
  for (const annotation of ['### 人员信息（子表，只读）', '| 姓名 | 文本 | 自动带出，只读 |']) {
    assert.equal(hasGlobalReadOnlyIntent(`请实现当前表单。\n${annotation}`), false, annotation);
    assert.equal(hasGlobalReadOnlyIntent(annotation), true, 'a field description alone grants no implementation exception');
  }
});

test('historical read-only inventory: present instructions still constrain authorized work', () => {
  const fact = '只读盘点选取上述两提交之间变更的 595 个生产 Java 文件';
  for (const prompt of [
    `请继续修改客户固定界面提示并完成定向测试。以下是此前盘点记录：\n${fact}，其中客户业务核心 579 个。`,
    '请修复事故页面。只读盘点已结束，未修改客户源码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  for (const prompt of [
    fact,
    `引用：“请修复事故页面”。\n${fact}。`,
    `如果需要修改事故页面再说。\n${fact}。`,
    `请修改事故页面。本轮${fact}。`,
    '请先只读盘点上述两提交之间变更的 Java 文件，暂不修改代码。',
    '此前已经授权你修改事故页面，但本轮只读分析，不要修改任何文件。',
    '请修复事故页面。本轮先只给修复方案，不要修改代码。',
    '请修复事故页面。请按附件的要求执行：本轮只读检查，不要修改代码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

const CRUD_SCOPED_SOURCE_PROMPT = "继续原维修台账验收，当前 DOMAIN-EXEC-004 已由真实浏览器和唯一 Host job ee09106e-42cd-4ff7-8d05-1097a593655e、receipt 892189a8-47f5-43af-84da-57c7e2430b34 完成。原件保持，不重跑旧 DOMAIN 负例、RBAC/IDOR、旧18项、六回填。本轮是 CRUD-CONTRACT-008 的新差集候选；你负责实际业务测试修改，操作员随后负责独立真实浏览器。先实现候选，暂不启动测试或浏览器。\n\n本轮写入只限原有两个文件：\n- forge-server/forge-admin-server/src/test/java/com/mdframe/forge/business/core/eqrepair/EqRepairLedgerHttpBrowserIntegrationTest.java\n- forge-server/forge-admin-server/src/test/resources/coverage-domain-exec/spec.md\n\n另外三个原前端 fixture 必须保持原字节，沿用真实 repair-ledger 页面、真实 API、加密、认证、租户和权限。沿正常 prepare_task inspect/propose 刷新以上两 ownedPaths 与必要实际 references；不手填签名、source fingerprint、admission。旧DOMAIN源码及回执保留为旧候选，新CRUD源另绑。\n\n当前页面实际启用了新增、详情、编辑、删除、批删、6项筛选及共享分页；还启用了 import、import-template、export。实际路由 GET /business/eq-repair-ledger/page，POST getById、add、edit、remove/:id，批删复用逐项remove。页面未启用树、业务Tab、列排序，不添加。请只读这些直接实现和请求/响应/字典/Excel合同，避免照猜字段或假定导入格式。\n\n完整目标：独立浏览器在本次唯一fixture内正常新增，详情回填同一字符串ID及真实字段，编辑可见字段/费用并重新打开核对持久化；筛选命中、不命中、重置，至少两页的真实请求/总数/无重复；实际可选字典选择且详情/编辑回填与列表标签正确；正常模板下载、文件导入、导出，在真实文件内容和数据库记录间核对往返；正常勾选并批删；最终正常确认删除主记录，页面与详情不再可读、数据库逻辑删除、真实审计关联。同一浏览器身份执行用户动作，后端只观察和断言，不替操作员用HTTP完成应由页面发生的主链。\n\n当前已知必须修正的fixture前提：上次真实三个字典请求HTTP200但下拉No Data，列表显示medium/pending；根因尚未证实。请核实际字典类型/项的tenant、status、删除标志、权限和缓存读取链，只补本测试隔离租户内直接需要的真实字典及资源，保持生产逻辑。现grantLedgerApiPermissions只给page/detail/add/edit/remove，请核导入导出/模板/批删真正使用的权限，不凭名称猜权限或创建无实际消费者的假resource。Host另有sys_cache_policy/t_lead_assess_plan缺表日志，尚无证据说明它们导致字典为空，不做全应用数据库整改；只有直接阻塞当前合同才报告精确原因。\n\n本测试当前观察新增后立即执行旧负例并结束，应改成等待这次完整用户链的实际终点才清理。保留独立browser token与HTTP观察token/密钥，auditFloor在READY之前采集、清理SQL和基础设施都成功才CLOSED。后端通过实际状态/审计证明新增、编辑、导入、批删和最终删除，不提供可手填passed接口。可以在唯一fixture中明确准备分页记录和导入输入文件，但必须清楚标记fixture初始化，不能将这些记录伪装为浏览器创建；不得由后端替浏览器发主链写请求。所需输入文件应由你在此两个owned文件内的正常测试准备产生于本次target目录，格式来自实际Excel合同，操作员只传给页面文件选择器，不代写业务产物。\n\nREADY仍使用已支持的target/domain-exec-fixture/ready.json，只输出原公开元数据（port、fixture、expiresAt等），无凭据。可以另写本测试target内最小验收输入/阶段快照供只读采集，不能把operator声明当通过。设明确有界浏览器窗口600秒，超时/断言失败如实失败并清理，不无限重试。最终终点应可由页面最后删除与数据库/审计事实识别，不能新增“mark passed”接口。规格须明确精确操作顺序、文件位置、字段预期和完成/清理条件，方便操作员一次实际执行。\n\n此次不运行forge-verify、不启动HTTP/浏览器、不governance/review/发布，也不额外全模块测试或安装依赖。若完整目标必须修改现有业务或第三个文件，先报告可复現的直接根因、最小必要路径及范围，不绕过当前scope。候选完成后报告真实修改和正常单类运行步骤，不能将候选、静态阅读或原DOMAIN通过说成CRUD已通过。\n";

const UI_COMPONENT_SCOPED_SOURCE_PROMPT = "继续当前 B 能力覆盖任务，只处理 AiCrudPage 已有编辑/详情流程 tab 的可见焦点与已记录的对比度缺口。业务修改仍由你这个 Harness 作者完成。本轮先准备最小源码候选，不启动浏览器、测试、构建、提交或发布；既有 CRUD、回填竞态与键盘行为已通过的结果全部保留。\n\n当前相关共享组件为 forge-admin-ui/src/components/ai-form/AiCrudPage.vue。既有源码 SHA 37728b4e 开头；先核对当前内容，不能覆盖后续修改。正常 prepare 当前前端范围，只读取此组件直接相关模板/样式和项目已有主题 token/对应共享 tab 样式，不进行全仓审计或新增设计文档。\n\n实际证据：真实聚焦的 tab 样本曾出现 outline-style=none；此组件的 :focus-visible 使用 var(--primary-color) 而没有缺省值。变量未解析是当前源级风险，尚不能声称浏览器根因已完全证实。请沿现有主题/共享控件约定做最小修复，确保该变量缺失时仍有合法可见的键盘焦点边框，不改变已验证的 tab/Shift+Tab/Arrow/Home/End/Escape 行为，不新增通用焦点框架。\n\n对比度另有真实未选中流程 tab 前景 #4e5969、实际背景 #999999、比值约2.49的违规；编辑8个/详情4个 bgOverlap 是未完成检测，不能当通过也不能当全部失败。只核查该组件直接相关的弹层背景、继承颜色和 tab 样式；有明确源级根因才最小修复，否则保留具体未知点供下一次真实浏览器取样。禁止删除检测、调低阈值、隐藏仍可见可操作的控件，或为了消除报告改变本来合法的业务状态。\n\n本轮仅可修改上述 AiCrudPage.vue 的直接相关局部样式/语义，不改业务API、回填逻辑、测试、其他页面或权限。若需要越出这一文件才能正确修复，就报告必要依赖并结束，不自行扩展。说明实际修改和仍需浏览器确认的内容，完成候选后结束本轮，不自动重跑历史用例。\n";

test('UI component scoped read: exact repair request remains writable', () => {
  assert.equal(crypto.createHash('sha256').update(UI_COMPONENT_SCOPED_SOURCE_PROMPT).digest('hex'), '4e66b24ab5dfe402f96fc998e7417fe8f6380407e913264765a48337098276d2');
  assert.equal(hasGlobalReadOnlyIntent(UI_COMPONENT_SCOPED_SOURCE_PROMPT), false);
});

test('UI component scoped read: named local style edits and reference variants stay bounded', () => {
  for (const prompt of [
    '本轮仅可修改上述 AiCrudPage.vue 的直接相关局部样式/语义。只读取此组件直接相关模板/样式和项目已有主题 token/对应共享 tab 样式。',
    '本次只可修改该 src/Widget.tsx 的局部样式。请仅读取该组件的相关模板和样式。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
});

test('UI component scoped read: global prohibitions and absent or quoted authorization still win', () => {
  const scope = '本轮仅可修改上述 AiCrudPage.vue 的直接相关局部样式/语义';
  const reading = '只读取此组件直接相关模板/样式和项目已有主题 token/对应共享 tab 样式。';
  for (const prompt of [
    UI_COMPONENT_SCOPED_SOURCE_PROMPT + '\n本轮只读分析。',
    UI_COMPONENT_SCOPED_SOURCE_PROMPT + '\n不要修改任何文件。',
    scope + '。本轮' + reading,
    reading,
    scope + '？' + reading,
    '“' + scope + '”。' + reading,
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

test('historical comma-separated authorization does not override the current source-read request', () => {
  const historical = '之前我明确授权你先 prepare，再只修当前测试。';
  assert.equal(hasGlobalReadOnlyIntent(historical + '只读 src/Example.java。'), true);
  assert.equal(hasGlobalReadOnlyIntent('此前我明确授权你先 prepare，再只修当前测试。只读 src/Example.java。'), true);
  assert.equal(hasGlobalReadOnlyIntent('我明确授权你先 prepare，再只修当前测试。只读 src/Example.java。'), false);
  assert.equal(hasGlobalReadOnlyIntent(historical + '现在请修改当前测试。只读 src/Example.java。'), false);
  assert.equal(hasGlobalReadOnlyIntent('之前要求保存，现在请修改当前测试。只读 src/Example.java。'), false);
  assert.equal(hasGlobalReadOnlyIntent(historical + '现在请修改当前测试。本轮只读分析，不得修改代码。'), true);
});

test('CRUD scoped source read: exact original request remains an implementation', () => {
  assert.equal(crypto.createHash('sha256').update(CRUD_SCOPED_SOURCE_PROMPT).digest('hex'), '6adaeb903d435ab66acd789c27c3bab434dccb613359ddcf2b501e400cc7158c');
  assert.equal(hasGlobalReadOnlyIntent(CRUD_SCOPED_SOURCE_PROMPT), false);
});

test('CRUD scoped source read: implementation and contract/helper reading stay local', () => {
  for (const prompt of [
    '本轮写入只限原有两个文件：src/Test.java、src/spec.md。请只读这些直接实现和请求/响应/字典/Excel合同。',
    '本次写入仅限以下2个文件。仅读这些直接实现和接口合同。',
    '修复这两个测试。请只读上述相关实现及请求/响应合同。',
    '我明确授权你修改两个文件。只读所需局部helper、请求合同。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
});

test('CRUD scoped source read: global prohibitions, questions and quotations stay read-only', () => {
  const scope = '本轮写入只限原有两个文件';
  const reading = '请只读这些直接实现和请求/响应/字典/Excel合同。';
  const fence = String.fromCharCode(96).repeat(3);
  for (const prompt of [
    reading,
    '只读所需局部helper、请求合同。',
    CRUD_SCOPED_SOURCE_PROMPT + '\n不要修改代码。',
    CRUD_SCOPED_SOURCE_PROMPT + '\n本轮只读分析。',
    CRUD_SCOPED_SOURCE_PROMPT + '\n禁止修改任何文件。',
    scope + '？' + reading,
    '是否' + scope + '？' + reading,
    '讨论' + scope + '的方案。' + reading,
    '“' + scope + '”。' + reading,
    '文档示例：\n' + scope + '。\n' + reading,
    fence + 'text\n' + scope + '。\n' + fence + '\n' + reading,
    '修改测试？' + reading,
    '如何修改测试？' + reading,
    '“\n修改测试。\n”\n' + reading,
    fence + 'text\n修改测试。\n' + fence + '\n' + reading,
    '本轮允许修改下列两个文件。本轮' + reading,
    '本轮写入只限原有两个文件。只读当前数据库。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});


import {
  abandonClaimedProtectedExecutionRecovery,
  claimProtectedExecutionRecovery,
  classifyPinnedDshPromptBody,
  digestProductionTaskAuthorityBinding,
  digestDirectUserTextContent,
  EXECUTION_CONTEXT_TTL_MS,
  forwardClaimedProtectedExecutionRecovery,
  hasGlobalReadOnlyIntent,
  hasDirectControlledPreparationIntent,
  hasUiInteractionWriteIntent,
  issueProtectedExecutionRecoveryPermit,
  prepareProtectedExecutionContext,
  PROTECTED_EXECUTION_RECOVERY_MODE,
  readProtectedExecutionContext,
  readProtectedExecutionRecoveryStatus,
  sha256,
  unparsedPromptAdvance,
  validateProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import {
  assertHeadlessTaskspaceOwner,
  prepareHeadlessExecutionFromEnvironment,
  validateAccessWiringContinuationSeedReceipt,
  validateBackendContinuationSeedReceipt,
  validateCrossLayerContinuationSeedReceipt,
  validateDatabaseContinuationSeedReceipt,
} from '../docker/harness/forge-prepare-headless-execution.mjs';
import {
  beginForgeDeliveryPhase,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState,
  resolveForgeDeliveryPhase,
  writeForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { buildForgeDeliveryPhasePrompt } from '../docker/harness/forge-delivery-phase-response.mjs';
import { canonicalStringify, compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { sourceTransitionCanonicalDigest } from '../docker/harness/taskspace-policy.mjs';
import { createBrokerExecutionContextResolver } from '../docker/harness/forge-phase-budget-guard.mjs';

test('global read-only intent does not promote local scope exclusions across clauses', () => {
  for (const prompt of [
    '只读',
    '只读分析事故调查页面',
    '只读方式分析。只读角色在此不出现任何可提交的编辑入口。',
    '只读角色在此不出现任何可提交的编辑入口。不要修改代码。',
    '只给方案',
    '只给修复方案，不要修改代码',
    '分析这个模块',
    '不要改任何文件',
    '不要修改代码',
    '不要执行',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
  for (const prompt of [
    '继续修改。只读角色在此不出现任何可提交的编辑入口"',
    '继续修改。只读 角色在此不出现任何可提交的编辑入口。',
    '修复前端常量。不要跑后端验证，本轮只改上述前端常量。',
    '不要修改数据库迁移/后端，只改前端',
    '分析后修复这个实现',
    '修改事故调查页面，检查测试结果',
    '修复前端。检查现有类型声明。',
    '事故事件管理中，事故事件调查菜单页面去掉待办调查、进行中、已完成、全部调查这四个 Tab 筛选。请保留已经完成的改动，先同步最新项目代码、解决冲突，检查通过后发布。',
    '发布：事故事件管理中，事故事件调查菜单页面去掉待办调查、进行中、已完成、全部调查这四个 Tab 筛选。保留已经完成的改动，先同步最新项目代码、解决冲突，检查通过后完成发布。',
    '移除事故调查筛选，验证通过后发版。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
});

test('scoped method context inspection preserves explicit file-edit permission', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-deploy-cas-callers-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const request = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-deploy-cas-callers-prompt.md', import.meta.url), 'utf8');
  for (const prompt of [
    request,
    '本轮允许修改下列9个精确文件。只读这些方法前后必要上下文和相关POM。',
    '本次允许修改以下文件。只读取相关函数的上下文。',
    '继续修复发布接口。仅读取上述调用方上下文及相关源码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
});

test('method context inspection cannot override global read-only instructions', () => {
  for (const prompt of [
    '只读这些方法前后必要上下文和相关POM。',
    '本轮允许修改下列9个精确文件。只读这些方法前后必要上下文和相关POM。不要修改任何文件。',
    '本轮允许修改下列9个精确文件。本轮只读这些方法前后必要上下文和相关POM。',
    '讨论是否允许修改下列文件。只读这些方法上下文。',
    '继续修复发布接口。只读当前数据库。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

test('view-details tab behavior describes a UI change rather than a read-only inspection', () => {
  for (const prompt of ['查看详情显示当前状态的tab页', '打开详情时默认选中当前状态对应的页签。']) {
    assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  }
  for (const prompt of ['只查看详情页，不修改代码', '查看详情是否显示当前状态的tab页',
    '查看详情显示当前状态的tab页？', '查看详情显示当前状态的tab页。不要修改代码。']) {
    assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
  }
});

test('UI behavior preservation after its object retains the requested tab change', () => {
  for (const prompt of [
    '查看详情时默认显示第一个 tab 页，其他行为保持不变。',
    '打开详情时默认选中当前状态对应的页签，其余功能保持不变。',
  ]) {
    assert.equal(hasUiInteractionWriteIntent(prompt), true, prompt);
    assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
    for (const restriction of ['不要修改代码。', '本轮只读分析。']) {
      assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, `${prompt} ${restriction}`);
    }
  }
  for (const prompt of [
    '只查看详情页，其他行为保持不变。',
    '查看详情是否默认显示第一个 tab 页，其他行为保持不变。',
    '查看详情时默认显示第一个 tab 页？其他行为保持不变。',
  ]) {
    assert.equal(hasUiInteractionWriteIntent(prompt), false, prompt);
    assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
  }
});

test('changed-check scope with jike does not cancel a separate repair request', () => {
  for (const prompt of [
    '请修复事故页面。只检查这次改了的地方即可。',
    '请修改详情页。仅验证本次修改即可。',
  ]) {
    assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
    for (const restriction of ['不要修改代码。', '本轮只读分析。']) {
      assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, `${prompt} ${restriction}`);
    }
  }
  for (const prompt of [
    '只检查这次改了的地方即可。',
    '能否修复事故页面？只检查这次改了的地方即可。',
    '本轮只检查这次改了的地方即可。请修复事故页面。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

test('local preservation and changed-check limits retain explicit UI and repair intent', () => {
  const uiRequests = [
    '查看详情时默认显示第一个 tab 页。并保持其他行为不变',
    '查看详情时默认显示第一个 tab 页，并保持其他行为不变。',
  ];
  const repairRequests = [
    '请修复事故页面。只检查这次改了的地方。',
    '请修复事故页面。只检查本次修改。',
  ];
  for (const prompt of uiRequests) {
    assert.equal(hasUiInteractionWriteIntent(prompt), true, prompt);
    assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  }
  for (const prompt of repairRequests) {
    assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  }
  for (const prompt of [...uiRequests, ...repairRequests]) {
    for (const restriction of ['不要修改代码。', '本轮只读分析。']) {
      assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, `${prompt} ${restriction}`);
    }
  }
  for (const prompt of [
    '只查看详情页，并保持其他行为不变。',
    '查看详情是否默认显示第一个 tab 页，并保持其他行为不变。',
    '查看详情时默认显示第一个 tab 页？并保持其他行为不变。',
    '请问能否查看详情时默认显示第一个 tab 页，并保持其他行为不变。',
  ]) assert.equal(hasUiInteractionWriteIntent(prompt), false, prompt);
  for (const prompt of [
    '只查看详情页，并保持其他行为不变。',
    '查看详情是否默认显示第一个 tab 页，并保持其他行为不变。',
    '查看详情时默认显示第一个 tab 页？并保持其他行为不变。',
    '只检查这次改了的地方。',
    '请修复事故页面。只分析问题，不要修改代码。',
    '能否修复事故页面？只检查这次改了的地方。',
    '是否允许修改事故页面？只检查这次改了的地方。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

test('current-round affected verification: original sample recovery request retains implementation', async () => {
  const prompt = (await readFile(new URL('./fixtures/consistency-samples-path-recovery-01-prompt.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  assert.equal(sha256(Buffer.from(prompt)), '6d15ccddf9754ae1762e21f2fa4f145440ee11d120ae7f2902ca4982d0ef38f9');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
});

test('current-round affected verification: nearby scopes require an independent implementation request', () => {
  for (const scope of [
    '只检查本轮及直接受影响的部分。',
    '只检查本次及直接受影响的范围。',
    '仅检查此次和直接受影响部分。',
    '只检查当前与受影响的范围。',
  ]) {
    assert.equal(hasGlobalReadOnlyIntent(`请修复现有表单。${scope}`), false, scope);
    assert.equal(hasGlobalReadOnlyIntent(scope), true, 'a verification limit alone grants no implementation exception');
  }
});

test('current-round affected verification: explicit turn restrictions still win', async () => {
  const prompt = await readFile(new URL('./fixtures/consistency-samples-path-recovery-01-prompt.md', import.meta.url), 'utf8');
  for (const restriction of [
    '本轮只检查不改。',
    '本轮只读分析。',
    '不要修改任何文件。',
    '禁止写入。',
  ]) assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
});

test('scoped verification after implementation does not make the whole request read-only', () => {
  const preparationPrompt = "请继续完成当前消防管理任务的第 8 阶段跨层验收，保留已接受的前七阶段和已有有效验证结果。\n\n上次准备作业 6ce37ef3-b13d-41a7-aa4f-47c0e454bbce 的 V1.0.20261010 校验失败，现已定位到平台测试库生命周期问题：生产库没有 V10；一个此前准备成功但尚未发布的候选把旧 V10 留在测试库，随后又被保存成了新候选的恢复基线。平台 Runner 已修复这个问题，并把恢复点重新绑定到首次 V10 候选开始前的原始健康快照；该快照已核验 216 条迁移全部成功、没有 V10。这里只纠正了受保护的恢复点登记，尚未执行数据库还原或新的迁移。\n\n因此，上一条要求你寻找“已发布的原 V10”再改业务迁移的前提已被新证据纠正。现在请使用当前已接受的消防候选源码，通过现有受控 prepare 正常恢复测试库并验证迁移；这次平台运行版本和恢复点已有实际变化，可以执行这一轮必要验证。不要修改生产迁移历史、猜造原始 SQL、凑校验值、清空数据库或降低检查标准，也不要仅为这次平台修复重做业务源码。先取得准备作业的真实终态，不要把请求超时当作作业失败，不要并发或重复提交准备。\n\n真实准备通过后，按已确认的消防需求继续完成角色允许与拒绝、租户及组织范围、核心 CRUD 和审批、审计、逻辑删除、Long ID、中英双语的必要运行验收；此前一个消防设备 GET 和一个数据库探测只算初步探测，不能代替完整消防验收。若出现具体业务缺陷，由你在原 Harness 对话中修复，只检查直接受影响内容；沿现有正常交接推进受控发布，不重新开始八阶段。\n\n本轮仍只限消防管理。浏览器、截图和页面 UAT 保持不执行；外部火警和 DCS 没有真实连通证据的，明确标记未验证。每个结论区分实际通过、失败与未覆盖，不把本次平台镜像更新当作消防验收完成。\n";
  assert.equal(hasGlobalReadOnlyIntent(preparationPrompt), false);
  assert.equal(hasGlobalReadOnlyIntent(preparationPrompt + "本轮只读分析，不执行任何操作。"), true);
  for (const prompt of [
    '请直接完成实施，只检查这次变更及直接影响的范围：lint、类型检查、相关测试及确有必要的构建。',
    '修改前端工具。只检查本次改动及直接影响的范围，不重跑后端。',
    '修改这一个后端测试类，只检查对应的测试类。',
    '只修改这个工具和它的测试。仅检查当前修改的文件。',
    '继续当前任务：沿当前候选继续检查点、有效回执复核和受控发布。如合入了其他人的新提交，只检查真实受影响部分。',
    '继续受控发布。只检查直接受影响的文件。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  for (const prompt of [
    '只检查这次变更及直接影响的范围。',
    '只检查对应的测试类。',
    '修改对应测试类的方案。只检查对应的测试类，不要修改代码。',
    '修改前端工具。只检查本次改动。不要修改代码。',
    '请直接完成实施。只读分析。',
    '修复前端工具。只给方案。',
    '只检查真实受影响部分。',
    '继续受控发布的方案讨论。只检查真实受影响部分。',
    '沿当前候选继续检查点。只检查真实受影响部分。不要修改代码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

const policyPath = path.resolve('docker/harness/forge-execution-policy.json');
test('read-only historical evidence does not revoke an explicit current repair', () => {
  for (const prompt of [
    '现在继续修复第三批并提交、集成、发布。只读旧回执，不重跑旧失败。只检查本轮改动和直接受影响的查询。',
    '继续修复列表查询。仅读取历史日志，不改写历史失败。',
    '修改页面默认组织。只读取原回执。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  for (const prompt of [
    '只读旧回执。',
    '现在继续修复的方案讨论。只读旧回执。不要修改代码。',
    '现在继续修复列表。只读分析。',
    '现在继续修复列表。只读旧回执。不要修改代码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

test('a read-only file digest fact does not turn review preparation into a read-only command', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-dual-review-recovery-prepare-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-dual-review-recovery-prepare-prompt.md', import.meta.url), 'utf8');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  const fact = `只读需求文件 docs/contract.json 的 SHA256 仍为 ${'a'.repeat(64)}`;
  for (const text of [
    `继续完成当前修复。${fact}。`,
    `继续完成当前修复。只读参考文件 docs/reference.json 的 SHA-256 为 ${'B'.repeat(64)}。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    `${prompt}\n本轮只读分析。`,
    `${prompt}\n不要修改任何文件。`,
    `继续完成当前修复。请${fact}。`,
    `继续完成当前修复。本轮${fact}。`,
    '继续完成当前修复。只读需求文件 docs/contract.json。',
    `继续完成当前修复。${fact} 并只读分析。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('bounded source reading does not cancel an explicit authorized implementation', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-keep-version-implementation-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  for (const prompt of [
    await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-keep-version-implementation-prompt.md', import.meta.url), 'utf8'),
    '修改这个测试。只读取直接相关源码。',
    '已获授权编写两个测试文件。只读取直接相关源码。',
    '本轮已授权创建集成测试。仅读取相关的源文件。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  for (const prompt of [
    '只读取直接相关源码。',
    '仅读取相关的源文件。',
    '修改这个测试的方案讨论。只读取直接相关源码。不要修改代码。',
    '已获授权编写两个测试文件。只读取直接相关源码。不要修改代码。',
    '已获授权编写两个测试文件。只读分析。',
    '已获授权编写两个测试文件。只给方案。',
    '已获授权编写两个测试文件的方案讨论。只读取直接相关源码。',
    '之前已获授权编写两个测试文件。只读取直接相关源码。',
    '文档写着：已获授权编写两个测试文件。只读取直接相关源码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});

test('read-only reference headings preserve an explicit repair inside an existing fixture', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-persistence-fault-prompt.md', import.meta.url)) || !existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-persistence-test-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-persistence-fault-prompt.md', import.meta.url), 'utf8');
  const compileFix = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-persistence-test-prompt.md', import.meta.url), 'utf8');
  for (const text of [
    prompt,
    compileFix,
    '请在现有测试中只修这两处类型。只读references包括两个依赖文件。',
    '请在现有集成夹具中修复回滚测试。只读 references 包括两个依赖文件。',
    '请在既有临时MySQL/Redis、真实登录和真实API集成夹具中修复这一点。只读references包括实际调用链。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    '只读references包括实际调用链。',
    '之前请在现有夹具中修复测试。只读references包括实际调用链。',
    '文档写着：请在现有夹具中修复测试。只读references包括实际调用链。',
    '是否在现有夹具中修复测试？只读references包括实际调用链。',
    `${prompt}\n不要修改任何文件。`,
    `${prompt}\n本轮只读分析。`,
    `${compileFix}\n不要修改任何文件。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('bounded explicit modification keeps read-only citations scoped to references', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-api-rbac-rejected-edit-recovery-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-api-rbac-rejected-edit-recovery-prompt.md', import.meta.url), 'utf8');
  for (const text of [
    prompt,
    '我明确授权你仅修改当前文件。只读引用：已有测试。',
    '已授权只修复调用连接。只读引用 src/Example.java。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    '只读引用：已有测试。',
    '之前我明确授权你仅修改当前文件。只读引用：已有测试。',
    '文档写着：我明确授权你仅修改当前文件。只读引用：已有测试。',
    '是否我明确授权你仅修改当前文件？只读引用：已有测试。',
    '我明确授权你仅修改当前文件的方案讨论。只读引用：已有测试。',
    `${prompt}\n不要修改任何文件。`,
    `${prompt}\n本轮只读分析。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('source-only correction preserves scoped read-only comparison and forbids global writes when requested', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-http-crypto-source-correction-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-http-crypto-source-correction-prompt.md', import.meta.url), 'utf8');
  for (const text of [
    prompt,
    '本次仅纠正当前测试。只读核对原IDOR helper与生产接收方。',
    '请先准备任务，再仅修复当前测试。只读核对现有源码。',
    '修复调用连接。只读比对已有参考实现。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    '只读核对原IDOR helper与生产接收方。',
    '之前本次仅纠正当前测试。只读核对现有源码。',
    '文档写着：本次仅纠正当前测试。只读核对现有源码。',
    '是否本次仅纠正当前测试？只读核对现有源码。',
    '本次仅纠正当前测试的方案讨论。只读核对现有源码。',
    '修复当前测试。本轮只读核对现有源码。',
    '修复当前测试。只读核对生产数据。',
    `${prompt}\n不要修改任何文件。`,
    `${prompt}\n本轮只读分析。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('read-only fixture references preserve direct owner implementation authorization', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-permission-resume-after-preparation-prompt.md', import.meta.url)) || !existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-authoritative-bootstrap-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-authoritative-bootstrap-prompt.md', import.meta.url), 'utf8');
  const optlock = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-permission-resume-after-preparation-prompt.md', import.meta.url), 'utf8');
  for (const text of [prompt,
    optlock,
    '我明确授权你实施测试初始化修复。请只读参考该夹具。',
    '请只读参考该夹具。我明确授权你实施测试初始化修复。',
    '修改当前测试。请只读参考该夹具。',
    '修改当前测试。请只读参考已有通过的其他模块测试。',
    '我明确授权你修复页面。只读参考 src/example.ts 的调用方式。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    '请只读参考该夹具。',
    '只读参考已有通过的其他模块测试。',
    '只读参考 src/example.ts 的调用方式。',
    '之前我明确授权你实施测试初始化修复。请只读参考该夹具。',
    '文档写着：我明确授权你实施测试初始化修复。请只读参考该夹具。',
    '我明确授权你实施测试初始化修复的方案讨论。请只读参考该夹具。',
    '是否我明确授权你实施测试初始化修复？请只读参考该夹具。',
    `${prompt}\n不要修改任何文件。`,
    `${prompt}\n本轮只读分析。`,
    `${prompt}\n只给方案。`,
    `${optlock}\n不要修改任何文件。`,
    `${optlock}\n本轮只读分析。`,
    '我明确授权你修复页面。本轮只读参考 src/example.ts 的调用方式。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('authorized preparation followed by repair permits bounded reads of named source files', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-controlled-query-deterministic-test-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-controlled-query-deterministic-test-prompt.md', import.meta.url), 'utf8');
  for (const text of [
    prompt,
    '我明确授权你先 prepare，再只修当前测试。只读实际 support/DbDialectFactory.java、support/MySqlDialect.java。',
    '修改当前测试。只读 src/Example.java。',
    '只读 `src/Example.java`。我明确授权你先准备，然后修复当前测试。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    '只读实际 support/DbDialectFactory.java、support/MySqlDialect.java。',
    '之前我明确授权你先 prepare，再只修当前测试。只读 src/Example.java。',
    '文档写着：我明确授权你先 prepare，再只修当前测试。只读 src/Example.java。',
    '我明确授权你先 prepare，再只修当前测试的方案讨论。只读 src/Example.java。',
    '是否我明确授权你先 prepare，再只修当前测试？只读 src/Example.java。',
    '我明确授权你先 prepare，再只修当前测试。本轮只读 src/Example.java。',
    `${prompt}\n不要修改任何文件。`,
    `${prompt}\n本轮只读分析。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('reading status in an authorized metadata sequence is not global read-only', async (t) => {
  if (!existsSync(new URL('../docs/long-tasks/acceptance-20260929/coverage-cas-concurrent-resume-prompt.md', import.meta.url))) return t.skip('Private historical prompt is not included in the public distribution.');
  for (const prompt of [
    '创建交付状态记录。只读当前状态。',
    '先初始化交付状态；只读状态。',
    '按原请求完成coverage-cas-concurrent-20260930-01：初始化；只读状态；成功者原样幂等重放。',
    await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-cas-concurrent-resume-prompt.md', import.meta.url), 'utf8'),
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), false, prompt);
  for (const prompt of [
    '只读状态。',
    '只读当前状态。',
    '初始化交付状态的方案。只读状态。',
    '先初始化交付状态。只读分析。',
    '先初始化交付状态。只读状态。不要写入。',
    '创建交付状态记录。只读状态。不要修改代码。',
  ]) assert.equal(hasGlobalReadOnlyIntent(prompt), true, prompt);
});
const testShadowPolicyPath = path.resolve(
  'tests/fixtures/forge-harness-behavior-evals/execution-policy.test-shadow.json',
);
const phaseCatalog = JSON.parse(await readFile(new URL(
  '../docker/harness/skills/forge-task-router/references/phase-profiles.json',
  import.meta.url,
), 'utf8'));
const actorUserId = '123e4567-e89b-42d3-a456-426614174000';

async function currentPidNamespace() {
  return process.platform === 'linux' ? readlink('/proc/self/ns/pid') : null;
}

test('protected headless preparation must use the TaskSpace owner identity', () => {
  const directory = (uid) => ({
    uid,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  assert.doesNotThrow(() => assertHeadlessTaskspaceOwner(directory(1000), 1000));
  assert.throws(
    () => assertHeadlessTaskspaceOwner(directory(1000), 0),
    /must run as the TaskSpace owner/u,
  );
  assert.throws(() => assertHeadlessTaskspaceOwner({
    uid: 1000,
    isDirectory: () => true,
    isSymbolicLink: () => true,
  }, 1000), /ordinary directory/u);
});

test('historical completion is an exact optional read-only context binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-historical-completion-'));
  const now = Date.parse('2026-09-01T00:01:00.000Z');
  const request = authenticated(classifyPinnedDshPromptBody(promptBody({
    rpcId: 'rpc:historical-context',
    content: [{ type: 'text', text: '继续执行。' }],
  }), 'session.prompt'), 'request-historical-context');
  const previousCompletion = {
    schemaVersion: 1,
    kind: 'historical-code-acceptance',
    projectSlug: metadata.projectSlug,
    taskId: metadata.taskId,
    actorUserId,
    actorUsername: 'alice',
    conversationId: metadata.conversationId,
    dshSessionId: 'session-one',
    sourceCommit: 'a'.repeat(40),
    workspaceFingerprint: 'b'.repeat(64),
    contractId: 'c'.repeat(64),
    acceptedAt: '2026-09-01T00:00:00.000Z',
    recordDigest: `sha256:${'d'.repeat(64)}`,
    verdictDigest: `sha256:${'e'.repeat(64)}`,
    gateDigest: `sha256:${'f'.repeat(64)}`,
  };
  try {
    const context = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request, policyPath, previousCompletion, now,
    });
    assert.equal(context.authorityClass, 'production-read-only');
    assert.deepEqual(context.ownedPaths, []);
    assert.deepEqual(context.previousCompletion, previousCompletion);
    const { idempotent: _idempotent, refreshed: _refreshed, ...protectedContext } = context;
    assert.equal(validateProtectedExecutionContext(protectedContext, now), protectedContext);
    const { previousCompletion: _previousCompletion, ...legacy } = protectedContext;
    assert.equal(validateProtectedExecutionContext(legacy, now), legacy);

    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: path.join(root, 'identity'), projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request, policyPath, previousCompletion: { ...previousCompletion, dshSessionId: 'different-session' }, now,
    }), (error) => error.code === 'EXECUTION_PREVIOUS_COMPLETION_INVALID');
    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: path.join(root, 'digest'), projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request, policyPath, previousCompletion: { ...previousCompletion, gateDigest: 'f'.repeat(64) }, now,
    }), (error) => error.code === 'EXECUTION_PREVIOUS_COMPLETION_INVALID');
    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: path.join(root, 'writer'), projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request, policyPath: testShadowPolicyPath, previousCompletion, now,
      trustedPolicyInput: {
        profile: 'test-shadow', sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete', phaseAuthority: phaseAuthority('requirements'),
      },
    }), (error) => error.code === 'EXECUTION_PREVIOUS_COMPLETION_INVALID');
    assert.throws(() => validateProtectedExecutionContext({
      ...protectedContext,
      previousCompletion: { ...previousCompletion, unsupported: true },
    }, now), (error) => error.code === 'EXECUTION_INPUT_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const metadata = {
  schemaVersion: 2,
  projectSlug: 'validation-project',
  taskId: 'task-context',
  actorId: 'alice',
  actorUserId,
  conversationId: 'conversation:context:001',
  accessMode: 'conversation',
  status: 'active',
};

function promptBody({ rpcId = '123e4567-e89b-42d3-a456-426614174111', content = [{ type: 'text', text: '修复分页。' }] } = {}) {
  return Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'session.prompt',
    payload: { sessionId: 'session-one', mode: 'queue', content },
  }));
}

function authenticated(request, requestId = 'request-one') {
  return {
    ...request,
    requestId,
    actorUserId,
    actorUsername: 'alice',
    conversationId: metadata.conversationId,
  };
}

function phaseAuthority(phaseId) {
  const resolved = resolveForgeDeliveryPhase({
    catalog: phaseCatalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    phaseId,
  });
  return {
    workflowId: resolved.workflowId,
    phaseId: resolved.phase.id,
    phaseIndex: resolved.phase.index,
    catalogVersion: resolved.catalogVersion,
    catalogDigest: resolved.catalogDigest,
    actionCeiling: resolved.phase.actionCeiling,
    ownedPaths: resolved.phase.ownedPaths,
    taskProfiles: resolved.phase.taskProfiles,
    requiredProfiles: resolved.phase.contractVerificationProfiles,
  };
}

function legacyFrontendPhaseAuthority() {
  const legacyCatalog = structuredClone(phaseCatalog);
  legacyCatalog.catalogVersion = '2026.09.03.4';
  const frontend = legacyCatalog.workflows
    .find((workflow) => workflow.id === 'crud-production').phases
    .find((phase) => phase.id === 'frontend');
  frontend.ownedPaths = [
    'forge-admin-ui/src/api',
    'forge-admin-ui/src/views',
  ];
  frontend.contractVerificationProfiles = frontend.contractVerificationProfiles.filter(
    (profile) => profile !== 'frontend-admin-typecheck',
  );
  frontend.hostVerificationProfiles = frontend.hostVerificationProfiles.filter(
    (profile) => profile !== 'frontend-admin-typecheck',
  );
  const resolved = resolveForgeDeliveryPhase({
    catalog: legacyCatalog,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    phaseId: 'frontend',
  });
  return {
    workflowId: resolved.workflowId,
    phaseId: resolved.phase.id,
    phaseIndex: resolved.phase.index,
    catalogVersion: resolved.catalogVersion,
    catalogDigest: resolved.catalogDigest,
    actionCeiling: resolved.phase.actionCeiling,
    ownedPaths: resolved.phase.ownedPaths,
    taskProfiles: resolved.phase.taskProfiles,
    requiredProfiles: resolved.phase.contractVerificationProfiles,
  };
}

test('legacy frontend phase authority remains admissible while the issued context keeps typecheck', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-legacy-frontend-'));
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({
      rpcId: '123e4567-e89b-42d3-a456-426614174224',
      content: [{ type: 'text', text: '实现真实 frontend CRUD 接线。' }],
    }), 'session.prompt'), 'request-legacy-frontend');
    const context = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete',
        phaseAuthority: legacyFrontendPhaseAuthority(),
      },
    });
    assert.equal(context.phaseCatalogVersion, '2026.09.03.4');
    assert.ok(context.requiredProfiles.includes('frontend-admin-typecheck'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runLinuxFlockPath(lockPath) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      '75',
      lockPath,
      '/usr/bin/true',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
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

function startLinuxExecutionStateWorker(options) {
  const moduleUrl = new URL('../docker/harness/forge-execution-context.mjs', import.meta.url).href;
  const source = `
    import {
      classifyPinnedDshPromptBody,
      prepareProtectedExecutionContext,
    } from ${JSON.stringify(moduleUrl)};
    const options = JSON.parse(
      Buffer.from(process.argv[1], 'base64url').toString('utf8'),
      (_key, value) => value?.type === 'Buffer' && Array.isArray(value.data)
        ? Buffer.from(value.data)
        : value,
    );
    const promptText = 'x'.repeat(900_000);
    for (let iteration = 0; ; iteration += 1) {
      const rpcId = 'linux-lock-worker-' + iteration;
      const body = Buffer.from(JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'session.prompt',
        payload: {
          sessionId: 'linux-lock-worker-session',
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        },
      }));
      const request = {
        ...classifyPinnedDshPromptBody(body, 'session.prompt'),
        requestId: 'linux-lock-worker-request-' + iteration,
        actorUserId: options.request.actorUserId,
        actorUsername: options.request.actorUsername,
        conversationId: options.request.conversationId,
      };
      await prepareProtectedExecutionContext({ ...options, request });
    }
  `;
  const encoded = Buffer.from(JSON.stringify(options), 'utf8').toString('base64url');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, encoded], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error, stderr }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null, stderr }));
  });
  return { child, closed };
}

test('pinned DSH session.prompt classifier binds exact body, rpc, session and text', () => {
  const body = promptBody();
  const classified = classifyPinnedDshPromptBody(body, 'session.prompt');
  assert.equal(classified.classification, 'claimable-text');
  assert.equal(classified.dshSessionId, 'session-one');
  assert.equal(classified.mode, 'queue');
  assert.equal(classified.bodyBytes, body.length);
  assert.match(classified.bodyDigest, /^[0-9a-f]{64}$/u);
  assert.equal(classified.textDigest, digestDirectUserTextContent([{ type: 'text', text: '修复分页。' }]));
});

test('image-only, subagent prompts and unknown shapes never become writer-eligible', () => {
  const image = classifyPinnedDshPromptBody(promptBody({
    content: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
  }), 'session.prompt');
  assert.equal(image.classification, 'read-only-image');

  const subagent = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: 'rpc-subagent', method: 'subagent.prompt',
    payload: { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable', content: [] },
  })), 'subagent.prompt');
  assert.equal(subagent.classification, 'read-only-subagent');

  const unknown = classifyPinnedDshPromptBody(Buffer.from('{"unexpected":true}'), 'session.prompt');
  assert.equal(unknown.classification, 'read-only-unknown');
  assert.equal(unparsedPromptAdvance('session.prompt', 20_000_000, 'too-large').classification, 'read-only-oversized');
});

test('host-owned execution state advances generation atomically and remains read-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-context-'));
  try {
    const firstRequest = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
    const first = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: firstRequest, now: Date.parse('2026-09-01T00:00:00.000Z'), policyPath,
    });
    assert.equal(first.generation, 1);
    assert.equal(first.actionCeiling, 'read-only');
    assert.deepEqual(first.ownedPaths, []);
    assert.equal(first.contract.actionCeiling, 'read-only');

    const replay = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: firstRequest, now: Date.parse('2026-09-01T00:01:00.000Z'), policyPath,
    });
    assert.equal(replay.generation, 1);
    assert.equal(replay.idempotent, true);

    const secondRequest = authenticated(classifyPinnedDshPromptBody(promptBody({ rpcId: 'rpc-second' }), 'session.prompt'), 'request-two');
    const second = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: secondRequest, now: Date.parse('2026-09-01T00:02:00.000Z'), policyPath,
    });
    assert.equal(second.generation, 2);

    const resolved = await readProtectedExecutionContext({
      projectRoot: root,
      taskMetadata: metadata,
      lookup: {
        projectSlug: metadata.projectSlug,
        taskId: metadata.taskId,
        conversationId: metadata.conversationId,
        actorUserId,
        dshSessionId: second.dshSessionId,
        rpcId: second.rpcId,
        textDigest: second.textDigest,
      },
      now: Date.parse('2026-09-01T00:03:00.000Z'),
    });
    assert.equal(resolved.executionId, second.executionId);
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
        request: secondRequest, now: Date.parse('2026-09-01T00:03:01.000Z'), policyPath,
      }),
      (error) => error.code === 'EXECUTION_CONTEXT_REPLAY_REQUIRES_READBACK',
    );

    await assert.rejects(() => readProtectedExecutionContext({
      projectRoot: root,
      taskMetadata: metadata,
      lookup: {
        projectSlug: metadata.projectSlug,
        taskId: metadata.taskId,
        conversationId: metadata.conversationId,
        actorUserId,
        dshSessionId: second.dshSessionId,
        rpcId: first.rpcId,
        textDigest: first.textDigest,
      },
      now: Date.parse('2026-09-01T00:03:00.000Z'),
    }), (error) => error.code === 'EXECUTION_CONTEXT_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only a first authorized database, frontend, access-wiring or cross-layer test-shadow execution can inherit a Controller generation floor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-database-continuation-generation-'));
  const request = authenticated(classifyPinnedDshPromptBody(promptBody({
    content: [{ type: 'text', text: '实现供应商 CRUD 并验证权限和租户边界。' }],
  }), 'session.prompt'));
  const trustedPolicyInput = {
    profile: 'test-shadow',
    sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
    caseFamily: 'crud-complete',
    phaseAuthority: phaseAuthority('database'),
  };
  const options = {
    projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
    request, policyPath: testShadowPolicyPath, trustedPolicyInput,
  };
  try {
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...options, projectRoot: path.join(root, 'production'), policyPath,
      trustedPolicyInput: undefined, minimumGeneration: 7,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...options, projectRoot: path.join(root, 'requirements'),
      trustedPolicyInput: { ...trustedPolicyInput, phaseAuthority: phaseAuthority('requirements') },
      minimumGeneration: 7,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...options, projectRoot: path.join(root, 'backend'),
      trustedPolicyInput: { ...trustedPolicyInput, phaseAuthority: phaseAuthority('backend') },
      minimumGeneration: 11,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    const accessOptions = {
      ...options,
      projectRoot: path.join(root, 'access-wiring'),
      trustedPolicyInput: { ...trustedPolicyInput, phaseAuthority: phaseAuthority('access-wiring') },
    };
    const accessFirst = await prepareProtectedExecutionContext({ ...accessOptions, minimumGeneration: 13 });
    assert.equal(accessFirst.generation, 13);
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...accessOptions, minimumGeneration: 13,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    const accessSecond = await prepareProtectedExecutionContext({
      ...accessOptions,
      request: { ...request, rpcId: 'access-rpc-2', requestId: 'access-request-2' },
    });
    assert.equal(accessSecond.generation, 14);
    const crossLayerOptions = {
      ...options,
      projectRoot: path.join(root, 'cross-layer'),
      trustedPolicyInput: { ...trustedPolicyInput, phaseAuthority: phaseAuthority('cross-layer-acceptance') },
    };
    const crossLayerFirst = await prepareProtectedExecutionContext({
      ...crossLayerOptions, minimumGeneration: 15,
    });
    assert.equal(crossLayerFirst.generation, 15);
    assert.equal(crossLayerFirst.actionCeiling, 'read-only');
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...crossLayerOptions, minimumGeneration: 15,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    const crossLayerSecond = await prepareProtectedExecutionContext({
      ...crossLayerOptions,
      request: { ...request, rpcId: 'cross-rpc-2', requestId: 'cross-request-2' },
    });
    assert.equal(crossLayerSecond.generation, 16);
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...options, minimumGeneration: 1,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    const first = await prepareProtectedExecutionContext({ ...options, minimumGeneration: 7 });
    assert.equal(first.generation, 7);
    await assert.rejects(() => prepareProtectedExecutionContext({
      ...options, minimumGeneration: 7,
    }), (error) => error.code === 'EXECUTION_GENERATION_SEED_DENIED');
    const second = await prepareProtectedExecutionContext({
      ...options,
      request: { ...request, rpcId: 'database-rpc-2', requestId: 'database-request-2' },
    });
    assert.equal(second.generation, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('access-wiring continuation seed binds six accepted artifacts and the exact phase prompt', () => {
  const digest = (character) => character.repeat(64);
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation'];
  const phases = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend', 'frontend'];
  const acceptedArtifacts = Object.fromEntries(kinds.map((kind, index) => [kind, digest(String(index + 1))]));
  const state = {
    sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
    catalogVersion: '2026.09.03.21', catalogDigest: digest('a'),
    taskId: 'eval-crud-complete', sessionId: 'session-one', stateDigest: digest('b'),
    status: 'active', currentPhaseId: 'access-wiring', currentPhaseIndex: 6,
    activeAttempt: null, lastExecutionGeneration: 12, acceptedArtifacts,
    history: kinds.map((kind, index) => ({ phaseId: phases[index], phaseIndex: index,
      decision: 'accepted', artifactDigest: acceptedArtifacts[kind] })),
  };
  const receipt = {
    schemaVersion: 'forge-delivery-access-wiring-continuation/v1',
    sourceStateSha256: digest('c'), bindingsSha256: digest('d'),
    sourceCommit: state.sourceCommit, catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest, taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: 12, nextExecutionGenerationMinimum: 13,
    inheritedArtifactDigests: { ...acceptedArtifacts },
    stateDigest: state.stateDigest, promptSha256: digest('e'), cumulativePatchSha256: digest('f'),
    inheritedStageCount: 6, newAcceptedStageCount: 0,
    newModelStarted: false, parentStateUnchanged: true,
  };
  const args = { receipt, state, promptFileSha256: digest('e'),
    sourceCommit: state.sourceCommit, taskId: state.taskId, sessionId: state.sessionId };
  assert.equal(validateAccessWiringContinuationSeedReceipt(args), 13);
  for (const changed of [
    { sourceCommit: '1'.repeat(40) }, { catalogDigest: digest('0') },
    { stateDigest: digest('0') }, { promptSha256: digest('0') },
    { nextExecutionGenerationMinimum: 14 }, { inheritedStageCount: 5 },
    { inheritedArtifactDigests: { ...acceptedArtifacts, 'frontend-implementation': digest('0') } },
  ]) assert.throws(() => validateAccessWiringContinuationSeedReceipt({
    ...args, receipt: { ...receipt, ...changed },
  }), /does not bind/u);
  for (const changed of [
    { activeAttempt: {} }, { currentPhaseId: 'frontend', currentPhaseIndex: 5 },
    { lastExecutionGeneration: 11 }, { sessionId: 'other-session' },
    { history: state.history.slice(0, 5) },
  ]) assert.throws(() => validateAccessWiringContinuationSeedReceipt({
    ...args, state: { ...state, ...changed },
  }), /does not bind/u);
});

test('cross-layer continuation seed binds seven accepted artifacts, idle phase and exact generation', () => {
  const digest = (character) => character.repeat(64);
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation',
    'access-wiring-implementation'];
  const phases = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend',
    'frontend', 'access-wiring'];
  const acceptedArtifacts = Object.fromEntries(kinds.map((kind, index) => [kind, digest(String(index + 1))]));
  const state = {
    sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
    catalogVersion: '2026.09.03.21', catalogDigest: digest('a'),
    taskId: 'eval-crud-complete', sessionId: 'session-one', stateDigest: digest('b'),
    status: 'active', currentPhaseId: 'cross-layer-acceptance', currentPhaseIndex: 7,
    activeAttempt: null, lastExecutionGeneration: 14, acceptedArtifacts,
    history: kinds.map((kind, index) => ({ phaseId: phases[index], phaseIndex: index,
      decision: 'accepted', artifactDigest: acceptedArtifacts[kind] })),
  };
  const receipt = {
    schemaVersion: 'forge-delivery-cross-layer-continuation/v1',
    sourceStateSha256: digest('c'), bindingsSha256: digest('d'),
    sourceCommit: state.sourceCommit, catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest, taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: 14, nextExecutionGenerationMinimum: 15,
    inheritedArtifactDigests: { ...acceptedArtifacts },
    stateDigest: state.stateDigest, promptSha256: digest('e'), cumulativePatchSha256: digest('f'),
    inheritedStageCount: 7, newAcceptedStageCount: 0,
    newModelStarted: false, parentStateUnchanged: true,
  };
  const args = { receipt, state, promptFileSha256: digest('e'),
    sourceCommit: state.sourceCommit, taskId: state.taskId, sessionId: state.sessionId };
  assert.equal(validateCrossLayerContinuationSeedReceipt(args), 15);
  for (const changed of [
    { sourceCommit: '1'.repeat(40) }, { catalogDigest: digest('0') },
    { stateDigest: digest('0') }, { promptSha256: digest('0') },
    { nextExecutionGenerationMinimum: 16 }, { inheritedStageCount: 6 },
    { inheritedArtifactDigests: { ...acceptedArtifacts, 'access-wiring-implementation': digest('0') } },
  ]) assert.throws(() => validateCrossLayerContinuationSeedReceipt({
    ...args, receipt: { ...receipt, ...changed },
  }), /does not bind/u);
  for (const changed of [
    { activeAttempt: {} }, { currentPhaseId: 'access-wiring', currentPhaseIndex: 6 },
    { lastExecutionGeneration: 13 }, { sessionId: 'other-session' },
    { history: state.history.slice(0, 6) },
  ]) assert.throws(() => validateCrossLayerContinuationSeedReceipt({
    ...args, state: { ...state, ...changed },
  }), /does not bind/u);
});

test('cross-layer initial prepare reads only private Controller prompt, receipt and seven artifacts', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-headless-cross-layer-continuation-'));
  const sourceCommit = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
  const sessionId = 'session-one';
  const controlDirectory = path.join(root, 'phase-control');
  const stateFile = path.join(controlDirectory, 'state.json');
  const promptFile = path.join(controlDirectory, 'current-prompt.md');
  const receiptFile = path.join(controlDirectory, 'cross-layer-continuation-receipt.json');
  const artifactsDirectory = path.join(controlDirectory, 'artifacts');
  const taskspaceRoot = path.join(root, 'taskspaces', metadata.taskId);
  try {
    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    await chmod(controlDirectory, 0o700);
    await mkdir(taskspaceRoot, { recursive: true });
    await writeFile(path.join(taskspaceRoot, 'metadata.json'), `${JSON.stringify({
      ...metadata, branch: 'task/alice/task-context', baseCommit: sourceCommit,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      accessTokenHash: '0'.repeat(64), harnessPort: 3080,
      lastCandidate: null, lastRelease: null,
    })}\n`);
    let state = createForgeDeliveryPhaseState({
      catalog: phaseCatalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
      taskId: metadata.taskId, sessionId, sourceCommit,
      now: '2026-09-01T00:00:00.000Z',
    });
    const artifacts = [];
    const fingerprint = crypto.createHash('sha256').update('').digest('hex');
    for (let index = 0; index < 7; index += 1) {
      const phase = phaseCatalog.workflows[0].phases[index];
      state = beginForgeDeliveryPhase({
        state, catalog: phaseCatalog, phaseId: phase.id,
        rpcId: `rpc-${index + 1}`, promptDigest: String(index + 1).repeat(64),
        executionGeneration: (index + 1) * 2,
        now: `2026-09-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`,
      });
      const artifact = createForgeDeliveryPhaseArtifact({
        state, catalog: phaseCatalog, phaseId: phase.id, attemptId: state.activeAttempt.attemptId,
        sourceFingerprint: fingerprint,
        changedPaths: phase.patchScope === 'phase' ? [`${phase.ownedPaths[0]}/candidate.txt`] : [],
        patchDigest: phase.patchScope === 'phase' ? fingerprint : null,
        payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, []])),
      });
      artifacts.push(artifact);
      const hostReceipts = phase.hostVerificationProfiles.map((profile) => ({
        profile, status: 'passed', receiptDigest: fingerprint, patchDigest: fingerprint,
      }));
      state = completeForgeDeliveryPhase({
        state, catalog: phaseCatalog, decision: 'accepted', artifact, hostReceipts,
        now: `2026-09-01T00:${String(index + 1).padStart(2, '0')}:30.000Z`,
      }).state;
      const artifactFile = path.join(artifactsDirectory, `${artifact.artifactKind}.json`);
      await writeFile(artifactFile, `${JSON.stringify(artifact)}\n`);
      await chmod(artifactFile, 0o600);
    }
    assert.equal(state.currentPhaseIndex, 7);
    assert.equal(state.lastExecutionGeneration, 14);
    await writeForgeDeliveryPhaseState(stateFile, state, phaseCatalog);
    const prompt = `${buildForgeDeliveryPhasePrompt({
      state, catalog: phaseCatalog,
      originalRequest: '实现供应商 CRUD 并验证权限和租户边界。', upstreamArtifacts: artifacts,
    })}\n`;
    await writeFile(promptFile, prompt);
    const receipt = {
      schemaVersion: 'forge-delivery-cross-layer-continuation/v1',
      sourceStateSha256: '1'.repeat(64), bindingsSha256: '2'.repeat(64),
      sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
      taskId: state.taskId, sessionId,
      parentLastExecutionGeneration: 14, nextExecutionGenerationMinimum: 15,
      inheritedArtifactDigests: { ...state.acceptedArtifacts },
      stateDigest: state.stateDigest,
      promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
      cumulativePatchSha256: '3'.repeat(64), inheritedStageCount: 7,
      newAcceptedStageCount: 0, newModelStarted: false, parentStateUnchanged: true,
    };
    await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`);
    await chmod(receiptFile, 0o600);
    const environment = {
      FORGE_EVAL_PROJECT_ROOT: root, PROJECT_SLUG: metadata.projectSlug,
      FORGE_TASKSPACE_ID: metadata.taskId,
      FORGE_TASKSPACE_ACTOR_USER_ID: metadata.actorUserId,
      FORGE_TASKSPACE_ACTOR_ID: metadata.actorId,
      FORGE_TASKSPACE_CONVERSATION_ID: metadata.conversationId,
      FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
      FORGE_PROTECTED_HEADLESS_RPC_ID: 'cross-rpc-1',
      FORGE_EVAL_SOURCE_COMMIT: sourceCommit, FORGE_EVAL_CASE_FAMILY: 'crud-complete',
      FORGE_EVAL_PROMPT_FILE: promptFile, FORGE_EXECUTION_POLICY_FILE: testShadowPolicyPath,
      FORGE_EVAL_PHASE_WORKFLOW_ID: 'crud-production', FORGE_EVAL_PHASE_ID: 'cross-layer-acceptance',
      FORGE_EVAL_PHASE_CATALOG_FILE: path.resolve(
        'docker/harness/skills/forge-task-router/references/phase-profiles.json',
      ),
      FORGE_EVAL_PHASE_STATE_FILE: stateFile,
      FORGE_EVAL_CROSS_LAYER_CONTINUATION_RECEIPT_FILE: receiptFile,
    };
    await writeFile(path.join(root, 'current-prompt.md'), prompt);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_EVAL_PROMPT_FILE: path.join(root, 'current-prompt.md'),
    }), /fixed phase-control layout/u);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_EVAL_ACCESS_WIRING_CONTINUATION_RECEIPT_FILE: receiptFile,
    }), /Only one fixed continuation seed/u);
    const artifactFile = path.join(artifactsDirectory, 'access-wiring-implementation.json');
    const originalArtifact = await readFile(artifactFile);
    await writeFile(artifactFile, `${JSON.stringify({
      ...artifacts[6], artifactDigest: '9'.repeat(64),
    })}\n`);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment(environment), /artifact/u);
    await writeFile(artifactFile, originalArtifact);
    const prepared = await prepareHeadlessExecutionFromEnvironment(environment);
    assert.equal(prepared.generation, 15);
    assert.equal(prepared.actionCeiling, 'read-only');
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_PROTECTED_HEADLESS_RPC_ID: 'cross-rpc-2',
    }), /does not bind/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('access-wiring initial prepare consumes only private same-directory Controller files and six real artifacts', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-headless-access-continuation-'));
  const sourceCommit = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
  const sessionId = 'session-one';
  const controlDirectory = path.join(root, 'phase-control');
  const stateFile = path.join(controlDirectory, 'state.json');
  const promptFile = path.join(controlDirectory, 'current-prompt.md');
  const receiptFile = path.join(controlDirectory, 'access-wiring-continuation-receipt.json');
  const artifactsDirectory = path.join(controlDirectory, 'artifacts');
  const taskspaceRoot = path.join(root, 'taskspaces', metadata.taskId);
  try {
    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    await chmod(controlDirectory, 0o700);
    await mkdir(taskspaceRoot, { recursive: true });
    await writeFile(path.join(taskspaceRoot, 'metadata.json'), `${JSON.stringify({
      ...metadata, branch: 'task/alice/task-context', baseCommit: sourceCommit,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      accessTokenHash: '0'.repeat(64), harnessPort: 3080,
      lastCandidate: null, lastRelease: null,
    })}\n`);
    let state = createForgeDeliveryPhaseState({
      catalog: phaseCatalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
      taskId: metadata.taskId, sessionId, sourceCommit,
      now: '2026-09-01T00:00:00.000Z',
    });
    const artifacts = [];
    const fingerprint = crypto.createHash('sha256').update('').digest('hex');
    for (let index = 0; index < 6; index += 1) {
      const phase = phaseCatalog.workflows[0].phases[index];
      state = beginForgeDeliveryPhase({
        state, catalog: phaseCatalog, phaseId: phase.id,
        rpcId: `rpc-${index + 1}`, promptDigest: String(index + 1).repeat(64),
        executionGeneration: (index + 1) * 2,
        now: `2026-09-01T00:${String(index + 1).padStart(2, '0')}:00.000Z`,
      });
      const artifact = createForgeDeliveryPhaseArtifact({
        state, catalog: phaseCatalog, phaseId: phase.id, attemptId: state.activeAttempt.attemptId,
        sourceFingerprint: fingerprint,
        changedPaths: phase.patchScope === 'phase' ? [`${phase.ownedPaths[0]}/candidate.txt`] : [],
        patchDigest: phase.patchScope === 'phase' ? fingerprint : null,
        payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, []])),
      });
      artifacts.push(artifact);
      const hostReceipts = phase.hostVerificationProfiles.map((profile) => ({
        profile, status: 'passed', receiptDigest: fingerprint, patchDigest: fingerprint,
      }));
      state = completeForgeDeliveryPhase({
        state, catalog: phaseCatalog, decision: 'accepted', artifact, hostReceipts,
        now: `2026-09-01T00:${String(index + 1).padStart(2, '0')}:30.000Z`,
      }).state;
      const artifactFile = path.join(artifactsDirectory, `${artifact.artifactKind}.json`);
      await writeFile(artifactFile, `${JSON.stringify(artifact)}\n`);
      await chmod(artifactFile, 0o600);
    }
    await writeForgeDeliveryPhaseState(stateFile, state, phaseCatalog);
    const prompt = `${buildForgeDeliveryPhasePrompt({
      state, catalog: phaseCatalog,
      originalRequest: '实现供应商 CRUD 并验证权限和租户边界。', upstreamArtifacts: artifacts,
    })}\n`;
    await writeFile(promptFile, prompt);
    const receipt = {
      schemaVersion: 'forge-delivery-access-wiring-continuation/v1',
      sourceStateSha256: '1'.repeat(64), bindingsSha256: '2'.repeat(64),
      sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
      taskId: state.taskId, sessionId,
      parentLastExecutionGeneration: 12, nextExecutionGenerationMinimum: 13,
      inheritedArtifactDigests: { ...state.acceptedArtifacts },
      stateDigest: state.stateDigest,
      promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
      cumulativePatchSha256: '3'.repeat(64),
      inheritedStageCount: 6, newAcceptedStageCount: 0,
      newModelStarted: false, parentStateUnchanged: true,
    };
    const writeReceipt = async (value) => {
      await writeFile(receiptFile, `${JSON.stringify(value)}\n`);
      await chmod(receiptFile, 0o600);
    };
    const environment = {
      FORGE_EVAL_PROJECT_ROOT: root, PROJECT_SLUG: metadata.projectSlug,
      FORGE_TASKSPACE_ID: metadata.taskId,
      FORGE_TASKSPACE_ACTOR_USER_ID: metadata.actorUserId,
      FORGE_TASKSPACE_ACTOR_ID: metadata.actorId,
      FORGE_TASKSPACE_CONVERSATION_ID: metadata.conversationId,
      FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
      FORGE_PROTECTED_HEADLESS_RPC_ID: 'access-rpc-1',
      FORGE_EVAL_SOURCE_COMMIT: sourceCommit, FORGE_EVAL_CASE_FAMILY: 'crud-complete',
      FORGE_EVAL_PROMPT_FILE: promptFile, FORGE_EXECUTION_POLICY_FILE: testShadowPolicyPath,
      FORGE_EVAL_PHASE_WORKFLOW_ID: 'crud-production', FORGE_EVAL_PHASE_ID: 'access-wiring',
      FORGE_EVAL_PHASE_CATALOG_FILE: path.resolve(
        'docker/harness/skills/forge-task-router/references/phase-profiles.json',
      ),
      FORGE_EVAL_PHASE_STATE_FILE: stateFile,
      FORGE_EVAL_ACCESS_WIRING_CONTINUATION_RECEIPT_FILE: receiptFile,
    };
    await writeReceipt(receipt);
    await writeFile(path.join(root, 'current-prompt.md'), prompt);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_EVAL_PROMPT_FILE: path.join(root, 'current-prompt.md'),
    }), /fixed phase-control layout/u);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_EVAL_BACKEND_CONTINUATION_RECEIPT_FILE: receiptFile,
    }), /Only one fixed continuation seed/u);
    const originalArtifact = await readFile(path.join(artifactsDirectory, 'frontend-implementation.json'));
    await writeFile(path.join(artifactsDirectory, 'frontend-implementation.json'),
      `${JSON.stringify({ ...artifacts[5], artifactDigest: '9'.repeat(64) })}\n`);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment(environment), /artifact/u);
    await writeFile(path.join(artifactsDirectory, 'frontend-implementation.json'), originalArtifact);
    const prepared = await prepareHeadlessExecutionFromEnvironment(environment);
    assert.equal(prepared.generation, 13);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_PROTECTED_HEADLESS_RPC_ID: 'access-rpc-2',
    }), /does not bind/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('database continuation seed receipt binds only the inherited idle state and exact prompt bytes', () => {
  const digest = (character) => character.repeat(64);
  const state = {
    sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
    catalogVersion: '2026.09.03.21', catalogDigest: digest('a'),
    taskId: 'eval-crud-complete', sessionId: 'session-one',
    stateDigest: digest('b'), status: 'active', currentPhaseId: 'database',
    currentPhaseIndex: 2, activeAttempt: null, lastExecutionGeneration: 4,
    acceptedArtifacts: {
      'requirements-contract': digest('c'), 'domain-api-contract': digest('d'),
    },
    history: [
      { phaseId: 'requirements', decision: 'accepted', artifactDigest: digest('c'), receiptDigest: digest('e') },
      { phaseId: 'domain-contract', decision: 'accepted', artifactDigest: digest('d'), receiptDigest: digest('f') },
    ],
  };
  const receipt = {
    schemaVersion: 'forge-delivery-database-continuation/v1',
    phaseId: 'database', phaseIndex: 2,
    sourceStateSha256: digest('1'), sourceStateDigest: digest('2'),
    sourceCommit: state.sourceCommit, catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest, taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: 6, nextExecutionGenerationMinimum: 7,
    inheritedArtifactDigests: { ...state.acceptedArtifacts },
    inheritedAcceptedReceiptDigests: { requirements: digest('e'), 'domain-contract': digest('f') },
    parentDatabaseFailureReceiptDigests: [digest('3'), digest('4')],
    stateDigest: state.stateDigest, promptSha256: digest('5'),
    inheritedStageCount: 2, newAcceptedStageCount: 0,
    modelStarted: false, parentStateUnchanged: true,
  };
  const args = {
    receipt, state, promptFileSha256: digest('5'),
    sourceCommit: state.sourceCommit, taskId: state.taskId, sessionId: state.sessionId,
  };
  assert.equal(validateDatabaseContinuationSeedReceipt(args), 7);
  for (const changed of [
    { stateDigest: digest('9') }, { promptSha256: digest('9') },
    { sourceCommit: '1'.repeat(40) }, { nextExecutionGenerationMinimum: 8 },
    { inheritedArtifactDigests: { ...receipt.inheritedArtifactDigests, 'domain-api-contract': digest('9') } },
    { parentDatabaseFailureReceiptDigests: [] },
  ]) assert.throws(() => validateDatabaseContinuationSeedReceipt({
    ...args, receipt: { ...receipt, ...changed },
  }), /does not bind/u);
  assert.throws(() => validateDatabaseContinuationSeedReceipt({
    ...args, state: { ...state, activeAttempt: {} },
  }), /does not bind/u);
});

test('backend continuation seed binds five accepted phases and the frontend generation floor', () => {
  const digest = (character) => character.repeat(64);
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation'];
  const acceptedArtifacts = Object.fromEntries(kinds.map((kind, index) => [kind, digest(String(index + 1))]));
  const state = {
    sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
    catalogVersion: '2026.09.03.21', catalogDigest: digest('a'),
    taskId: 'eval-crud-complete', sessionId: 'session-one', stateDigest: digest('b'),
    status: 'active', currentPhaseId: 'frontend', currentPhaseIndex: 5,
    activeAttempt: null, lastExecutionGeneration: 10, acceptedArtifacts,
    history: kinds.map((kind, index) => ({ phaseIndex: index, decision: 'accepted',
      artifactDigest: acceptedArtifacts[kind] })),
  };
  const receipt = {
    schemaVersion: 'forge-delivery-backend-finalize-continuation/v1',
    sourceStateSha256: digest('c'), bindingsSha256: digest('d'),
    backendHostReceiptsSha256: digest('e'), cumulativePatchSha256: digest('f'),
    sourceCommit: state.sourceCommit, catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest, taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: 10, nextExecutionGenerationMinimum: 11,
    inheritedArtifactDigests: Object.fromEntries(kinds.slice(0, 4).map((kind) => [kind, acceptedArtifacts[kind]])),
    backendArtifactDigest: acceptedArtifacts['backend-implementation'],
    stateDigest: state.stateDigest, promptSha256: digest('9'),
    inheritedStageCount: 4, finalizedBackendStageCount: 1,
    newModelStarted: false, parentStateUnchanged: true,
  };
  const args = { receipt, state, promptFileSha256: digest('9'),
    sourceCommit: state.sourceCommit, taskId: state.taskId, sessionId: state.sessionId };
  assert.equal(validateBackendContinuationSeedReceipt(args), 11);
  for (const changed of [
    { promptSha256: digest('0') }, { backendArtifactDigest: digest('0') },
    { nextExecutionGenerationMinimum: 10 }, { inheritedStageCount: 5 },
  ]) assert.throws(() => validateBackendContinuationSeedReceipt({
    ...args, receipt: { ...receipt, ...changed },
  }), /does not bind/u);
  assert.throws(() => validateBackendContinuationSeedReceipt({
    ...args, state: { ...state, activeAttempt: {} },
  }), /does not bind/u);
  assert.throws(() => validateBackendContinuationSeedReceipt({
    ...args, state: { ...state, currentPhaseId: 'backend', currentPhaseIndex: 4 },
  }), /does not bind/u);
});

test('protected headless database continuation prepares generation 7 only from its private Controller receipt', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-headless-database-continuation-'));
  const sourceCommit = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
  const sessionId = 'session-one';
  const stateFile = path.join(root, 'control', 'state.json');
  const promptFile = path.join(root, 'current-prompt.md');
  const receiptFile = path.join(root, 'continuation-receipt.json');
  const taskspaceRoot = path.join(root, 'taskspaces', metadata.taskId);
  try {
    await mkdir(taskspaceRoot, { recursive: true });
    await writeFile(path.join(taskspaceRoot, 'metadata.json'), `${JSON.stringify({
      ...metadata, branch: 'task/alice/task-context', baseCommit: sourceCommit,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      accessTokenHash: '0'.repeat(64), harnessPort: 3080,
      lastCandidate: null, lastRelease: null,
    })}\n`);
    let state = createForgeDeliveryPhaseState({
      catalog: phaseCatalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
      taskId: metadata.taskId, sessionId, sourceCommit,
      now: '2026-09-01T00:00:00.000Z',
    });
    const artifacts = [];
    for (const generation of [1, 2]) {
      const phase = phaseCatalog.workflows[0].phases[state.currentPhaseIndex];
      state = beginForgeDeliveryPhase({
        state, catalog: phaseCatalog, phaseId: phase.id,
        rpcId: `rpc-${generation}`, promptDigest: String(generation).repeat(64),
        executionGeneration: generation,
        now: `2026-09-01T00:0${generation}:00.000Z`,
      });
      const artifact = createForgeDeliveryPhaseArtifact({
        state, catalog: phaseCatalog, phaseId: phase.id, attemptId: state.activeAttempt.attemptId,
        sourceFingerprint: crypto.createHash('sha256').update('').digest('hex'),
        changedPaths: [], patchDigest: null,
        payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, []])),
      });
      artifacts.push(artifact);
      state = completeForgeDeliveryPhase({
        state, catalog: phaseCatalog, decision: 'accepted', artifact, hostReceipts: [],
        now: `2026-09-01T00:0${generation}:30.000Z`,
      }).state;
    }
    await writeForgeDeliveryPhaseState(stateFile, state, phaseCatalog);
    const prompt = `${buildForgeDeliveryPhasePrompt({
      state, catalog: phaseCatalog,
      originalRequest: '实现供应商 CRUD 并验证权限和租户边界。',
      upstreamArtifacts: artifacts,
    })}\n`;
    await writeFile(promptFile, prompt);
    const receipt = {
      schemaVersion: 'forge-delivery-database-continuation/v1',
      phaseId: 'database', phaseIndex: 2,
      sourceStateSha256: '1'.repeat(64), sourceStateDigest: '2'.repeat(64),
      sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
      taskId: state.taskId, sessionId,
      parentLastExecutionGeneration: 6, nextExecutionGenerationMinimum: 7,
      inheritedArtifactDigests: { ...state.acceptedArtifacts },
      inheritedAcceptedReceiptDigests: {
        requirements: state.history[0].receiptDigest,
        'domain-contract': state.history[1].receiptDigest,
      },
      parentDatabaseFailureReceiptDigests: ['3'.repeat(64), '4'.repeat(64)],
      stateDigest: state.stateDigest,
      promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
      inheritedStageCount: 2, newAcceptedStageCount: 0,
      modelStarted: false, parentStateUnchanged: true,
    };
    const environment = {
      FORGE_EVAL_PROJECT_ROOT: root, PROJECT_SLUG: metadata.projectSlug,
      FORGE_TASKSPACE_ID: metadata.taskId,
      FORGE_TASKSPACE_ACTOR_USER_ID: metadata.actorUserId,
      FORGE_TASKSPACE_ACTOR_ID: metadata.actorId,
      FORGE_TASKSPACE_CONVERSATION_ID: metadata.conversationId,
      FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
      FORGE_PROTECTED_HEADLESS_RPC_ID: 'database-rpc-1',
      FORGE_EVAL_SOURCE_COMMIT: sourceCommit, FORGE_EVAL_CASE_FAMILY: 'crud-complete',
      FORGE_EVAL_PROMPT_FILE: promptFile, FORGE_EXECUTION_POLICY_FILE: testShadowPolicyPath,
      FORGE_EVAL_PHASE_WORKFLOW_ID: 'crud-production', FORGE_EVAL_PHASE_ID: 'database',
      FORGE_EVAL_PHASE_CATALOG_FILE: path.resolve(
        'docker/harness/skills/forge-task-router/references/phase-profiles.json',
      ),
      FORGE_EVAL_PHASE_STATE_FILE: stateFile,
      FORGE_EVAL_DATABASE_CONTINUATION_RECEIPT_FILE: receiptFile,
    };
    const writeReceipt = async (value) => {
      await writeFile(receiptFile, `${JSON.stringify(value)}\n`);
      await chmod(receiptFile, 0o600);
    };
    for (const changed of [
      { sourceCommit: '1'.repeat(40) },
      { stateDigest: '9'.repeat(64) },
      { promptSha256: '9'.repeat(64) },
    ]) {
      await writeReceipt({ ...receipt, ...changed });
      await assert.rejects(() => prepareHeadlessExecutionFromEnvironment(environment), /does not bind/u);
    }
    await writeReceipt(receipt);
    const prepared = await prepareHeadlessExecutionFromEnvironment(environment);
    assert.equal(prepared.generation, 7);
    await assert.rejects(() => prepareHeadlessExecutionFromEnvironment({
      ...environment, FORGE_PROTECTED_HEADLESS_RPC_ID: 'database-rpc-2',
    }), /does not bind/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Harness image explicitly provides the fixed Linux flock executable', async () => {
  const dockerfile = await readFile(new URL('../docker/harness/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /apt-cache show iproute2 jq ripgrep util-linux/u);
  assert.match(dockerfile, /procps \\\n\s*ripgrep \\\n\s*util-linux; do/u);
});

test('the Linux execution-state lock is a permanent canonical owner-only inode', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-flock-identity-'));
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
    const options = {
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      now: Date.parse('2026-09-01T00:00:00.000Z'),
      policyPath,
    };
    await prepareProtectedExecutionContext(options);
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const lockPath = `${statePath}.lock`;
    const first = await lstat(lockPath, { bigint: true });
    assert.equal(first.isFile(), true);
    assert.equal(first.isSymbolicLink(), false);
    assert.equal(first.nlink, 1n);
    assert.equal(first.size, 0n);
    assert.equal(first.mode & 0o777n, 0o600n);
    assert.equal(await realpath(lockPath), path.resolve(lockPath));

    const alias = `${lockPath}.hardlink`;
    await link(lockPath, alias);
    await assert.rejects(
      () => prepareProtectedExecutionContext({ ...options, now: Date.parse('2026-09-01T00:01:00.000Z') }),
      (error) => error.code === 'EXECUTION_STATE_LOCK_INVALID',
    );
    await rm(alias);

    const replay = await prepareProtectedExecutionContext({
      ...options,
      now: Date.parse('2026-09-01T00:01:00.000Z'),
    });
    assert.equal(replay.idempotent, true);
    const second = await lstat(lockPath, { bigint: true });
    assert.equal(second.dev, first.dev);
    assert.equal(second.ino, first.ino);
    assert.equal(second.nlink, 1n);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Linux kernel lock stays held for the operation and SIGKILL releases it', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-flock-death-'));
  let worker;
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
    const options = {
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      now: Date.parse('2026-09-01T00:00:00.000Z'),
      policyPath,
    };
    await prepareProtectedExecutionContext(options);
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const lockPath = `${statePath}.lock`;

    worker = startLinuxExecutionStateWorker({
      ...options,
      now: Date.parse('2026-09-01T00:01:00.000Z'),
    });
    let whileStopped;
    let stoppedTemporary;
    const stateDirectory = path.dirname(statePath);
    const temporaryPrefix = `.${path.basename(statePath)}.`;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) break;
      const temporary = (await readdir(stateDirectory)).find((name) => (
        name.startsWith(temporaryPrefix) && name.endsWith('.tmp')
      ));
      if (temporary === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      assert.equal(worker.child.kill('SIGSTOP'), true);
      let stoppedBySignal = false;
      for (let observation = 0; observation < 100; observation += 1) {
        const status = await readFile(`/proc/${worker.child.pid}/status`, 'utf8').catch(() => '');
        if (/^State:\s+T/mu.test(status)) {
          stoppedBySignal = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(stoppedBySignal, true, 'execution-state owner did not reach a stopped state');
      if ((await readdir(stateDirectory)).includes(temporary)) {
        whileStopped = await runLinuxFlockPath(lockPath);
        if (whileStopped.error === null && whileStopped.signal === null && whileStopped.code === 75) {
          stoppedTemporary = temporary;
          break;
        }
      }
      assert.equal(worker.child.kill('SIGCONT'), true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const earlyWorkerExit = worker.child.exitCode !== null || worker.child.signalCode !== null
      ? await worker.closed
      : null;
    assert.ok(
      stoppedTemporary,
      `worker was not stopped inside an atomic state operation: ${earlyWorkerExit?.stderr ?? ''}`,
    );
    assert.equal((await lstat(path.join(stateDirectory, stoppedTemporary))).isFile(), true);
    assert.deepEqual(
      { code: whileStopped.code, signal: whileStopped.signal, error: whileStopped.error },
      { code: 75, signal: null, error: null },
      whileStopped.stderr,
    );
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        ...options,
        now: Date.parse('2026-09-01T00:01:01.000Z'),
      }),
      (error) => error.code === 'EXECUTION_STATE_BUSY',
    );

    assert.equal(worker.child.kill('SIGKILL'), true);
    const killed = await worker.closed;
    assert.equal(killed.error, null, killed.error?.message);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const afterDeath = await runLinuxFlockPath(lockPath);
    assert.deepEqual(
      { code: afterDeath.code, signal: afterDeath.signal, error: afterDeath.error },
      { code: 0, signal: null, error: null },
      afterDeath.stderr,
    );

    const replay = await prepareProtectedExecutionContext({
      ...options,
      now: Date.parse('2026-09-01T00:01:02.000Z'),
    });
    assert.equal(replay.generation >= 1, true);
  } finally {
    if (worker?.child.exitCode === null && worker?.child.signalCode === null) {
      worker.child.kill('SIGKILL');
      await worker.closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('the non-Linux fallback reconciles a stale execution lock only with dead-owner evidence', {
  skip: process.platform === 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-lock-recovery-'));
  try {
    const firstRequest = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
    await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: firstRequest, policyPath,
    });
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const lockPath = `${statePath}.lock`;
    const staleAt = new Date(Date.now() - 60_000);
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 2,
      pid: 2147483647,
      processStartToken: null,
      pidNamespace: await currentPidNamespace(),
      ownerNonce: '44444444-4444-4444-8444-444444444444',
      statePathDigest: sha256(Buffer.from(statePath, 'utf8')),
      acquiredAt: staleAt.toISOString(),
    })}\n`);
    await utimes(lockPath, staleAt, staleAt);
    const second = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(
        classifyPinnedDshPromptBody(promptBody({ rpcId: 'dead-owner-recovery-rpc' }), 'session.prompt'),
        'dead-owner-recovery-request',
      ),
      policyPath,
    });
    assert.equal(second.generation, 2);
    const evidence = await readdir(`${statePath}.lock-recovery`);
    assert.equal(evidence.length, 1);
    assert.match(evidence[0], /44444444-4444-4444-8444-444444444444/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the non-Linux fallback never reclaims a lock from a foreign PID namespace', {
  skip: process.platform === 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-lock-foreign-namespace-'));
  try {
    await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt')),
      policyPath,
    });
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const lockPath = `${statePath}.lock`;
    const staleAt = new Date(Date.now() - 60_000);
    const localNamespace = await currentPidNamespace();
    const foreignNamespace = localNamespace === 'pid:[999999999]' ? 'pid:[888888888]' : 'pid:[999999999]';
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 2,
      pid: 2147483647,
      processStartToken: null,
      pidNamespace: foreignNamespace,
      ownerNonce: '77777777-7777-4777-8777-777777777777',
      statePathDigest: sha256(Buffer.from(statePath, 'utf8')),
      acquiredAt: staleAt.toISOString(),
    })}\n`);
    await utimes(lockPath, staleAt, staleAt);
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
        request: authenticated(
          classifyPinnedDshPromptBody(promptBody({ rpcId: 'foreign-namespace-rpc' }), 'session.prompt'),
          'foreign-namespace-request',
        ),
        policyPath,
      }),
      (error) => error.code === 'EXECUTION_STATE_BUSY',
    );
    const preserved = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(preserved.pidNamespace, foreignNamespace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the non-Linux fallback adopts a valid dead claimant but rejects an unknown hardlink', {
  skip: process.platform === 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-lock-cas-'));
  try {
    await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt')),
      policyPath,
    });
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const lockPath = `${statePath}.lock`;
    const staleAt = new Date(Date.now() - 60_000);
    const record = {
      schemaVersion: 2,
      pid: 2147483647,
      processStartToken: null,
      pidNamespace: await currentPidNamespace(),
      ownerNonce: '55555555-5555-4555-8555-555555555555',
      statePathDigest: sha256(Buffer.from(statePath, 'utf8')),
      acquiredAt: staleAt.toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(record)}\n`);
    await utimes(lockPath, staleAt, staleAt);
    await link(lockPath, `${lockPath}.reconcile`);
    const nextRequest = authenticated(
      classifyPinnedDshPromptBody(promptBody({ rpcId: 'cas-recovery-rpc' }), 'session.prompt'),
      'cas-recovery-request',
    );
    const recovered = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: nextRequest, policyPath,
    });
    assert.equal(recovered.generation, 2);
    await writeFile(lockPath, `${JSON.stringify(record)}\n`);
    await utimes(lockPath, staleAt, staleAt);
    await link(lockPath, `${lockPath}.unknown-hardlink`);
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
        request: nextRequest, policyPath,
      }),
      (error) => error.code === 'EXECUTION_STATE_LOCK_RECOVERY_INCOMPLETE',
    );
    const preserved = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(preserved.ownerNonce, record.ownerNonce);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the non-Linux fallback preserves an orphaned reconcile claim without permanent lockout', {
  skip: process.platform === 'linux',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-lock-orphan-'));
  try {
    await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt')),
      policyPath,
    });
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const lockPath = `${statePath}.lock`;
    const orphanNonce = '66666666-6666-4666-8666-666666666666';
    await writeFile(`${lockPath}.reconcile`, `${JSON.stringify({
      schemaVersion: 2,
      pid: 2147483647,
      processStartToken: null,
      pidNamespace: await currentPidNamespace(),
      ownerNonce: orphanNonce,
      statePathDigest: sha256(Buffer.from(statePath, 'utf8')),
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    })}\n`);
    const recovered = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(
        classifyPinnedDshPromptBody(promptBody({ rpcId: 'orphan-reconcile-rpc' }), 'session.prompt'),
        'orphan-reconcile-request',
      ),
      policyPath,
    });
    assert.equal(recovered.generation, 2);
    const evidence = await readdir(`${statePath}.lock-recovery`);
    assert.equal(evidence.some((name) => name.includes(orphanNonce)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy expired test-shadow context uses one exact permit and preserves its complete identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-refresh-'));
  try {
    const issuedAt = Date.parse('2026-09-01T00:00:00.000Z');
    const recoveryAt = issuedAt + EXECUTION_CONTEXT_TTL_MS + 1_000;
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({
      content: [{ type: 'text', text: '修复供应商后端受影响行数并补齐测试。' }],
    }), 'session.prompt'));
    const options = {
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete',
        phaseAuthority: phaseAuthority('backend'),
      },
    };
    const first = await prepareProtectedExecutionContext({ ...options, now: issuedAt });
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const currentState = JSON.parse(await readFile(statePath, 'utf8'));
    delete currentState.lifecycle;
    delete currentState.recovery;
    delete currentState.tombstones;
    currentState.schemaVersion = 1;
    await writeFile(statePath, `${JSON.stringify(currentState)}\n`);

    await assert.rejects(
      () => prepareProtectedExecutionContext({ ...options, now: recoveryAt }),
      (error) => error.code === 'EXECUTION_CONTEXT_EXPIRED',
    );
    const phaseAttempt = {
      attemptId: '78577957-286b-42d4-abf4-4203263481c9',
      phaseId: 'backend',
      sessionMode: 'resume',
      rpcId: first.rpcId,
      promptDigest: first.promptDigest,
      executionGeneration: first.generation,
    };
    const recovery = {
      mode: PROTECTED_EXECUTION_RECOVERY_MODE,
      operationId: '11111111-1111-4111-8111-111111111111',
      authorizationReference: 'codex-task:test-owner-authorized-refresh',
      expectedPhaseAttemptId: phaseAttempt.attemptId,
      expectedExecutionId: first.executionId,
      expectedClaimId: first.claimId,
      expectedGeneration: first.generation,
      expectedContractId: first.contractId,
    };
    const permitted = await issueProtectedExecutionRecoveryPermit({
      ...options, phaseAttempt, recovery, now: recoveryAt,
    });
    assert.equal(permitted.executionId, first.executionId);
    assert.equal(permitted.claimId, first.claimId);
    assert.equal(permitted.generation, first.generation);
    assert.equal(permitted.recoveryPermit.status, 'permitted');
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        ...options,
        request: authenticated(
          classifyPinnedDshPromptBody(promptBody({ rpcId: 'different-rpc-during-recovery' }), 'session.prompt'),
          'different-request-during-recovery',
        ),
        now: recoveryAt + 50,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_IN_PROGRESS',
    );

    const firstReadback = {
      schemaVersion: 'forge-protected-session-readback/v1',
      sessionId: first.dshSessionId,
      rpcId: first.rpcId,
      textDigest: first.textDigest,
      observedSeq: 231872,
      eventDigest: 'a'.repeat(64),
      sessionObserved: true,
      historyComplete: true,
      requestObserved: false,
      turnOpen: false,
      observedAt: new Date(recoveryAt + 50).toISOString(),
    };
    const permittedAbandonRoot = path.join(root, 'permitted-abandoned-copy');
    const permittedAbandonStatePath = path.join(
      permittedAbandonRoot, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`,
    );
    await mkdir(path.dirname(permittedAbandonStatePath), { recursive: true });
    await writeFile(permittedAbandonStatePath, await readFile(statePath));
    const permittedAbandonment = await abandonClaimedProtectedExecutionRecovery({
      projectRoot: permittedAbandonRoot,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      executionId: first.executionId,
      claimId: first.claimId,
      generation: first.generation,
      contractId: first.contractId,
      phaseAttemptId: phaseAttempt.attemptId,
      reason: 'stable-idle-pre-ingress-cancelled-no-resend',
      readback: {
        sessionId: first.dshSessionId,
        rpcId: first.rpcId,
        textDigest: first.textDigest,
        observedSeq: 231872,
        eventDigest: firstReadback.eventDigest,
        baselineSeq: null,
        baselineDigest: null,
        historyComplete: true,
        requestObserved: false,
        turnOpen: false,
        sessionRunning: false,
        observedAt: new Date(recoveryAt + 60).toISOString(),
      },
      now: recoveryAt + 65,
    });
    assert.equal(permittedAbandonment.lifecycleStatus, 'abandoned');
    assert.equal(
      permittedAbandonment.tombstone.reason,
      'stable-idle-pre-ingress-cancelled-no-resend',
    );
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        ...options, projectRoot: permittedAbandonRoot, now: recoveryAt + 70,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_ABANDONED',
    );
    const newAfterPermittedCancellation = await prepareProtectedExecutionContext({
      ...options,
      projectRoot: permittedAbandonRoot,
      request: authenticated(
        classifyPinnedDshPromptBody(
          promptBody({ rpcId: 'new-rpc-after-permitted-cancellation' }),
          'session.prompt',
        ),
        'new-request-after-permitted-cancellation',
      ),
      now: recoveryAt + 75,
    });
    assert.equal(newAfterPermittedCancellation.generation, first.generation + 1);
    const claimed = await claimProtectedExecutionRecovery({
      projectRoot: root,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      now: recoveryAt + 100,
      readback: firstReadback,
    });
    for (const key of [
      'executionId', 'claimId', 'generation', 'rpcId', 'dshSessionId', 'bodyDigest',
      'textDigest', 'promptDigest', 'contractId', 'contractDigest', 'policyVersion',
      'sourceCommit', 'workflowId', 'phaseId', 'phaseCatalogDigest',
    ]) assert.equal(claimed[key], first[key], `${key} must survive recovery unchanged`);
    assert.notEqual(claimed.expiresAt, first.expiresAt);

    const repeatedClaim = await claimProtectedExecutionRecovery({
      projectRoot: root,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      now: recoveryAt + 125,
      readback: { ...firstReadback, observedAt: new Date(recoveryAt + 120).toISOString() },
    });
    assert.equal(repeatedClaim.idempotent, true);
    const resumedAfterClaim = await issueProtectedExecutionRecoveryPermit({
      ...options, phaseAttempt, recovery, now: recoveryAt + 130,
    });
    assert.equal(resumedAfterClaim.recoveryPermit.status, 'submission-attempted');
    await assert.rejects(
      () => prepareProtectedExecutionContext({ ...options, now: recoveryAt + 140 }),
      (error) => error.code === 'EXECUTION_RECOVERY_REQUIRES_RUNNER',
    );
    const secondReadback = {
      ...firstReadback,
      observedAt: new Date(recoveryAt + 145).toISOString(),
    };
    const ingress = await forwardClaimedProtectedExecutionRecovery({
      projectRoot: root,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      readback: secondReadback,
      now: recoveryAt + 150,
    });
    assert.equal(ingress.recoveryIngressAuthorized, true);
    assert.equal(ingress.executionId, first.executionId);
    const repeatedIngress = await forwardClaimedProtectedExecutionRecovery({
      projectRoot: root,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      readback: { ...secondReadback, observedAt: new Date(recoveryAt + 155).toISOString() },
      now: recoveryAt + 160,
    });
    assert.equal(repeatedIngress.idempotent, true);
    assert.equal(repeatedIngress.recoveryIngressAuthorized, false);
    const resumedAfterIngress = await issueProtectedExecutionRecoveryPermit({
      ...options, phaseAttempt, recovery, now: recoveryAt + 165,
    });
    assert.equal(resumedAfterIngress.recoveryPermit.status, 'ingress-forwarded');
    await assert.rejects(
      () => prepareProtectedExecutionContext({ ...options, now: recoveryAt + 170 }),
      (error) => error.code === 'EXECUTION_CONTEXT_REPLAY_REQUIRES_READBACK',
    );

    const abandonedRoot = path.join(root, 'abandoned-copy');
    const abandonedStatePath = path.join(
      abandonedRoot, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`,
    );
    await mkdir(path.dirname(abandonedStatePath), { recursive: true });
    await writeFile(abandonedStatePath, await readFile(statePath));
    const abandonment = await abandonClaimedProtectedExecutionRecovery({
      projectRoot: abandonedRoot,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      executionId: first.executionId,
      claimId: first.claimId,
      generation: first.generation,
      contractId: first.contractId,
      phaseAttemptId: phaseAttempt.attemptId,
      readback: {
        sessionId: first.dshSessionId,
        rpcId: first.rpcId,
        textDigest: first.textDigest,
        observedSeq: 231900,
        eventDigest: 'e'.repeat(64),
        baselineSeq: 231872,
        baselineDigest: firstReadback.eventDigest,
        historyComplete: true,
        requestObserved: true,
        turnOpen: false,
        sessionRunning: false,
        observedAt: new Date(recoveryAt + 175).toISOString(),
      },
      now: recoveryAt + 180,
    });
    assert.equal(abandonment.lifecycleStatus, 'abandoned');
    assert.equal(abandonment.tombstone.requestObserved, true);
    const abandonedAgain = await abandonClaimedProtectedExecutionRecovery({
      projectRoot: abandonedRoot,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      executionId: first.executionId,
      claimId: first.claimId,
      generation: first.generation,
      contractId: first.contractId,
      phaseAttemptId: phaseAttempt.attemptId,
      readback: {
        sessionId: first.dshSessionId,
        rpcId: first.rpcId,
        textDigest: first.textDigest,
        observedSeq: 231900,
        eventDigest: 'e'.repeat(64),
        baselineSeq: 231872,
        baselineDigest: firstReadback.eventDigest,
        historyComplete: true,
        requestObserved: true,
        turnOpen: false,
        sessionRunning: false,
        observedAt: new Date(recoveryAt + 185).toISOString(),
      },
      now: recoveryAt + 190,
    });
    assert.equal(abandonedAgain.idempotent, true);
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        ...options, projectRoot: abandonedRoot, now: recoveryAt + 200,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_ABANDONED',
    );
    const nextAfterAbandonment = await prepareProtectedExecutionContext({
      ...options,
      projectRoot: abandonedRoot,
      request: authenticated(
        classifyPinnedDshPromptBody(promptBody({ rpcId: 'new-rpc-after-abandoned-recovery' }), 'session.prompt'),
        'new-request-after-abandoned-recovery',
      ),
      now: recoveryAt + 210,
    });
    assert.equal(nextAfterAbandonment.generation, first.generation + 1);
    const stateAfterAbandonment = JSON.parse(await readFile(abandonedStatePath, 'utf8'));
    assert.equal(stateAfterAbandonment.tombstones.length, 1);
    await assert.rejects(
      () => prepareProtectedExecutionContext({
        ...options, projectRoot: abandonedRoot, now: recoveryAt + 220,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_ABANDONED',
    );

    const lookup = {
      projectSlug: metadata.projectSlug,
      taskId: metadata.taskId,
      conversationId: metadata.conversationId,
      actorUserId,
      dshSessionId: claimed.dshSessionId,
      rpcId: claimed.rpcId,
      textDigest: claimed.textDigest,
    };
    const resolved = await readProtectedExecutionContext({
      projectRoot: root, taskMetadata: metadata, lookup, now: recoveryAt + 210,
    });
    assert.equal(resolved.executionId, first.executionId);
    await readProtectedExecutionContext({
      projectRoot: root, taskMetadata: metadata, lookup, now: recoveryAt + 310,
    });
    const consumed = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(consumed.schemaVersion, 3);
    assert.equal(consumed.lifecycle.status, 'consumed');
    assert.equal(consumed.recovery.status, 'consumed');
    assert.equal(consumed.recovery.phaseAttemptId, phaseAttempt.attemptId);
    assert.equal(consumed.current.executionId, first.executionId);
    assert.equal(consumed.current.claimId, first.claimId);
    const observedConsumption = await readProtectedExecutionRecoveryStatus({
      projectRoot: root,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      executionId: first.executionId,
      claimId: first.claimId,
      generation: first.generation,
      contractId: first.contractId,
      phaseAttemptId: phaseAttempt.attemptId,
    });
    assert.equal(observedConsumption.consumed, true);
    assert.equal(observedConsumption.lifecycleStatus, 'consumed');
    assert.equal(observedConsumption.recoveryStatus, 'consumed');
    await writeFile(`${statePath}.lock`, '{malformed live writer lock\n');
    const observedWithoutTakingWriterLock = await readProtectedExecutionRecoveryStatus({
      projectRoot: root,
      taskId: metadata.taskId,
      operationId: recovery.operationId,
      executionId: first.executionId,
      claimId: first.claimId,
      generation: first.generation,
      contractId: first.contractId,
      phaseAttemptId: phaseAttempt.attemptId,
    });
    assert.equal(observedWithoutTakingWriterLock.consumed, true);
    await rm(`${statePath}.lock`);
    await assert.rejects(
      () => issueProtectedExecutionRecoveryPermit({
        ...options, phaseAttempt, recovery, now: recoveryAt + EXECUTION_CONTEXT_TTL_MS + 200,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_CONSUMED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired production contexts and mismatched recovery modes fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-refresh-denied-'));
  try {
    const issuedAt = Date.parse('2026-09-01T00:00:00.000Z');
    const observedAt = issuedAt + EXECUTION_CONTEXT_TTL_MS + 1_000;
    const request = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
    const options = {
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath,
    };
    const first = await prepareProtectedExecutionContext({ ...options, now: issuedAt });
    const phaseAttempt = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      phaseId: 'backend',
      sessionMode: 'resume',
      rpcId: first.rpcId,
      promptDigest: first.promptDigest,
      executionGeneration: first.generation,
    };
    const recovery = {
      mode: PROTECTED_EXECUTION_RECOVERY_MODE,
      operationId: '33333333-3333-4333-8333-333333333333',
      authorizationReference: 'codex-task:test-production-refresh-denied',
      expectedPhaseAttemptId: phaseAttempt.attemptId,
      expectedExecutionId: first.executionId,
      expectedClaimId: first.claimId,
      expectedGeneration: first.generation,
      expectedContractId: first.contractId,
    };
    await assert.rejects(
      () => issueProtectedExecutionRecoveryPermit({
        ...options, phaseAttempt, recovery, now: observedAt + 100,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_DENIED',
    );
    await assert.rejects(
      () => issueProtectedExecutionRecoveryPermit({
        ...options,
        phaseAttempt,
        recovery: { ...recovery, mode: 'implicit-refresh' },
        now: observedAt + 100,
      }),
      (error) => error.code === 'EXECUTION_RECOVERY_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare rejects authority fields and tampered state fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-context-tamper-'));
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: { ...request, ownedPaths: ['forge-server'] }, policyPath,
    }), (error) => error.code === 'EXECUTION_INPUT_INVALID');

    const current = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request, now: Date.parse('2026-09-01T00:00:00.000Z'), policyPath,
    });
    const statePath = path.join(root, 'taskspaces', '.broker', 'executions', `${metadata.taskId}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.current.contractId = 'f'.repeat(64);
    await writeFile(statePath, `${JSON.stringify(state)}\n`);
    await assert.rejects(() => readProtectedExecutionContext({
      projectRoot: root,
      taskMetadata: metadata,
      lookup: {
        projectSlug: metadata.projectSlug, taskId: metadata.taskId,
        conversationId: metadata.conversationId, actorUserId,
        dshSessionId: current.dshSessionId, rpcId: current.rpcId, textDigest: current.textDigest,
      },
      now: Date.parse('2026-09-01T00:01:00.000Z'),
    }), (error) => error.code === 'EXECUTION_CONTEXT_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fixture-only test-shadow policy requires exact source and case routing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-test-shadow-'));
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({
      content: [{ type: 'text', text: '实现供应商 CRUD 并验证权限和租户边界。' }],
    }), 'session.prompt'));
    const context = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete',
        phaseAuthority: phaseAuthority('requirements'),
      },
    });
    assert.equal(context.authorityClass, 'test-shadow-writer');
    assert.equal(context.testOnly, true);
    assert.equal(context.actionCeiling, 'read-only');
    assert.deepEqual(context.ownedPaths, []);
    assert.deepEqual(context.requiredProfiles, []);
    assert.equal(context.workflowId, 'crud-production');
    assert.equal(context.phaseId, 'requirements');
    assert.equal(context.phaseIndex, 0);

    const database = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request: { ...request, rpcId: 'database-rpc', requestId: 'database-request' },
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete',
        phaseAuthority: phaseAuthority('database'),
      },
    });
    assert.equal(database.generation, 2);
    assert.equal(database.actionCeiling, 'workspace-write');
    assert.deepEqual(database.ownedPaths, [
      'forge-server/db/migration',
      'forge-server/forge-business/forge-business-core/src/test/java',
    ]);
    assert.ok(database.contract.requiredSkills.includes('forge-database-migration'));
    assert.ok(database.contract.requiredSkills.includes('forge-backend-architecture'));
    assert.ok(!database.contract.requiredSkills.includes('forge-frontend-admin'));

    const releasePhase = phaseAuthority('database');
    releasePhase.actionCeiling = 'release';
    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: path.join(root, 'release-shadow'),
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request: { ...request, rpcId: 'release-shadow-rpc', requestId: 'release-shadow-request' },
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete',
        phaseAuthority: releasePhase,
      },
    }), (error) => error.code === 'EXECUTION_PHASE_AUTHORITY_INVALID');

    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request: { ...request, rpcId: 'different-rpc' },
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'unknown-case',
      },
    }), (error) => error.code === 'EXECUTION_POLICY_ROUTE_DENIED');

    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request: { ...request, rpcId: 'production-rpc' },
      policyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
        caseFamily: 'crud-complete',
      },
    }), (error) => error.code === 'EXECUTION_POLICY_ROUTE_DENIED');

    const downgraded = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath,
    });
    assert.equal(downgraded.generation, 3);
    assert.equal(downgraded.authorityClass, 'production-read-only');
    assert.equal(downgraded.testOnly, false);
    assert.equal(downgraded.actionCeiling, 'read-only');
    assert.deepEqual(downgraded.ownedPaths, []);
    assert.equal(downgraded.phaseId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production task writer requires an exact protected Controller authority and binds its source and grant', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-production-task-'));
  try {
    const prompt = '移除事故事件调查页面的状态标签并补充聚焦回归测试。';
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({
      rpcId: '123e4567-e89b-42d3-a456-426614174225',
      content: [{ type: 'text', text: prompt }],
    }), 'session.prompt'), 'request-production-task');
    const taskAuthority = {
      actionCeiling: 'workspace-write',
      ownedPaths: ['forge-admin-ui/src/views/accident'],
      taskProfiles: ['frontend-admin'],
    };
    const expected = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
    const productionAuthorityId = '123e4567-e89b-42d3-a456-426614174226';
    const controllerGrantDigest = '3'.repeat(64);
    const trustedPolicyInput = {
      profile: 'production-controller',
      sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
      workspaceFingerprint: '1'.repeat(64),
      caseFamily: 'maintenance',
      productionAuthorityId,
      productionAuthorityDigest: digestProductionTaskAuthorityBinding({
        projectSlug: metadata.projectSlug,
        taskId: metadata.taskId,
        actorUserId,
        actorUsername: 'alice',
        conversationId: metadata.conversationId,
        dshSessionId: request.dshSessionId,
        route: request.route,
        rpcId: request.rpcId,
        promptDigest: request.textDigest,
        sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
        workspaceFingerprint: '1'.repeat(64),
        caseFamily: 'maintenance',
        productionAuthorityId,
        controllerGrantDigest,
        contractId: expected.contractId,
        actionCeiling: taskAuthority.actionCeiling,
        ownedPaths: taskAuthority.ownedPaths,
      }),
      controllerGrantDigest,
      expectedContractId: expected.contractId,
      taskAuthority,
    };
    const context = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath,
      trustedPolicyInput,
    });
    assert.equal(context.authorityClass, 'production-task-writer');
    assert.equal(context.testOnly, false);
    assert.equal(context.actionCeiling, 'workspace-write');
    assert.equal(context.contractId, expected.contractId);
    assert.deepEqual(context.ownedPaths, taskAuthority.ownedPaths);
    assert.deepEqual(context.contract.taskProfiles, ['frontend-admin']);
    assert.equal(context.sourceCommit, trustedPolicyInput.sourceCommit);
    assert.equal(context.workspaceFingerprint, trustedPolicyInput.workspaceFingerprint);
    assert.equal(context.productionAuthorityId, trustedPolicyInput.productionAuthorityId);
    assert.equal(context.productionAuthorityDigest, trustedPolicyInput.productionAuthorityDigest);
    assert.equal(context.controllerGrantDigest, trustedPolicyInput.controllerGrantDigest);
    assert.equal(context.workflowId, null);
    assert.equal(context.phaseId, null);

    const replay = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request: { ...request, requestId: 'request-production-task-replay' },
      policyPath,
      trustedPolicyInput,
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.executionId, context.executionId);

    for (const [name, supplied] of [
      ['expected-contract', { ...trustedPolicyInput, expectedContractId: '4'.repeat(64),
        taskAuthority: { ...taskAuthority, contract: expected } }],
      ['current-authority-digest', { ...trustedPolicyInput, productionAuthorityDigest: '4'.repeat(64),
        taskAuthority: { ...taskAuthority, contract: expected } }],
      ['changed-requirements', (() => {
        const changed = compileForgeTaskExecutionContract({ prompt, ...taskAuthority,
          taskProfiles: ['frontend-admin', 'crud'] });
        return { ...trustedPolicyInput, expectedContractId: changed.contractId,
          taskAuthority: { ...taskAuthority, contract: changed } };
      })()],
    ]) {
      await assert.rejects(() => prepareProtectedExecutionContext({
        projectRoot: path.join(root, `continued-${name}`), projectSlug: metadata.projectSlug,
        taskMetadata: metadata, request, policyPath, trustedPolicyInput: supplied,
      }), (error) => error.code === 'EXECUTION_POLICY_INVALID');
    }

    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: path.join(root, 'contract-mismatch'),
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath,
      trustedPolicyInput: { ...trustedPolicyInput, expectedContractId: '4'.repeat(64) },
    }), (error) => error.code === 'EXECUTION_POLICY_INVALID');

    await assert.rejects(() => prepareProtectedExecutionContext({
      projectRoot: path.join(root, 'shadow-policy'),
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: testShadowPolicyPath,
      trustedPolicyInput,
    }), (error) => error.code === 'EXECUTION_POLICY_ROUTE_DENIED');

    const { idempotent: _idempotent, refreshed: _refreshed, ...persistedContext } = context;
    assert.throws(
      () => validateProtectedExecutionContext({ ...persistedContext, workspaceFingerprint: '5'.repeat(64) }),
      /contract binding|authority/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary continuation preserves complete historical obligations while newly compiled contracts retain scoped rules', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-ordinary-contract-compatibility-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = '继续完成此前授权的修改和验证。';
  for (const [name, relative, historical, formatMaintenance] of [
    ['historical-tool', 'forge-admin-ui/src/utils/label.ts', true, false],
    ['historical-page', 'forge-admin-ui/src/views/example.vue', true, false],
    ['historical-format', 'forge-admin-ui/src/utils/label.ts', true, true],
    ['current-tool', 'forge-admin-ui/src/utils/label.ts', false, false],
  ]) {
    const taskAuthority = { actionCeiling: 'workspace-write', ownedPaths: [relative],
      taskProfiles: ['frontend-admin', ...(formatMaintenance ? ['frontend-format-maintenance'] : [])] };
    const current = compileForgeTaskExecutionContract({ prompt, ...taskAuthority },
      { independentReview: 'suspended', verificationScope: 'changed' });
    const original = historical ? { ...compileForgeTaskExecutionContract({ prompt, ...taskAuthority },
      { independentReview: 'suspended' }), requiredVerificationProfiles: current.requiredVerificationProfiles } : current;
    const { contractId: _contractId, ...payload } = original;
    const contract = { ...original, contractId: sha256(canonicalStringify(payload)) };
    const preserved = structuredClone(contract);
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({ rpcId: `rpc:${name}`,
      content: [{ type: 'text', text: prompt }] }), 'session.prompt'), `request:${name}`);
    const binding = {
      projectSlug: metadata.projectSlug, taskId: metadata.taskId, actorUserId, actorUsername: 'alice',
      conversationId: metadata.conversationId, dshSessionId: request.dshSessionId, route: request.route,
      rpcId: request.rpcId, promptDigest: request.textDigest, sourceCommit: '1'.repeat(40),
      workspaceFingerprint: '2'.repeat(64), caseFamily: 'maintenance',
      productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226', controllerGrantDigest: '3'.repeat(64),
      contractId: contract.contractId, actionCeiling: taskAuthority.actionCeiling, ownedPaths: taskAuthority.ownedPaths,
    };
    const options = { projectRoot: path.join(root, name), projectSlug: metadata.projectSlug,
      taskMetadata: metadata, request, policyPath,
      trustedPolicyInput: { profile: 'production-controller', sourceCommit: binding.sourceCommit,
        workspaceFingerprint: binding.workspaceFingerprint, caseFamily: binding.caseFamily,
        productionAuthorityId: binding.productionAuthorityId,
        productionAuthorityDigest: digestProductionTaskAuthorityBinding(binding),
        controllerGrantDigest: binding.controllerGrantDigest, expectedContractId: contract.contractId,
        taskAuthority: { ...taskAuthority, contract } } };
    const first = await prepareProtectedExecutionContext(options);
    assert.deepEqual(first.contract, preserved, name);
    const replay = await prepareProtectedExecutionContext({ ...options,
      request: { ...request, requestId: `request:${name}:retry` } });
    assert.equal(replay.idempotent, true, name);
    assert.equal(replay.executionId, first.executionId, name);
    assert.deepEqual(replay.contract, preserved, name);
    assert.deepEqual(contract, preserved, 'supplied historical evidence is not rewritten');
  }
});

async function checkpointRenewalFixture(t, roleGrantDecisions, semanticResources) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-checkpoint-renewal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-09-21T00:00:00.000Z');
  const prompt = '修改前端后验证并发布。';
  const request = authenticated(classifyPinnedDshPromptBody(promptBody({
    rpcId: 'rpc-checkpoint-renewal', content: [{ type: 'text', text: prompt }],
  }), 'session.prompt'));
  const taskAuthority = { actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'], taskProfiles: ['frontend-admin'] };
  const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority }, { roleGrantDecisions, semanticResources });
  if (roleGrantDecisions !== undefined || semanticResources !== undefined) taskAuthority.contract = contract;
  const binding = {
    projectSlug: metadata.projectSlug, taskId: metadata.taskId, actorUserId, actorUsername: 'alice',
    conversationId: metadata.conversationId, dshSessionId: request.dshSessionId, route: request.route,
    rpcId: request.rpcId, promptDigest: request.textDigest, sourceCommit: '1'.repeat(40),
    workspaceFingerprint: '2'.repeat(64), caseFamily: 'maintenance',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226',
    controllerGrantDigest: '3'.repeat(64), contractId: contract.contractId,
    actionCeiling: 'release', ownedPaths: taskAuthority.ownedPaths,
  };
  const trustedPolicyInput = { profile: 'production-controller', sourceCommit: binding.sourceCommit,
    workspaceFingerprint: binding.workspaceFingerprint, caseFamily: binding.caseFamily,
    productionAuthorityId: binding.productionAuthorityId,
    productionAuthorityDigest: digestProductionTaskAuthorityBinding(binding),
    controllerGrantDigest: binding.controllerGrantDigest, expectedContractId: contract.contractId, taskAuthority };
  await prepareProtectedExecutionContext({ projectRoot: root, projectSlug: metadata.projectSlug,
    taskMetadata: metadata, request, policyPath, trustedPolicyInput, now });
  const lookup = Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId',
    'rpcId'].map((key) => [key, binding[key]]));
  lookup.textDigest = request.textDigest;
  const options = { projectRoot: root, taskMetadata: metadata, lookup, now: now + 1 };
  const context = await readProtectedExecutionContext(options);
  const seal = (value) => { const { digest: _digest, ...body } = value;
    return { ...body, digest: sourceTransitionCanonicalDigest(body) }; };
  const sourceTransition = seal({ schemaVersion: 1,
    operationId: '123e4567-e89b-42d3-a456-426614174227',
    task: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
      'dshSessionId'].map((key) => [key, context[key]])),
    from: { head: context.sourceCommit, fingerprint: '4'.repeat(64) },
    to: { head: '5'.repeat(40), fingerprint: '4'.repeat(64) },
    canonicalHead: context.sourceCommit, phase: 'checkpointed',
    sourceAuthority: Object.fromEntries(['executionId', 'generation', 'contractId', 'productionAuthorityDigest',
      'controllerGrantDigest', 'actionCeiling', 'issuedAt', 'expiresAt'].map((key) => [key, context[key]])),
    digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1',
  });
  const nextBinding = { ...binding, sourceCommit: sourceTransition.to.head,
    workspaceFingerprint: sourceTransition.to.fingerprint,
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174228', controllerGrantDigest: '6'.repeat(64) };
  const response = {
    authority: { ...nextBinding, authorityId: nextBinding.productionAuthorityId,
      productionAuthorityDigest: digestProductionTaskAuthorityBinding(nextBinding),
      issuedAt: new Date(now + 2).toISOString(), expiresAt: new Date(now + EXECUTION_CONTEXT_TTL_MS + 2).toISOString() },
    trustedPolicyInput: { profile: 'production-controller', expectedContractId: contract.contractId, taskAuthority },
    sourceTransition,
  };
  return { context, options: { ...options, now: now + 2 }, sourceTransition, response, seal };
}

test('protected role decisions remain bound in the real execution context and its checkpoint renewal', async (t) => {
  const value = await checkpointRenewalFixture(t, []);
  assert.deepEqual(value.context.contract.roleGrantDecisions, []);
  const updated = await readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
    renew: async () => value.response });
  assert.deepEqual(updated.contract, value.context.contract);
  assert.equal(updated.sourceCommit, value.sourceTransition.to.head);
});

test('semantic context: validated authority resources survive preparation and matching checkpoint renewal', async (t) => {
  const resources = [{ type: 'ui-component', key: 'admin/DeviceForm' }];
  const value = await checkpointRenewalFixture(t, undefined, resources);
  assert.deepEqual(value.context.contract.semanticResources, resources);
  const updated = await readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
    renew: async () => value.response });
  assert.deepEqual(updated.contract, value.context.contract);
  assert.equal(updated.contractId, value.context.contractId);
  assert.equal(updated.sourceCommit, value.sourceTransition.to.head);
});

for (const [label, before, after] of [
  ['present-to-absent', [{ type: 'table', key: 'orders' }], undefined],
  ['absent-to-present', undefined, [{ type: 'table', key: 'orders' }]],
  ['changed-resource', [{ type: 'table', key: 'orders' }], [{ type: 'table', key: 'orders_other' }]],
]) {
  test(`semantic context: renewal rejects ${label} without changing stored context`, async (t) => {
    const value = await checkpointRenewalFixture(t, undefined, before);
    const response = structuredClone(value.response);
    const task = response.trustedPolicyInput.taskAuthority;
    const { contract: _contract, ...scope } = task;
    task.contract = compileForgeTaskExecutionContract({ prompt: '修改前端后验证并发布。', ...scope },
      { semanticResources: after });
    await assert.rejects(readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
      renew: async () => response }), { code: 'EXECUTION_RENEWAL_MISMATCH' });
    assert.deepEqual(await readProtectedExecutionContext(value.options), value.context);
    if (before !== undefined) {
      // Omitting the entire contract cannot hide a resource removal either.
      delete task.contract;
      await assert.rejects(readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
        renew: async () => response }), { code: 'EXECUTION_RENEWAL_MISMATCH' });
    }
  });
}

test('semantic context: legacy authority without resources remains compatible and model fields are rejected', async (t) => {
  const value = await checkpointRenewalFixture(t);
  assert.equal(Object.hasOwn(value.context.contract, 'semanticResources'), false);
  const updated = await readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
    renew: async () => value.response });
  assert.deepEqual(updated.contract, value.context.contract);
  const request = authenticated(classifyPinnedDshPromptBody(promptBody(), 'session.prompt'));
  await assert.rejects(prepareProtectedExecutionContext({ projectRoot: value.options.projectRoot,
    projectSlug: metadata.projectSlug, taskMetadata: metadata, policyPath,
    request: { ...request, semanticResources: [{ type: 'table', key: 'orders' }] },
  }), { code: 'EXECUTION_INPUT_INVALID' });
});

test('checkpoint renewal updates the consumed same-RPC context before expiry without changing its scope', async (t) => {
  const value = await checkpointRenewalFixture(t);
  let calls = 0;
  const updated = await readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
    renew: async (context) => { calls += 1; assert.deepEqual(context, value.context); return value.response; } });
  assert.equal(calls, 1);
  assert.equal(updated.sourceCommit, value.sourceTransition.to.head);
  assert.equal(updated.workspaceFingerprint, value.sourceTransition.to.fingerprint);
  for (const key of ['rpcId', 'executionId', 'generation', 'contractId', 'actionCeiling', 'ownedPaths', 'contract']) {
    assert.deepEqual(updated[key], value.context[key], key);
  }
  assert.deepEqual(await readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
    renew: async () => { throw new Error('already migrated checkpoint must not renew again'); } }), updated);
});

test('source renewal never treats unfinished merge, checkpoint content drift or another authority as current', async (t) => {
  const value = await checkpointRenewalFixture(t);
  for (const mutation of [
    (transition) => { transition.phase = 'conflict-open'; },
    (transition) => { transition.to.fingerprint = '7'.repeat(64); },
    (transition) => { transition.task.conversationId = 'different-conversation'; },
    (transition) => { transition.from.head = '7'.repeat(40); },
    (transition) => { transition.sourceAuthority.executionId = crypto.randomUUID(); },
    (transition) => { transition.sourceAuthority.generation += 1; },
    (transition) => { transition.sourceAuthority.controllerGrantDigest = '7'.repeat(64); },
    (transition) => { transition.sourceAuthority.issuedAt = new Date(Date.parse(transition.sourceAuthority.issuedAt) + 1).toISOString(); },
    (transition) => { transition.sourceAuthority.expiresAt = new Date(Date.parse(transition.sourceAuthority.expiresAt) + 1).toISOString(); },
  ]) {
    const changed = structuredClone(value.sourceTransition); mutation(changed);
    const result = await readProtectedExecutionContext({ ...value.options, sourceTransition: value.seal(changed),
      renew: async () => { throw new Error('unbound transition cannot trigger renewal'); } });
    assert.deepEqual(result, value.context);
  }
});

test('integrated renewal advances execution once in the same RPC while preserving the task contract', async (t) => {
  const value = await checkpointRenewalFixture(t);
  const transition = value.seal({ ...value.sourceTransition, phase: 'integrated',
    to: { ...value.sourceTransition.to, fingerprint: '8'.repeat(64) } });
  const response = structuredClone(value.response);
  response.sourceTransition = transition;
  response.authority.workspaceFingerprint = transition.to.fingerprint;
  response.authority.productionAuthorityDigest = digestProductionTaskAuthorityBinding({
    ...response.authority, productionAuthorityId: response.authority.authorityId,
  });
  const updated = await readProtectedExecutionContext({ ...value.options, sourceTransition: transition, renew: async () => response });
  assert.equal(updated.generation, value.context.generation + 1);
  assert.notEqual(updated.executionId, value.context.executionId);
  assert.notEqual(updated.claimId, value.context.claimId);
  assert.equal(updated.sourceCommit, transition.to.head);
  assert.equal(updated.workspaceFingerprint, transition.to.fingerprint);
  for (const key of ['rpcId', 'textDigest', 'contractId', 'actionCeiling', 'ownedPaths', 'contract']) {
    assert.deepEqual(updated[key], value.context[key], key);
  }
  assert.deepEqual(await readProtectedExecutionContext({ ...value.options, sourceTransition: transition,
    renew: async () => { throw new Error('a consumed integration cannot advance a second time'); } }), updated);
});

test('checkpoint renewal rejects missing or changed service confirmation without updating protected state', async (t) => {
  const value = await checkpointRenewalFixture(t);
  for (const mutation of [
    (response) => { delete response.sourceTransition; },
    (response) => { response.sourceTransition.digest = '7'.repeat(64); },
    (response) => { response.authority.sourceCommit = '7'.repeat(40); },
    (response) => { response.authority.actionCeiling = 'workspace-write'; },
  ]) {
    const response = structuredClone(value.response); mutation(response);
    await assert.rejects(readProtectedExecutionContext({ ...value.options, sourceTransition: value.sourceTransition,
      renew: async () => response }), { code: 'EXECUTION_RENEWAL_MISMATCH' });
    assert.deepEqual(await readProtectedExecutionContext(value.options), value.context);
  }
});

test('checkpoint renewal does not allow an ordinary expiring lease to change HEAD without a transition', async (t) => {
  const value = await checkpointRenewalFixture(t);
  const options = { ...value.options, now: Date.parse(value.context.expiresAt) - 1 };
  await assert.rejects(readProtectedExecutionContext({ ...options, renew: async () => value.response }),
    { code: 'EXECUTION_RENEWAL_MISMATCH' });
  assert.deepEqual(await readProtectedExecutionContext(value.options), value.context);
  const response = structuredClone(value.response);
  response.authority.sourceCommit = value.context.sourceCommit;
  response.authority.productionAuthorityDigest = digestProductionTaskAuthorityBinding({
    ...response.authority, productionAuthorityId: response.authority.authorityId,
  });
  delete response.sourceTransition;
  const updated = await readProtectedExecutionContext({ ...options, renew: async () => response });
  assert.equal(updated.sourceCommit, value.context.sourceCommit);
  assert.equal(updated.workspaceFingerprint, response.authority.workspaceFingerprint);
});

test('production task writer preserves each explicit trusted action ceiling and rejects unknown values', async (t) => {
  const prompt = '完成受保护的生产任务并保留显式动作上限。';
  for (const [index, actionCeiling] of ['workspace-write', 'git-checkpoint', 'release'].entries()) {
    await t.test(actionCeiling, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `forge-execution-production-${index}-`));
      try {
        const request = authenticated(classifyPinnedDshPromptBody(promptBody({
          rpcId: `production-action-${index}`,
          content: [{ type: 'text', text: prompt }],
        }), 'session.prompt'), `production-action-request-${index}`);
        const taskAuthority = {
          actionCeiling,
          ownedPaths: ['forge-admin-ui/src/views/accident'],
          taskProfiles: ['frontend-admin'],
        };
        const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
        const productionAuthorityId = '123e4567-e89b-42d3-a456-426614174226';
        const controllerGrantDigest = '3'.repeat(64);
        const trustedPolicyInput = {
          profile: 'production-controller',
          sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
          workspaceFingerprint: '1'.repeat(64),
          caseFamily: 'maintenance',
          productionAuthorityId,
          productionAuthorityDigest: digestProductionTaskAuthorityBinding({
            projectSlug: metadata.projectSlug,
            taskId: metadata.taskId,
            actorUserId,
            actorUsername: 'alice',
            conversationId: metadata.conversationId,
            dshSessionId: request.dshSessionId,
            route: request.route,
            rpcId: request.rpcId,
            promptDigest: request.textDigest,
            sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
            workspaceFingerprint: '1'.repeat(64),
            caseFamily: 'maintenance',
            productionAuthorityId,
            controllerGrantDigest,
            contractId: contract.contractId,
            actionCeiling,
            ownedPaths: contract.ownedPaths,
          }),
          controllerGrantDigest,
          expectedContractId: contract.contractId,
          taskAuthority,
        };

        const context = await prepareProtectedExecutionContext({
          projectRoot: root,
          projectSlug: metadata.projectSlug,
          taskMetadata: metadata,
          request,
          policyPath,
          trustedPolicyInput,
        });
        const { idempotent: _idempotent, refreshed: _refreshed, ...persisted } = context;
        const roundtripped = JSON.parse(JSON.stringify(persisted));

        assert.equal(context.authorityClass, 'production-task-writer');
        assert.equal(context.actionCeiling, actionCeiling);
        assert.equal(context.contract.actionCeiling, actionCeiling);
        assert.equal(validateProtectedExecutionContext(roundtripped).actionCeiling, actionCeiling);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  const invalidRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-production-invalid-'));
  t.after(() => rm(invalidRoot, { recursive: true, force: true }));
  const invalidRequest = authenticated(classifyPinnedDshPromptBody(promptBody({
    rpcId: 'production-action-invalid',
    content: [{ type: 'text', text: prompt }],
  }), 'session.prompt'), 'production-action-request-invalid');
  await assert.rejects(() => prepareProtectedExecutionContext({
    projectRoot: invalidRoot,
    projectSlug: metadata.projectSlug,
    taskMetadata: metadata,
    request: invalidRequest,
    policyPath,
    trustedPolicyInput: {
      profile: 'production-controller',
      sourceCommit: '6eb2881e6f6af85a5348acf3da63cef53a873b0e',
      workspaceFingerprint: '1'.repeat(64),
      caseFamily: 'maintenance',
      productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226',
      productionAuthorityDigest: '2'.repeat(64),
      controllerGrantDigest: '3'.repeat(64),
      expectedContractId: '4'.repeat(64),
      taskAuthority: {
        actionCeiling: 'unknown',
        ownedPaths: ['forge-admin-ui/src/views/accident'],
        taskProfiles: ['frontend-admin'],
      },
    },
  }), (error) => error.code === 'EXECUTION_POLICY_ROUTE_DENIED');
});

test('edge pagination writer route cannot mutate before the database skill is in its exact contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-edge-route-'));
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({
      rpcId: '123e4567-e89b-42d3-a456-426614174222',
      content: [{ type: 'text', text: '修复数据库分页边界与共享 PageQuery owner，并先写真实回归测试。' }],
    }), 'session.prompt'), 'request-edge-route');
    const context = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'edge-pagination-shared-owner',
      },
    });
    assert.deepEqual(context.contract.taskProfiles, ['database', 'backend', 'shared-owner']);
    assert.ok(context.contract.requiredSkills.includes('forge-database-migration'));
    assert.ok(context.contract.requiredSkills.includes('forge-backend-architecture'));
    assert.ok(context.contract.requiredObligations.includes('transaction-index-and-query-review'));
    assert.ok(context.contract.semanticOwners.includes('database-schema-and-persistence'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend AiCrudPage scenario has an unphased frontend-only writer route with typed verification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-frontend-route-'));
  try {
    const request = authenticated(classifyPinnedDshPromptBody(promptBody({
      rpcId: '123e4567-e89b-42d3-a456-426614174223',
      content: [{ type: 'text', text: '实现 AiCrudPage API 合同并验证 TypeScript、权限和状态。' }],
    }), 'session.prompt'), 'request-frontend-route');
    const context = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: testShadowPolicyPath,
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'frontend-aicrudpage-api-contract',
      },
    });
    assert.equal(context.workflowId, null);
    assert.equal(context.phaseId, null);
    assert.deepEqual(context.ownedPaths, ['forge-admin-ui']);
    assert.deepEqual(context.contract.taskProfiles, ['frontend-admin', 'security']);
    assert.deepEqual(context.requiredProfiles, [
      'governance', 'frontend-admin-lint', 'frontend-admin-test',
      'frontend-admin-typecheck', 'frontend-admin-build', 'changed-safe', 'full-regression',
    ]);
    assert.ok(context.contract.requiredSkills.includes('forge-frontend-admin'));
    assert.ok(!context.contract.requiredSkills.includes('forge-crud-production'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('batch-scoped checks preserve the complete third-batch implementation and release request', () => {
  const prompt = "现在继续安保第三批，完成后提交并发布到当前forge-base业务系统，随后我按MD逐页浏览器验收。此前暂停后续批次的安排已解除，但本轮只完成三防设施管理的人防、物防、技防三个页面，第四批一张图三防台账以后再做。前两批七页已实际浏览器验收通过，测试记录已正常删除，复用成果即可。第三批9份原始MD仍在 /project-inputs/incoming/2026-09-24/fdbad499-69b4-43a2-9104-7f36e55b843b/.forge-derived/prototype-2caf47f86052/README.md 及同级site目录；此前已经全文读过，请恢复完整要求，无法从已有上下文确认的原文需续读到文末，不能只看索引。历史提交2f7eed0a保留了第三批十文件草稿，后来为先发前两批而从候选撤回；请你通过现有受控工具评估并恢复可复用部分，不能回退覆盖前两批的新修复。完整落实人防各字段和真实申请/审批/状态约束/流程信息，物防技防档案及文件照片、查看编辑删除/批删/导出、筛选、导航和页内Tab，复用项目现有流程与附件能力，不造静态审批结果，不合并成下一批结构化台账。只检查本批新增修改及有直接依据的影响范围，保留有效检查证据；检查、提交、集成、复核、后台发布和结果回收在授权内连续完成，不等我再说继续或发版。若合同过期或正常源码阶段变化，按现有受控准备和有效回执复核机制续接，不能伪造回执或放宽权限；真正的平台拒绝请保留具体工具错误。最后按三个页面说明实际实现和发布版本，以及确实缺少业务决定的内容。业务代码和测试均由你在此Harness对话完成。";
  for (const request of [prompt, '完成后提交并发布。只检查本批新增修改及直接影响范围。', '实现三防设施。仅检查本批修改的文件。']) {
    assert.equal(hasGlobalReadOnlyIntent(request), false, request);
  }
  for (const request of ['只检查本批新增修改及直接影响范围。', '完成后提交并发布。只检查本批修改。不要修改代码。', '完成后提交并发布的方案讨论。只检查本批修改。']) {
    assert.equal(hasGlobalReadOnlyIntent(request), true, request);
  }
});

test('completed read-only diagnostic statements preserve an explicit current implementation', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-third-import-feedback-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt,
    '继续修复导入。只读运行日志已定位当前错误：导入未启用。',
    '修复页面。只读查询结果已经确认问题来自字段映射。',
    '继续修改。仅读取运行回执已证明旧检查失败。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [
    '继续修复导入。只读运行日志已定位错误。不要修改代码。',
    '继续修复导入。只读分析。',
    '只读运行日志，分析错误原因。',
    '请只读分析当前问题，不要执行。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('read-only evidence limitations do not revoke the original authorized candidate repair', () => {
  const prompt = `继续完成同一个已授权候选发布。本消息是集成后的新一轮明确请求：基于当前 HEAD d4f158b9131616ce22cf2be217e0800c0f5e608e 和当前源码，重新通过正常 prepare_task 取得最小修复权限，处理未发布迁移版本冲突及仍存在的公共国际化直接阻塞，随后必要验证、受控集成与发布。不要要求业务用户再手动回复继续。

请纠正上轮未经证实的结论：Codex只读核验 /integration/main@51c8d313 的中文 messages.properties 有3606键，英文messages_en.properties有3608键，多出“租户业务数据源未授权或不可写”“请先创建租户再授权业务数据源”。原候选和该主线都存在这个差异；UiMessagesTest第91行比较键集合，UiMessages还从中文资源建立legacyKeys映射。只读资源前5行不能证明它已修。先核当前集成工作区这两条键的实际情况，未修则在正常授权范围内由你完成最小公共资源修复，保留测试断言，不跳过失败测试。

允许的直接增量范围：原18个候选业务文件保持；你已指出的旧、向前的新迁移文件；forge-server/forge-framework/forge-starter-parent/forge-starter-core/src/main/resources/forge/i18n/messages.properties（仅该实际缺陷所需内容，英文源/UiMessagesTest只读核对即可）。迁移不得改动已发布历史，未发布候选新编号以实际最新版本为准。Codex不代写任何业务/测试。

平台已用现有只读 protected-completion 接口核当前合同e83e7944：BOUNDED_BLOCKED、18项未闭合，但不存在 DB-REVIEW-001、BE-RELIABILITY-001、FE-UX-001、OBS-001 四项独立人工补签。真正requiredProfiles为governance/backend-module-test/frontend-admin-lint/frontend-admin-test。请按当前合同与正式回执闭合，不自行调用不适用的独审入口或要求用户找人登记。

旧有效前端54项与Lint按平台支持的正式reuse-receipt复核，只有绑定不兼容才重验；后端先修根因再执行必要范围。保留真实失败。业务发布由你沿正常受控入口完成并核回执；不做浏览器/页面UAT，不扩其他业务。
`;
  const fact = '只读资源前5行不能证明它已修';
  for (const text of [prompt,
    '继续修复当前问题。只读取文件开头不足以确认问题已经解决。',
    '修复当前候选。仅读取日志无法说明修复已经生效。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [prompt + '\n本轮只读分析。', prompt + '\n不要修改任何文件。',
    fact,
    `继续修复当前问题。请${fact}。`,
    `继续修复当前问题。本轮${fact}。`,
    '继续修复当前问题。只读资源前5行，不能证明它已修。',
    '继续修复当前问题。只读资源前5行是否能证明它已修？',
    `继续修复当前问题。${fact}并只读分析。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
  const contract = compileForgeTaskExecutionContract({
    prompt, ownedPaths: ['forge-server/example/messages.properties'], actionCeiling: 'workspace-write',
  });
  assert.deepEqual(contract.ownedPaths, ['forge-server/example/messages.properties']);
  assert.ok(!contract.ownedPaths.some(file => /messages_en|UiMessagesTest/u.test(file)),
    'a statement about evidence cannot authorize writes to read-only references');
});

test('business read visibility limits preserve the actual Fire implementation request', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/backend-fire-business-read-visibility-request.json', import.meta.url), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(prompt).digest('hex'), '9187d3dc269f461ddcf852baba6d40d338e7994deab3429129a71ee5f93620ee');
  const limits = ['只读范围对齐不扩大办理、签署或修改资格', '只读可见不自动获得他人办理权限'];
  for (const text of [prompt, ...limits.map(limit => `请修复消防授权。${limit}。`)]) {
    assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  }
  for (const text of [prompt + '\n本轮只读分析，不得修改代码。', prompt + '\n不要修改代码。',
    ...limits, ...limits.map(limit => `文档示例：“请修复消防授权。”。\n${limit}。`),
    '请修复消防授权。本轮只读，不修改。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('recipient record read-only behavior does not revoke implementation', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-third-cc-receiver-feedback-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt,
    '修复抄送页面，使收件人能查看自己收到的申请详情；只读当前记录，不给审批权。',
    '实现详情页面，让普通用户可以查看自己的记录；只读该记录。',
    '实现接收页面。只检查修改及直接影响范围。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [prompt + '\n不要修改代码。', prompt + '\n本轮只读分析。',
    '修复抄送页面。只读当前记录。',
    '只读当前记录，分析问题。',
    '实现页面，让模型查看申请详情；只读当前记录。',
    '实现页面，让收件人查看申请详情；只读分析当前代码。',
    '只检查修改及直接影响范围。',
    '实现页面。只检查修改方案。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('read-only observed bindings preserve an explicit inspection and repair request', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-fifth-role-feedback-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt,
    '请在本会话检查并修复权限。只读核对现有sys_user_org_role：admin=1/org6/admin。',
    '请在当前对话中定位并修复问题。只读核对当前config:mode=enabled。',
    '继续修复权限。只读核对现有bindings:user=37/manager。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [prompt + '\n不要修改代码。', prompt + '\n本轮只读分析。',
    '只读核对现有sys_user_org_role：admin=1/org6/admin。',
    '请在本会话检查是否需要修复权限。只读核对现有bindings:user=37。',
    '请在本会话检查并修复权限。请只读核对现有bindings:user=37。',
    '请在本会话检查并修复权限。只读核对现有绑定是否正确。',
    '文档示例为“请在本会话检查并修复权限”。只读核对现有bindings:user=37。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('source inspection findings preserve explicit business role repair', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-fifth-role-ceiling-feedback-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt,
    '请核对并修复角色。只读检查当前SysUserServiceImpl1360—1383：普通用户不允许ALL或TENANT。',
    '修复权限。只读检查当前Policy.java：普通用户不能获得全部数据范围。',
    '修复授权。只读核对现有RolePolicy：业务用户允许本组织数据。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [prompt + '\n本轮只读分析。', prompt + '\n不要修改代码。',
    '只读检查当前Policy.java：普通用户不能获得全部数据范围。',
    '修复权限。请只读检查当前Policy.java：普通用户不能获得全部数据范围。',
    '修复权限。本轮只读检查当前Policy.java：普通用户不能获得全部数据范围。',
    '修复权限。只读检查当前Policy.java：确认普通用户不能获得全部数据范围。',
    '修复权限。只读检查当前Policy.java：是否允许全部数据范围。',
    '修复权限。只读检查当前Policy.java。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('numbered baseline evidence preserves explicit rollback of unintended edits', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-third-cc-legacy-feedback-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt,
    '仅撤回误加注解。只读基线比对1002确认原方法相同。',
    '继续修复。只读比对记录 42 证明两个版本相同。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [prompt + '\n本轮只读分析。', prompt + '\n不要修改代码。',
    '仅撤回误加注解。只读基线比对并确认原方法是否相同。',
    '仅撤回误加注解。请只读基线比对1002确认原方法相同。',
    '只读基线比对1002确认原方法相同。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('direct impact scope without a conjunction preserves the exact approval repair', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-third-approval-feedback-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt, '继续修复审批。只检查本次修改直接影响范围。', '实现页面。仅验证当前变更直接影响的文件。']) {
    assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  }
  for (const text of ['只检查本次修改直接影响范围。', prompt + '\n不要修改代码。', '继续修复审批。只检查当前问题，不要执行。']) {
    assert.equal(hasGlobalReadOnlyIntent(text), true, text);
  }
});

test('separate implementation request keeps fifth batch verification scope local', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-fifth-original-request-20260925.json', import.meta.url), 'utf8'));
  for (const text of [prompt, prompt.slice(prompt.indexOf('开始安保第五批')),
    '分别实现两个页面。只检查本批新增修改和有直接依据的影响范围。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), false, text);
  for (const text of [prompt + '\n不要修改代码。', prompt + '\n本轮只读分析。',
    '只检查本批新增修改和有直接依据的影响范围。',
    '只读分析分别实现两个页面的方案。只检查本批修改。',
    '文档示例是“分别实现两个页面”。只检查本批修改。',
    '是否分别实现两个页面？只检查本批修改。',
  ]) assert.equal(hasGlobalReadOnlyIntent(text), true, text);
});

test('scoped verification preserves the exact sixth batch controlled release request', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-sixth-scoped-release-20260927.json', import.meta.url), 'utf8'));
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  const action = '完成必要检查、受控提交集成、发布到当前项目';
  const scope = '只检查本批新增修改和有直接依据的影响范围。';
  assert.equal(hasGlobalReadOnlyIntent(`${action}。${scope}`), false);
  for (const restricted of [
    `${action}？${scope}`, `是否${action}。${scope}`,
    `日志显示：${action}。${scope}`, `“${action}”。${scope}`,
    `文档示例：\n${action}。\n${scope}`,
    `\`\`\`text\n${action}。\n\`\`\`\n${scope}`,
    `${action}。${scope}不要修改代码。`, `${action}。${scope}只给方案。`,
  ]) assert.equal(hasGlobalReadOnlyIntent(restricted), true, restricted);
});

test('direct text with image references retains text intent and binds the complete body', async () => {
  const text = '单人调查也需要委任书，内容参考截图，样式布局参考团队调查委任书';
  const content = [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }, { type: 'text', text }];
  const body = promptBody({ content });
  const classified = classifyPinnedDshPromptBody(body, 'session.prompt');
  assert.equal(classified.classification, 'claimable-text');
  assert.equal(classified.imageCount, 1);
  assert.equal(classified.promptText, text);
  assert.equal(classified.textDigest, digestDirectUserTextContent([{ type: 'text', text }]));
  const changed = classifyPinnedDshPromptBody(promptBody({ content: [
    { type: 'image', mediaType: 'image/png', data: 'd29ybGQ=' }, { type: 'text', text },
  ] }), 'session.prompt');
  assert.equal(changed.textDigest, classified.textDigest);
  assert.notEqual(changed.bodyDigest, classified.bodyDigest);
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-image-reference-'));
  try {
    const execution = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classified), now: Date.parse('2026-09-01T00:00:00.000Z'), policyPath,
    });
    assert.equal(execution.classification, 'claimable-text');
    assert.equal(execution.authorityClass, 'production-read-only');
    assert.equal(execution.bodyDigest, classified.bodyDigest);
    assert.equal(execution.actionCeiling, 'read-only');
  } finally { await rm(root, { recursive: true, force: true }); }
  const imageOnly = classifyPinnedDshPromptBody(promptBody({ content: [
    content[0], { type: 'text', text: '  ' },
  ] }), 'session.prompt');
  assert.equal(imageOnly.classification, 'read-only-image');
});

test('remaining full candidate publication retains scoped verification intent', async () => {
  const { prompt } = JSON.parse(await readFile(new URL('./fixtures/security-sixth-full-candidate-release-20260927.json', import.meta.url), 'utf8'));
  for (const action of [prompt, '完成剩余受控提交集成、发布。', '完成后直接受控提交集成和发布。', '继续剩余的受控提交、集成以及发布。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${action}只检查本次修改。`), false, action);
    assert.equal(hasGlobalReadOnlyIntent(`${action}本轮不要修改代码。`), true, action);
  }
});

test('Broker runtime resolves the same image text digest as the Manager', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-image-broker-'));
  const tokenFile = `/run/forge-taskspace/image-test-${crypto.randomUUID()}`;
  const content = [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
    { type: 'text', text: '单人调查也需要委任书，内容参考截图，样式布局参考团队调查委任书' }];
  const classified = classifyPinnedDshPromptBody(promptBody({ content }), 'session.prompt');
  const token = crypto.randomBytes(32).toString('hex');
  let server;
  try {
    await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classified), now: Date.now(), policyPath,
    });
    let calls = 0;
    server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.headers['x-forge-taskspace-token'], token);
      assert.equal(input.textDigest, classified.textDigest);
      assert.equal(input.rpcId, classified.rpcId);
      calls += 1; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: context }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const resolver = createBrokerExecutionContextResolver({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
      tokenFile, projectSlug: metadata.projectSlug, taskId: metadata.taskId,
      conversationId: metadata.conversationId, actorUserId: metadata.actorUserId });
    const resolve = (blocks) => resolver({ agent: { session: { id: 'session-one' } },
      decision: { messages: [{ source: { kind: 'user', rpcId: classified.rpcId }, content: blocks }] } });
    assert.equal((await resolve(content))?.executionId, context.executionId);
    assert.equal((await resolve([content[1]]))?.executionId, context.executionId);
    assert.equal(await resolve([content[0]]), undefined);
    assert.equal(await resolve([{ type: 'document', text: content[1].text }, content[1]]), undefined);
    assert.equal(await resolve([{ type: 'text', text: 42 }, content[0]]), undefined);
    assert.equal(calls, 2);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tokenFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('source transition context lookup waits for slow Broker while ordinary deadlines and identity remain enforced', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-transition-broker-'));
  const tokenFile = `/run/forge-taskspace/transition-test-${crypto.randomUUID()}`;
  const content = [{ type: 'text', text: '查看当前状态。' }];
  const classified = classifyPinnedDshPromptBody(promptBody({ content }), 'session.prompt');
  const token = crypto.randomBytes(32).toString('hex');
  let server;
  try {
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classified), now: Date.now(), policyPath,
    });
    let delayMs = 0;
    let mismatch = false;
    server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.headers['x-forge-taskspace-token'], token);
      assert.equal(input.rpcId, classified.rpcId);
      assert.equal(input.textDigest, classified.textDigest);
      const result = mismatch ? { ...context, rpcId: crypto.randomUUID() } : context;
      setTimeout(() => {
        if (!response.destroyed) response.end(JSON.stringify({ ok: true, result }));
      }, delayMs);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const resolver = createBrokerExecutionContextResolver({ brokerUrl: `http://127.0.0.1:${server.address().port}`,
      tokenFile, projectSlug: metadata.projectSlug, taskId: metadata.taskId,
      conversationId: metadata.conversationId, actorUserId: metadata.actorUserId,
      timeoutMs: 1000, sourceTransitionTimeoutMs: 2500 });
    const agent = { session: { id: 'session-one' } };
    await resolver({ agent, decision: { messages: [{ source: { kind: 'user', rpcId: classified.rpcId }, content }] } });
    delayMs = 1400;
    const continuation = { agent, decision: { messages: [] } };
    await assert.rejects(resolver(continuation), /EXECUTION_CONTEXT_TIMEOUT/u);
    assert.equal((await resolver({ ...continuation, sourceTransition: { phase: 'integrated' } })).executionId, context.executionId);
    await assert.rejects(resolver({ ...continuation, sourceTransition: { phase: 'unknown' } }), /EXECUTION_CONTEXT_TIMEOUT/u);
    delayMs = 0; mismatch = true;
    await assert.rejects(resolver({ ...continuation, sourceTransition: { phase: 'integrated' } }), /does not match the active DSH prompt/u);
    mismatch = false;
    const defaults = { brokerUrl: `http://127.0.0.1:${server.address().port}`, tokenFile,
      projectSlug: metadata.projectSlug, taskId: metadata.taskId,
      conversationId: metadata.conversationId, actorUserId: metadata.actorUserId };
    assert.throws(() => createBrokerExecutionContextResolver({ ...defaults, sourceTransitionTimeoutMs: 60_001 }), /configuration is invalid/u);
    const productionResolver = createBrokerExecutionContextResolver(defaults);
    await productionResolver({ agent, decision: { messages: [{ source: { kind: 'user', rpcId: classified.rpcId }, content }] } });
    delayMs = 31_000;
    assert.equal((await productionResolver({ ...continuation, sourceTransition: { phase: 'checkpointed' } })).executionId, context.executionId);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(tokenFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('current request renewal waits beyond five seconds without extending first lookup or accepting another RPC', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-ordinary-renewal-'));
  const tokenFile = `/run/forge-taskspace/renewal-test-${crypto.randomUUID()}`;
  const content = [{ type: 'text', text: '查看当前状态。' }];
  const classified = classifyPinnedDshPromptBody(promptBody({ content }), 'session.prompt');
  const token = crypto.randomBytes(32).toString('hex');
  let server;
  try {
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classified), now: Date.now(), policyPath,
    });
    let delayMs = 6100, mismatch = false;
    server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.headers['x-forge-taskspace-token'], token);
      assert.equal(input.rpcId, classified.rpcId);
      assert.equal(input.textDigest, classified.textDigest);
      assert.equal(Object.hasOwn(input, 'renewal'), false, 'the wait hint is local and never creates Broker authority');
      const result = mismatch ? { ...context, rpcId: crypto.randomUUID() } : context;
      const timer = setTimeout(() => response.end(JSON.stringify({ ok: true, result })), delayMs);
      response.once('close', () => clearTimeout(timer));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const options = { brokerUrl: `http://127.0.0.1:${server.address().port}`, tokenFile,
      projectSlug: metadata.projectSlug, taskId: metadata.taskId,
      conversationId: metadata.conversationId, actorUserId: metadata.actorUserId };
    const resolver = createBrokerExecutionContextResolver(options);
    const agent = { session: { id: 'session-one' } };
    const initial = { agent, decision: { messages: [{ source: { kind: 'user', rpcId: classified.rpcId }, content }] } };
    const renewal = { rpcId: classified.rpcId, dshSessionId: agent.session.id };
    await assert.rejects(resolver({ ...initial, renewal }), /EXECUTION_CONTEXT_TIMEOUT/u);
    delayMs = 0;
    await resolver(initial);
    delayMs = 6100;
    const started = Date.now();
    const renewed = await resolver({ agent, decision: { messages: [] }, renewal });
    assert.ok(Date.now() - started >= 6000, 'the real HTTP renewal exceeds the default five-second lookup deadline');
    assert.equal(renewed.executionId, context.executionId);
    assert.equal(renewed.rpcId, classified.rpcId);
    assert.equal(renewed.actionCeiling, context.actionCeiling);
    delayMs = 0; mismatch = true;
    await assert.rejects(resolver({ agent, decision: { messages: [] }, renewal }), /does not match the active DSH prompt/u);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(tokenFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('controlled preparation accepts a continued command and post-release observation without treating a receipt digest as a ban', () => {
  const digestFact = '只读原件摘要' + 'a'.repeat(64) + '，未写数据库。';
  for (const request of ['请继续执行当前任务的受控 forge-release prepare。', '继续当前消防任务的发布后受控运行补验。']) {
    assert.equal(hasDirectControlledPreparationIntent(request), true);
    assert.equal(hasGlobalReadOnlyIntent(request + digestFact), false);
    assert.equal(hasGlobalReadOnlyIntent(request + '本轮只读分析，不执行任何操作。'), true);
    assert.equal(hasDirectControlledPreparationIntent('日志：' + request), false);
    assert.equal(hasDirectControlledPreparationIntent('“' + request + '”'), false);
    assert.equal(hasDirectControlledPreparationIntent(request.replace('。', '？')), false);
    assert.equal(hasDirectControlledPreparationIntent('不要' + request), false);
  }
  assert.equal(hasGlobalReadOnlyIntent(digestFact), true);
});


test('business read-only clauses preserve table and record subjects while explicit turn restrictions win', () => {
  const action = '请继续实现安全目标任务执行，完成必要测试、保存、集成和受控发布。';
  const business = [
    '| 告知人 | 接收告知待办，只读查看结果 |',
    '| 被考核人 | 接收阅知待办，只读查看 |',
    '| 流程图 | openModuleFlow(code)，只读示意 |',
    '只读详情/审批沿既有公共详情浮层保留完整信息与合法动作。',
    '只读页面使用公共详情组件展示业务字段。',
    '只读表单保持字段禁用并显示审核记录。',
    '只读详情页默认在当前列表上的弹窗中展示。',
    '只读抽屉保留关闭按钮和业务状态。',
    '只读字段禁止编辑。',
    '- `BR-041`：**确认后分数锁定**——回写并推送告知待办；评分人侧该记录置 `locked = true`，只读。',
  ];
  for (const row of business) {
    assert.equal(hasGlobalReadOnlyIntent(`${action}\n${row}`), false, row);
    assert.equal(hasGlobalReadOnlyIntent(row), true, 'a business description alone does not authorize implementation');
  }
  const reference = `<requirements-reference>\n${business.join('\n')}\n${business.join('\n')}\n</requirements-reference>`;
  const request = `${action}\n${reference}`;
  assert.equal(hasGlobalReadOnlyIntent(request), false);
  for (const restriction of [
    '本轮只读分析，不要修改代码。', '只读', '不要修改任何文件。',
    '| 执行约束 | 本轮只读分析，不要修改代码 |',
    '| 本轮只读 | 执行边界 |',
    '| 业务规则 | 请先看材料，只读分析，不要修改代码 |',
  ]) assert.equal(hasGlobalReadOnlyIntent(`${request}\n${restriction}`), true, restriction);
  assert.equal(hasGlobalReadOnlyIntent(`${action}\n评分人侧该记录置 locked=true，本轮只读。`), true);
  for (const restriction of [
    '本轮只读详情页，不修改代码。', '请只读查看页面代码。',
    '只读页面的代码。', '只读表单数据。', '只读查看数据库。',
    '只读分析详情页如何实现。', '只读详情页是否显示正常？',
  ]) assert.equal(hasGlobalReadOnlyIntent(`${action}\n${restriction}`), true, restriction);
});

test('continued release keeps negative read-only UI presentation requirements local', async () => {
  const original = await readFile(new URL('./fixtures/frontend-scope-repaired-release-prompt.md', import.meta.url));
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), '3f72fc9e63ea764cf9b5dddc69952f342b2e757d4b28990168b0a1f17779a895');
  const prompt = original.toString('utf8');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  for (const restriction of ['本轮只读分析。', '只读', '不要修改任何文件。', '禁止执行任何操作。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
  }
  for (const property of [
    '只读详情不应变成满页灰色输入框。',
    '只读表单不应该显示为禁用的编辑控件。',
    '只读页面不能呈现为原始 JSON。',
  ]) {
    assert.equal(hasGlobalReadOnlyIntent(property), true, 'a UI description alone grants no implementation exception');
    assert.equal(hasGlobalReadOnlyIntent(`请修正当前页面。${property}`), false);
    for (const command of ['检查通过后再发布。', '验证通过后受控发布。', '测试通过后再部署。']) {
      assert.equal(hasGlobalReadOnlyIntent(`${command}\n${property}`), false, command);
      for (const nonCommand of [`${command.slice(0, -1)}？`, `日志记录：${command}`, `“${command}”`, `不要${command}`]) {
        assert.equal(hasGlobalReadOnlyIntent(`${nonCommand}\n${property}`), true, nonCommand);
      }
    }
  }
  for (const restriction of ['请只读查看页面代码。', '只读表单数据。', '只读查看数据库。']) {
    assert.equal(hasGlobalReadOnlyIntent(`检查通过后再发布。${restriction}`), true, restriction);
  }
});

test('native modal request keeps business read-only views local without granting execution authority', async () => {
  const prompt = "继续当前事故前端任务。本轮明确授权必要业务代码/测试修正、正常同步集成和检查点，以及受控发布必要服务。Owner刚指出事故新增独立页与原版用户管理浮层不同，要求先走原版全过程；该浏览器核实已经完成。撤销上一轮prompt第3项“保留事故已有独立表单”，那是Codex根据既有实现作出的无依据判断，不是产品要求。不要继续沿用它。\n\n已核实依据：原版用户管理新增、编辑、点击用户名只读详情都在当前列表上的modal完成，创建/编辑共用分组两列表单，900px居中，正文可滚动，底部操作可见；取消/关闭保留列表URL与上下文。空表单显示字段必填提示。事故实际则类型选择后跳到/accident/report-form/EHSS。固定原事故c07f6e2b的code-copilot/changes/accident-incident-management/spec.md:43写“类型选择弹窗（4选1）→打开对应上报表单弹窗”，:93是上报审批详情弹窗；:270独立页指另一个审批App。原始上传HTML未取得，这些规格不能冒充Owner人工确认，但没有产品要求独立新增页的证据。Owner最新要求已明确以原版浮层流程为默认基准。\n\n在当前工作区保留全部有效草稿，完成以下直接修正：\n1. 事故列表“发起上报”仍按真实四类型选择，选择后在当前列表打开对应上报表单浮层，不新开独立工作页/页签。编辑草稿使用同一浮层、同一schema与DTO转换，真实回填。沿现有公共表单/浮层owner的尺寸、两列/长文本跨列、分组导航、正文滚动、底部动作和关闭语义；以原版user.vue、当前AiCrudPage/ai-modal真实接口为依据，不虚构prop/slot，不复制一套局部CSS和提交控制器。\n2. 保留真实业务字段、四类型差异、保存草稿/提交/取消、权限与状态限制，不能为套普通CRUD丢掉草稿或提交动作。底部动作统一归属一个公共容器；取消/关闭不写数据，提交busy防重，失败保留输入，成功反馈并更新列表。只读详情/审批沿既有公共详情浮层保留完整信息与合法动作，不把审批当编辑保存。既有直链如被其他真实入口使用，采用最小兼容方式，不能留下两套表单实现或破坏已用入口。\n3. 保留上一轮已经完成的日期/时间控件、DTO和对应测试草稿，以及前轮多选/批删helper和查询修复。真实删除仍受remove权限、同租户和仅草稿限制；禁止删除既有事故数据或代审批来制造验收。\n4. 读取当前实际manifest、.82或更新版frontend page-patterns/UI一致性Skill。普通新增/编辑默认modal，其他模式必须有当前需求或已确认交互依据；既有router跳转、字段多/表单长、草稿+提交都不是独立页依据。不要再扩低代码接管。\n\n前轮已正常取消running=false/turn19/53333 aborted(user)，草稿保留。最后governance调用被取消且没有返回job/检查回执，后台状态未知；先沿现有受支持状态入口恢复必要检查，不重复启动仍运行的job。有效旧检查按正式能力复用；只验证当前新增/修改及直接影响，不全仓回归。frontend-wide历史isme:icons失败与已用三个相关spec通过21项的证据保留；含[]路径lint走默认changed-files，不重复失败的显式路径用法。\n\n现有运行合同pin错配已经由正常同步解除，不回退并行Dockerfile、不手改受保护合同/approval。canonical如有新变更按正常受控同步保留，不覆盖其他会话成果。业务代码/测试/发布全部由你在本Harness完成。最终提交与同次必要发布包含当前事故浮层修正和已有有效草稿；报告真实源码/检查/发布/运行版本，不以工具accepted或页面能打开替代完成。\n";
  assert.equal(crypto.createHash('sha256').update(prompt).digest('hex'), '9d2c30506de92ece939f34682fac84e2be0141f56a99eabe985ada42bda9c1fd');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  for (const restriction of ['本轮只读分析。', '只读', '不要修改任何文件。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
  }
  const classified = classifyPinnedDshPromptBody(promptBody({ content: [{ type: 'text', text: prompt }] }), 'session.prompt');
  assert.equal(classified.promptText, prompt);
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-modal-read-only-'));
  try {
    const execution = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: authenticated(classified), now: Date.parse('2026-09-01T00:00:00.000Z'), policyPath,
    });
    assert.equal(execution.textDigest, classified.textDigest);
    assert.equal(execution.authorityClass, 'production-read-only');
    assert.equal(execution.actionCeiling, 'read-only');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('menu object responsibility clauses preserve explicit accident spec writes without granting authority', () => {
  // Complete original request that was rejected at prepare_task seq333270/333271.
  const prompt = "继续本原对话的需求中心历史资料工作。本轮用户指出“事故事件管理 / 事故事件台账”看不到业务实体关系、图及对应表。Root已在普通账号核实：指定你上次事故提交b2b632da对应批次可读两实体和一表，但默认列表为空的问题由平台修复，不由你改平台。\n\n你本轮只负责事故资料的真实内容纠正，写入原有 code-copilot/changes/delivery-center-history-accident/spec.md，正常提交并经既有自动采集路径收录。不要修改业务代码、业务测试、数据库、平台代码；不重跑业务测试/八阶段/发布，不改其它模块资料，不为收录添加无意义文件。\n\n具体已观察问题：accident.entity.incident的原描述是v1台账且新版菜单不读取它；accident.entity.investigation有reportId但无显式关系；已绑定台账的表目前只有旧t_accident_incident；entities的relations为空，图只是单实体属性图，模型到表映射为空。这些不是当前台账业务模型完整的证据。\n\n请先读取你已形成的事故spec及其明确来源，复用原历史截点34b0710e的源码索引和已有核对结果。沿该截点“事故事件台账”的真实页面路由→接口→业务对象/持久化读取链，只核当前台账直接涉及的已有对象与表，区分该截点的新台账、旧v1和共享依赖。不需要扫全项目、不自动拉取或合并其它业务更新，也不要把历史截点标成现在生产版本。\n\n修正过程产物，使业务人员能看到：台账这个视图由哪些对象组成；每个对象的业务含义和关键属性；对象间实际逻辑引用、连接字段、已知数量关系与未知项；业务对象对应哪些表、属性怎样存储；该菜单直接维护哪些对象，只读取哪些共享对象；旧版记录为何保留、它和该截点台账的关系。用户/组织等基础对象只有确实参与本菜单时才记录引用及用途，不复制整份通用定义，不根据通用审计字段推定直接业务依赖。\n\n关系、映射、菜单/功能关联使用既有deliveryCenter结构与稳定标识，保留准确path@commit来源。关系应能由中心现有Mermaid绘制；可以在原文明确的关系基础上输出Mermaid，但不能为了画图发明关系、基数、权限或采用结论。缺少目标修订保持未知，不生成伪造回执；原adoption/发布/验收未知不能改为通过。现有字段和失败历史不得丢失。\n\n完成后只做本次文档必要的最小治理检查，复用未变化的有效证据，然后在原对话正常checkpoint提交这一份spec。说明实际修正、固定来源截点、保留未知和提交结果；不要停在计划或用“资料已存在”代替这次缺失关系的补齐。若确有源码证据不足，明确具体缺口和现有最小事实，不编造。\n";
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  const responsibility = '该菜单直接维护哪些对象，只读取哪些共享对象。';
  assert.equal(hasGlobalReadOnlyIntent(responsibility), true, 'business description alone grants no write scope');
  for (const restriction of ['本轮只读取，不要修改任何文件。', '本轮只读分析。', '不要修改任何文件。']) {
    assert.equal(hasGlobalReadOnlyIntent(prompt + '\n' + restriction), true, restriction);
  }
  assert.equal(hasGlobalReadOnlyIntent('请修正事故spec。该菜单有共享对象，只读取源码。'), true, 'business keywords do not waive inspection-only scope');
  assert.equal(hasGlobalReadOnlyIntent('请修正事故spec。该菜单直接维护哪些对象，只读取源码。'), true, 'the menu question does not waive another read-only action');
});


const FIVE_MODULE_ORIGINAL_PROMPTS = [
  {
    "name": "fire",
    "sha256": "a8418e2954f634d88f26233d3630e9609986f113dab22af577660dd435e114ba",
    "prompt": "请实现并提交、发布消防现有PC页面的前端标准化修复。\r\n\r\n当前明确范围：forge-admin-ui/src/views/fire及该模块直接使用的业务组件/API/前端测试；以当前真实菜单和代码核实范围。\r\n原消防fire-management-eight-stage对话与当前main中的消防实现。原对话属于其他账号，当前为Owner授权的独立关联前端修复，原会话及工作区保留。\r\n\r\n本次只读盘点页面候选（不是完成证明）：\r\n- 台账与记录：equipment、detect-record、maintain-record、alarm、spare-part、maintenance-report\r\n- 三类审批：isolation-approval、occupy-approval、water-approval\r\n- 巡检与地图：inspection、map\r\n\r\n已发现的代表差距（原对话核实实际行为后修）：\r\n- forge-admin-ui/src/views/fire/components/FireCrudPage.vue：已复用AiCrudPage；readonly或缺batchDelete均隐藏多选/批删。前者可能合法，缺接口不能自动视为产品不需要默认能力。\r\n- forge-admin-ui/src/views/fire/components/FireApprovalPage.vue：额外审批动作使用自有NModal及底栏；统一公共弹层/滚动/防重/错误反馈，保留签字审批规则。\r\nOwner已确认：用平台原生用户管理和已交付的公共前端标准，优化五模块全部已生成PC业务页面。当前这轮仅负责本文指定的一个模块，从最新main保留其他AI成果继续。你负责业务代码、业务测试和正常受控提交发布；操作员负责公共底座和直接平台阻塞，不会替你代写业务。\r\n\r\n先读取实际forge-admin-ui/DESIGN.md、原版src/views/system/user.vue相关模式以及forge-frontend-admin Skill的references/page-patterns.md，核实当前AiCrudPage/AiSearch/AiTable/AiForm/ai-modal/MasterDetailWorkspace/SystemTableCell的真实接口。沿实际组件和主题实现，不每页重新发明查询、表格、分页、弹窗及样式。原有业务规则、状态、数据、权限、后端接口、已有导入导出/签字/附件和子表能力保持。\r\n\r\n完整标准同时覆盖：页面/打开方式、布局与信息层级、字体主题密度、按钮样式与位置顺序、查询区、列表默认能力、表格语义、新增编辑、分组长表单、可读详情及审批、弹窗抽屉浮层、完整提交过程、加载/空/错/无权限等状态、返回上下文、数据格式与业务文案、权限及状态、宽窄窗口与焦点、关联选择/附件等既有扩展、标准代码与API组织。这些是默认前端能力，不等待产品逐控件补需求。\r\n\r\n普通可维护台账默认多选/全选/选中数量/批删及确认；仅有单删接口时采用已有公共支持的真实逐条调用，正确保留失败项、刷新成功项，不用“无batch端点”隐藏能力。只读归档/审计、审批和库存流水等真实语义限制按现有业务核定，记录具体依据，不能机械加删除。普通新增编辑默认原生modal；已有独立路由、字段多、草稿按钮都不足以保留独立编辑页。原专用主从工作区、地图、流程/模板设计器按真实交互保留。\r\n\r\n按钮主次/尺寸/图标/顺序沿公共实现，查询为搜索→重置→适用的展开，底部取消在左、次操作居中、保存/提交主操作在右；行常用操作保持稳定顺序，低频用更多。字段使用语义控件、字典和关联选择；编辑真实回填；校验、防重、busy、失败保留、重试、重开复位、取消不写、未保存关闭遵循现有公共规则。详情用完整分组可读值，不用灰色disabled输入框或原始JSON。保留设计器已拥有的显示配置/字段，不因改版覆盖人工配置；这次不扩建低代码系统。\r\n\r\n完成本模块全部已生成页面的差距修复。你可按共享业务组件及页面类型分组处理；已达标的实现保留并说明，无需为了凑改动重写。API调用和转换进入本模块现有API层，复用公共状态/反馈，业务专用扩展维持明确边界。发现直接公共缺口给出最小证据和所需接口，由操作员处理底座；其余可推进页面继续完成。\r\n\r\n验证限定本次修改及明确直接影响：相关前端lint/组件交互/业务边界与正常受控发布检查，保留有效旧证据；源码检查和浏览器实际行为分别报告。避免重跑无关后端、全仓扫描或从需求阶段重启整个八阶段。业务数据验收优先测试适配/专用测试记录，不删除已有生产记录、不代审批。最后通过正常checkpoint/integrate/release完成main和本次必要UI运行版本；按现役Runner真实要求处理发布检查与备份，保留所有失败记录。发布共享锁按正常机制串行，不能清理他人的锁/源码/镜像。遇到阻塞报告直接工具原件和最小解除条件；操作员已授权优先解阻。不得用文档、静态检查或“建议下一步”替代尚可推进的实际修复。\r\n\r\n回报实际修改页面/共享业务组件、保留的业务例外、定向结果、未验边界和最终source/运行版本；遵守同根因两轮无推进或累计30活跃分钟换路径。任务是完整一轮本模块标准化，不止修一页示例。无需再次请求Owner授权。\r\n"
  },
  {
    "name": "leadership",
    "sha256": "ff18cf3463e492efc98069750e013d402d5237913a72bc9553bab2f8659857a0",
    "prompt": "请实现并提交、发布领导引领力现有PC页面的前端标准化修复。\r\n\r\n当前明确范围：forge-admin-ui/src/views/leadership及该模块直接使用的业务组件/API/前端测试；以当前真实菜单和代码核实范围。\r\n原领导引领力交付对话dd5f4e6d-561c-4cea-8c14-f839397f31b7 / task c-c444ed5231de9b6877f45cab（领导力-测试1.5）。本对话是Owner授权、与其明确关联的前端修复对话，原对话和归属保留。\r\n\r\n本次只读盘点页面候选（不是完成证明）：\r\n- 基础台账与配置：resp-list、check-item、commit-template、resp-template、task-engine\r\n- 承诺履责与档案：commitment-all、commitment-president、resp-book、sign-status、archive\r\n- 组织计划任务工作区：org-chart、personal-plan、target-task、task-exec、action-plan\r\n- 考核与评估：assess-plan、assess-approval、assess-result、device-assess、device-summary、duty-score\r\n- 费用预算与统计：fee-accrual、fee-budget、fee-stat\r\n\r\n已发现的代表差距（原对话核实实际行为后修）：\r\n- forge-admin-ui/src/views/leadership/resp-list.vue：手写查询、固定640px NModal及view模式disabled输入框；有单行删除，普通台账默认多选批删需补齐实际契约。\r\n- forge-admin-ui/src/views/leadership/components/ConfigAssetPage.vue：4个配置入口经业务私有NDataTable/NForm/NModal封装，readonly仍disabled表单；需复用公共查询/浮层/可读详情，保留真正模板设计步骤。\r\n- forge-admin-ui/src/views/leadership/personal-plan.vue：主从计划工作区手写表格及查询/按钮；统一公共布局与状态，保留业务工作区，不机械改普通CRUD。\r\n操作员当前浏览器已实看action-plan：普通最大化1920×945；列表有勾选但无批删按钮，查询/工具栏与行按钮不是原生统一模式；新增正确使用modal但footer靠左。只读详情已有0输入控件，保留这个正确点，修正只读内容残留必填星号和无内容操作列。新建/查看/取消未写业务数据。\r\n\r\nOwner已确认：用平台原生用户管理和已交付的公共前端标准，优化五模块全部已生成PC业务页面。当前这轮仅负责本文指定的一个模块，从最新main保留其他AI成果继续。你负责业务代码、业务测试和正常受控提交发布；操作员负责公共底座和直接平台阻塞，不会替你代写业务。\r\n\r\n先读取实际forge-admin-ui/DESIGN.md、原版src/views/system/user.vue相关模式以及forge-frontend-admin Skill的references/page-patterns.md，核实当前AiCrudPage/AiSearch/AiTable/AiForm/ai-modal/MasterDetailWorkspace/SystemTableCell的真实接口。沿实际组件和主题实现，不每页重新发明查询、表格、分页、弹窗及样式。原有业务规则、状态、数据、权限、后端接口、已有导入导出/签字/附件和子表能力保持。\r\n\r\n完整标准同时覆盖：页面/打开方式、布局与信息层级、字体主题密度、按钮样式与位置顺序、查询区、列表默认能力、表格语义、新增编辑、分组长表单、可读详情及审批、弹窗抽屉浮层、完整提交过程、加载/空/错/无权限等状态、返回上下文、数据格式与业务文案、权限及状态、宽窄窗口与焦点、关联选择/附件等既有扩展、标准代码与API组织。这些是默认前端能力，不等待产品逐控件补需求。\r\n\r\n普通可维护台账默认多选/全选/选中数量/批删及确认；仅有单删接口时采用已有公共支持的真实逐条调用，正确保留失败项、刷新成功项，不用“无batch端点”隐藏能力。只读归档/审计、审批和库存流水等真实语义限制按现有业务核定，记录具体依据，不能机械加删除。普通新增编辑默认原生modal；已有独立路由、字段多、草稿按钮都不足以保留独立编辑页。原专用主从工作区、地图、流程/模板设计器按真实交互保留。\r\n\r\n按钮主次/尺寸/图标/顺序沿公共实现，查询为搜索→重置→适用的展开，底部取消在左、次操作居中、保存/提交主操作在右；行常用操作保持稳定顺序，低频用更多。字段使用语义控件、字典和关联选择；编辑真实回填；校验、防重、busy、失败保留、重试、重开复位、取消不写、未保存关闭遵循现有公共规则。详情用完整分组可读值，不用灰色disabled输入框或原始JSON。保留设计器已拥有的显示配置/字段，不因改版覆盖人工配置；这次不扩建低代码系统。\r\n\r\n完成本模块全部已生成页面的差距修复。你可按共享业务组件及页面类型分组处理；已达标的实现保留并说明，无需为了凑改动重写。API调用和转换进入本模块现有API层，复用公共状态/反馈，业务专用扩展维持明确边界。发现直接公共缺口给出最小证据和所需接口，由操作员处理底座；其余可推进页面继续完成。\r\n\r\n验证限定本次修改及明确直接影响：相关前端lint/组件交互/业务边界与正常受控发布检查，保留有效旧证据；源码检查和浏览器实际行为分别报告。避免重跑无关后端、全仓扫描或从需求阶段重启整个八阶段。业务数据验收优先测试适配/专用测试记录，不删除已有生产记录、不代审批。最后通过正常checkpoint/integrate/release完成main和本次必要UI运行版本；按现役Runner真实要求处理发布检查与备份，保留所有失败记录。发布共享锁按正常机制串行，不能清理他人的锁/源码/镜像。遇到阻塞报告直接工具原件和最小解除条件；操作员已授权优先解阻。不得用文档、静态检查或“建议下一步”替代尚可推进的实际修复。\r\n\r\n回报实际修改页面/共享业务组件、保留的业务例外、定向结果、未验边界和最终source/运行版本；遵守同根因两轮无推进或累计30活跃分钟换路径。任务是完整一轮本模块标准化，不止修一页示例。无需再次请求Owner授权。\r\n"
  }
];

for (const { name, prompt, sha256: digest } of FIVE_MODULE_ORIGINAL_PROMPTS) {
  test(`five-module original ${name} implementation keeps inventory and business read-only semantics scoped`, () => {
    assert.equal(crypto.createHash('sha256').update(prompt).digest('hex'), digest);
    assert.equal(hasGlobalReadOnlyIntent(prompt), false);
    for (const restriction of ['本轮只读分析。', '本轮只读。', '不得修改任何文件。']) {
      assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
    }
  });
}

test('five-module inventory and business read-only exceptions require independent implementation', () => {
  const descriptions = [
    '本次只读盘点页面候选（不是完成证明）：',
    '只读归档/审计、审批和库存流水等真实语义限制按现有业务核定。',
    '只读详情已有0输入控件。',
  ];
  for (const description of descriptions) {
    assert.equal(hasGlobalReadOnlyIntent(`请实现现有页面。\n${description}`), false, description);
    for (const prefix of ['', '如何实现现有页面？\n', '“请实现现有页面。”\n']) {
      assert.equal(hasGlobalReadOnlyIntent(prefix + description), true, prefix + description);
    }
    assert.equal(hasGlobalReadOnlyIntent(`请实现现有页面。\n${description}\n本轮不得修改代码。`), true);
  }
  for (const restriction of [
    '本次只读盘点页面候选。',
    '本轮只读盘点归档与审计记录，不要修改代码。',
    '请只读查看归档数据。',
    '只读审计日志。',
    '本轮只读详情已有0输入控件。',
  ]) assert.equal(hasGlobalReadOnlyIntent(`请实现现有页面。\n${restriction}`), true, restriction);
});

test('source-review repair findings: exact fire continuation remains authorized', async () => {
  const prompt = (await readFile(new URL('./fixtures/fire-source-review-continuation-prompt.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  assert.equal(sha256(prompt), '8d83a3661753cc0e269b3d15750bce180d9f0182cfef62a784ff17cb53e866a9');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  for (const restriction of ['本轮只读分析。', '本轮只读。', '不得修改任何文件。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
  }
});

test('source-review repair findings: independent authorization and explicit restrictions remain required', () => {
  const findings = [
    '当前只读源码审阅确认两项需要你在原候选上修复：第一',
    '只读源文件检查已发现3个问题待修复',
    '当前只读源码核对确认以下问题需要修复：',
  ];
  for (const finding of findings) {
    assert.equal(hasGlobalReadOnlyIntent(`请修复当前页面。\n${finding}`), false, finding);
    for (const prefix of ['', '如何修复当前页面？\n', '修复当前页面可以吗？\n', '“请修复当前页面。”\n', '需求记录写着：“请读取日志，修复当前页面。”\n', '请发布当前候选可以吗？\n', '文档说明：请发布当前候选。\n']) {
      assert.equal(hasGlobalReadOnlyIntent(prefix + finding), true, prefix + finding);
    }
    assert.equal(hasGlobalReadOnlyIntent(`请修复当前页面。\n${finding}。本轮不要修改代码。`), true);
    assert.equal(hasGlobalReadOnlyIntent(`请发布当前候选。\n${finding}`), false);
  }
  for (const restriction of [
    '本轮只读源码审阅确认两项需要你在原候选上修复：第一',
    '请只读源码审阅确认两项需要修复。',
    '当前只读源码审阅，确认两项需要修复的问题。',
    '本轮仅只读审阅源码，列出后续需要修复的问题，不要改代码。',
    '当前只读源码审阅是否确认两项需要修复？',
    '| 本轮只读源码审阅 | 不得修改代码 |',
  ]) assert.equal(hasGlobalReadOnlyIntent(`请修复当前页面。\n${restriction}`), true, restriction);
});


test('candidate verification review: original backend feedback is not a global read-only restriction', async () => {
  const prompt = await readFile(new URL('./fixtures/backend-candidate-permission-review-prompt.md', import.meta.url), 'utf8');
  assert.equal(hasGlobalReadOnlyIntent(prompt), false);
  for (const restriction of ['本轮只读分析。', '本轮只读。', '不得修改任何文件。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${prompt}\n${restriction}`), true, restriction);
  }
});

test('candidate verification review: findings alone, questions and quoted commands grant no repair exception', () => {
  const finding = '只读审查发现：ControllerTest 仅反射检查注解。';
  const continuation = '继续当前示例候选，补齐权限验证后保存候选，不发布。';
  for (const prefix of ['', `“${continuation}”\n`, `文档说明：${continuation}\n`, continuation.replace('。', '？') + '\n']) {
    assert.equal(hasGlobalReadOnlyIntent(prefix + finding), true, prefix);
  }
  assert.equal(hasGlobalReadOnlyIntent(`${continuation}\n${finding}`), false);
  assert.equal(hasGlobalReadOnlyIntent(`请修复当前测试。\n${finding}`), false);
  for (const restriction of ['本轮只读审查发现：ControllerTest 仅反射检查注解。', '请只读审查发现的问题。', '只读审查发现：请修改测试。']) {
    assert.equal(hasGlobalReadOnlyIntent(`${continuation}\n${restriction}`), true, restriction);
  }
});
