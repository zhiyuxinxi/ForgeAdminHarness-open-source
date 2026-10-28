---
name: forge-taskspace-collaboration
description: Resolve a concrete TaskSpace synchronization or integration need while preserving isolated work and other contributors.
---

未启用 `FORGE_DIRECT_DEVELOPMENT_V1` 时，读取 [受控模式原有规则](CONTROLLED.md)，沿用其要求。模式由平台配置与签名上下文决定，模型不能自行切换。以下精简流程仅适用于 direct 模式。

# Forge 工作舱协作

直接开发模式 `FORGE_DIRECT_DEVELOPMENT_V1` 下按需参考，不要求每个任务加载本 Skill，不要求固定阶段、重复确认或独立验收流程。

Policy markers: `FORGE_TASKSPACE_ISOLATION_V1`, `FORGE_PRIVATE_GIT_REMOTE_V1`.

只在当前 `/workspace` 编辑、测试和保存。`/integration` 是只读集成视图，不能用直接 git fetch/rebase/merge/add 同步；不访问他舱文件、会话和令牌，不改变归属环境变量。代码、业务与双语私有规则继续保留。

## 需要同步时

使用已有的新鲜 taskspace/integration 状态。缺少或实际过期才执行一次 `forge-release status`；不要紧接着 preflight，checkpoint/integrate 已返回的新状态直接使用。dirty 或未包含 canonical 是选择下一步的正常状态，本身不是平台故障。

没有待续 integration 且未包含 canonical 时，按实际字段执行：

```text
forge-release integrate --mode start --expected-head <taskspace.head> --expected-fingerprint <taskspace.workspaceFingerprint> --canonical-head <taskspace.canonicalHead> [--path <dirtyPath> ...]
```

每个属于本任务且已核实的 dirtyPaths 项对应一个 `--path`，为空则不传。参数取自机器状态，不要求用户填写或猜测。start 不带 operation-id。integrate 会受控保存 dirty source，不先 checkpoint 制造另一份来源。

已有 `conflict-open` 时，读取明确的 conflictPaths，只解决这些文件，保留双方业务含义，不全选 ours/theirs、不增加无关修改。不要求另发一轮用户请求或先跑固定 governance profile。编辑后需要当前源码状态时读取一次 status，继续原操作：

```text
forge-release integrate --mode continue --operation-id <integration.operationId> --expected-head <taskspace.head> --expected-fingerprint <taskspace.workspaceFingerprint> --canonical-head <integration.canonicalHead> --path <conflictPath> ...
```

两种模式的 expected-head、expected-fingerprint 都取当前 status 的 taskspace.head、taskspace.workspaceFingerprint，不能取历史 integration.to.head 或 integration.to.fingerprint。start 的 canonical-head 取 taskspace.canonicalHead；continue 取 integration.canonicalHead，即该待续操作的固定目标，项目 canonical 已前进也不替换它。continue 的路径只来自当前 integration.conflictPaths，不能使用所有 dirtyPaths。`source-saved-error` 的恢复按该 operation 的实际恢复动作执行；若 `recoveryOnly=true`，只是恢复冲突基线，按返回路径继续解决，不宣称已合并。业务语义无法确定时说明具体文件和双方差异。

成功后使用返回的新来源和状态，同一请求继续已授权工作。真实合并或内容变化做必要的相关检查；同内容保存或未发生 sourceTransition 时复用现有结果，不重复 admission、回执验收或 Skill 加载。源码绑定由运行时刷新；真实刷新失败保留已保存内容并处理准确错误，不重复保存。

候选已包含 canonical 且仅有本任务 dirty 修改时，使用受控 checkpoint。集成或保存成功不等于已经发布。需要发布则继续一次受控 release，由 Broker 在项目发布锁内核对当前候选及私有远端并作普通 fast-forward 推送。远端不就绪、分歧或推送失败仍须按真实错误处理，不 force push、不索取 Deploy Key、不绕过为本地发布。

## 保留工作和真实结果

发布锁串行化项目发版，不影响他舱编辑；已有 operation 继续观察。迁移只作为当前候选交给 Runner，版本只向前，不改已发布迁移，不运行任意 SQL/repair。真实测试失败只修相关部分，不删除测试或改忽略规则掩盖失败。

stop/close 保留代码、会话、上传和缓存，不删除目录或 volume。报告区分已保存、已集成、已发布和当前在线版本，保留对应真实操作结果；不以模型叙述替代终态，不要求用户提供 SHA、指纹或命令参数。
