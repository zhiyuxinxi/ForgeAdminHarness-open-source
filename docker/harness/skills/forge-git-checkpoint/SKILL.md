---
name: forge-git-checkpoint
description: Save explicitly authorized progress in the current TaskSpace with a controlled checkpoint; saving is distinct from testing, pushing and publishing.
---

未启用 `FORGE_DIRECT_DEVELOPMENT_V1` 时，读取 [受控模式原有规则](CONTROLLED.md)，沿用其要求。模式由平台配置与签名上下文决定，模型不能自行切换。以下精简流程仅适用于 direct 模式。

# Forge 保存进度

直接开发模式 `FORGE_DIRECT_DEVELOPMENT_V1` 下按需参考。保存是代码恢复点，不是发布、验收通过或异机备份。用户要求保存时可以保存本任务尚未完成或检查失败的内容，如实说明当前状态；不为建立恢复点强制先通过测试。

Policy markers: `FORGE_GIT_CHECKPOINT_GUARD_V1`, `LOCAL_COMMIT_DOES_NOT_AUTHORIZE_PUSH_V1`.

## 工作舱保存

1. 沿用真实用户授权和当前账号权限，普通代码编辑不自动授予提交/发布。已经授权就不再次确认，不要求加载其他 Skill。只保存已核实属于本任务的文件，不纳入凭据、缓存或他人改动。
2. 使用已有的新鲜状态；缺少当前 HEAD、指纹或 dirtyPaths 才读取一次 `forge-release status`。不要求先获得测试回执或运行 preflight。若需要集成 canonical，先使用 integrate，它自身会保存 dirty source，不重复 checkpoint。
3. 用状态中的 taskspace.head、taskspace.workspaceFingerprint 和确切路径执行：

```text
forge-release checkpoint --path <仓库相对文件> --path <另一个文件> --message-base64 <提交信息的UTF-8-base64url无填充编码> --expected-head <40位HEAD> --expected-fingerprint <64位源码指纹>
```

不要猜参数、用通配符或直接 git add/commit。Broker 核对当前身份、候选和文件。`workspaceClean=false` 在保存前是正常状态，不是必须先消除的错误。

4. 返回 `status=checkpointed` 与具体 commit 才说明保存成功；是否 clean 按真实结果报告。成功后复用返回的新状态。同内容 checkpoint 不重新申请 admission、不加载测试 Skill、不调用 `--reuse-receipt` 重新验收、不重跑未变检查。真实内容/依赖变化才补必要检查。上下文刷新失败不抹除已成功保存事实，按实际错误续接，不重复提交。

## 边界与结果

不为 clean 删除、忽略、覆盖或提交未知文件，不 reset --hard、clean、stash、改历史或 force push。非 TaskSpace 兼容环境仅在已授权时按显式路径使用普通 Git；不全量暂存、不强制附加发布流程。

本地保存不自动授权远端推送或发布。已明确要求受控发布时，由发布链路负责私有远端同步和上线，无须为同一授权再次询问。发布仍须处理真实测试失败、冲突和权限问题。

向用户说明已保存范围、实际检查状态及是否还有未完成工作；不能把保存说成完成、已上线或已异机备份。提交 ID 按需提供。
