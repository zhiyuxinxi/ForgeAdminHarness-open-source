---
name: forge-evidence-truth
description: Audit evidence behind a claimed Forge Admin implementation, verification, migration, Git checkpoint, release, runtime version, or handoff. Use when completion proof is requested, evidence conflicts, or a delivery claim needs validation; do not trigger for exploratory analysis that makes no delivery claim.
---

# Forge Admin 证据真实性

Policy marker: `FORGE_EVIDENCE_TRUTH_V1`.

当前普通开发以用户目标推进：以下参考中的强制 Skill/TDD 顺序、固定阶段比例、反复独审和强制收尾已暂停；组件、样式与架构偏好只作建议。允许先保存修复草稿，再做受影响验证。真实权限、租户、数据完整性、秘密和危险操作授权继续保留；合入与发布须取得实际构建、必要启动、功能测试及源码绑定证据。不要把这段解释成已通过任何验证。

本 Skill 检查“实际发生了什么”是否支持“准备声称什么”。它不因审计而获得修复、重跑有副作用操作、提交、连接服务器、发布或补写历史证据的权限。

本 Skill 可以在路由阶段提前加载以了解证据规则，但提前加载不是完成确认，也不会关闭尚未开始的任务。以实际候选和机器结果核对声明，不要求靠再次调用 Skill 才能结束轮次。

## 从声明开始，不从报告开始

1. 加载 `forge-task-contract`，固定项目、任务、基线、审计范围和允许动作。审计发布或运行态时同时读取当前运行契约和对应的 Broker/Runner 结构化结果；历史聊天、README 和源代码版本号不能替代运行证据。
2. 把每个结论拆成单一声明，例如“候选代码已实现”“指定测试在 commit X 通过”“迁移在登记 `_test` schema 通过”“镜像 digest Y 已部署”“角色 Z 完成业务验收”。不要用一个“完成”混合多个阶段。
3. 复杂交付、证据冲突或正式 handoff 时读取 [references/evidence-ledger.md](references/evidence-ledger.md)，为每条声明记录对象、版本、证据来源、观察时间、结果和缺口。
4. 优先读取机器权威与直接观察：Git 对象、命令退出状态、检查器结果、Broker/Runner receipt、镜像 digest、运行契约、真实 API/浏览器结果。模型总结、手写日志、计划表、文件名和状态字段只作待核对叙述。

## 不得混淆的事实

- 写出命令、计划运行、创建报告文件或 Agent 声称成功，都不等于命令实际成功。
- 源码存在 Skill 不等于 catalog 已登记、镜像已构建、运行容器已升级、当前会话已发现或实际调用。
- 本地改动不等于已实现候选；本地 commit 不等于已推送、异机备份、集成、发布或验收。
- 单元/静态检查不等于完整构建；测试退出 0 不证明测试覆盖了声明中的业务结果。
- `_test` 迁移不等于主库迁移；候选迁移通过不等于应用发布成功。
- 容器 running/healthy、端口可达或 HTTP 200 不等于业务菜单、CRUD、状态、权限和导入导出验收通过。
- 执行过回退命令不等于旧版本恢复健康；必须有回退后验证。
- 第二模型不可用、未收到输出或只是同一 Agent 改名时，不得声称独立复审。
- 用户在对话中授权不等于模型可以制造 Gateway/Broker/Runner 的机器授权 receipt；特权动作仍以真实受控边界校验为准。

## 核对对象一致性

证据必须绑定同一个 project、task/TaskSpace、base/candidate commit、服务、环境和时间窗口。尤其核对：

- 测试是否在最终候选 commit 和正确工作目录执行，之后源码是否漂移；
- Flyway 文件、候选 Admin 镜像、`_test` 迁移结果和 Runner candidate 是否一致；
- 发布 jobId、candidate commit、镜像 digest、服务清单、运行契约和当前运行对象是否一致；
- 浏览器/API 验收是否命中批准 URL、运行版本、角色、租户和本轮测试数据；
- Skill bundle 的源码候选、catalog bundleVersion、镜像 label/digest、容器运行版本和会话加载证据是否分别存在。

