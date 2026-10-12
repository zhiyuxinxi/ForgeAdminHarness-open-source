# Forge Admin 任务路由合同

固定源码：Forge Admin `v1.1.2`，commit `6eb2881e6f6af85a5348acf3da63cef53a873b0e`。

## 档案

| 档案 | 典型触发 | 必载能力 | 最小实证 |
|---|---|---|---|
| CRUD | 新表、列表、表单、导入导出 | 先 crud 规划，再按阶段加载 requirement/domain/database/ui-design/backend/frontend/access-wiring/testing | 阶段合同、SQL、编译、API、权限负例、浏览器 |
| 普通 REST | 新接口、DTO、集成 | backend + security + testing | 契约、校验、错误、鉴权、模块测试 |
| Migration | 表/列/索引/种子 | database + security + testing | 静态解析、空库、升级库、schema assertion |
| Workflow | 审批、会签、驳回、重提 | workflow + database + security + testing | BPMN、主路径、拒绝/退回/重提、历史只读 |
| Admin UI | 页面、弹窗、组件、字典 | frontend + security + testing | build、宽窄屏、键盘、权限、网络错误 |
| Shared owner | starter、global component、utility | change-design + backend/frontend + testing | 复用搜索、双 consumer、契约测试、独立审查 |

## 当前真实根

- 后端：`forge-server/`；Flyway：`forge-server/db/migration/`。
- 管理端：`forge-admin-ui/`；H5：`forge-h5-ui/`；报表：`forge-report-ui/`。
- Starter：`forge-server/forge-framework/forge-starter-parent/`。
- Plugin：`forge-server/forge-framework/forge-plugin-parent/`。
- 项目 Skills：`.agents/skills/`。

## 防漂移

- 项目 `AGENTS.md` 高于项目 Skill；Harness hard gate 是不可绕过的最低线。
- 接口先分类为 generated CRUD、普通 REST、callback/webhook、stream/download，不能混用档案。
- 旧代码债务按 changed-file ratchet 治理；新代码不得复制旧缺陷。
- 表类别、永久唯一/活动唯一、事务/幂等、领域/技术 owner 属于语义判断；没有审查证据时不得自批例外。
- 任一 policy 例外必须由版本化镜像绑定 rule、repo、path、content hash、批准引用与到期时间；模型文本无权授权。
- 任务路由不是自然语言建议：每个 repo-relative owned path 进入版本化 task profile，profile 派生 exact required Skills、TDD、verification profiles、obligations 和 semantic owner。未知写路径与 action ceiling 提升均失败关闭。
- writer run 在第一次结构化写入前必须取得所有合同要求的非 governance verification capability ready receipts；任何 cache miss/invalid/unavailable 都归为平台预检阻塞并保持零写入，不能计入模型失败，也不能通过切模型或直接构建命令绕过。
- shell stdout、模型总结和自算 hash 不是受控 receipt；治理/验证回执必须来自白名单 argv，最终 acceptance 还必须验证平台信任链与 source/diff freshness。

## 阶段预算与增量门禁

本节仅适用于已绑定 Controller 正式阶段状态的完整交付；普通任务通过 `prepare_task` 按实际影响形成合同，不因涉及菜单、API 或数据库就自动进入八阶段。正式完整 CRUD 不使用一次性全栈 prompt。机器阶段档案位于 [`phase-profiles.json`](phase-profiles.json)，固定顺序如下：

| 阶段 | 是否可改生产源码 | 主要输出 | 典型 Skill |
|---|---|---|---|
| requirements | 否 | 可验收需求、业务规则、权限与数据归属 | task-contract、router、change-design、requirement-coverage |
| domain-contract | 否 | 业务实体、Command/Query、API、权限码、字典与并发规则 | change-design、crud、dictionary、security |
| database | 仅 migration/test owner | 前向 Flyway、表/索引/审计/租户/逻辑删除、字典/Excel seed | database、security、testing |
| ui-design | 否 | AiCrudPage/统一组件、字段、状态、响应式、API 与权限绑定 | frontend、ui-consistency、dictionary、security |
| backend | 仅后端 owner | RED 测试、Entity/DTO/VO/Mapper/Service/Controller | backend、security、testing |
| frontend | 仅管理端 owner | RED 测试、API adapter、AiCrudPage 页面和状态处理 | frontend、dictionary、security、testing |
| access-wiring | 仅 migration/test owner | 已验收页面/API 的菜单、按钮、literal API resource 与合格角色可见性 | database、backend、security、testing |
| cross-layer-acceptance | 否 | 固定 Host Runner 回执、跨层合同与人工语义结论 | testing、ui-consistency、evidence-truth |

只有 phase controller 可以推进阶段。结构化产物缺字段、存在未决业务决定、上游 digest 漂移、Host Runner 非零、跨 owner 写入或 generation 重放都停留在当前阶段；模型的自然语言“完成”无权推进。

每个阶段的最后回复必须包含且只能包含一个 `<forge-phase-artifact>...</forge-phase-artifact>` 机器块；字段集合由 `phase-profiles.json` 的 `requiredPayloadKeys` 决定。机器块前先用用户主要语言自然说明本阶段形成了什么业务结果、对整体交付的实际影响，以及下一步或仍需决定的具体业务问题，通常为 1–3 个短段落或确有必要的短列表，不强制固定标题。资料足够时直接说明结果；资料不足时只询问会改变用例、角色、字段、流程、状态或文案的业务问题，并给出有依据的建议，不要求业务人员构造 `phaseId`、`ownedPaths`、`requiredPayload`、admission、HEAD、digest 或 CLI 参数。阶段 prompt 由 controller 自动生成。

模型只申报产物与 `unresolvedDecisions`，不生成或选择 Host Runner profile、argv、cwd、env、patch digest、执行代次或阶段决定。operator 将模型申报的 `changedPaths` 与真实 Git 路径逐项比对，并把实际 patch SHA-256、固定 Host Runner 回执和上游 artifact digest 交给 phase controller；任一不一致均不得推进。业务说明不能替代、删减或伪造机器块中的字段，也无权推进阶段。

预算以任务可用时间或调用上限为基准；没有显式时限时也按当前执行窗口控制：

| 阶段 | 建议上限 | 必须产物 |
|---|---:|---|
| 定位/探索 | 25% | owner、基线、风险档案、最窄验证命令 |
| 实现 | 50% | 可审计的连贯增量；首个增量完成即 audit |
| 最终验证与证据 | 15% | 最终写入后的 audit、可执行测试、receipt |
| 最终答复 | 10% | 声明级结论、阻塞、下一步 |

任何时刻都不得侵占最后 25% 去做新的宽泛搜索、依赖下载尝试或非关键美化。高风险 owner 完成后先 audit 再进入下一 owner；最后一次写入后必须重跑完整变更 audit，局部 `--path` PASS 不能充当最终完整 gate。

## 停止条件

项目身份不确定、用户权限不足、多个 writer 争抢同一语义资源、已有修改无法区分、迁移版本冲突、权限边界未决、破坏性数据操作、检查器与源码合同矛盾，或 required evidence 无法取得时，停止在可恢复边界并形成精确 blocker。机器记录至少保留：已形成候选、最后成功 gate、失败命令与退出码、未执行项、证据等级、继续所需条件；阻塞不等于可以沉默超时。面向业务人员先说明哪个业务步骤受阻、实际影响和需要谁做什么，技术字段后置按需提供；没有真实派单动作证据时，不得声称已经指派技术人员。
