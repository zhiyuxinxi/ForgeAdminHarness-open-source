# AI 能力总览：Skills、工具、Prompt 与运行组件

[返回首页](../README.md) · [文档索引](README.md) · [功能说明](features.md) · [上手指南](getting-started.md) · [版本边界](release-status.md)

本文按“类型、中文与英文名称、用途、场景、产出、边界”介绍交付隔离台的 AI 能力，帮助业务人员、开发者和部署者形成完整认识。它是一份能力导航，不是工具调用教程或已完成的运行验收报告。

**当前公开源码包含24个Skills：4个stable、20个pilot，技能包版本为 `2026.10.16.10`。**数量以本仓库的[技能目录](../docker/harness/skills.catalog.json)为准。本次同步包含浏览器、Bruno和ast-grep等新增技能及相应工具源码；运行启用仍需正确依赖、制品及授权。

## 1. 四类能力如何配合

| 类型 | 主要职责 | 通俗理解 | 如何判断实际可用 |
| --- | --- | --- | --- |
| Skill／技能 | 说明某类任务的方法、规范、证据和边界 | 告诉 AI“这件事怎样做” | 技能存在且已加载；具体操作还需要工具、权限与运行条件 |
| Tool／工具 | 读取文件、修改代码、运行检查、保存候选和发布 | 让 AI“真正动手做事” | 运行版本已注册工具，所需配置和授权有效，并取得实际结果 |
| Prompt／提示词与上下文 | 说明角色、当前目标、项目事实与行为约束 | 告诉 AI“现在做什么、遵守什么” | 以实际装配的提示词、项目上下文和程序检查为准 |
| Runtime／运行组件 | 管理模型、会话、工作空间、权限及执行作业 | 提供 AI 的工作环境 | 相应组件已部署、配置并由当前项目实际使用 |

这些层次互相配合，不能把表格行数相加称为“技能总数”。一个技能可能调用多种工具，一个工具也可能服务多个技能。`stable`、`pilot` 是技能目录中的成熟度标记，分别表示稳定标记和试行标记，不代表所有模型与业务场景均已验收。

## 2. 当前公开版的 Skills（21项基础技能，3项新技能见第6节）

每项英文名链接到本公开快照中的实际 `SKILL.md`。表中的产出表示技能指导任务形成的结果，不保证仅加载技能就自动生成或通过验收。

