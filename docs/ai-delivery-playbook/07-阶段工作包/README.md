# 八阶段 Markdown 工作包使用手册

本目录不是新建一套平行制度，而是把现有模板元数据、S0-S5 证据分级、阶段门禁和黄金配方接入 Harness 的固定八阶段运行时。目标是让同事每次只拿一张阶段卡和必要资料与 AI 交互，同时得到可检查、可维护、可归档、可准备为 Memory candidate 的过程卷宗。

## 一次只使用一张卡

| 顺序 | 阶段 | 固定交互卡 | 主要结果 |
|---:|---|---|---|
| 1 | requirements | [`requirements.md`](../../../docker/harness/skills/forge-phase-work-package/assets/requirements.md) | 需求、边界、验收、数据归属、权限矩阵 |
| 2 | domain-contract | [`domain-contract.md`](../../../docker/harness/skills/forge-phase-work-package/assets/domain-contract.md) | 实体、命令/查询、API、权限、字典、校验、并发合同 |
| 3 | database | [`database.md`](../../../docker/harness/skills/forge-phase-work-package/assets/database.md) | Flyway、表/索引、租户、审计、逻辑删除、字典/Excel seed |
| 4 | ui-design | [`ui-design.md`](../../../docker/harness/skills/forge-phase-work-package/assets/ui-design.md) | 页面模式、全局组件、状态、响应式、可访问性、绑定 |
| 5 | backend | [`backend.md`](../../../docker/harness/skills/forge-phase-work-package/assets/backend.md) | RED 测试、分层实现、分页、权限、异常、事务/并发 |
| 6 | frontend | [`frontend.md`](../../../docker/harness/skills/forge-phase-work-package/assets/frontend.md) | RED 测试、统一组件/API、Long ID、交互状态、可访问性 |
| 7 | access-wiring | [`access-wiring.md`](../../../docker/harness/skills/forge-phase-work-package/assets/access-wiring.md) | 已验收页面/API 的菜单、按钮、API resource 与角色接线 |
| 8 | cross-layer-acceptance | [`cross-layer-acceptance.md`](../../../docker/harness/skills/forge-phase-work-package/assets/cross-layer-acceptance.md) | 跨层一致性、机器/人工证据和 cannot-claim |

不要把八张卡一次上传给模型。Harness 的 phase controller 固定顺序，每次只注入当前阶段的最小 Skills、上游内容摘要、owner、路径和验证 profile；模型不能跳过、重排或自行推进阶段。

## 每阶段自动归档什么

Controller 接受或阻塞一个 attempt 时，都会在该 attempt 的 run-owned evidence 目录生成：

1. `00-input.md`：来源摘要、上游摘要、授权和同事检查项；
2. `01-result.md`：内容寻址 JSON artifact 的人类投影；
3. `02-process.md`：可观察动作、决定、纠偏和本阶段最佳实践；
4. `03-verification.md`：预期/实际受控回执、失败与不可扩大声明；
5. `04-handoff.md`：下一阶段、携带物、blocker 和归档规则；
6. `05-memory-candidate.md`：候选正文、来源、范围、不确定性、冲突与晋升状态；
7. `manifest.json`：规范版本、阶段身份、artifact/receipt 摘要、文件 bytes/SHA-256 和封存状态。

机器 JSON/receipt 是事实源，Markdown 是可维护的人类投影。两者冲突时，不能编辑 Markdown“修好”；应创建新 attempt，重新生成完整工作包并保留失败历史。

## Memory 与验证边界

`05-memory-candidate.md` 默认 `draft-review-required`，不会自动写入 MCP Memory。只有确实跨任务稳定、证据充分，并且 owner 明确审核指定候选后，才允许通过独立受控流程晋升。

AI 可以填写说明和建议，不能自行宣告验证通过。验证状态只由 controller、Broker/Runner 回执和独立人工语义复核支持；未运行、失败、过期和 cannot-claim 必须保留。

## 归档与维护

- 工作包只存仓库相对路径或稳定逻辑标识，不保存宿主绝对路径、Secret 或生产数据。
- `manifest.json` 的文件集合和 SHA-256 是硬门禁；缺失、额外、符号链接或漂移都会拒绝。
- 模板语义变化时提升 Skill bundle/work-package 版本，并同时更新阶段合同、触发 eval、Runtime Lock 和回归证据。
- 失败工作包也是重要资产，不删除、不覆盖；下一次修订使用新 attempt。
