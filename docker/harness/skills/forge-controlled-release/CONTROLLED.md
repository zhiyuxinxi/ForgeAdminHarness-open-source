---
name: forge-controlled-release
description: Publish the current Forge Admin project through its project-scoped controlled release runner. Use whenever the user says 发版, 发布, 部署, 重启应用, 上线, or asks to validate a release. Never use a workspace Compose file or install infrastructure.
---

# Forge Admin 受控发布

候选保存/集成后，已配置输入定义的项目使用 `forge-release plan` 计算各服务相对自身成功发布基线的差异。按照 `selectedServices` 选择发布服务，结合已有回执只补 `checks` 对应的受影响验证；现有合同仍要求的未变检查通过受保护输入证明复用，不重跑。计划不构建、不部署，也不产生权限。缺失基线、未知依赖或同制品含其他任务改动以工具返回的具体原因处理，不默认全发。`releaseApplied=false/outcome=unchanged` 表示本次无需部署，不报告成新版本上线；`not-configured` 表示项目仍用旧合同，不能声称已自动收缩范围。

当用户在当前项目要求“发版”、“发布”、“部署”、“上线”或“重启应用”时，这是唯一允许的发布路径。

Policy marker: `PRODUCT_OPERATOR_ESCALATION_GUARD_V1`.

## 意图与只读边界

Policy marker: `READ_ONLY_INSPECTION_GUARD_V1`.

- 业务启动和运行日志通过 `forge-release logs --services forge-admin --tail 200` 只读查询；按实际业务服务选择，省略 `--services` 查询本项目业务服务，可加 `--since 30m`。当前项目所有有效工作舱均可读取，无需曾发起发布、候选干净或发布授权；不触发 prepare、checkpoint、测试或发布。报告真实错误、时间和截断，不让业务用户自行取服务器日志；项目隔离和秘密脱敏保持。
- 用户只要求“检查”、“核对”、“评审”、“预检”或明确声明“只读”时，只能读取 Skill/契约并执行 `forge-release contract`、`forge-release capability`、`forge-release preflight` 等只读命令；不得编辑文件、格式化代码、生成迁移、提交、发布或更新长期记忆。
- 只读检查发现问题时，报告准确文件、规则和可执行修复建议后停止。不得把“给出改写方案”解释成“已经获得修改授权”。
- 只有用户明确要求修复、实现或继续交付时，才允许修改当前项目代码；只有用户明确要求发版/发布/部署/上线时，才允许提交并执行 `forge-release release`。
- 只要本轮发生过任何文件写入、提交或发布，最终报告就不得声称“全程只读”；必须如实列出写入和验证结果。
- “部署”只表示发布当前项目已经批准的代码版本，不表示重新安装 Forge、创建工作空间、初始化数据库/缓存或替换平台环境。无法识别当前项目或 Runner 契约时必须失败关闭。

普通对话未进入固定交付 workflow 时，若当前仍是只读任务准备合同且 `prepare_task` 可用，先 `prepare_task inspect`，按需有界读取真实相关文件，再 `prepare_task propose` 提交精确范围；显式只读请求不得借此提出写入范围。`prepared` 的实际权限上限由真实用户请求和当前账号权限共同决定，可能为 `workspace-write`、`git-checkpoint` 或 `release`，不能只凭状态名称推断。用户已明确授权发布当前范围、平台也已签发相应合同的，沿该合同继续，不要求用户重复确认；只有缺少必要授权时才说明准确缺口。模型必须取得实际发布合同和必需验收，不得自行提权、替用户确认或承诺一定放行。固定交付 workflow 仍遵循原阶段授权，不能套用普通对话准备路径。

1. 若存在 `FORGE_TASKSPACE_ID`，先加载 `forge-taskspace-collaboration`；当前 TaskSpace 状态是唯一候选来源，`forge-release` 会自动通过 TaskSpace Broker 提交。然后执行 `forge-release contract`，确认项目 slug、共享外部 MySQL/Redis、主库、`_test` 库、Redis 运行/测试库和允许服务。运行契约比历史对话、源码 README 和示例 Compose 更权威。
2. 发布前读取一次 `forge-release status`；它已包含本次 preflight 的 TaskSpace、integration、sourceTransition 和 Runner 字段，以及实际服务状态，以下模板中的 `preflight` 指这份结果，不再紧接着调用 `forge-release preflight`。同一轮候选、canonical 和 integration 状态未变化时复用本次结果；实际编辑、checkpoint、integrate 或工具指出状态已变化/过期后，再读取一次 status。明确区分：本舱 dirty/候选验收状态、当前项目集成版本、实际项目已发布版本；不能用“本舱未发布”推断“线上还是旧版本”。工作区不干净时不能直接发布，应按后续 canonical 同步或 checkpoint 分支处理。受保护部署文件改变、共享服务不可达、出现服务端管理 SQL、删表/清表/删列等破坏性迁移或契约不匹配时，停止并报告，不得自行补建基础设施。
   `workspaceClean=false`、`includesCanonical=false` 是选择后续受控流程的输入，不能单独证明平台故障或混入他人改动。先按当前需求、已有对话和实际文件差异核对 `dirtyPaths`；文件属于后端不等于它超出原候选范围，本轮不新增后端也不自动撤销原候选授权。确认属于原任务且仍获授权的改动按第3或第6条处理；确有无关或归属不明的改动时保留原件，列出具体文件和已核对的差异，不泛泛要求平台替模型修改、隔离业务候选。不得为得到clean状态顺手纳入、删除或隐藏未知改动。