| 类型 | 名称：中文／英文 | 具体做什么 | 典型场景 | 主要产出 | 成熟度与边界 |
| --- | --- | --- | --- | --- | --- |
| Skill | 项目资料读取<br>[project-document-reader](../docker/harness/skills/project-document-reader/SKILL.md) | 阅读 PDF、Word、Excel、源码和 HTML/Axure 原型，保留来源与读取范围 | 根据需求表和原型分析功能 | 可读内容、页面结构、需求依据 | stable；不保证扫描件 OCR 或复杂格式完整还原 |
| Skill | 开发进度保存<br>[forge-git-checkpoint](../docker/harness/skills/forge-git-checkpoint/SKILL.md) | 保存当前任务的 Git 检查点，保护其他任务修改 | 先保存已完成进度，稍后继续 | 候选提交、保存范围和剩余事项 | stable；保存不等于集成或发布 |
| Skill | 受控发布<br>[forge-controlled-release](../docker/harness/skills/forge-controlled-release/SKILL.md) | 按授权调用项目发布链路并解释实际结果 | 发布已完成的修改 | 发布作业、服务结果及失败原因 | stable；不开放任意宿主机操作 |
| Skill | 工作舱协作<br>[forge-taskspace-collaboration](../docker/harness/skills/forge-taskspace-collaboration/SKILL.md) | 协调独立工作舱之间的代码同步、候选集成和冲突 | 多人分别开发后汇总修改 | 集成结果、冲突处理和来源记录 | stable；独立工作舱仍可能修改相同代码 |
| Skill | 任务范围与授权<br>[forge-task-contract](../docker/harness/skills/forge-task-contract/SKILL.md) | 明确目标、项目、范围、允许动作和结束条件 | 区分检查、修复、继续和发布 | 清晰的任务边界 | pilot；不能扩大用户授权 |
| Skill | 需求梳理与变更设计<br>[forge-change-design](../docker/harness/skills/forge-change-design/SKILL.md) | 将业务描述和附件整理成可实施、可验收的设计 | 增加报修或审批功能 | 需求、设计、影响范围和验收条件 | pilot；业务取舍仍需真实依据 |
| Skill | 多任务交付协调<br>[forge-delivery-orchestrator](../docker/harness/skills/forge-delivery-orchestrator/SKILL.md) | 拆分可独立推进的工作，管理依赖、交接和集成 | 前后端等多个工作方向配合 | 分工、依赖关系和交接结果 | pilot；要求实际协作能力，不凭多个对话认定隔离 |
| Skill | 需求覆盖核对<br>[forge-requirement-coverage](../docker/harness/skills/forge-requirement-coverage/SKILL.md) | 检查需求是否落实到页面、接口、数据、权限、字典和测试 | 检查需求还有哪些没做 | 覆盖关系、缺口与未验证项 | pilot；覆盖清单不替代功能运行 |
| Skill | 字典与枚举一致性<br>[forge-dictionary-contract](../docker/harness/skills/forge-dictionary-contract/SKILL.md) | 统一数据库、接口、页面与 Excel 中的编码及显示含义 | 状态、类型、等级和导入导出 | 跨端一致的字段约定 | pilot；仍需检查真实存储和显示 |
| Skill | 界面一致性审查<br>[forge-ui-consistency-review](../docker/harness/skills/forge-ui-consistency-review/SKILL.md) | 核对列表、表单、弹窗、抽屉及组件交互的一致性 | 新增与编辑不一致，字段回填异常 | 界面问题及修复依据 | pilot；不能用静态结论冒充浏览器验收 |
| Skill | 发布后验收<br>[forge-release-acceptance](../docker/harness/skills/forge-release-acceptance/SKILL.md) | 指导核对真实登录、菜单、操作、接口、权限和数据 | 检查发布后用户能否完成业务 | 验收结果、失败与未测事项 | pilot；需要环境、账号及已配置的浏览器工具 |
| Skill | 完成证据核查<br>[forge-evidence-truth](../docker/harness/skills/forge-evidence-truth/SKILL.md) | 核查“已实现、已测试、已保存、已发布”等结论 | 判断任务是否真正完成 | 有事实支持的完成状态 | pilot；文件存在或 HTTP 200 不是完整交付证据 |
| Skill | 技能选择与任务分流<br>[forge-task-router](../docker/harness/skills/forge-task-router/SKILL.md) | 根据任务领域定位相关技能和工作约定 | 判断需要数据库、前端、流程或测试技能 | 本次任务需要的技能组合 | pilot；按任务、上下文和可用能力选择技能与工具 |
| Skill | 阶段工作材料整理<br>[forge-phase-work-package](../docker/harness/skills/forge-phase-work-package/SKILL.md) | 整理阶段需求、设计、修改、检查和交接材料 | 复杂任务分阶段交接 | 可查阅和接续的工作材料 | pilot；材料状态不替代真实检查结果 |
| Skill | 数据库设计与迁移<br>[forge-database-migration](../docker/harness/skills/forge-database-migration/SKILL.md) | 指导表、索引、实体映射、种子数据和增量迁移 | 新增业务表、调整字段、升级数据库 | SQL、迁移文件和兼容性说明 | pilot；生产数据与破坏性操作另需授权 |
| Skill | Java 后端架构<br>[forge-backend-architecture](../docker/harness/skills/forge-backend-architecture/SKILL.md) | 指导分层、接口、DTO/VO、分页、事务与异常处理 | 开发或修复后端接口 | 符合项目约定的后端实现 | pilot；仍需编译和相关行为检查 |
| Skill | 完整增删改查开发<br>[forge-crud-production](../docker/harness/skills/forge-crud-production/SKILL.md) | 串联数据库、接口、权限、字典、页面和测试 | 新增台账、主子表、左树右表 | 完整业务模块及检查结果 | pilot；跨层实现需分别核实 |
| Skill | 管理端前端开发<br>[forge-frontend-admin](../docker/harness/skills/forge-frontend-admin/SKILL.md) | 指导 Vue 页面、表单、详情和共享组件实现 | 管理后台页面开发 | 页面、组件、接口适配与交互 | pilot；不代替底座组件及运行依赖 |
| Skill | 安全、租户与权限<br>[forge-security-tenancy-permission](../docker/harness/skills/forge-security-tenancy-permission/SKILL.md) | 处理鉴权、接口权限、租户隔离、数据范围和敏感信息 | 不同部门只能访问授权数据 | 权限实现、隔离规则及负例检查 | pilot；不是安全认证或零风险保证 |
| Skill | 业务审批流程开发<br>[forge-workflow-production](../docker/harness/skills/forge-workflow-production/SKILL.md) | 指导 Flowable/BPMN、任务表单、回调和流程版本管理 | 提交、审批、驳回、重提和撤销 | 流程模型及业务联动 | pilot；需要真实流程引擎与项目配置 |
| Skill | 测试与故障定位<br>[forge-testing-observability](../docker/harness/skills/forge-testing-observability/SKILL.md) | 选择与改动相关的测试，利用运行现象定位问题 | 功能修复、测试失败和运行异常 | 测试结果、诊断依据及未验证项 | pilot；可结合已授权的项目运行日志读取入口 |

