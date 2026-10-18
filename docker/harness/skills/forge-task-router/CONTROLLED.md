---
name: forge-task-router
description: Route a Forge Admin implementation or review to the minimum required project and Harness skills, governance rules, risk floor, and verification profile. Use at the start of any Forge code, SQL, API, permission, frontend, workflow, test, security, or architecture task; do not trigger for a generic explanation unrelated to the current Forge repository.
---

# Forge Admin 任务路由

需求梳理、会议/附件转需求、Spec/PRD或需求取舍，使用 [forge-change-design](../forge-change-design/SKILL.md) 的需求方法；只读/文档任务不因这一路由获得实施权限，明确的小改不重做需求。已有阶段绑定继续按当前合同，需求方法不增加阶段或改变payload。

Policy marker: `FORGE_TASK_ROUTER_V1`.

当前普通开发以用户目标推进：以下参考中的强制 Skill/TDD 顺序、固定阶段比例、反复独审和强制收尾已暂停；组件选型与普通样式偏好只作建议，职责、模块依赖及关键代码正确性要求仍须落实。允许先保存修复草稿，再做受影响验证。真实权限、租户、数据完整性、秘密和危险操作授权继续保留；合入与发布须取得实际构建、必要启动、功能测试及源码绑定证据。不要把这段解释成已通过任何验证。

本 Skill 是常驻的最小入口，不承载所有领域细节。它先识别任务档案，再加载真正适用的项目 Skill 和 Harness Skill，避免 DeepSeek 靠记忆拼装规范。

入口 [自然语言选择技能与工具](SKILL.md) 同样适用于受控模式：模型按当前目标选择必要能力，允许不调用或组合调用；工具名称不是触发口令。新增浏览器、接口及结构搜索能力不新增阶段，不替代当前执行合同，也不解除工具端的权限与路径限制。

普通业务对话没有固定的八阶段入口。当前合同没有 `workflowId/phaseId` 且提供 `prepare_task` 时，先用该工具的 `inspect` 读取当前任务和项目允许范围；结合用户目标与实际读取的相关文件，用 `propose` 提交本次目标、具体文件范围、实际职责和参考文件路径。摘要、身份、源码及授权由运行时和服务器处理，不要求用户填写。收到新的执行合同后，在已授权文件内推进；按需读取相关 Skill。没有现成业务合同不等于不能执行；本次合同由实际需求和代码形成。明确只读时不得申请写入；已有任务的问答和接续不自动变成新业务任务。工具不可用时如实说明平台缺失，不能虚构已准备的范围。

用户要求按附件原型/需求重构整个模块时，先按`project-document-reader`消费资料，并使用`forge-requirement-coverage`保留原要求与已知差距。不要把整体目标自行改成“仅样式”“不改业务接口/逻辑”；用户确有这些限制时才保留。可以选择一个连贯增量申报路径，但说明它对应原目标哪部分并保留剩余工作；已授权的后续增量沿同一目标继续。补齐需求属于原范围，不是因为本批合同较窄就消失；需要更新路径时走现有准备入口，不越过机器权限。

## 路由顺序

1. 读取当前 TaskSpace 根目录的 `AGENTS.md`、`PROJECT_CONTEXT.md` 与平台注入的只读 Git 基线摘要；不得用任意 Git shell 补查。项目文件是当前业务真相；Harness 规则是不能下调的安全下限。
2. 如果存在 `.agents/skills/forge-codegen-crud/SKILL.md`，CRUD/表/API/菜单/权限/Excel 任务必须完整读取它；流程任务读取 `.agents/skills/forge-business-flow-development/SKILL.md`。不要在仓库内复制第二套项目 Skill。
3. 先判断是单 owner 小改，还是跨数据库/后端/前端的多 owner 交付。单 owner 小改根据实际影响加载最小组合：
   - DDL、Flyway、实体、索引：`forge-database-migration`；
   - 后端生成、修改、重构及分层、DTO/VO、分页、Mapper、工具类：`forge-backend-architecture`，在写入前确定职责、依赖方向和实际涉及的关键代码边界；
   - 完整 CRUD 垂直切片：先加载 `forge-crud-production` 形成阶段计划；进入具体实现阶段后只加载本阶段领域 Skill；
   - Vue 管理端、组件、字典、页面：`forge-frontend-admin`；
   - 登录、租户、权限、数据范围、敏感字段：`forge-security-tenancy-permission`；
   - 审批、Flowable、回调：`forge-workflow-production`；
   - 测试、日志、指标、完成声明：`forge-testing-observability`。
4. 已绑定 Controller 正式阶段状态的多 owner CRUD 必须读取 [阶段档案](references/phase-profiles.json)，按 `requirements → domain-contract → database → ui-design → backend → frontend → access-wiring → cross-layer-acceptance` 执行。`database` 只做物理 schema、字典/Excel seed 与迁移测试；`access-wiring` 必须等已验收页面/API 存在后才做菜单、按钮、API resource 与角色接线。第一阶段创建持久会话，后续阶段恢复同一会话；controller 必须为每阶段封存 `forge-phase-work-package` 合同规定的工作包，同事手工准备时只读取当前阶段交互卡；不得在一个 prompt 中加载全部领域 Skill、一次读取八张卡片、同时实现全部 owner 或自行跳阶段。
5. 跨层或高风险改动在对应设计阶段加载 `forge-change-design`；并行工作加载 `forge-delivery-orchestrator`；发布不是实现的默认下一步。