3. 先检查当前 `preflight.integration`：`phase=conflict-open` 时走第 4 条的 continue；`phase=source-saved-error` 且 `error.code=TASKSPACE_INTEGRATION_DIRTY_LIMIT` 时，在新用户业务请求已取得绑定当前保存 HEAD/fingerprint 的 release 合同后，先按第 4 条模板执行一次恢复 continue，此前不得编辑冲突文件。其他错误状态停止并报告。只有没有待续 integration 且候选未包含固定 canonical HEAD 时，加载或重新加载本 Skill 与 `forge-taskspace-collaboration`（历史 `invokedSkills` 名称不代表已读取当前契约），再严格使用以下完整 start 模板。字段只取自刚取得的只读 preflight：`--expected-head` = `preflight.taskspace.head`，`--expected-fingerprint` = `preflight.taskspace.workspaceFingerprint`，`--canonical-head` = `preflight.taskspace.canonicalHead`；对完整 `preflight.taskspace.dirtyPaths` 中每一项各重复一次 `--path`，列表为空时必须有零个 `--path`，不得发明或漏掉值。start 不得带 `--operation-id`。

   ```text
   forge-release integrate --mode start --expected-head <preflight.taskspace.head> --expected-fingerprint <preflight.taskspace.workspaceFingerprint> --canonical-head <preflight.taskspace.canonicalHead> [--path <dirtyPath-1> --path <dirtyPath-2> ...]
   ```

   Broker 会受控保存 dirty source，不能先 checkpoint 成另一份源事实。这些参数来自当前机器事实，不要求用户输入 SHA 或 CLI 参数。禁止直接执行 `git fetch`、`git rebase`、`git merge`、`git add` 或其他手工 Git 同步。
4. 若返回 `conflict-open`，读取 `operationId`、`conflictPaths` 与完整 `dirtyPaths`。保持既有 F0（`conflict-open`）→ Host-bound F1（冲突 edit 后用可信运行时自动刷新的 admission 运行本合同要求的一个 profile，优先 `governance`）→ merge F2（受控 continue）顺序。下一次正常续谈取得新 source 合同后，只 edit/write 明确冲突文件；禁止全选 ours/theirs、静默覆盖或修改无关路径。F1 的真实通过、失败或阻塞必须记录，但它不是 merge 后最终验收，也不得伪造通过。随后重新读取 preflight，并使用以下完整 continue 模板：`--expected-head`、`--expected-fingerprint` 取当前 `preflight.taskspace.head`、`preflight.taskspace.workspaceFingerprint`，不能取历史 `preflight.integration.to.head` 或 `preflight.integration.to.fingerprint`；`--canonical-head` 取 `preflight.integration.canonicalHead`，保持该待续操作的固定目标，即使项目 canonical 已前进也不替换。continue 的每个 `--path` 只取当前 `preflight.integration.conflictPaths`，不得传完整 `preflight.taskspace.dirtyPaths` 或自动合并路径；`--operation-id` 只取当前 `preflight.integration.operationId`（待续冲突操作）或此前 `conflict-open` 结果的 `operationId`，恰好出现一次且不得发明。

   ```text
   forge-release integrate --mode continue --operation-id <current-preflight.integration.operationId-or-conflict-result.operationId> --expected-head <preflight.taskspace.head> --expected-fingerprint <preflight.taskspace.workspaceFingerprint> --canonical-head <preflight.integration.canonicalHead> --path <preflight.integration.conflictPaths-1> [--path <preflight.integration.conflictPaths-2> ...]
   ```

   Broker 由此精确 stage/commit；不要求用户输入 SHA、指纹或命令。若返回 `recoveryOnly=true`，这一步只用隔离重演恢复同一 operation 的真实待解冲突基线，不修改或提交 live 源码，且 `sourceTransition` 必须为 `null`；只编辑返回的 `conflictPaths`，在新 fingerprint 上取得真实 Host profile/binding 后再执行普通 continue。一次 bare continue 或一次 continue 成功只证明该待续 operation 的结果，不证明所有会话均已同步；不得隐藏或自动接受 fresh/new HEAD。真实业务语义无法确定时，给出具体文件与双方差异供用户决策，不泛泛要求用户手工同步。
