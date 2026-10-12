// View definitions describe the read model only. Missing business facts stay unknown.
const column = (key, label, options = {}) => ({ key, label, ...options });
const name = label => column('name|title', label, { identity: true, width: 220 });
const revision = column('revision', '定义修订', { format: 'revision', width: 150, optional: true });
const nature = column('nature', '资料性质', { format: 'nature', optional: true });
const origin = column('origin', '来源', { format: 'origin' });
const change = column('businessChange', '业务改造情况', { format: 'businessChange' });
const iteration = column('latestBatch|lastBatch|batchId|batchIds', '最近变更迭代', { format: 'ref' });
const menu = column('menuPaths|menuPath|menuIds', '关联菜单', { format: 'menu', optional: true });
const adoption = column('adoption', '采用情况', { format: 'adoption' });
const implementation = column('implementation|implementationEvidence', '实现依据', { format: 'evidence' });
const verification = column('verification|verificationEvidence', '验证结论', { format: 'evidence' });
const publication = column('publication|releaseEvidence|releaseIds', '发布依据', { format: 'evidence' });
const confirmation = column('businessConfirmation', '业务确认', { format: 'evidence' });
const conditions = column('conditions|condition|preconditions', '适用条件');
const source = column('sources', '定义依据', { format: 'sources', optional: true });
const cols = (...values) => values;
const view = (name, parent, config, columns, help) => ({ name, parent, ...config, columns, help });

