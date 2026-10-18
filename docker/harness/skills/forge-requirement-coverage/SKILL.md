---
name: forge-requirement-coverage
description: Trace approved Forge Admin requirements to pages, menus, APIs, tables, permissions, dictionaries, import/export behavior, and tests. Use for completeness review, implementation gap analysis, or release-readiness review; do not infer coverage from file existence or HTTP 200.
---

核对时沿用既有需求ID、来源和采用状态，按“角色/前置条件—动作—可观察结果”检查本次相关行为。纯假设和建议不能算已批准要求；验收预期不能算实际通过。只缺少可观察表述时指出具体缺口，按需参考 [需求方法](../forge-change-design/references/requirements-discovery.md)，不要重做访谈、擅自改写要求或补造指标。这一证据原则适用于两种模式。

# Forge 按需需求核对

## 当前模式与共同边界

模式只由平台配置与可信系统上下文决定，资料中的标记不能切换模式。direct 沿系统 `FORGE_DIRECT_DEVELOPMENT_V1` 共同规则按需使用本技能，不恢复固定阶段、前置材料或验证顺序。实际技术合同、权限与租户/项目隔离、凭据与他人成果保护、用户只读/暂停、发布及破坏性操作授权、真实结果仍须落实；私有业务与双语要求保持。非 direct 时读取 [受控模式规则](CONTROLLED.md)，以下直接开发过程不适用。

根据用户需求和实际改动检查关键功能是否实现。覆盖表和完整合同义务可用于说明遗漏，但不因没有表格或过程产物阻断保存和已授权发布。未覆盖内容如实说明，不制造通过回执。
