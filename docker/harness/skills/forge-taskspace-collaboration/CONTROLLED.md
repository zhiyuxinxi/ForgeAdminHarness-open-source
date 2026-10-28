---
name: forge-taskspace-collaboration
description: Work safely inside one isolated Forge Admin TaskSpace. Use at the start of every development, database-migration, or release task when FORGE_TASKSPACE_ID is present, and whenever another AI or release may be active on the same project.
---

# Forge Admin TaskSpace 协作

Policy markers: `FORGE_TASKSPACE_ISOLATION_V1`, `FORGE_PRIVATE_GIT_REMOTE_V1`.

## 当前工作舱就是唯一写边界

- `/workspace` 是当前任务的独立 Git clone；只在这里编辑、构建、测试和提交。
- `/integration` 是平台管理的只读集成分支视图；不得尝试写入、删除、改变权限或用普通 Git 命令同步它。发布链路中的版本核对与同步只走 `forge-release status`、`forge-release preflight` 和受控 `forge-release integrate`。
- 当前 `FORGE_TASKSPACE_ID`、`FORGE_TASKSPACE_ACTOR_ID` 和 `FORGE_TASKSPACE_CONVERSATION_ID` 是任务归属证据。不得修改这些环境变量、读取 `/run/forge-taskspace` 中的令牌或把令牌写入日志/回复。
- 不访问其他 TaskSpace、其他人的 DSH_HOME、上传区、缓存、分支或未提交改动。当前工作舱看不见它们是预期隔离，不得寻找绕过路径。

## 并行修改和候选提交

1. 开始工作时记录当前候选 HEAD 与工作区状态。发布前读取一次 `forge-release status`；它已包含本次 preflight 的 TaskSpace、integration、sourceTransition 和 Runner 字段，以及实际服务状态，以下模板中的 `preflight` 指这份结果，不再紧接着调用 `forge-release preflight`。同一轮候选、canonical 和 integration 状态未变化时复用本次结果；实际编辑、checkpoint、integrate 或工具指出状态已变化/过期后，再读取一次 status。分别识别本舱 dirty/候选验收状态、当前项目集成版本和实际项目已发布版本；“本舱候选尚未发布”不能推导为“线上仍是旧版本”。只处理本任务已核实的文件。
2. 同一文件可以被多个任务并行修改，因为各自 clone 不共享未提交状态；冲突只允许在候选集成前显式解决，不能用覆盖集成分支的方式“抢先”。
3. 先检查当前 `preflight.integration`：`phase=conflict-open` 时走第 4 条的 continue；`phase=source-saved-error` 且 `error.code=TASKSPACE_INTEGRATION_DIRTY_LIMIT` 时，在新用户业务请求已取得绑定当前保存 HEAD/fingerprint 的 release 合同后，先按第 4 条模板执行一次恢复 continue，此前不得编辑冲突文件。其他错误状态停止并报告。只有没有待续 integration 且候选未包含固定 canonical HEAD 时，加载或重新加载本 Skill 与 `forge-controlled-release`（历史 `invokedSkills` 名称不代表已读取当前契约），再严格使用以下完整 start 模板。`--expected-head` = `preflight.taskspace.head`，`--expected-fingerprint` = `preflight.taskspace.workspaceFingerprint`，`--canonical-head` = `preflight.taskspace.canonicalHead`；对完整 `preflight.taskspace.dirtyPaths` 每项各重复一次 `--path`，列表为空时使用零个 `--path`。start 不得带 `--operation-id`，任何值都不得发明或遗漏。

   ```text
   forge-release integrate --mode start --expected-head <preflight.taskspace.head> --expected-fingerprint <preflight.taskspace.workspaceFingerprint> --canonical-head <preflight.taskspace.canonicalHead> [--path <dirtyPath-1> --path <dirtyPath-2> ...]
   ```

   Broker 会受控保存 dirty source，不能先用 checkpoint 制造另一份不同源事实。参数来自当前机器事实，不要求用户输入 SHA、指纹或 CLI 参数。不得直接执行 `git fetch`、`git rebase`、`git merge` 或 `git add`。