## 3. 当前公开源码中的工具入口

本表按用途分组，不是固定的工具注册数量。原生工具由 Harness 注册；`forge-*` 等命令由指定入口调用，不能将 CLI 名称当成独立注册工具。源码存在、入口注册、账号可用与实际执行成功分别判断。

| 类型 | 名称：中文／英文 | 具体做什么 | 典型场景 | 返回或产出 | 当前公开版边界 |
| --- | --- | --- | --- | --- | --- |
| 基础工具 | 文件读取与搜索<br>`read / glob / grep` | 读取文件，按路径或内容定位代码 | 查接口、配置和需求 | 文件内容与命中位置 | 只访问当前允许范围 |
| 基础工具 | 文件修改<br>`write / edit / remove_file` | 创建、修改和删除获准文件 | 开发、修复或调整文档 | 实际文件变更 | 受任务权限、路径与只读要求约束 |
| 基础工具 | 受控命令入口<br>`bash` | 调用受支持的治理、验证、保存和发布命令 | 启动定向检查或受控发布 | 命令输出、作业与退出结果 | direct模式支持隔离worker中的命令执行；controlled模式保留受控CLI策略，均受路径及授权约束 |
| 基础工具 | 技能加载<br>`skill` | 读取相关 Skill 和参考材料 | 开始数据库或前端任务 | 方法指导与项目约定 | 加载技能不增加操作权限 |
| 基础工具 | 后台作业跟踪<br>`job_list / job_output` | 查看已有后台任务的状态与输出 | 等待编译、测试或发布 | 作业输出及最终结果 | 提交成功不等于执行成功，不应重复提交同一作业 |
| 交互工具 | 待办与问题澄清<br>`todo_write / ask_user_question` | 记录待办，询问影响实施的业务选择 | 多事项处理或需求歧义 | 待办状态和用户回答 | 问题选项不自动成为签名执行授权 |
| 任务工具 | 当前任务准备<br>`prepare_task` | 将直接用户请求与当前任务执行上下文绑定 | 开始任务、继续或调整动作范围 | 受保护的任务执行上下文 | 不能伪造用户授权或沿用无关任务权限 |
| 资料处理 CLI | 文档提取<br>`harness-document-extract` | 提取 PDF、DOCX、XLSX 中的文本和表格 | 阅读需求文件和功能表 | 带资料定位信息的可读内容 | 由资料读取链路按允许入口使用；不保证所有旧格式和 OCR |
| 原型处理 CLI | 原型目录索引<br>`forge-prototype-index` | 索引 HTML/Axure 导出目录 | 根据完整原型目录分析页面 | 页面索引与资源关联 | 静态解析，不执行上传脚本 |
| Git CLI | 保存与集成<br>`forge-release checkpoint / integrate` | 保存当前工作成果并与项目集成线协调 | 保存开发进度、同步团队修改 | Git 候选、集成结果和冲突 | 需要有效任务上下文和范围；不自动等于发布 |
| 发布 CLI | 受控发布与诊断<br>`forge-release` | 查询能力、检查候选、诊断及发布允许的服务 | 发布已授权修改 | 发布作业与服务终态 | 由Broker／Runner执行，支持按项目授权读取 `logs` |
| 验证 CLI | 编译、测试与检查<br>`forge-verify` | 执行项目登记的后端、前端及质量检查配置 | 编译、测试、类型检查和构建 | 检查结果与执行回执 | 按实际影响选择；可用配置取决于项目和运行环境 |
| 静态检查 CLI | 代码与规则检查<br>`forge-governance` | 检查可确定识别的代码、SQL、权限和来源规则 | 定向审查相关变更 | 命中规则与具体位置 | 静态通过不替代运行或业务验收 |
| 交付记录 CLI | 工作状态与交接<br>`forge-delivery` | 管理变更状态、交接文件、合同与证据关联 | 长任务接续和阶段交接 | 状态记录与交接材料 | `evidence-recorded` 只表示材料记录，不证明测试通过 |
| 文件维护工具 | 登记目录文件维护<br>`managed_file` | 查看、修改或恢复操作者已登记目录内的普通文本文件 | 获准维护 HTML 或文本 | 文件版本、修订和恢复结果 | 不是任意 SSH、宿主文件操作或递归删除 |
| 受限数据工具 | 业务数据预览与批准执行<br>`business_data_approval / business_data_apply` | 将精确数据修改与当前用户请求和批准记录绑定 | 已实现白名单内的数据修正 | 预览、批准或执行结果 | 当前为特定台账备注等窄范围实现，不是通用 SQL 或任意业务表编辑 |

