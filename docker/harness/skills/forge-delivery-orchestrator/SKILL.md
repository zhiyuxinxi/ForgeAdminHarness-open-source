---
name: forge-delivery-orchestrator
description: Coordinate a long-running or multi-agent Forge Admin delivery as a bounded fan-out/fan-in work graph. Use when a change has at least two independently owned workstreams or the user asks for parallel agents; do not use for ordinary single-owner implementation.
---

# Forge Admin 多线程交付编排

Policy marker: `FORGE_DELIVERY_ORCHESTRATOR_V1`.

本 Skill 负责把一个已授权目标分解为可并行、可交接、可串行集成的工作图。它不向子任务转移额外权限，也不把“创建了多个 Agent”当成隔离、进度或完成证据。

## 启动条件与预检

1. 加载 `forge-task-contract`。跨层目标尚无稳定合同或验收标准时先加载 `forge-change-design`；存在 `FORGE_TASKSPACE_ID` 时加载 `forge-taskspace-collaboration`。
2. 记录精确项目、基线 commit、工作区状态、唯一目标、授权动作和发布边界。目标不能拆成至少两个互不争抢 writer 的工作项时使用单线程，不为并发数量牺牲正确性。
3. 识别当前协调能力：真实独立 TaskSpace/clone、可用 Agent 槽位、范围租约、状态/交接工具、Git/Broker/Runner。只认可实际可查询的能力和回执；字段写着 `worktree`、Agent 自述“已锁定”或目录名称不同都不构成硬隔离。`forge-delivery worktree inspect` 可只读列出当前 commit、branch 和变更分类，但它不是路径租约。
4. 在分派或接受正式交接前读取 [references/orchestration-ledger.md](references/orchestration-ledger.md)，维护工作 DAG、writer ownership、候选和证据。

## 以 artifact ownership 拆分

每个工作项必须包含：Work ID、目标、依赖、基线、权威输入、精确 owned paths、owned semantic resources、允许/禁止动作、交付物、验证、停止条件和交接证据。

- 共享 API/DTO、Flyway 版本、表/列、permission、dict key、workflow key、公共组件和配置 key 都是语义资源，即使文件不同也只能有一个 writer。
- 合同、schema 或公共 owner 由单一责任人先完成并冻结；依赖方只消费已确认版本。合同未冻结时可以并行只读分析，不能并行猜测实现。
- 只读审查线程可以检查相同范围，但不得修改。写线程之间 owned paths 和语义资源必须互斥。
- 文档、catalog、版本和集成文件由指定集成责任人统一更新，避免多个线程同时“顺手收尾”。
- 子任务只继承明确写入工作项的动作权限。父任务允许实现不等于子任务允许发布、推送、写生产数据、读取 Secret 或改变平台。

## 并行执行边界

- 写入任何 change、handoff 或 verification 状态前，项目模板必须已登记 `/.forge-delivery/` 为 Git ignore，且目录内没有 tracked 文件。让 CLI 自己失败关闭；遇到 `DELIVERY_STATE_NOT_IGNORED` 时停止状态写入，不在业务线程修改模板或 `.gitignore`。
- 有真实 TaskSpace 时，每个 writer 使用自己的 clone/branch，记录 TaskSpace ID 和 base commit；候选通过 Git commit 与 Broker 协调，不复制未提交目录。
- 多 Agent 共享同一文件系统但没有确定性范围租约时，最多允许一个 writer；其他 Agent 只读分析或等待。当前 `forge-delivery` 只锁 change 状态更新，不提供路径或语义资源租约，不得依赖聊天约定来保证并行写安全。
- 如果平台提供受审的类型化状态或 handoff 命令，使用其固定参数和回执；命令不存在、版本不符或回执不可验证时降级为保守编排并标记 `hard_coordination_unavailable`，不得发明命令或伪造 receipt。
- 同一工作项不能因超时或新消息重复分派给第二个 writer。先确认原执行者状态和可恢复点；无法证明停止时保持单 writer 假设。
- 迁移、候选集成和项目发布始终按项目串行。并行开发不放宽 `_test` schema、Broker 锁、远端 fast-forward 或 Runner exact-commit 门禁。

## 进度、交接与失败

`forge-delivery` change 只接受这一条不可跳级链：

```text
scoped → designed → implementing → implemented → verifying → evidence-recorded
```

每次转换前执行 `change status`，使用返回的准确 version 和新的逻辑 idempotency key；重试同一个逻辑请求必须复用原 key。`evidence-recorded` 只表示自述 verification artifact 已被完整性检查并写入 change，不是 `verified`，也不证明执行、发布或部署。

工作项协调状态只使用 `planned`、`ready`、`running`、`blocked`、`failed`、`ready_for_integration`、`integrated`、`cancelled`。这些聊天/台账状态不属于 CLI change 状态；没有平台回执时不得称为权威状态。

一个精确示例：

```text
forge-delivery worktree inspect
forge-delivery change status --change provider_import_20260830
forge-delivery change transition --change provider_import_20260830 --to implementing --expected-version 2 --idempotency-key provider-import-implementing-20260830-01
forge-delivery handoff create --handoff provider_import_design_handoff_01 --change provider_import_20260830 --source docs/changes/provider-import.md
forge-delivery handoff verify --handoff provider_import_design_handoff_01
```

示例中的 change、handoff、version 和 source 是同一个假定任务的完整精确值，不得复制到其他任务。实际 `--source` 必须是已获授权、真实存在的精确仓库相对普通文件，禁止通配、目录、绝对路径、`.git` 和 `.forge-delivery`。handoff 绑定创建时的 commit、change state/version 和 source hash；接收者必须在任何 commit、状态或文件变化前验证，过期后重新创建新 handoff ID，不能覆盖旧记录。

交接必须绑定 Work ID、base、candidate commit 或只读发现、精确文件、测试命令及退出结果、未决风险和下一责任人。计划中的测试、第二模型、复核或发布不能写成已完成。需要正式交接时按 ledger 的 handoff 字段检查内容一致性；可用确定性 handoff 工具时再附其摘要/hash。

只对已识别、无副作用或有幂等键的暂时性失败做有界重试。授权失败、范围冲突、基线漂移、迁移冲突、测试确定性失败、Broker/Runner 拒绝和证据矛盾不盲目重试；保留候选和诊断后转为 `blocked` 或 `failed`。用户替换目标时先停止可停止的工作项，记录已发生写入与恢复点，再建立新合同。

## 串行集成与收尾

1. 集成责任人逐个核对 handoff、owned paths、candidate commit 和验证；缺证据的候选退回原 writer，不直接代填“通过”。
2. 基于最新集成 commit 逐项合入。冲突在候选 TaskSpace 中解决、重新测试并生成新候选；不覆盖集成 workspace，不改写他人历史。
3. 所有候选组装后在最终 commit 上重跑跨模块构建、合同、权限负例、迁移和适用 UAT。单项测试通过不能证明组合通过。按实际时点逐级 CAS 到 `implemented`、`verifying`；不得提前推进。
4. 使用 `forge-evidence-truth` 核对最终声明。自述记录最多允许转到 `evidence-recorded`，不能把该状态报告为 verified。Git checkpoint、发布和发布后验收分别加载对应 Skill；当前目标未显式授权发布时停在有证据的本地候选。

最终报告工作图、各线程实际贡献、集成 commit、组合验证、失败/降级、尚未由硬门禁保护的边界，以及是否发生提交、推送、发布或外部写入。