发现对象不一致时标为 `contradicted` 或拆成不同声明，不用较新的文档覆盖较旧的运行事实。基线已存在的失败与本轮引入的失败分开记录；没有可复现基线时标为 `unverified_baseline`，不得随意归责。

判断历史测试失败时，同时核对基线断言与其实际被测代码；仅测试文件未修改不足以证明无关。若旧断言与未变的基线表达式已明确失配，可记录这份静态基线证据，不为归责重复运行整套历史测试。原失败 receipt、总通过/失败数量及缺口必须保留，新增定向测试通过不能把整批失败改为通过。直接阻断当前验收的过时断言，由原 Harness 经必要范围续接做最小修复，保留业务行为要求，只验证相关测试。

最后一次源码、测试、依赖锁或相关配置写入前的 PASS 保留为历史通过，不得直接声称当前候选已验证。平台通过 `forge-verify run ... --reuse-receipt <原receiptId>` 正式接纳的当前合同复核可以延用原执行；复核不是重跑，必须保留原执行来源和当前绑定。其余受修改影响或复核明确失效的检查，才按当前范围补做。后端回执可复用不代表旧治理或前端回执有效，不能在真实源码变化使治理失效后盲用旧治理回执。读取 `receipt` 或调用独立语义 `review` 均不能代替正式复核；进入本 Skill 后再次写入时，按实际影响重新核对这些绑定，不自动重跑全部检查。

## 收集与结论边界

- 只读审计优先使用不会改变状态的查询。构建、测试数据、迁移、提交、发布、服务器查询或外部系统访问需要当前任务相应授权；不能为了补齐漂亮报告扩大动作范围。
- 可重复执行且在当前测试授权内的检查可以重新运行，并记录新证据时间；不可重复、特权或有副作用的操作只能读取既有受控 receipt，缺失时明确缺证据。
- 日志和回执必须脱敏；不读取、输出或持久化 Token、Cookie、Deploy Key、模型 Key、数据库凭据或完整客户数据。哈希用于完整性关联，不把秘密内容先输出再哈希。
- 如果存在版本化证据检查器，使用它的固定输入、退出状态和版本；检查器不存在时标记 `manual_evidence_review`。Skill 清单和人工矩阵不能冒充机器放行器。
- 只有用户授权持久化时才把审计结果写入项目证据文件；不得补造过去的命令输出、时间、操作者、用户决定或 receipt。

## 自述证据记录器的准确语义

镜像内置 `forge-governance audit` 与本地自述记录的证据语义不同。`OPERATOR_ONLY_REFERENCE_V1`：`forge-delivery` 只可能由平台/operator 的独立授权动作产生 derived receipt，不是标准模型运行面的命令。审计 receipt 只有同时满足 `scope.completeChange=true`、`ok=true`、目标 repository/base/head 与当前候选一致、policy/source baseline 符合当前 catalog，且没有未复核的 applied exception，才能证明“该候选已执行并通过这版确定性静态规则”。其中 `executionProven=true` 只证明检查器真实运行；`runtimeBehaviorProven=false`、`semanticReviewProven=false` 必须保留。局部 `--path` receipt、过期/错项目/错内容 hash 的例外、模型自写 ignore、静态 PASS 后继续改文件，均不能作为完整 gate。

`forge-verify` 是 TaskSpace Broker 绑定身份后的受控执行回执，不是自述记录。核对其 `receiptType=forge-verify/run`、project/task、source HEAD/workspace/dependency fingerprint、profile/selectors、不可变 toolchain image、cache pack digest、每步 argv/exit/timeout、test count、`freshness=current` 和最终候选一致。`verificationProven=true` 只覆盖该固定 profile；Runner 强制保留 `semanticCorrectnessProven=false`、`databaseIntegrationProven=false`、`releaseProven=false`。`cache_miss`/`cache_invalid` capability receipt 证明环境能力未准备好，不证明源码失败，也不允许模型绕过 Runner 访问网络。