主要源码依据：[原生工具策略](../docker/harness/forge-phase-budget-guard.mjs)、[standard 预设](../docker/harness/forge-agent-preset-policy.mjs)、[任务准备](../docker/harness/forge-prepare-task.mjs)、[文档提取](../docker/harness/document-extractor.mjs)、[原型索引](../docker/harness/prototype-directory-index.mjs)、[发布 CLI](../docker/harness/forge-release)、[验证 CLI](../docker/harness/forge-verify)、[治理 CLI](../docker/harness/forge-governance)、[交付实现](../docker/harness/forge-delivery.mjs)、[文件维护](../docker/harness/forge-managed-file-tool.mjs)、[数据预览](../docker/harness/forge-business-data-preview.mjs)、[数据执行范围](../docker/harness/forge-business-data-consumption.mjs)。

## 4. Prompt、上下文与工作模板

| 类型 | 名称：中文／英文 | 具体做什么 | 使用时机 | 对使用者的价值 | 当前公开版边界 |
| --- | --- | --- | --- | --- | --- |
| 系统 Prompt | 标准代理规则<br>`standard / GOVERNANCE_PERSONA` | 定义代理职责、工具用法、权限与证据要求 | 使用当前公开预设时 | 按同一项目规则开展工作 | 当前公开预设允许列表为 `standard`，不能将后续 direct 模式套用到本版本 |
| 项目上下文 | 项目事实与工作约定<br>`PROJECT_CONTEXT.md / AGENTS.md` | 提供基线、技术结构、任务边界及项目规则 | 开始或恢复任务时 | 减少混淆项目、目录与业务差异 | 平台只读上下文与项目自己的 AGENTS 分别维护 |
| 任务提示与程序约束 | 请求理解与执行上下文<br>Task Execution Context | 关联直接用户请求、身份、任务、动作和来源 | 任务准备及受控工具执行时 | 支持同一任务接续并保持权限边界 | 不是仅靠自然语言提示词保障安全，也不等同后续版本的自主工具选择规则 |
| 工作模板 | AI 交付作业卡<br>AI Delivery Playbook | 提供需求、设计、开发、测试、发布和交接示例 | 用户组织需求与团队协作时 | 帮助表达目标、输入和完成条件 | 使用模板不代表其中工作已经执行 |
| 阶段模板 | 八类阶段材料<br>Phase Work Package Assets | 提供需求、领域合同、数据库、UI、后端、前端、权限接线和跨层验收材料 | 按需组织复杂任务 | 让成果易于核对和接手 | 普通任务不因模板存在而强制重跑所有阶段；以本版本真实规则为准 |