5. 受控同步不是 READY、验收通过或发布证据。`integrate` 成功返回 `integrated` 且工作区 clean 时，若确有受保护源码迁移，运行时核对 Broker 固定迁移事实、原任务范围和当前账号权限，在同一请求内绑定新 HEAD、新执行身份并清空旧候选验收。绑定成功后按当前合同补足必要检查并取得新源码验收，再完成已经授权的发布；不要仅因 HEAD 改变就结束对话或再次请求用户确认。旧 grant/proof/receipt 不能直接充当新源码验收，同内容 checkpoint 的回执复核规则也不能跨用到真实 merge。若续接未成功，按实际错误码使用现有修复路径，不自行忽略绑定；conflict-open、source-saved-error 等未完成同步仍遵循前述流程。若 status/preflight 已证明候选内容与实际已发布版本一致，不重复 release 凑证据。
   若本次 `integrate` 的固定 `integration.from/to` HEAD 和 fingerprint 均相同、结果 `sourceTransition=null`，则没有产生新源码；当前合同的正式复核及验收仍有效时，复用并继续已授权发布。若工具因比较基准等绑定变化指出缺项，只补该缺项，不因 `integrated` 标签重跑已通过且仍适用的测试。复核回执顶层 `source.head` 保留原执行来源；应同时读取 `revalidation.admissionReceipt.source` 和实际验收状态，旧顶层 HEAD 本身不是失效或重跑理由。需要重新复核时沿 `forge-verify run ... --reuse-receipt <原receiptId>`，不得由模型自行宣布旧回执有效。
6. 仅当候选已包含 canonical HEAD 且仍有普通预期 dirty 修改时，加载 `forge-git-checkpoint` Skill 并使用精确 `forge-release checkpoint`；不得直接 `git add/commit`。只提交已核实文件，不得删除、覆盖或顺手提交他人变更。若可信checkpoint仅改变HEAD、内容及依赖绑定不变，平台沿同一请求核对当前权限并刷新合同；按 `forge-testing-observability` 的 `forge-verify run ... --reuse-receipt <原receiptId>` 正式复核已有结果后继续，不要求用户再确认或无变化重跑。没有可信同内容迁移、发生合并或内容变化时不套用此例外，仍按当前源取得必要验收；已有 clean HEAD 则按当前验收状态补足必要检查或正式复核。
7. 根据已核实的改动、依赖和当前授权，只选择实际受影响的 `forge-admin`、`forge-app`、`forge-flow`、`forge-ui`；涉及移动 API、H5 构建或同源路由时必须同时包含 `forge-app` 与 `forge-ui`。影响范围和授权已明确时直接执行，不再确认。只有现有证据无法确定的业务取舍，才用一次 `ask_user_question` 提供具体业务选项供点击澄清，所选结果仍须落在真实授权与合同允许范围内；不得把不确定当作发布四个服务的理由，不要求用户填写服务名或命令参数。
8. 执行 `forge-release release --services <逗号分隔服务>`。Broker 先在项目发布锁内校验并 fast-forward 项目私有 Git 远端，远端推后复核成功才推进服务器集成 HEAD。Runner 随后固定使用项目 `ops/compose.yaml`，先构建唯一版本候选镜像，再按实际服务、当前成功发布基线及候选变更判断数据库准备是否适用。仅 `forge-ui` 且相对已确认成功基线的变更全部属于前端时，使用 Runner 返回的数据库 `not-required` 证据继续，不额外要求后端或数据库检查；基线未知或实际涉及后端/数据库时保留原有检查。数据库准备适用时，检查专属 `_test` schema 和持久恢复状态。健康状态下先生成带 SHA-256 证据的项目内恢复快照，再只执行候选镜像的增量 Flyway 校验/迁移；若上一次迁移失败或 Runner 中断，则先从已登记的健康快照恢复同一个测试 schema，再执行修正版增量迁移。门禁通过后才原子更新项目镜像引用、定向发布应用服务并冒烟；主库永远不进入该自动恢复路径。
   发布命令只提交一次。新版 TaskSpace CLI 在原准入通过后返回 `status: accepted`、`terminal: false` 和 `operationId`，原 Broker 操作继续执行；受理和命令退出码 0 均不代表已经发布。保存该 ID，用 `forge-release status --operation-id <原operationId>` 观察同一操作；只有返回的 `release.operation.operationId` 与原 ID 一致且 `status: success` 才是该操作成功，`failed`、`interrupted`、`unknown` 或缺少原操作均不能报成功。等待期间可报告发布中或进行独立只读工作，不重复提交、不反复长轮询，也不修改正在发布的候选。本舱正在发布时跟踪原操作；另一舱占锁时等待其真实状态，不能把本舱锁误称另一舱。旧版 CLI 或直连 Runner 仍同步返回：需要时使用原生 `bash` 的 `run_in_background: true` 启动一次，保存 `bash-*`，收到通知后以 `job_output` 领取原结果。若客户端断开或超时，先读 `forge-release status` 核对已有操作。查询本舱之前是否发布成功时，先核 `release.lastTaskRelease` 的本任务持久结果、提交和完成时间；`release.operation` 是项目当前或最近操作，可能属于另一舱，不能覆盖或否定本舱已有的历史成功。历史成功不等于该版本仍在线；要分别报告本次发布结果与当前运行版本。`lastTaskRelease.operationId` 缺失时不得伪造精确操作绑定；有原 ID 时继续按该 ID 查询。必要时使用 `forge-release diagnose` 辅助诊断；客户端退出不表示服务器作业已停止，也不授权重发。
