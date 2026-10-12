---
name: forge-change-design
description: Design an implementation-ready Forge Admin change across business behavior, data, API, permissions, UI, migration, and verification. Use for a substantive cross-layer feature or risky change before implementation; do not trigger for a small localized fix with an already-settled contract.
---

# Forge Admin 变更设计

Policy marker: `FORGE_CHANGE_DESIGN_V1`.

当前普通开发以用户目标推进：以下参考中的强制 Skill/TDD 顺序、固定阶段比例、反复独审和强制收尾已暂停；组件选型与普通样式偏好只作建议，职责、模块依赖及关键代码正确性要求仍须落实。允许先保存修复草稿，再做受影响验证。真实权限、租户、数据完整性、秘密和危险操作授权继续保留；合入与发布须取得实际构建、必要启动、功能测试及源码绑定证据。不要把这段解释成已通过任何验证。

本 Skill 把已批准的业务目标转成可实施、可验证、可回退的变更合同。它不因完成设计而获得代码修改、业务数据写入、Git、发布或项目长期状态写入权限。`OPERATOR_ONLY_REFERENCE_V1`：`forge-delivery` 状态写入只属于平台/operator 的独立授权面，不是标准模型运行面的可执行命令。

## 先固定设计边界

1. 先加载 `forge-task-router` 与 `forge-task-contract`，确认当前项目、基线、唯一目标、权威输入、动作级别、适用领域 Skill、确定性规则和停止条件；存在 `FORGE_TASKSPACE_ID` 时同时加载 `forge-taskspace-collaboration`。
2. 读取当前提交中的项目规则、相似实现和适用的源码耦合 Skill。CRUD/菜单/权限/Excel 优先读取 `.agents/skills/forge-codegen-crud/SKILL.md`；流程/Flowable 优先读取 `.agents/skills/forge-business-flow-development/SKILL.md`。文件不存在时以固定源码和测试为准，不猜造框架能力。
3. 区分权威与参考：已批准需求、明确用户决定和当前源码合同可以约束设计；原型、截图、旧系统、历史聊天和相似项目只能提供候选，不得静默覆盖当前权威。
4. 用户只要求设计或方案时，产出设计后停止，不改业务代码、迁移、测试、Git 或运行环境。用户已明确要求实施时，设计用于限定随后实现，不要求对低风险既定事项重复确认；仍需把不可逆数据变更、权限扩大、外部发送和发布留给各自的显式授权与硬门禁。
5. 进入生成或编码前，按实际业务职责、变化原因和现有调用链确定每项逻辑的 owner、直接 consumer 与模块依赖方向；已有大类不能默认成为新功能入口。普通风格建议不覆盖用户或本任务要求的职责/结构整改。后端读取 `forge-backend-architecture` 的职责与关键代码边界：业务运行合同不得依赖 generator 内部实现；应用服务承担协调与事务，Controller 只处理协议；需要拆分时按职责和稳定协议设计，不预设 CommonUtils、机械拆文件或新增一套框架。

涉及低代码运行能力时，设计直接采用 `forge-backend-architecture` 的“低代码运行 API 与生成代码”映射，并读取当前项目实际 API 源码和消费模块 POM。区分公共接口、兼容桥与仍需迁移的旧调用；旧业务样例只证明相应业务行为，不自动成为新代码的依赖规范。基线缺少所需 API 时反馈精确的公共基线缺口，不编造类型、不复制 generator 实现，也不把当前客户候选 helper 宣称为已发布公共能力。

同时区分生成业务消费的合同与公共运行模块的内部装配边界：配置/数据源/公式/编号适配器已经存在时直接复用，不为每个业务新建端口实现。设计说明按真实 Maven 归属列直接依赖，不能把保留的旧包名当成 generator 依赖依据，也不能通过重新注入设计服务、回调主服务或运行模块反向依赖来恢复旧耦合。

## 形成跨层变更合同

生成前必须区分公共能力与具体业务实现，确认模块、类、方法及直接消费者的单向调用关系。公共方法不得包含客户专用分支或业务方法，方法不得循环依赖；发现反向调用或相互回调时，先调整职责及窄契约，不能靠改包名、静态查找或延迟注入通过设计。

先定义可观察的业务结果，再选择实现。至少核对适用的层：