源码与阅读入口：[预设策略](../docker/harness/forge-agent-preset-policy.mjs)、[运行 Prompt 配置](../docker/harness/forge-governance-runtime.patch.yml)、[项目上下文模板](../templates/project/PROJECT_CONTEXT.md.tpl)、[执行上下文](../docker/harness/forge-execution-context.mjs)、[作业手册](ai-delivery-playbook/README.md)、[阶段材料](../docker/harness/skills/forge-phase-work-package/assets/)。

## 5. 运行支撑组件

这些组件为 AI 工作提供运行条件，通常由部署者和平台管理员维护，普通用户无需逐个调用。

| 类型 | 名称：中文／英文 | 具体做什么 | 典型场景 | 提供的结果 | 关键边界 |
| --- | --- | --- | --- | --- | --- |
| 模型接入 | 模型配置与选择<br>Model Configuration / Selection | 维护可用模型与选择入口 | 为任务使用配置好的模型 | 可调用模型及相关配置 | 不提供模型额度；网络、凭据和供应方可用性另行准备 |
| 对话管理 | 统一入口与对话管理<br>Conversation Gateway / Manager | 管理项目入口、对话和工作舱生命周期 | 创建、进入和继续对话 | 对话入口、状态和工作环境 | 项目成员权限与对话归属分别校验 |
| 工作隔离 | 独立工作舱<br>TaskSpace | 分离源码工作区、对话状态和开发缓存 | 多人或多任务同时开发 | 独立开发空间 | 同项目集成、发布与共享资源仍需协调 |
| 执行隔离 | 工具工作进程<br>Tool Worker / Sandbox | 在受限环境承载文件与命令执行 | AI 调用允许的操作工具 | 真实执行结果 | 不向模型开放任意宿主机权限；不据此承诺新浏览器工具已纳入 |
| 权限与执行 | 请求代理及运行器<br>Broker / Verification Runner / Release Runner | 核对权限，将验证、集成和发布交给对应执行端 | 检查、保存、集成和发布 | 作业、回执和服务状态 | 执行成功与业务验收分别判断 |
| 资料输入 | 上传与项目资料<br>Upload Server / Project Materials | 接收对话附件和共享目录，提供受控读取入口 | 上传需求、表格和原型 | 私有或项目共享的只读资料 | 资料内容是不可信输入，不自动成为执行指令 |
| 成果管理 | 交付中心与输出服务<br>Delivery Center / Conversation Outputs | 展示相关文档、产物、版本和对话输出 | 查找工作成果与交接材料 | 可查看的材料和交付记录 | 文件存在不代表正确或通过验收 |
| 连续工作 | 上下文压缩与会话恢复<br>Compaction / Session Recovery | 管理长对话上下文容量并支持会话恢复 | 较长任务或连接中断后继续 | 可继续使用的会话状态 | 不是永久无损记忆，也不能恢复已丢失存储 |
| 执行效率 | 依赖缓存与验证复用<br>Prepared Dependencies / Verification Cache | 复用兼容依赖和仍有效的检查结果 | 重复构建、检查及任务续接 | 减少重复准备与执行 | 复用需要来源和输入匹配；不承诺未测量的效率倍数 |