9. 必须完整核验并记录 Runner 返回的 jobId、Git 提交、版本、镜像 ID、测试库沙箱模式、快照相对路径与校验和、服务、冒烟和回退文件。面向业务人员默认先说明本次功能是否已发布、当前可见影响、数据/版本状态和实际下一步；上述标识放在内部记录或按需技术凭据中，不要求业务人员理解或转填。不得将“命令已提交”冒充为“发布成功”。

## 面向产品人员的失败与升级

- 执行发布时当前合同必须具有 `release` 权限，当前 clean HEAD 的 Protected Acceptance 必须为 READY；失败、缺失或旧源码回执不能放行。仅有版本构建成功不能替代完整技术验收。

- Harness 页面可访问不代表使用者是服务器操作员。发布能力不可用、契约不匹配或共享服务失败时，不得要求用户执行 `mvn`、`pnpm`、`docker`、SQL、清缓存、重启服务或重新部署 Forge。
- 能由当前代码授权和 Runner 固定动作恢复的问题，在当前可见会话闭环；超出边界的问题形成升级记录后停止。升级记录完整保留项目/提交、失败阶段、稳定错误码、业务影响、是否发生数据或运行态变更、可重试性、脱敏证据、建议责任人和恢复后复测项，但只作为内部记录或按需技术附录。对业务人员说明哪个业务步骤受阻、实际影响和谁需要采取什么动作；没有真实接手或通知证据时，不得声称已经派给技术人员。
- 对产品/业务人员的默认回复使用其主要语言和自然短句，通常为 1–3 个简短段落或确有必要的短列表，先说明功能是否已经可验证、是否需要其做业务决定、当前数据和版本是否安全，以及实际下一步。原始命令与长日志只能作为技术证据，不能作为让其照抄执行的操作清单。
- 结论必须来自实际状态：本次修改尚未发布不等于线上仍是旧版本，必须读取 status/preflight 或运行态事实；代码检查通过不等于已经发布；镜像构建完成不等于 release success；快照存在不等于已经回滚。只呈现与当前结论有关的未完成项。
- 同一发布 job 已在运行时，不因新消息重复提交发布。先查询既有 jobId；新需求或新版本使用独立任务合同，不能改写正在运行的发布目标。

## 失败诊断与会话内闭环

Policy marker: `STRUCTURED_RELEASE_DIAGNOSIS_V1`.

Policy marker: `TEST_DATABASE_SANDBOX_V1`.

Policy marker: `TEST_DATABASE_RECOVERY_V2`.