范围提案区分业务背景与实际改动：“页面显示了问题”不单独证明要改前端。根据当前目标、已读文件和接口/权限/迁移影响选择职责与路径，不为覆盖所有关键词加载全部领域 Skill。返回合同与实际范围明显不符时，说明具体差异，沿已有范围修正入口处理；相同提案已被绑定或拒绝时，不反复提交它，也不擅自扩修无关业务来迎合合同。范围差异本身不撤销仍有效的身份、owned paths 和草稿权限，可继续这些边界内的独立工作；真实权限拒绝仍须遵守。模型不能删除机器合同的验证义务、擅称全部通过或绕过工具拒绝。

普通任务的 Skill、阶段顺序和编辑次数是工作建议。已有明确实施意图时直接沿同一目标推进，不要求固定确认口令；明确只读、取消和真正缺失的业务取值仍应遵守或澄清。任务身份与 owned paths 仍由可信执行合同校验；同任务短租约由可信服务重新核验后续期，模型不自行制造授权。同一任务中未变化的已读文件与 Skill 可继续使用，只有新错误、实际改动或缺失事实需要时才补读；信息足以实施时不继续遍历无关目录。

确有影响交付的业务歧义时，将待决定事项汇总为一次原生 `ask_user_question`，给出清晰的业务选项供点击；已明确授权的动作与范围不重复确认。平台的执行、发版按钮发送正常用户消息，按当前用户身份和可信合同处理，用户无需记口令或填写命令。选项用于澄清业务取值，不能由模型自行扩大权限。

## 实施与验证

先完成能检查的连贯改动，中间使用聚焦测试或预览定位问题，不因每次编辑重跑全量。最终合入或发布前运行当前受影响范围的必要构建、启动、测试及静态安全检查。普通样式建议不要求独立复审，但职责混杂、大类/长方法、不合理依赖及关键代码错误不能因此免修；已有巨类不能继续无边界堆功能，也不能只机械搬文件。

本次代码生成、修改或质量整改按 `forge-testing-observability` 的范围化检查与修复路径收束。模型必须读取真实检查结果，把本范围问题反馈为具体位置、职责/行为原因与修复动作，并继续在同一任务内整改；profile 可选不等于已发现的问题可忽略。未涉及的历史问题不扩成全仓阻塞，达到本点必要行为与检查证据后返回原目标；不新增阶段、门禁或反复验证。

普通增量任务以前端页面改动 5 分钟以内、涉及后台数据建设总体 20 分钟以内为交付目标。根据实际记录区分执行、等待用户与发布耗时，同一任务的阶段切换、复核和重试不重置已耗时；没有可靠时间证据时如实说明。超出目标时报告具体原因，保留当前作业和有效结果继续必要工作；不能靠快速失败、减少必要验证或强杀进程宣称达标，也不把目标解释为任意规模任务的耗时保证。

受控静态检查仍使用：

```text
forge-governance audit --root /workspace --base <approved-base-commit> --format json
```

退出0只证明相应静态检查通过；不能代替测试、运行或发布。可以如实结束尚未验证完的草稿轮次，不为凑收尾格式强制重新读文件、加载 Skill 或终止工具。依赖缺失、测试失败和后台作业尚未结束应分别报告；保留已有作业与可复用证据，不循环重提。详细工具用法见[任务路由合同](references/routing-contract.md)，其中旧强制顺序以本页当前普通开发规则为准。

## 输出

任务档案、已加载 Skill、风险等级、唯一 owner、适用机器规则、验证矩阵和禁止动作必须在执行前完成识别并保留为机器事实，默认不逐项转述到用户首屏。面向用户的回复默认使用其主要语言，用 1–3 个简短段落或确有必要的短列表，先说明本次具体业务结果及当前影响，必要时再给实际下一步；不要固定套用标题，也不要每轮重述全部工程边界。

普通任务按“命令 → 执行结果 → 发版 → 发布结果”呈现：执行终态先说成功或失败，再简述实际已验证范围、可靠耗时及发布状态；尚未发布时明确“未发布”。仍在运行或受阻时如实报告，不能提前写成成败终态。发布完成后独立报告发布成功或失败及实际结果，不用执行成功代替发布成功。原请求已包含发布授权时直接续接；未授权发布时等待用户通过发版按钮或正常消息发起，不要求固定措辞。

技术事实不得因此省略或降级。最终仍须区分静态审计、真实测试、独立复核、Git、发布与业务验收；Candidate/HEAD/diff、命令与退出状态、回执和声明等级继续记录，用户要求、技术排障或正式交接时再提供后置技术凭据。只展示与本次结论有关的实际未完成项，不用一个“完成”代替全部事实，也不把无关的 UAT、回滚或治理清单一律刷到每次回复中。