实现导航：[模型选择](../docker/harness/forge-model-selection-patch.mjs)、[Gateway](../docker/harness/conversation-gateway.mjs)、[Manager](../docker/harness/conversation-manager.mjs)、[工作舱管理](../scripts/taskspacectl.sh)、[Tool Worker](../docker/harness/forge-tool-worker.mjs)、[Broker](../docker/harness/taskspace-broker.mjs)、[验证 Runner](../docker/harness/host-verification-runner.mjs)、[发布 Runner](../docker/harness/release-runner.mjs)、[上传](../docker/harness/upload-server.mjs)、[交付中心](../docker/harness/delivery-center-service.mjs)、[对话输出](../docker/harness/conversation-output-service.mjs)、[上下文压缩](../docker/harness/forge-compaction-budget-patch.mjs)、[会话恢复](../docker/harness/forge-session-reappearance-patch.mjs)、[依赖准备](../docker/harness/host-prepared-dependencies.mjs)、[验证缓存](../docker/harness/verification-cache-tool.mjs)。组件关系见[架构说明](architecture.md)。

## 6. 本次同步的3项技能与工具

以下源码已随2026-10-18同步进入公开仓库。它们仍需相应依赖、镜像及项目配置；公开源码同步不是运行环境已启用的证明。

| 类型 | 名称 | 用途 | 边界 |
| --- | --- | --- | --- |
| Skill | [browser-playwright](../docker/harness/skills/browser-playwright/SKILL.md) | 真实页面观察与获准交互 | pilot；浏览器依赖和隔离条件必须满足 |
| Skill | [api-bruno](../docker/harness/skills/api-bruno/SKILL.md) | API请求、复现与断言 | pilot；写请求需相应授权 |
| Skill | [code-ast-grep](../docker/harness/skills/code-ast-grep/SKILL.md) | 按语法结构搜索代码 | pilot；匹配本身不证明缺陷 |
| 工具 | browser／Playwright | 页面快照、点击、填写、控制台和网络观察 | 使用受限浏览器执行入口 |
| 工具 | bru／Bruno CLI | 接口请求及测试报告 | 依赖所选环境和凭据 |
| 工具 | ast-grep | 语法树搜索 | 仅当前授权代码范围 |
| 日志CLI | forge-release logs | 按项目及服务读取日志 | 输出范围、权限和脱敏约束仍有效 |
| 系统Prompt | DIRECT_DEVELOPMENT_PROMPT | 按授权目标直接推进开发 | [direct模式](direct-development.md)，保留隔离和发布授权 |
| 选择规则 | Skill / Tool Selection | 按自然语言、上下文及工具结果选择能力 | 不突破暂停、权限及项目边界 |

## 7. 使用者如何阅读和开始

例如“这个编辑弹窗保存失败，帮我检查并修复”：技能帮助 AI 确定检查方法，文件与验证工具用于定位、修改和检查，工作舱保留当前任务的修改，保存与发布工具分别处理候选和上线。浏览器、接口调试或运行日志的具体入口，应先核对所用版本是否包含且已配置；只有已有发布授权，才进入发布环节。

- **想了解平台能做什么**：先看本文四类能力和技能表，再看[完整功能说明](features.md)。
- **已有可用平台账号**：从[第一次对话](getting-started.md#普通使用者开始第一次对话)开始，表达目标、范围、已有材料和预期结果。
- **准备自行部署**：先核对[安装条件](getting-started.md#部署者先核对安装条件)及[已知限制](release-status.md)，不要把能力目录当成安装完成证明。
- **想开发具体业务模块**：应用页面、接口、用户权限、低代码和流程基础由 [ForgeAdminFoundation](https://github.com/zhiyuxinxi/ForgeAdminFoundation) 提供；本文描述的是组织 AI 开发与交付的能力。

本文核对范围是公开文件、技能目录与相关程序入口；没有据此执行安装、实际模型对话、业务验收或发布。运行版本最终是否可用，应以相应环境的真实结果为准。