export const deliveryTabs = {
  menus: view('菜单管理', null, { endpoint: 'menus' }, cols(name('菜单名称'), column('businessPurpose|purpose', '业务用途'), column('parentId', '上级菜单', { format: 'parent' }), change, iteration, column('runtimeConfiguration', '运行配置情况', { format: 'runtimeConfiguration' }), { ...origin, label: '菜单来源', optional: true }, column('resourceType', '节点类型', { format: 'resourceType', optional: true }), column('enabled', '启用状态', { format: 'enabled', optional: true }), column('visible', '显示状态', { format: 'visible', optional: true }), column('path', '完整菜单路径', { format: 'menu', optional: true })), '选一个菜单，查看业务用途、功能及变化。运行配置不等于功能已验收。'),
  'menu-matrix': view('关联矩阵', 'menus', { view: 'menu-matrix' }, cols(name('业务菜单'), ...[['requirements','独立要求'],['functions','功能'],['pages','页面'],['processes','流程'],['entities','业务对象'],['tables','数据表'],['apis','接口'],['permissions','权限'],['acceptance','验收'],['releases','发布']].map(([key,label]) => column(`counts.${key}|${key}`,label,{format:'count-link',target:key}))), '一行一个菜单；关联数量可以重叠，不相加作为项目总数。未知关联不记为零。'),
  requirements: view('需求与迭代', null, { endpoint: 'requirements', recordType: 'requirement' }, cols(name('需求名称'), column('statement|description', '要求内容'), column('functionRefs|functions|featureIds', '关联功能', { format: 'ref' }), adoption, implementation, verification, publication, column('requirementType|type', '要求类型', { optional: true }), { ...iteration, optional: true }, revision, menu), '逐条看要求及落实依据。当前要求不等于生产能力；原始章节在“来源资料”。'),
  'requirement-matrix': view('需求矩阵', 'requirements', { view: 'requirement-matrix' }, cols(column('menuPaths|menuPath|menuRef|menu|menuIds|menuId', '业务菜单', {format:'menu'}), column('functionRef|function|feature', '功能', {format:'ref'}), column('requirementRef|requirement|name', '具体要求', {identity:true,format:'ref'}), column('requirementRevision|revision','要求修订',{format:'revision'}), column('rowType|recordType','关联行类型'), conditions, adoption, implementation, verification, publication), '菜单、功能、要求按明确适用关系排列。保留部分关联和无菜单内容，不把关联行数当功能数。'),
  batches: view('迭代批次', 'requirements', { endpoint: 'batches' }, cols(name('迭代批次'), column('sourceLabel|description','来源说明'), column('createdAt','形成时间',{format:'date'}), column('status','记录状态',{format:'status'}), source), '选择“查看资料”阅读该批次的已收录要求，并可切换功能或页面；具体变更仅展示已有的变更说明。'),
  changes: view('具体变更', 'requirements', { view: 'changes' }, cols(column('target|object|name','变更对象',{identity:true,format:'ref'}), column('changeType|type','变更类型'), column('before|beforeContent','原要求'), column('after|afterContent','调整后要求'), column('reason','调整原因'), column('adoptionSources|sources','采用依据',{format:'sources'}), implementation, verification, publication), '展示实际记录的前后业务含义及采用依据，不根据文件差异自动生成业务结论。'),
  sources: view('来源资料', 'requirements', { view: 'requirements-sources' }, cols(name('资料名称'), column('section|originalDocument.section','章节'), column('sourceConversationId|conversationId|taskId','来源对话 / 任务'), menu, column('requirementRefs|requirementIds','已关联要求',{format:'ref'}), column('availability','原文可用性',{format:'availability'}), nature, column('recordedAt','收录时间',{format:'date'})), '原文、AI解释与采用决定分别保留。章节尚未整理不影响阅读，也不计作独立业务要求。'),
  entities: view('业务模型与关系', null, { kind: 'entity' }, cols(name('对象名称'), column('description','来源描述（未确认业务含义）'), column('businessMeaning|definition','业务含义'), column('contextName|contextId','所属业务范围'), column('responsibility','业务职责'), column('nature','定义依据',{format:'nature'}), revision, column('usedByMenuCount|menuCount','关联菜单数',{format:'count',optional:true}), { ...origin, optional:true }), '查看对象含义、职责与关系。源码观察不等于已采用的业务定义。'),
  definitions: view('共用业务定义', 'entities', { view: 'definitions' }, cols(name('定义名称'), column('recordType|definitionType|type','定义类型'), column('businessMeaning|definition|description','业务定义'), column('contextName|contextId','业务范围'), column('unit','单位'), column('precision','精度'), revision, source), '阅读概念、值域、单位和计算口径等有来源的共用定义。属性与页面引用同一修订。'),
  relations: view('对象关系', 'entities', { view: 'relations', kind: 'entity' }, cols(column('from','起点对象',{identity:true,format:'ref'}), column('name|label|type','关系名称'), column('to','终点对象',{format:'ref'}), column('cardinality','数量约束'), conditions, column('validity|timeRule','时间规则'), source), '业务关系与数据库物理外键分别理解；关系的条件和有效期间按原定义阅读。'),
  scenes: view('业务场景与流程', null, { kind: 'scene' }, cols(name('场景名称'), column('goal|businessGoal','业务目标'), column('trigger|triggers','触发条件'), column('initiator','发起角色'), column('actor|actors','参与角色'), column('normalResult','正常结果'), column('menuParticipation|usage','当前菜单参与方式'), column('processCount','关联流程数',{format:'count',optional:true}), revision, { ...iteration, optional:true }), '看业务如何开始、由谁处理，再展开完整步骤与分支。'),
  processes: view('流程定义', 'scenes', { view: 'processes' }, cols(name('流程名称'), column('businessPurpose|purpose','业务用途'), column('trigger|triggerType','触发方式'), revision, column('scenarioCount','引用场景数',{format:'count'}), column('menuCount','涉及菜单数',{format:'count'}), column('engineType','引擎使用情况'), source), '流程定义和实际办理实例分别计数。没有审批流程的业务仍可有登记、校验和保存场景。'),
  rules: view('规则引用', 'entities', { kind: 'rule' }, cols(name('规则名称'), column('target|appliesTo','适用对象',{format:'ref'}), conditions, column('rule|requirement','规则要求'), column('failureHandling','不满足时处理'), revision, source), '对象与场景引用同一规则及修订；这里不自动推理或补写业务规则。'),
  tasks: view('任务定义', 'scenes', { kind: 'task' }, cols(name('任务名称'), column('purpose|businessPurpose','业务用途'), column('trigger','触发条件'), column('executionMode','执行方式'), column('engineType','引擎类型'), column('failureHandling','失败处理'), revision), '仅展示有来源的任务定义及步骤引用；名称中有“任务”不代表已采用任务引擎。'),
  dictionaries: view('字典与值域', 'entities', { kind: 'dictionary' }, cols(name('定义名称'), column('businessMeaning|description','业务含义'), column('contextName|contextId','适用范围'), revision, source), '值域、单位和解释来自已收录定义，技术编码不能替代业务含义。'),
  database: view('数据库设计', null, { kind: 'table' }, cols(name('表名称'), column('comment','数据库原始注释'), column('businessPurpose|purpose','业务用途'), column('usage|menuUsage','当前菜单使用方式'), change, column('tableName|name','数据表名',{format:'code',optional:true}), { ...origin, label:'表的来源', optional:true }, column('entityCount','关联对象数',{format:'count',optional:true}), { ...iteration, optional:true }), '查看业务信息怎样保存。设计、迁移执行与实际表结构分别核对。'),
  'model-mappings': view('模型映射', 'database', { view: 'model-mappings' }, cols(column('entity|entityRef|object','业务对象',{identity:true,format:'ref'}), column('attribute|businessAttribute','业务属性',{format:'ref'}), column('table|tableRef','数据表',{format:'ref'}), column('field|fieldRef','字段',{format:'ref'}), column('storageMode','保存方式'), column('description|mappingExplanation','映射说明'), source), '一项属性拆成多个字段时分别阅读映射。未建立关联与按设计不单独存储分别显示。'),
  constraints: view('关系与约束', 'database', { view: 'constraints' }, cols(name('关系 / 约束'), column('from|sourceTable','来源表',{format:'ref'}), column('sourceField','来源字段'), column('to|targetTable','目标表',{format:'ref'}), column('targetField','目标字段'), conditions, column('physicalForeignKey','物理外键情况'), implementation), '逻辑引用、程序检查、数据库约束及索引各有依据，不能互相代替。'),
  'structure-changes': view('结构变更', 'database', { view: 'structure-changes' }, cols(column('target|name','变更对象',{identity:true,format:'ref'}), column('changeType|type','变更类型'), column('before','变更前'), column('after','变更后'), column('reason','业务原因'), column('requirementRefs','关联要求',{format:'ref'}), column('migration|migrationScript','迁移脚本'), column('commits','代码提交',{format:'commit'})), '提交迁移脚本不代表生产执行。详情分别核对环境、执行结果和实际结构观察。'),
  pages: view('页面与前端', null, { kind: 'page' }, cols(column('pageName|name|title','页面名称',{identity:true,width:220}), column('description','来源描述'), column('businessPurpose|purpose','业务用途'), column('pageType|pageMode','页面形态'), { ...menu, optional:false }, column('scenarioRefs|scenes','关联场景',{format:'ref'}), column('parentPage|parentPageRef','上级页面',{format:'ref',optional:true}), revision, { ...iteration, optional:true }), '查看页面用途，再核对字段、操作和反馈；共用页面需核对菜单实际使用范围。'),
  'page-implementations': view('前端实现关联', 'pages', { view:'page-implementations' }, cols(column('page|pageRef|name','页面',{identity:true,format:'ref'}), column('route','访问路由'), column('component','组件'), column('configuration|usage','使用配置'), column('apiRefs|apiBindings','数据接口',{format:'ref'}), column('commits','实现提交',{format:'commit'}), publication, verification), '查看具体定义与源码、配置、提交和验证的关系；文件存在不等于交互已验证。'),
  backend: view('后端接口与调用', null, { kind:'api' }, cols(name('接口业务名称'), column('businessPurpose|purpose','处理用途'), column('providerModule|provider|owner|module','提供模块'), column('usage|menuUsage','当前菜单使用关系',{format:'api-menu-usage'}), column('behaviorType','行为类型'), column('handlingMethod|processingMode','处理方式',{optional:true}), revision, { ...iteration, optional:true }, column('method','请求方式',{optional:true}), column('path|endpoint','访问路径',{optional:true,format:'code'})), '先看接口处理什么业务、由谁提供，再查看输入输出与调用关系。'),
  calls: view('调用与依赖', 'backend', { view:'calls' }, cols(column('from|caller','调用方',{identity:true,format:'ref'}), column('system|module|targetModule','目标模块 / 系统'), column('to|target|name','目标能力',{format:'ref'}), column('purpose','调用目的'), column('trigger|condition','触发条件'), column('callType|type','调用类型'), column('processingMode','处理方式'), column('failureImpact','失败影响'), source), '默认核对直接依赖；完整共享定义与跨菜单调用仍可阅读，环状引用按需查看。'),
  permissions: view('业务权限', null, { view:'permission-rules', kind:'permission' }, cols(
    column('subject|role|name','角色 / 主体',{identity:true,format:'ref'}), column('canSee','原文可见内容 / 能力'),
    column('canPerform|operation|action','原文操作声明'), column('dataScope','范围声明'), column('recordMeaning','资料状态'), { ...source, label:'来源', optional:false },
    column('description','设计说明',{optional:true}), column('roles|roleKeys','组内角色',{optional:true}), column('subjectType','主体类型',{optional:true}),
    column('object|objectRef','业务对象',{format:'ref',optional:true}), column('canAct','原文可处理事项',{optional:true}),
    column('denialConditions','原报告共同拒绝约束',{optional:true}), column('taskConditions|conditions|preconditions','原报告共同任务约束 / 业务条件',{optional:true}),
    column('decision','授权结论',{format:'authorization',optional:true}), column('sourceNameNote','源名称提示',{optional:true}), revision),
    '按原文阅读角色、可见能力、操作与范围声明。可见能力不代表可执行操作，历史声明不证明当前授权或执行。范围保留原始声明，未说明的具体业务边界保持未知；权限码不是功能数量。本中心仍为全账号共享查看。'),
  'permission-matrix': view('角色矩阵', 'permissions', { view:'permission-matrix' }, cols(column('subject|role|name','主体',{identity:true,format:'ref'}), column('subjectType','主体类型')), '按原文命名主体或角色组阅读；阶段合同声明不推定授权允许，组内角色不展开。未找到授权记录不等于明确禁止。'),
  'permission-evidence': view('落实依据', 'permissions', { view:'permission-evidence' }, cols(
    column('name|rule|ruleRef','来源声明',{identity:true,format:'ref'}), column('locationType','依据类型'),
    column('serverPermissions|endpointRule|target|targetRef','权限 / 接口原文声明',{format:'ref'}),
    column('trustedFields|trustedContext|configuration','可信身份原文声明'), column('tenantAndScope','租户 / 范围原文声明'), column('recordMeaning','资料状态'),
    column('ruleRef','精确来源关联',{format:'ref',optional:true}), { ...implementation, optional:true }, { ...publication, optional:true }, { ...verification, optional:true }),
    '原文声明分别列出，长内容在详情阅读。旧版接口约束与身份上下文保留原意；阶段实现声明不代表已落实、生产启用或真实授权验证。'),
  acceptance: view('验收与测试', null, { view:'acceptance', kind:'test' }, cols(name('验收项'), column('functionRefs','关联功能',{format:'ref'}), column('requirementRefs','关联要求',{format:'ref'}), verification, confirmation, column('issueCount','关联问题数',{format:'count'}), column('requirementRevision','要求修订',{format:'revision',optional:true}), { ...revision, label:'标准修订' }), '看哪些要求得到实际验证。预期结果、执行结论和业务确认分别阅读。'),
  'test-cases': view('测试场景', 'acceptance', { view:'test-cases' }, cols(name('用例名称'), column('goal|verificationTarget','验证目标'), column('identityConditions','身份条件'), column('dataConditions','数据条件'), column('preconditions','前置状态'), column('operation|actions','操作'), column('expectedResult','预期结果')), '逐条核对身份、数据、操作和预期，步骤详情关联具体要求及验证内容。'),
  'test-executions': view('执行记录', 'acceptance', { view:'test-executions' }, cols(column('profile|caseRef|testCase|name','检查项目',{identity:true,format:'ref'}), column('executionStatus','原声明状态',{format:'status'}), column('executionCounts','执行 / 通过 / 失败 / 跳过'), column('receiptId','回执编号'), column('executionKind','执行与引用'), column('sourceRecord','来源记录'), column('recordMeaning','依据边界'), column('limitations','局限',{optional:true}), column('verdict','结果判定',{format:'status',optional:true}), column('evidence','证据入口',{format:'evidence',optional:true}), column('actualResult','实际结果',{optional:true}), column('executedAt|createdAt','执行时间',{format:'date',optional:true}), column('environment','运行环境',{format:'environment',optional:true}), column('commit|testedCommit','被测提交',{format:'commit',optional:true})), '阶段产物中的执行声明；回执未经本中心单独复核。历史引用不代表本次重跑，覆盖说明不等于执行。'),
  issues: view('问题与复验', 'acceptance', { view:'issues' }, cols(name('问题名称'), column('conditions','发生条件'), column('actualResult|phenomenon','实际现象'), column('functionRefs','影响功能',{format:'ref'}), column('version|revision','发生版本'), column('failureEvidence','原始失败依据',{format:'evidence'}), column('handling','处理记录'), column('reverification','复验结果',{format:'evidence'})), '原失败、修复提交、实际部署和复验结果分别保留，不因最新通过覆盖历史失败。'),
  'test-materials': view('原始测试资料', 'acceptance', { kind:'test' }, cols(name('资料名称'), column('recordType','记录类型'), nature, column('expectedResult','预期内容'), column('actualResult','实际记录'), source), '兼容查看尚未整理的测试资料与检查计划；章节和期望数字不计作真实执行。'),
  overview: view('交付概览', null, { view:'feature-delivery', kind:'function' }, cols(name('功能名称'), adoption, implementation, verification, confirmation, publication, column('issueCount','关联问题数',{format:'count',optional:true}), menu, revision), '按功能核对采用、实现、验证、业务确认与发布；新要求不覆盖旧能力的发布事实。'),
  stages: view('八阶段产物', 'overview', { endpoint:'stages' }, cols(column('phaseId|name','阶段名称',{identity:true,format:'phase'}), column('status','原始阶段状态',{format:'stage-status'}), column('taskId','来源任务'), column('summary|description','阶段说明'), column('functionRefs|requirementRefs|scope','适用要求 / 功能范围',{format:'ref'}), column('updatedAt|createdAt','最近处理时间',{format:'date'})), '保留原任务的八阶段和真实状态。多个任务分别查看，不拼成虚构完整过程。'),
  'overview-changes': view('迭代变化', 'overview', { view:'changes' }, cols(menu, column('functionRefs','关联功能',{identity:true,format:'ref'}), column('changeType|type','变更类型'), column('before','原要求'), column('after','本次要求'), adoption, implementation, verification, publication), '新增规则只影响有依据的具体要求，不把菜单原有全部能力都改成开发中。'),
  'overview-issues': view('关注事项', 'overview', { view:'issues' }, cols(name('事项名称'), column('functionRefs','影响功能',{format:'ref'}), column('status|situation','当前情况',{format:'status'}), column('handling','已有处理记录'), column('recordedAt','记录时间',{format:'date'}), source), '仅汇总已有问题、阻塞和待处理记录；缺关联不自动生成问题或派单。'),
  releases: view('项目发布尝试', null, { view:'release-attempts', endpoint:'releases' }, cols(column('businessVersion|version|name|title','业务版本 / 名称',{identity:true}), column('changeSummary|summary','业务变化摘要',{format:'release-change-summary'}), column('environment','目标环境',{format:'environment'}), column('result|status','发布结果',{format:'status'}), column('finishedAt|releasedAt','结束时间',{format:'date'}), column('id|releaseId','发布编号',{optional:true}), column('startedAt','开始时间',{format:'date',optional:true}), column('initiator|actor','发起人',{optional:true})), '项目级发布尝试，一行一次，失败和重试均保留。当前菜单仅作导航，不限制下方发布记录；已记录的变化说明不代表验收通过或完整功能范围。'),
  'business-versions': view('项目业务版本记录', 'releases', { view:'business-versions' }, cols(name('业务版本'), column('changeSummary','本次业务变化',{format:'release-change-summary'}), column('scopeBinding|scopeType','范围依据',{format:'scopeBinding'}), column('baseline','可信基线',{format:'ref'}), column('releasedAt|createdAt','形成时间',{format:'date'}), column('version','版本名称',{optional:true}), source), '查看项目已收录的业务版本，当前菜单仅作导航。本次变化与完整能力分开看；完整范围必须有可信基线和变化依据。'),
  artifacts: view('发布包与制品', 'releases', { endpoint:'artifacts' }, cols(name('制品名称'), column('type','制品类型'), column('version','制品标签'), column('digest|imageDigest','不可变标识',{format:'commit'}), column('commit|sourceCommit','构建提交',{format:'commit'}), column('releaseIds|releaseId','关联发布',{format:'ref'}), column('availability','获取情况',{format:'availability'})), '仅提供真实存在且可访问的包或制品引用，不新建构建、发布或回滚操作。'),
  environments: view('项目环境记录', 'releases', { view:'environments' }, cols(column('environment','运行环境',{identity:true,format:'environment'}), column('component','组件名称'), column('commit','实际观察提交',{format:'commit'}), column('artifactRef|artifact','实际观察制品',{format:'ref'}), column('observedAt','观察时间',{format:'date'}), column('enabledEvidence','启用依据',{format:'evidence'}), verification, source), '查看项目已收录的环境观察，当前菜单仅作导航。按最后一次可靠观察阅读；最近发布目标和 latest 标签不能替代当前运行事实。'),
};