`appliedExceptions` 非空时逐项核对外部版本化 policy 中的 rule、project、精确 path、content hash、approvalRef、owner、reason 与 expiresAt；模型、源码注释、项目文件或聊天不能新增/延长例外。静态 receipt 不能替代编译、Flyway 实跑、权限/租户负例、浏览器、并发、可观测性、独立 review、Git、镜像或发布证据。

`OPERATOR_ONLY_REFERENCE_V1`：只有项目模板已安全登记本地状态目录为 ignored、change 已由平台合法推进到 `verifying`，且实际检查另行执行并生成非空脱敏日志后，operator 才能通过独立类型化动作记录自述元数据。标准模型不调用 `forge-delivery`，只核对平台返回的 record/check/evidence receipt 是否绑定当前 change、verification ID、真实 argv、exit code、当前 commit、仓库相对日志 hash、expected version 与幂等键；未提供这类 receipt 时保持 `not_recorded`，不得复制示例或手写状态制造证据。

必须解析平台返回的 JSON receipt，而不是只看状态文字或退出码：

- `recordedExitCodeZero=true` 仅表示调用者记录了 0；
- `recordIntegrityValid=true` 仅表示 record 完整、当前 commit 与日志未漂移；
- `proofType=self-recorded-artifact-integrity-only` 和 `authority=self-recorded-local` 表明证据仍是自述；
- `executionProven=false`、`verificationProven=false` 必须原样保留；`releaseProven=false`、`deploymentProven=false` 也不得省略；
- `consumedByEvidenceRecordedTransition=true` 只表示该 record 被最终状态引用。

任一 check/evidence 操作失败、记录 exit code 非零、commit/log 漂移或 change version 不符时，不得转换到 `evidence-recorded`。禁止直接编辑 record、重写日志后沿用旧 ID，或把自然语言 statement 当 evidence。

真实测试/CI 的受控执行回执、Git 对象、Broker/Runner 结果、镜像 digest 和浏览器/API 观察仍需分别核对。它们可以让声明达到 `proven`，但不会改变 CLI 自述 record 的 authority，也不能把 change 状态改名为 `verified`。

每条声明只能标为 `proven`、`supported_with_gaps`、`unverified`、`contradicted` 或 `not_applicable`。`evidence-recorded` 不是这里的声明结论。任一关键声明 `contradicted`，或发布/权限/迁移关键证据 `unverified` 时，不得给整体“完成/可发布/已发布/已验收”结论。

超时、依赖不可用或必需检查失败也必须产出结论。证据记录至少保留：最终 candidate/HEAD/diff、已实现范围、最后一次 audit、每条测试命令及退出码/未执行原因、声明等级、未证实风险、可恢复边界和最小下一步。默认用户回复可汇总相关检查结果，只展示与本次业务结论有关的失败或未执行项；精确命令、哈希、ID、`proven` 等等级放在内部记录或按需技术凭据中。禁止以继续扫描、反复重试或没有最终答复来代替 `blocked` 收尾。

## 输出

面向用户默认使用其主要语言，以 1–3 个简短段落或确有必要的短列表，先给具体业务结论、当前影响和最小下一步，不强制固定标题或逐条免责声明。机器记录继续保留直接证据、缺口/矛盾、精确命令与退出状态和声明等级；用户要求、技术排障或正式交接时再提供后置技术凭据。

结论语义不得改变：设计合同不等于代码实现，未运行或失败的检查不能说通过；本地源码候选、已验证候选、已提交候选、已打包能力、已部署运行态和已完成业务验收必须明确区分。`READY` 只说明当前合同要求的代码检查已满足，不能翻译成已发布；`cannotClaim` 和缺口只按与本次结论的关联展示，不能删除、改写或隐藏会改变结论的项。