4. `integrate` 返回 `conflict-open` 时，读取其 `operationId`、`conflictPaths` 和完整 `dirtyPaths`。下一次正常续谈取得新 source 合同后，只 edit/write 明确冲突文件；禁止全选 ours/theirs、静默覆盖或修改无关路径。保持 F0（`conflict-open`）→ Host-bound F1（只修改明确冲突文件后，用可信运行时自动刷新的 admission 运行本合同要求的一个 profile，优先 `governance`）→ merge F2（受控 continue）的既有顺序。F1 检查不是 merge 后最终验收。随后重新读取 preflight，严格使用以下 continue 模板；`--expected-head`、`--expected-fingerprint` 取当前 `preflight.taskspace.head`、`preflight.taskspace.workspaceFingerprint`，不能取历史 `preflight.integration.to.head` 或 `preflight.integration.to.fingerprint`；`--canonical-head` 取 `preflight.integration.canonicalHead`，保持该待续操作的固定目标，即使项目 canonical 已前进也不替换。continue 的 `--path` 必须完整且只来自当前 `preflight.integration.conflictPaths`，不得传 `preflight.taskspace.dirtyPaths` 或自动合并路径；`--operation-id` 只取当前 `preflight.integration.operationId` 或此前 `conflict-open` 结果的 `operationId`，恰好出现一次且不得发明。

   ```text
   forge-release integrate --mode continue --operation-id <current-preflight.integration.operationId-or-conflict-result.operationId> --expected-head <preflight.taskspace.head> --expected-fingerprint <preflight.taskspace.workspaceFingerprint> --canonical-head <preflight.integration.canonicalHead> --path <preflight.integration.conflictPaths-1> [--path <preflight.integration.conflictPaths-2> ...]
   ```

   Broker 由此精确 stage/commit；模型仍不得执行 `git add` 或手工提交。若返回 `recoveryOnly=true`，这一步只用隔离重演恢复同一 operation 的真实待解冲突基线，不修改或提交 live 源码，且 `sourceTransition` 必须为 `null`；只编辑返回的 `conflictPaths`，在新 fingerprint 上取得真实 Host profile/binding 后再执行普通 continue。一次 bare continue 或一次 continue 成功只证明该待续 operation 的结果，不证明所有会话均已同步；不得隐藏或自动接受 fresh/new HEAD。真实业务语义无法确定时，给出具体文件、双方差异和待决业务语义。
5. `integrated` 只证明受控同步事实，不是 READY、验收通过、发布或部署证据。成功同步且工作区 clean 后，若确有受保护源码迁移，运行时核对 Broker 固定迁移事实及当前账号权限，在同一请求内绑定新 HEAD 和新执行身份，清空旧候选验收；绑定成功后直接继续当前合同的必要检查和已授权发布，不因这次 HEAD 变化要求用户新发一轮。旧 grant、proof 或 receipt 不得直接充当新源码验收，同内容 checkpoint 的复核不能套用到真实 merge。续接失败须按实际错误处理，不跳过新绑定；未完成同步仍按前述冲突/错误流程。仅当候选已经包含 canonical HEAD 且仍有普通预期 dirty 修改时，才使用 `forge-release checkpoint` 建立受控候选；同内容提交按当前 `forge-git-checkpoint` 规则正式复核已有结果。
   若本次 `integrate` 的固定 `integration.from/to` HEAD 和 fingerprint 均相同、结果 `sourceTransition=null`，则没有产生新源码；当前合同的正式复核及验收仍有效时复用继续。复核回执顶层 `source.head` 是原执行来源，应同时读取 `revalidation.admissionReceipt.source` 和实际验收状态，不能仅因旧顶层 HEAD 或 `integrated` 标签重跑；需要重新复核时沿 `forge-verify run ... --reuse-receipt <原receiptId>`，不得由模型自行宣布旧回执有效。