export const subviews = {
  menus: ['menus','menu-matrix'], requirements: ['requirements','requirement-matrix','batches','changes','sources'],
  entities: ['entities','definitions','relations','rules','dictionaries'], scenes: ['scenes','processes','tasks'],
  database: ['database','model-mappings','constraints','structure-changes'], pages: ['pages','page-implementations'],
  backend: ['backend','calls'], permissions: ['permissions','permission-matrix','permission-evidence'],
  acceptance: ['acceptance','test-cases','test-executions','issues','test-materials'],
  overview: ['overview','stages','overview-changes','overview-issues'], releases: ['releases','business-versions','artifacts','environments'],
};

export const enumNames = {
  origin: { baseline:'初始底座已有', 'base-upgrade':'底座升级引入', 'business-added':'业务需求新增', unknown:'来源待确认' },
  businessChange: { modified:'有明确业务改造', unchanged:'核对范围内未发现改造', unknown:'待核对' },
  runtimeConfiguration: { observed:'已在运行配置中发现', 'configuration-observed':'已在运行配置中发现', 'stage-only':'仅阶段资料定义', 'stage-defined':'仅阶段资料定义', unknown:'待核对' },
  nature: { original:'原始业务资料', interpretation:'AI解释', design:'设计定义', 'implementation-observation':'实现观察', execution:'执行类资料（原文分类）', 'historical-compilation':'后来整理', unknown:'资料性质未明确' },
  adoption: { adopted:'已明确采用', proposed:'待明确', withdrawn:'已撤回', superseded:'已被替代', unknown:'采用情况未明确' },
  authorization: { allow:'允许', allowed:'允许', conditional:'条件允许', deny:'明确禁止', denied:'明确禁止', unknown:'未明确' },
  availability: { available:'可读取', restricted:'原件访问受限', missing:'原件未保留', unknown:'可用性未确认', unavailable:'暂无可用入口' },
  scopeBinding: { full:'完整范围有依据', complete:'完整范围有依据', delta:'仅本次变化', partial:'仅可证部分', unknown:'范围尚未确认' },
};

