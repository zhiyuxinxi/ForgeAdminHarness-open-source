# Forge Admin 变更设计合同

在正式设计、多人交接或高风险复核时使用本合同。它是结构化交付物，不是平台权威状态；除非用户授权写入项目文档，否则只在当前响应中维护。

## 1. 身份与范围

| 字段 | 内容 |
|---|---|
| Change ID | 当前任务内稳定 ID |
| Project / TaskSpace | 精确项目；有工作舱时记录 TaskSpace ID |
| Base | 分支与完整 Git commit；工作区状态 |
| Objective | 一个可验收业务结果 |
| Authority | 已批准需求、用户决定、当前源码/合同 |
| References | 原型、截图、旧系统或相似实现，明确非权威 |
| In scope / Out of scope | 本次包含与明确排除 |
| Allowed actions | 只读、设计、实现、测试、提交、发布分别列明 |
| Stop conditions | 冲突、缺证据、越权或不可逆风险的停止点 |

`OPERATOR_ONLY_REFERENCE_V1`：只有平台/operator 通过独立授权的 `forge-delivery` 类型化动作返回成功 receipt 时，设计文档才记录 `changeId`、当前 `state/version` 与该回执；标准模型不探测或调用该 CLI。未提供回执时写 `guidance_only`，不能手工补状态。本地状态目录必须先由受审项目模板登记为 ignored，不能为单个业务变更临时放宽仓库规则。

## 2. 可验收业务结果

给每项分配 `AC-<n>`：

| ID | Actor / precondition | Action | Observable result | Negative result | Evidence |
|---|---|---|---|---|---|

避免“完成页面”“接口正常”等不可判断措辞。金额、状态、权限、数据归属和副作用必须能由测试或业务验收观察。

功能与独立要求分别保留身份：功能说明目标、边界和可观察结果，独立要求描述能够单独判断是否满足的约束，两者可多对多。字段规则、菜单或文档章节不能按行计为功能。按[过程产物约定](../../forge-task-contract/references/delivery-center-artifacts.md)在本次已授权的既有产物中同步保留已经形成或使用的正文、`deliveryCenter` 身份、菜单/功能引用及真实来源。协议可选只为兼容旧产物，不表示本次已知内容可以省略；有来源的采用、撤回和替代分别引用具体修订，不增加人工登记表，也不为填表编造或扩大写入范围。

## 3. 跨层合同

只保留适用行，非适用项说明依据：

| Contract ID | Domain rule | API / DTO | Data / migration | Permission / tenant | UI / H5 | Import/export | Audit | Compatibility |
|---|---|---|---|---|---|---|---|---|

对每个共享资源记录唯一 owner：表/列、Flyway 版本、API 路径、DTO、permission、dict type/value、workflow key、公共组件和导入导出配置 key。owner 不清时不能分配并行 writer。

跨层定义沿用已有对象身份，关系记录双方修订、条件及来源；未明确的引用保持未知，不自动指向最新版。页面、接口、表、流程继续消费这套实际业务定义：将本次实际形成或使用的字段及校验、操作、接口调用、业务属性与保存字段映射留在各自正文，不能只保留文件名、数量或完成说明。菜单和功能引用可单向记录一次供平台反查，不要求两端手抄；后续 AI 读取已有定义和具体修订继续，未变化的上游只引用，不重新生成。不能另写与生成依据无关联的展示说明；修正上游不自动代表下游已更新。

## 4. 风险与决定

风险不是按文件数量计算。出现下列任一信号时提升风险：认证或租户、服务端权限、生产/客户数据、非兼容 API、状态机/事务/幂等、Flyway 或存量数据、外部消息/支付/文件、副作用重试、安全策略、Secrets、发布或回退困难。

| Decision ID | Type (`business`/`technical`/`platform`) | Options and trade-off | Recommendation | Owner | Required before | Status |
|---|---|---|---|---|---|---|

高风险条目必须补充：失败关闭行为、负向用例、恢复/补偿路径、可观察信号和明确责任人。

## 5. 工作依赖与责任

| Work ID | Outcome | Depends on | Owned paths | Owned semantic resources | Allowed actions | Deliverable | Verification | Stop condition |
|---|---|---|---|---|---|---|---|---|

先完成并冻结共享合同，再并行实现。多个 writer 不得同时拥有同一路径或语义资源；读者/复核者可以重叠，但不能顺手修复。

## 6. 验证与回退

| AC / Contract ID | Static check | Unit/contract test | `_test` migration | Permission negative | Browser/API UAT | Required receipt |
|---|---|---|---|---|---|---|

分别定义代码回退、数据兼容/补偿、运行版本回退和测试数据清理。主库破坏性恢复、基础设施创建和生产数据修复不属于普通实施或发布授权。

## 7. 设计结论

结论只说明设计是否足以进入当前已授权动作：

- `ready_for_implementation`
- `ready_with_explicit_decisions`
- `blocked_by_authority`
- `blocked_by_platform`
- `blocked_by_safety`

该结论不等于实现、验证、提交、发布或业务验收已经完成。

设计结论为 `ready_for_implementation` 时，允许把 CLI change 从 `scoped` CAS 转到 `designed`。状态转换只记录设计阶段已被协调者声明完成；设计正文、决定和验收合同仍需单独审查，状态文件不能替代它们。
