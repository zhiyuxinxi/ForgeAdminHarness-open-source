---
name: forge-workflow-production
description: Design, implement, or review Forge Admin v1.1.2 Flowable business workflows, BPMN ownership, code-first or low-code binding, task forms, field permissions, status callbacks, versioning, idempotency, and approval tests. Use for process models, submit/approve/reject/return/resubmit/cancel behavior, workflow migrations, or workflow-backed business records; do not replace a workflow with a fake status field.
---

# Forge Admin 生产级工作流

Policy marker: `FORGE_WORKFLOW_PRODUCTION_V1`.

当前普通开发以用户目标推进：以下参考中的强制 Skill/TDD 顺序、固定阶段比例、反复独审和强制收尾已暂停；组件、样式与架构偏好只作建议。允许先保存修复草稿，再做受影响验证。真实权限、租户、数据完整性、秘密和危险操作授权继续保留；合入与发布须取得实际构建、必要启动、功能测试及源码绑定证据。不要把这段解释成已通过任何验证。

## 权威与模式

先完整读取项目 `.agents/skills/forge-business-flow-development/SKILL.md` 及任务所需 references；项目中的真实 Flowable/BPMN、binding 和 purchase-order sample 是源码事实。本 Skill 只提供不可下调的生产地板。

1. 选择 code-first（自定义表/Service/复杂表单/状态修复）或 low-code（动态 CRUD/runtime binding）。不要同时建立两条 start/save 路径。
2. 业务合同至少定义 objectCode、modelKey、`<objectCode>:<recordId>` businessKey、状态机、actor、变量、表单 asset、字段权限、终止语义和副作用。
3. BPMN 节点属性是新配置的 owner；binding `nodeForms` 仅兼容 fallback。模型已有非空 BPMN XML 时不得被初始化代码覆盖，designer 保存后的版本必须保留。
4. code-first Provider 与 Service 做 server-side 状态和 writable-field 校验；done/history 上下文只读。前端不能靠隐藏字段实现权限。

## 状态、事务与事件

- 默认状态 `DRAFT -> IN_PROCESS -> APPROVED`，reject-to-modify 使用 `NEED_MODIFY`，终态按业务区分 `REJECTED/CANCELED`；扩展前先画合法 transition 表。
- `ON_TASK_CREATED`、`ON_TASK_COMPLETED`、`ON_COMPLETED`、`ON_REJECTED`、`ON_CANCELED` 都按 event identity 幂等处理。不能只依赖 final completed variable。
- start 以 tenant + businessKey 防双提交；业务表保存 businessKey/processInstanceId。回调乱序、重复、丢失通过 active-task reconciliation 和可审计 repair 处理。
- 审批后的库存、财务、数量、外部调用使用独立 idempotency key 和 transactional outbox/等价可靠交付；不要在前端 handler 或不可重试 callback 中直接做不可逆副作用。
- recordId、assignee/user IDs 和 flow variables 的 Long 值在前端保持 string。

## 办理规则与共享引擎

- 所有业务入口（普通 API、任务表单、兼容入口）委派同一状态动作 owner，校验稳定 userId、真实任务归属/指定人、原记录范围、预期状态和允许字段。普通保存不能伪造批准、签署人或审批轨迹；审批历史只来自真实事件，不在生产 create 中写示例历史。
- 审批中及 done/history 默认不可经普通 edit 改审批依据；确需修订时走业务允许的当前节点操作，状态/version 与实际 UPDATE 同时约束。业务状态和待办/已办列表投影来自同一事实，不仅改显示 progress。
- 会签完成必须证明本轮全部必需义务有效批准，不能仅检查 pending 数量为零。驳回重提保留已完成历史并恢复所有尚未有效批准的义务；并发办理在读节点状态前锁定聚合或采用等价 CAS/current-read，禁止整体覆盖无版本 JSON 丢失他人结果。
- 复用已安装 FlowClient、真实 BPMN 抄送节点/回调和任务服务；业务不直接维护 `sys_flow_*` 或 Flowable 表，不仿造第二套通用任务执行器。接收人策略与业务入账留业务，流程持久化与任务生命周期交给流程 owner。公开客户端暂不支持某能力时修窄契约或使用现有节点，不反向注入引擎实现。
- 回调核对 tenant、businessKey、processInstanceId 与实际本轮记录，旧实例和已完成过账不能使状态回退。库存扣减条件、流水和幂等标记共用事务；自动累计在成功入账时计算，不能沿用提交时旧快照。幂等键相同但对象/数量/方向/主体不同必须拒绝。

## BPMN 与版本演进

每个 assignee/candidate/gateway 表达式必须有类型明确的 variable mapping；gateway default flow 不带 condition；multi-instance、return、delegate、terminate 和 required comment 必须逐节点说明。已部署且有运行实例的版本不可原地重写历史语义；新版本部署、在途实例继续/迁移/取消由业务 owner 与运维 owner 共同决定，模型不能代批。

## 硬门禁和验证

```text
forge-governance audit --root /workspace --base <approved-base-commit> --format json
```

确定性 audit 覆盖 Flowable 必需 artifact、历史 migration 变更、tenant 0/Flyway placeholder、Long ID 和缺失权限等可静态识别形态。callback 幂等与乱序、BPMN 表达式、状态 repair、副作用交付、会签完成条件和在途实例策略属于语义/runtime 判断，必须独立复核并实测；需要放宽确定性 rule 的例外只能由版本化 policy 批准并绑定 hash/范围/expiry，模型不能自批。

随后运行启用真实编译和测试的 Maven 命令、BPMN parse/deploy tests、migration 升级、API/权限负例和可用环境中的完整流程。默认 Maven 配置会跳过编译/测试，必须显式 `-Penable-tests` 或等价地关闭 `forge.compiler.skip`/`forge.tests.skip`，并检查真实输出。详细矩阵见 [工作流生产合同](references/workflow-contract.md)。

## 输出

报告模式、状态/事件/变量/表单 owner、BPMN version、事务/幂等/repair、权限租户、主/负路径 receipt、在途实例决策与未验证项。流程图能打开、状态字段变化或 audit 0 均不等于流程已验证。