- 发布失败后先执行 `forge-release diagnose`，以 `stage`、稳定错误码、`retryable`、脱敏诊断摘要和 `recommendedAction` 为准。不得把容器消失、日志读取失败、Flyway 校验错误统一改写成“数据库迁移超时”，也不得在没有证据时猜测 failed history 或要求运维 repair/reset。
- `TASKSPACE_ACCEPTANCE_REVALIDATION_REQUIRED` 或验收明确指出 `ACCEPTANCE_CONTRACT_EXPIRED` 时，先保留原 prepared 候选、jobId 和通过回执。合同到期本身不是用户撤销授权，也不能跳过当前权限核验；在同一对话继续读取 `forge-release status` / `preflight`，消费可信运行时核验后提供的当前准入信息。准入续期由运行时完成，模型不得调用内部 admit/renew 接口或修改有效期。
  当前准入可用且原任务仍获授权时，加载 `forge-testing-observability`，按实际缺项、原 profile 和原选择器执行 `forge-verify run ... --admission-id <当前ID> --idempotency-key <新的复核键> --reuse-receipt <原receiptId>`。只有平台实际接纳的正式复核才计入当前验收；兼容的已有结果不重跑，只有缺失、真实失败或绑定不兼容的检查才补做。取得当前 READY 后续发同一候选，由 Runner 判断 prepared 制品能否复用；不要因合同到期自行重建或让用户再说一次“继续/发版”。若当前权限已撤销、准入不可用或复核明确拒绝，保留该具体错误并按其恢复路径处理，不能把这些真实阻塞写成已恢复。
- `MIGRATION_VERSION_CONFLICT`、`MIGRATION_VERSION_NOT_FORWARD`、`MIGRATION_HISTORY_IMMUTABLE`、`MIGRATION_SQL_FORBIDDEN` 属于项目代码门禁。若用户已授权修复/交付，应在当前工作区按 preflight 返回的最新版本编写新的向前迁移、测试、提交并重试；不得修改或改名已发布迁移。
- `MIGRATION_VALIDATION_FAILED` 先核对诊断中的具体文件和校验原因，优先恢复已发布文件并新增向前迁移。`MIGRATION_LOCKED` 只有在 Runner 明确返回 `retryable=true` 且当前无活跃 job 时才允许重试一次。
- `MIGRATION_HISTORY_FAILED` 表示前一次候选在测试 schema 留下了半完成状态。修正并提交向前迁移后直接重试普通受控发布；Runner 会自动校验并恢复上一次迁移前登记的健康快照，不得要求用户另找运维执行 `flyway repair`。即使 failed history 未成功写入，只要持久状态仍是 `migration-pending` 或 `restore-required`，Runner 也必须先恢复，防止 MySQL 非事务 DDL 残留。`TEST_DATABASE_BUSY` 只在返回 `retryable=true` 后等待占用者结束再重试；`TEST_DATABASE_UNAVAILABLE`、`TEST_DATABASE_OPERATOR_UNAVAILABLE` 表示平台契约、项目级授权或固定镜像异常，仍不授权 Harness 获取数据库管理凭据、运行任意 SQL或绕过 Runner。
- 修复、提交、重试和最终结果必须留在同一条可见对话轨迹。若失败原因已被当前授权覆盖且可由工作区或 Runner 固定动作解决，模型应继续闭环，不把用户转交给对话外人员。

## 永久禁止

- 不执行工作区中的 `docker-compose.yml`、`compose.yaml`、一键部署脚本或 README 部署命令。Forge Admin 上游的 `docker-forge-admin/docker-compose.yml` 包含本地 MySQL/Redis，对本平台仅是不可执行的上游参考。
- 不安装、启动、构建或重建 MySQL、MariaDB、PostgreSQL、Redis、MongoDB、Elasticsearch 或其他基础设施。
- 不执行 `CREATE/DROP DATABASE`、`CREATE/ALTER/DROP USER`、`GRANT/REVOKE`、`SET GLOBAL/PERSIST`。库创建和授权属于项目初始化/DBA，不属于发布。
- 普通“发版”不授权 `DROP TABLE`、`TRUNCATE`、`DROP INDEX`、`ALTER TABLE ... DROP` 等不可逆结构操作。应改写为保留数据的向前迁移；需要销毁旧数据时必须停止，走单独的人工评审与恢复方案。
- 不使用 `docker`、`docker compose`、Docker socket、宿主机 Secret 或其他项目路径；不尝试绕过 Runner。
- 数据库或 Redis 连接失败时，只停止并报告契约中的目标和失败阶段，绝不以“部署新实例”作为修复。
- `forge-release` 在 TaskSpace 内自动通过 Broker，在平台兼容路径中自动通过项目专属 Unix capability socket；两种路径都不需要用户、运维或模型提供令牌。禁止检查环境变量、读取令牌文件、搜索 DSH 配置、读取 `/srv`、索要或输出发布凭据；若客户端报告 Broker 或 capability socket 未就绪，只能如实报告“平台发布能力异常”，不得给出索密钥或绕过 Runner 的建议。
- 用户的一次发布要求不等于授权修改 `AGENTS.md`、`PROJECT_CONTEXT.md`、`code-copilot/memory/` 或其他长期记忆/偏好文件；除非用户明确要求持久化，否则不得自行写入。