6. Broker 只接受当前工作舱 HEAD，并在项目集成分支未变化时做 fast-forward 晋升。启用项目私有远端后，Broker 还会在发布锁内要求远端分支等于当前集成 HEAD，先普通 fast-forward push 并复核远端 Commit，再推进服务器集成工作区；Runner 会再次核对候选 Commit，防止检查后版本被替换。
7. `TASKSPACE_GIT_REMOTE_NOT_READY`、`TASKSPACE_GIT_REMOTE_DIVERGED` 或 `TASKSPACE_GIT_REMOTE_FAILED` 都是平台/远端门禁。停止发布并报告稳定错误码，不得索取 GitLab 密码、读取 Deploy Key、改写 remote、force push 或绕过为本地发布。

## 数据库和发布

- 解决同步冲突时复用已经存在的相关测试，不为满足测试先行形式而新增重复测试；当前 integration 只接受它记录的冲突路径。若本轮误新增了无关或重复的普通源码文件，先用 `read` 读取，再用结构化 `remove_file(file_path)` 撤回这个精确文件。该工具沿用当前合同的 ownedPaths、写入权限、admission 和文件观察版本；不得使用 `rm`、删除目录、改 ignore/exclude 或删除原有测试来消除失败。撤回后重新取得当前 source 的检查绑定，再继续同一 integration。
- 同步完成后，Host governance 的比较基准由 Broker 推进到本次固定的项目集成版本。此前的冲突现场检查只提供 source binding，不能冒充新 HEAD 的最终验收；真实 merge 或源码变化后按当前合同补足必要检查。仅比较基准改变而源码未变时，按工具指出的绑定缺项补检查或正式复核，不重跑已通过且仍适用的测试。

- Harness 没有数据库账号、Docker Socket 或 Release Runner Socket。数据库迁移只作为当前候选镜像的一部分，经 `forge-release` 交给 TaskSpace Broker 和项目 Runner。
- 多个任务的发布在项目级串行；`TASKSPACE_RELEASE_IN_PROGRESS` 表示另一个候选正在发布，只查询状态并等待，不重复提交、不绕过锁。
- Flyway 迁移版本全项目唯一且只向前。发生版本冲突时，当前任务必须基于最新集成提交选择更高版本；不得修改已发布迁移。
- 候选迁移失败只影响项目专属 `_test` schema。修正当前 TaskSpace 的向前迁移并重新提交；Runner 在下一次尝试前按已验证快照恢复测试库。不得执行 `repair`、手工 SQL、主库恢复或数据库管理操作。
- A 在自己的 TaskSpace 工作时，B 可以发布另一个 clean 候选；A 的文件和会话不受影响，但 A 后续发布必须集成 B 已晋升的提交。
- 若冲突具有真实业务含义且从当前证据无法确定，应向用户列出具体文件、双方差异和待决业务语义；不得只泛泛要求“手工同步”。若 preflight/status 已证明候选内容与实际已发布版本一致，不重复发布来凑证据。

## 关闭与报告

- `stop`、`close` 都保留工作区、对话状态、上传和缓存。不要自行删除任务目录或 Compose volume。
- 最终必须核验并在机器记录中保留 TaskSpace ID、候选 Commit、测试证据、是否已集成最新项目提交、Runner jobId/结果。面向业务人员默认用自然短句先说明本次业务结果、当前影响和实际下一步；这些标识只在用户要求、技术排障或正式交接时作为后置凭据提供，不要求业务人员取得或填写。不要声称看过其他 TaskSpace 的未提交内容。
- 新 HEAD 后的下一次正常继续或发布仍由 Controller 自动绑定当前来源和准入；模型不得手写 admission，也不得让用户提供 HEAD、fingerprint、hash 或受控命令参数。业务回复不能把 `integrated`、检查通过或构建完成说成已经发布；实际线上版本必须另读发布/运行状态。