const section = (keys, title, columns) => ({ keys, title, columns });
const nestedSection = (keys, nested, title, columns) => ({ keys, nested, title, columns });
const d = (...columns) => columns.map(([key,label,format]) => ({key,label,format}));
const itemAttributes = d(['_parent.name|_parent.fieldName|_parent.field','所属集合'],['name|fieldName|field','集合项子属性'],['businessMeaning|meaning|description','子属性含义（资料原文）'],['_detailPath','资料内路径'],['sources','子属性来源']);
const attributes = d(['name|fieldName|field','属性名称'],['businessMeaning|meaning|description|label','业务含义'],['values|valueRange','取值范围'],['dictionary|dictionaryRef','取值字典','ref'],['requiredCondition|required','必填条件'],['definitionRef','共用定义','ref'],['validation|rules','业务约束']);
const references = d(['type|usage','使用关系'],['target|to|targetId','使用对象','ref'],['revision|targetRevision','引用修订','revision'],['conditions','适用条件'],['sources','依据','sources']);
export const detailSchemas = {
  requirement: [
    section('actions|operations','业务操作',d(['name','操作名称'],['actor','操作者'],['preconditions','前置条件'],['description|processing','处理内容'],['result','业务结果'])),
    section('fields|fieldRequirements','字段要求',d(['page|pageRef','所属页面','ref'],['name|field','字段名称'],['businessMeaning|description','业务含义'],['requiredCondition|required','必填条件'],['validation|constraints','输入限制'])),
    section('rules|businessRules','业务规则',d(['target|object','适用对象','ref'],['trigger|condition','触发条件'],['requirement|rule|description','规则要求'],['failureHandling','不满足时处理'])),
    section('workflowRequirements|flows','流程要求',d(['action','触发动作'],['roles','参与角色'],['conditions','流转条件'],['completion','结束条件'],['exceptions','异常处理'])),
    section('acceptanceCriteria','验收条件',d(['name|description','验证场景'],['preconditions','前置条件'],['operation|steps','操作'],['expectedResult|expected','预期结果'])),
    section('targets|modelRefs','作用对象',references),
  ],
  function: [
    section('requirements|requirementRefs','关联独立要求',d(['name|id','要求','ref'],['revision','要求修订','revision'],['conditions','适用条件'],['adoption','采用情况','adoption'])),
    section('usage|menuLinks','使用位置',d(['menu|menuId','菜单','ref'],['type|usage','使用关系'],['conditions','适用条件'],['sources','依据','sources'])),
    section('deliveryTasks|tasks','交付任务',d(['name|taskId|id','任务'],['conversationId','来源对话'],['scope','适用范围'],['status','原任务状态','status'])),
  ],
  entity: [
    section('attributes|properties|fields','业务属性',attributes),
    nestedSection('attributes|properties|fields','itemAttributes','集合项子属性（不代表顶级属性或物理列）',itemAttributes),
    section('behaviors|operations|commands','允许行为',d(['name','操作名称'],['preconditions','前置条件'],['result|postconditions','处理结果'],['ruleRefs','引用规则','ref'])),
    section('states|lifecycle','生命周期',d(['name|state','状态'],['meaning|description','业务含义'],['transitions','允许变化'],['completion|conditions','结束条件'])),
    section('events','业务事件',d(['name','事件名称'],['meaning|description','已经发生的事实'],['trigger','产生条件'],['scenarioRefs','响应场景','ref'])),
    section('rules|invariants','固有规则',d(['name','规则名称'],['conditions','成立条件'],['rule|description','规则要求'],['sourceRef|sources','定义依据','sources'])),
    section('relationships|logicalRelations','对象逻辑关系',d(['from|sourceEntity|_recordRef','起点对象','ref'],['name|label|type','关系名称 / 原类型'],['to|targetEntity|targetRef','终点对象','ref'],['cardinality','数量约束'],['conditions|condition','成立条件'],['validity|timeRule','时间规则'],['sources','关系来源'])),
    section('modelMappings|tableMappings|tables|entityMappings|fieldMappings','数据库保存映射',d(['entity|object|businessAttribute|_recordRef','业务对象 / 属性','ref'],['table|tableRef|tableName|name','数据表','ref'],['field|column','字段'],['storageMode','保存方式'],['condition|conditions','适用条件'],['description','映射说明'],['sources','映射来源'])),
    section('technicalFields','技术补充字段',d(['name','字段名称'],['description','源码原始注释'],['dataType','数据类型'],['purpose','技术用途'])),
  ],
  scene: [
    section('steps','业务步骤',d(['number|step|id','步骤编号'],['name|title','步骤名称'],['actor|role','执行角色'],['menu|menuRef|menuId','入口菜单','ref'],['object|objectRef','操作对象','ref'],['action|description','业务动作'],['result','处理结果'],['next','下一步骤','ref'])),
    section('branches|exceptions','分支与异常',d(['step|stepRef','发生步骤','ref'],['condition|trigger','触发条件'],['action','处理动作'],['actor|role','负责角色'],['next','后续去向','ref'],['result','结束结果'])),
    section('transitions','对象状态变化',d(['object','对象','ref'],['from','原状态'],['action','触发行为'],['conditions','必要条件'],['to','目标状态'])),
    section('events|eventResponses','事件响应',d(['name|event','事件名称'],['step','产生步骤','ref'],['object','响应对象','ref'],['conditions','响应条件'],['action','后续行为'])),
    section('engines|engineBindings|taskBindings','引擎使用',d(['step','关联步骤','ref'],['executionMode','执行方式'],['engineType','引擎类型'],['definition','关联定义','ref'],['revision','配置修订','revision'],['trigger','触发条件'],['failureHandling','失败处理'])),
  ],
  table: [
    section('fields|columns','数据库字段',d(['label|businessName','字段业务名称'],['name|field|column','字段名'],['businessMapping|businessMeaning','字段含义'],['businessAttribute|attribute','对应业务属性','ref'],['purpose','设计用途'],['requiredCondition','业务必填条件'],['nullable','数据库允许空值','boolean'],['defaultValue|default','默认值'],['dataType|type','数据类型'],['length','长度'],['precision','精度'])),
    section('modelMappings|entityMappings|fieldMappings','业务模型映射',d(['entity|object|entityRef','业务对象','ref'],['businessAttribute|attribute','业务属性','ref'],['table|tableRef|_recordRef','数据表','ref'],['field|column','字段'],['storageMode','保存方式'],['condition|conditions','适用条件'],['description','映射说明'],['sources','映射来源'])),
    section('relationships|logicalRelations','表逻辑关系',d(['from|sourceTable|_recordRef','来源表','ref'],['sourceField','来源字段'],['to|targetTable|targetRef','目标表','ref'],['targetField','目标字段'],['businessRelation','业务关系','ref'],['type','关系原类型'],['cardinality','数量约束'],['conditions|condition','关联条件'],['physicalForeignKey','物理外键情况'],['sources','关系来源'])),
    section('constraints','约束与原文',d(['description','约束原文'],['name','约束名称'],['rule','业务规则'],['scope','适用范围'],['databaseConstraint','数据库约束'],['implementation','程序实现入口','ref'])),
    section('indexes','索引',d(['name','索引名称'],['fields|columns','字段顺序'],['unique','是否唯一','boolean'],['purpose','服务的查询 / 规则'],['sources','依据','sources'])),
    section('technicalFields','技术补充字段',d(['name','字段名称'],['description','已记录含义'],['purpose','设计用途'],['dataType','数据类型'])),
    section('migrations|migrationRecords','迁移声明与执行记录',d(['description','迁移声明（不代表已执行）'],['name|path','迁移脚本'],['dataHandling','旧数据处理'],['environment','运行环境','environment'],['status','执行结果','status'],['executedAt','执行时间','date'],['evidence','执行依据','evidence'])),
    section('observations|schemaObservations','实际结构观察',d(['environment','运行环境','environment'],['observedAt','核对时间','date'],['sourceRevision','结构版本','revision'],['evidence|sources','结构依据','sources'])),
  ],
  page: [
    section('regions|blocks|sections','页面区域',d(['name|title','区域名称'],['position','所在位置'],['purpose','业务用途'],['content|description','承载内容'],['visibleCondition','显示条件'])),
    nestedSection('regions','fields','区域字段与规则',d(['_parent.name|_parent.title','所属区块'],['name|field','字段标识'],['label|name','显示名称'],['businessMeaning|meaning|description','业务含义'],['inputType|editType|type','呈现方式'],['requiredCondition|required','必填条件'],['optionSource|dictionarySource|options','取值来源'],['validation|validationRules|rules','校验规则'],['trigger','触发条件'])),
    section('queryFields|searchFields|search','查询条件',d(['label|name','条件名称'],['businessMeaning|description','业务含义'],['inputType|editType|type','输入方式'],['optionSource|options','选项来源'],['matchMode','匹配方式'],['defaultValue','默认值'],['linkage','联动条件'],['knownLimitation|knownLimitations','已知限制说明'])),
    section('listColumns|columnProps|columns','列表内容',d(['label|name','列名称'],['businessMeaning|description','业务含义'],['dataSource','内容来源'],['format','显示格式'],['visible|defaultVisible','默认显示','boolean'],['sortRule','排序规则'],['target|targetRef','关联查看入口','ref'],['knownLimitation|knownLimitations','已知限制说明'])),
    section('formFields|editFields|fields','表单字段与校验',d(['label|name','字段名称'],['businessMeaning|description','业务含义 / 用途'],['attribute|attributeRef','对应业务属性','ref'],['inputType|editType|type','输入方式'],['optionSource|options','取值来源'],['defaultValue','默认值'],['requiredCondition|required','必填条件'],['visibleCondition','可见条件'],['editableCondition','可编辑条件'],['validation|validationRules|rules','校验规则'],['mode','适用模式'],['knownLimitation|knownLimitations','已知限制说明'])),
    nestedSection('formFields|editFields|fields','itemAttributes','集合项子属性（不代表顶级属性或物理列）',itemAttributes),
    section('actions|operations|buttons','操作与反馈',d(['name|label','操作名称'],['position','所在位置'],['behavior|behaviorRef','对应业务行为','ref'],['visibleCondition','显示条件'],['enabledCondition|preconditions','可用条件'],['permissionRef','权限依据','ref'],['success|result','成功结果'],['failureHandling','失败处理'])),
    section('navigation|jumps|routes','页面跳转',d(['from','来源页面','ref'],['action','触发操作'],['to|target','目标页面','ref'],['openMode','打开方式'],['object','携带对象','ref'],['mode','进入模式'],['returnTo','返回位置'])),
    section('linkages','字段联动',d(['field','触发字段'],['condition','触发条件'],['targetField','受影响字段'],['rule','处理规则'],['sourceRef','规则依据','ref'])),
    section('states|interactionStates','页面状态',d(['name|state','页面状态'],['description|feedback','反馈内容'],['availableActions','仍可用操作'],['recovery','恢复方式'],['evidence','验证依据','evidence'])),
    section('apiBindings','数据接口关联',d(['action|event','页面操作'],['api|apiRef|targetId','调用接口','ref'],['purpose','调用目的'],['sources','依据','sources'])),
    nestedSection('actions','apiRefs','操作调用接口',d(['_parent.name|_parent.label','页面操作'],['_parent.trigger','触发条件'],['_value','调用接口','ref'])),
    section('frontend|pageImplementation|implementations','前端实现',d(['name|component','组件'],['route','路由'],['configuration','菜单使用配置'],['commit|commits','实际提交','commit'],['releaseRefs','发布依据','ref'],['verification','验证记录','evidence'])),
  ],
  api: [
    section('menuUsages','菜单使用关系',d(['menuRef','使用菜单','ref'],['usage','菜单用途'],['source','来源原文'])),
    section('calls','调用记录（来源原文）',d(['caller','调用方'],['targetModule','目标模块'],['targetCapability','目标能力'],['purpose','调用目的'],['trigger','触发条件'],['callType','调用类型原文'],['failureImpact','失败影响'],['source','来源原文'])),
    section('dependencies','依赖记录（来源原文）',d(['caller','调用方'],['targetModule','目标模块'],['targetCapability','目标能力'],['purpose','依赖用途'],['trigger','触发条件'],['callType','依赖类型原文'],['failureImpact','失败影响'],['source','来源原文'])),
    section('requestFields|request|input|parameters','请求字段',d(['name','字段名称'],['businessMeaning|description','业务含义'],['attribute|attributeRef','关联业务属性','ref'],['source|dataSource','信息来源'],['requiredCondition|required','必传条件'],['allowedValues|options','允许值'],['validation|rules','校验规则'])),
    section('responseFields|response|output','返回字段',d(['name','字段名称'],['businessMeaning|description','业务含义'],['object|objectRef','关联业务对象','ref'],['condition','返回条件'],['purpose','后续用途'])),
    section('processing|steps','业务处理步骤',d(['name|step','处理步骤'],['action','业务动作'],['object|objectRef','涉及对象','ref'],['rule|ruleRef','引用规则','ref'],['result','预期结果'])),
    section('internalCalls','内部模块调用',d(['name|target|endpoint','目标能力','ref'],['module|owner','提供模块'],['purpose|description','调用目的'],['condition','触发条件'],['processingMode','处理方式'],['failureImpact','失败影响'])),
    section('externalCalls','外部系统调用',d(['name|target|endpoint','目标能力','ref'],['system|owner','外部系统'],['purpose|description','调用目的'],['condition','触发条件'],['processingMode','处理方式'],['failureImpact','失败影响'])),
    section('usages|calledBy|apiBindings','使用入口',d(['menu|menuId','使用菜单','ref'],['page|pageRef','使用页面','ref'],['action','页面操作 / 后台触发'],['purpose','调用目的'],['sources','依据','sources'])),
    section('exceptions|failureHandling','异常与恢复',d(['condition','发生条件'],['message','提示信息'],['result','业务结果'],['dataChanged','数据是否改变','boolean'],['allowedActions','允许后续操作'],['sources','处理依据','sources'])),
    section('completion','异步受理与完成',d(['acceptedWhen','受理条件'],['acceptedResult','受理返回'],['progressQuery','进度查询'],['completionCondition','业务完成条件'],['resultLocation','最终结果入口','ref'])),
    section('performance','已有性能记录',d(['operation','被测操作'],['environment','环境','environment'],['dataSize','数据规模'],['concurrency','并发条件'],['duration','耗时'],['observedAt','观测时间','date'],['verdict','验证结论','status'])),
  ],
  permission: [
    section('roles','资料列明角色',d(['displayNameZh|displayName|name|role|description|roleKey','角色名称（原文）'],['roleKey','角色编码'],['dataScope','范围声明（原文）'],['visibleCapabilities|canSee','原文可见内容 / 能力（不代表可执行操作）'])),
    section('permissionCodes','资料列明权限码',d(['code|description','权限码原文（不代表已生效）'])),
    section('tenantScope','资料中的租户范围说明',d(['description','租户范围原文'])),
    section('rules|permissionMatrix|bindings','权限规则',d(['subject|role','适用主体','ref'],['subjectType','主体类型'],['object','业务对象','ref'],['operation|action','业务操作'],['decision','授权结论','authorization'],['dataScope','数据范围'],['conditions','业务前提'])),
    section('roleMappings|roleBindings','职责与角色映射',d(['responsibility','业务职责'],['role|roleName','系统角色'],['personRule','人员确定规则'],['organizationConditions','组织 / 岗位条件'],['sources','映射依据','sources'])),
    section('dataScopes','数据范围定义',d(['name','范围名称'],['businessMeaning','业务含义'],['relation','判断关系'],['organizationRule','组织层级规则'],['operations','适用操作'],['sources','定义依据','sources'])),
    section('fieldRestrictions','字段限制',d(['field','字段'],['read','可读条件'],['edit','可修改条件'],['mask','脱敏规则'],['export','导出规则'],['sources','依据','sources'])),
    section('enforcement|permissionEnforcement','各处落实',d(['locationType','落实位置类型'],['target','具体位置','ref'],['ruleRef','规则修订','ref'],['implementation','实现依据','evidence'])),
    section('verification|evidence','实际验证',d(['identityConditions','身份条件'],['operation','业务操作'],['dataConditions','对象归属条件'],['objectState','对象状态'],['expectedResult','预期结果'],['actualResult','实际结果'],['environment','环境','environment'],['commit','实现提交','commit'],['evidence','依据','evidence'])),
  ],
  test: [
    section('executionState','本轮执行状态（原文）',d(['description','原记录状态'])),
    section('reportedResults','历史报告原文（不代表本轮执行）',d(['description','报告原文'])),
    section('limitations','记录适用限制',d(['description','限制原文'])),
    section('acceptanceCriteria','验收条件',d(['name|description','验收项'],['requirementRef','关联要求','ref'],['conditions','适用条件'],['expectedResult','验收标准'],['businessConfirmation','业务确认','evidence'])),
    section('cases|testCases','测试用例',d(['name|description','用例名称 / 原文'],['goal','验证目标'],['identityConditions','身份条件'],['dataConditions','数据条件'],['preconditions','前置状态'],['operation','操作'],['expectedResult','预期结果'])),
    section('steps','测试步骤',d(['name|step','步骤'],['operation|description','操作内容'],['expectedResult|expected','预期结果'])),
    section('executions|execution','执行记录',d(['executionStatus|status','执行状态','status'],['actualResult','实际结果'],['verdict','结果判定','status'],['executedAt','执行时间','date'],['environment','环境','environment'],['commit','被测提交','commit'],['evidence','证据入口','evidence'])),
    section('issues','问题与复验',d(['name','问题'],['conditions','发生条件'],['actualResult','实际现象'],['version','发生版本'],['failureEvidence','原失败依据','evidence'],['handling','处理记录'],['reverification','复验结果','evidence'])),
    section('reuse','历史证据适用',d(['executionRef','原执行记录','ref'],['acceptanceRef','适用验收项','ref'],['revision','适用版本','revision'],['scope','复用范围'],['sources','复用依据','sources'])),
  ],
  release: [
    section('services','本次发布组件（记录原文）',d(['name|component|description','组件原文'])),
    section('documentedChanges','已记录的业务变化说明',d(['name','变化名称','brief'],['changeType','变化类型','change-type'],['menuNames','涉及菜单','brief'],['before','变化前摘要','expandable-text'],['after','变化后摘要','expandable-text'],['provenance.nature','资料性质','documented-change-nature'],['provenance.recordRef','精确来源','documented-change-source'])),
    section('changes|delta','本次业务变化',d(['target|name','变更对象','ref'],['changeType','变更类型'],['before','变更前'],['after','变更后'],['sources','依据','sources'])),
    section('functions|fullScope|requirementSnapshots','有依据的功能范围',d(['name|functionRef','功能 / 要求','ref'],['revision','定义修订','revision'],['conditions','适用条件'],['scopeBinding','范围依据','scopeBinding'],['sources','来源','sources'])),
    section('components','组件与实际制品',d(['name|component','组件名称'],['repository','代码仓库'],['commit|buildCommit','实际构建提交','commit'],['artifact|artifactRef','制品名称','ref'],['digest','不可变标识','commit'],['buildEvidence','构建依据','evidence'],['deploymentEvidence','发布消费依据','evidence'])),
    section('steps|attempts','发布步骤及结果',d(['name|step','组件 / 步骤'],['status','实际结果','status'],['failure','失败位置'],['handling','后续处理'],['evidence','依据','evidence'])),
    section('rollbacks','回滚依据',d(['from','被回退版本','ref'],['to','目标版本','ref'],['code','代码回退'],['configuration','配置回退'],['database','数据库回退'],['data','数据恢复'],['evidence','依据','evidence'])),
    section('observations','环境观察',d(['environment','环境','environment'],['component','组件'],['commit','观察提交','commit'],['artifactRef','观察制品','ref'],['observedAt','观察时间','date'],['enabledEvidence','启用依据','evidence'])),
  ],
  dictionary: [section('values|options|items','字典值与业务含义',d(['code|value|id','存储值'],['label|name','业务名称'],['meaning|description','业务含义'],['conditions','适用条件'],['sources','依据','sources']))],
  rule: [section('rules','规则定义',d(['name','规则名称'],['conditions','适用条件'],['requirement|description','规则要求'],['failureHandling','不满足时处理'],['sources','依据','sources']))],
  task: [section('steps','任务步骤',d(['name','步骤'],['trigger','触发条件'],['executionMode','执行方式'],['engineType','引擎类型'],['result','预期结果'],['failureHandling','失败处理']))],
};