- 角色、租户、数据归属、状态机、事务、幂等、并发和计算规则；
- 页面、菜单、按钮、PC/H5 行为、API/DTO/错误合同；
- 表、索引、字典、Flyway 向前迁移和存量数据兼容；
- 导入、模板、校验、错误回执、导出和打印；
- 审计、敏感数据、可观测性、兼容性、回退与发布后业务验收。

不存在的层标为 `not_applicable` 并说明依据，不为清单完整度制造组件。共享 DTO、迁移版本、权限资源、字典 key、流程 key 和公共 UI owner 必须有唯一责任方。

把待定事项分成三类：

- **业务决定**：可见流程、字段含义、角色、状态规则、文案和验收结果；给出推荐、替代方案、影响与回退性，请产品负责人只确认这些事项。
- **技术决定**：模型边界、事务、索引、DTO、组件 owner、测试和迁移实现；优先依据当前源码、架构和确定性门禁，重大分歧交技术复核。
- **平台阻塞**：项目身份、TaskSpace、检查器、Broker、Runner 或运行契约缺失；如实报告能力缺口，不让产品人员执行服务器命令，也不以提示词冒充平台已经支持。

涉及认证/租户/数据权限、破坏性数据变化、共享合同不兼容、外部系统副作用、生产数据或安全策略时标为高风险。必须包含负向用例、失败关闭、恢复路径和人工决定；无法形成可验证安全路径时停止设计结论，不给“先做再看”的默认授权。

正式产出或复核变更包时读取 [references/change-design-contract.md](references/change-design-contract.md)，使用稳定条目 ID，形成范围、跨层合同、决定、依赖、验证和停止条件。工作拆分按可独立验收结果与 artifact owner，不按“前端/后端各写一点”的模糊角色分配。设计必须列出将运行的 `forge-governance` 完整变更审计、编译/迁移/权限/浏览器等运行证据；静态规则未覆盖的表类别、永久唯一性、事务幂等、跨租户和公共 owner 决定必须保留独立语义复核，不能由设计者自批例外。

## Operator-only/reference-only 本地 CAS 状态

`OPERATOR_ONLY_REFERENCE_V1`：标准模型运行面不探测、不调用 `forge-delivery`，也不以任意 shell 判断它是否可用。只有平台/operator 通过独立授权的类型化动作返回成功 receipt，且精确项目已安全登记本地状态目录为 Git ignore 时，设计报告才可引用该状态；否则一律标记 `guidance_only`。平台返回 `DELIVERY_STATE_NOT_IGNORED` 时将其作为模板阻塞报告，不为当前业务任务临时修改 ignore 规则。

`OPERATOR_ONLY_REFERENCE_V1`：供平台/operator 使用的状态请求必须绑定当前合同的稳定 `changeId`、objective、幂等键和刚读取的 expected version；恢复时遵循 status → conditional init → status → CAS transition 的顺序。模型只能核对已返回 receipt 的这些字段，不能复制示例 ID、推算 version、发起 CLI 调用或直接修改状态 JSON。遇到 `VERSION_CONFLICT`、非法转换、完整性失败或其他错误时保留 blocker，不声称进入 `designed`。

CLI 缺失、版本不支持或状态写入失败时继续产出设计，但标记 `guidance_only` 与准确错误；不得手写状态文件、声称已进入 `designed`，也不得把 `designed` 解释成已经实现或验证。

## Skill 与硬门禁的边界

- 除上述本地 CAS 记录外，本 Skill 只能指导模型形成合同、发现冲突和选择停止点；它不能锁定路径、证明测试、执行迁移或批准发布。
- 只有实际存在且返回成功回执的类型化协调工具、检查器、Git、TaskSpace Broker 和 Release Runner 才能提供相应硬约束。`OPERATOR_ONLY_REFERENCE_V1`：`forge-delivery` 的 change 状态只证明合法顺序、CAS 与记录完整性，不证明各阶段工作真实完成，也不是模型执行入口。
- 检查器或契约测试尚未实现时，结论写明 `guidance_only` 或 `hard_gate_unavailable`，并保留人工复核项；设计清单不能冒充机器放行。
- `designed`、`implemented`、`verified`、`committed`、`released`、`accepted` 是不同事实，任何阶段不能代表后续阶段。

## 输出

输出一份精简的变更包摘要：目标与非目标、基线和权威输入、业务结果、跨层影响、关键决定、风险与回退、工作依赖、验证矩阵、未决项和停止条件。明确本轮是否只做设计，以及是否存在尚未由硬门禁执行的项目。
