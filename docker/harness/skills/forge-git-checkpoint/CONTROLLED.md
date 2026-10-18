---
name: forge-git-checkpoint
description: Safely preserve progress in the current Forge Admin project Git repository. Use when a task reaches a tested milestone, before controlled release, before a risky change, or when the user asks to save, commit, checkpoint, or push progress. Do not auto-commit incomplete or unrelated shared-workspace changes.
---

# Forge Admin Git 进度保护

Policy markers: `FORGE_GIT_CHECKPOINT_GUARD_V1`, `LOCAL_COMMIT_DOES_NOT_AUTHORIZE_PUSH_V1`.

每个项目工作区都是独立 Git 仓库，并从受审 Forge Admin 基线提交创建独立工作分支。Git 提交是代码恢复点，不等同于发布、项目 Memory、任务完成或平台备份。

## 何时建立提交

优先使用事件触发，不在模型仍编辑时按固定时间强行提交：

- 一个可独立说明和验证的需求、修复或迁移完成后；
- 大范围重构、依赖升级或其他高风险修改之前；
- 上下文即将切换、需要移交给其他人或模型时；
- 用户明确要求保存、提交或建立恢复点时；
- 执行 `forge-release release` 前，必须形成经过验证的干净提交。

只有改动边界清晰且最低相关验证已通过时才提交。编译中断、测试失败、迁移未审查或文件归属不清时，应先报告未形成恢复点的原因，不制造“看似安全”的半成品提交。

## 安全提交流程

### 对话 TaskSpace 的受控提交

存在 `FORGE_TASKSPACE_ID` 时使用本段。当前可信合同必须允许 `git-checkpoint` 或 `release`，并已加载本 Skill；普通写代码授权不会自动变成提交授权。不要执行直接 `git add/commit`。

1. 用 `read/grep/glob` 审查本次完整改动与测试；用 `forge-release preflight` 核对当前 TaskSpace、HEAD 与集成基线。工作区未提交导致 `workspaceClean=false` 是此时的正常待办，不能当作“无法建立提交”的平台故障；其他真实阻断仍需处理。
2. 使用当前候选真实验证回执中的 `source.head` 和 `source.workspaceFingerprint`，明确列出全部已审且属于当前合同的脏文件。缓存、Secret、未知或其他任务改动不能进入路径清单。
3. 执行一个精确命令：`forge-release checkpoint --path <仓库相对文件> --path <另一个文件> --message-base64 <提交信息的UTF-8-base64url无填充编码> --expected-head <40位HEAD> --expected-fingerprint <64位源码指纹>`。禁止通配符、`git add .`、shell组合或猜测指纹。Broker 会重新核对当前授权、完整路径、源码、暂存区和提交结果。
4. 只有返回 `status=checkpointed`、`workspaceClean=true` 与具体 `commit` 才能声明本地提交完成。提交不代表推送或发布。可信受控checkpoint仅改变HEAD、内容及依赖绑定不变时，平台在同一对话请求内核对原范围和当前账号权限并刷新合同；不要求用户重新确认。加载 `forge-testing-observability`，按当前profile、admission及原选择器执行 `forge-verify run ... --reuse-receipt <原receiptId>` 正式复核，取得当前合同接受结果后才计入验收，不能将旧HEAD回执直接用于发布。刷新暂时失败时保留已成功的提交，按实际诊断续接，不重复checkpoint。合并或内容/依赖变化不适用同内容复用，应按当前源完成必要验证。

非 TaskSpace 的兼容环境按下面流程执行：

1. 执行 `git rev-parse --show-toplevel`、`git branch --show-current`、`git status --short` 和 `git diff --check`，确认只操作当前 `/workspace` 仓库。
2. 对照本轮需求逐项分类文件。显式列出正式源码、迁移、测试和交付文档；备份、构建产物、临时脚本、调试结果、Key、口令、环境文件与会话状态不得进入提交。
3. 运行与本轮影响范围对应的测试和构建。数据库迁移还必须经过 `forge-release preflight`；只读或未获发布授权时不得执行 release。
4. 只用显式路径 `git add -- <path...>` 暂存本轮已核实文件。共享工作区禁止用 `git add -A`、`git add .` 或通配符把未知改动一起收入。
5. 检查 `git diff --cached --check`、`git diff --cached --stat`、`git diff --cached` 与 `git status --short`。发现凭据、生成垃圾、未解释的删除或他人改动时取消相关暂存并停止。
6. 使用能说明业务结果的提交信息建立提交，再验证 `git status --short`。发布前必须完全干净；普通阶段提交允许保留已明确属于其他并行任务的未提交改动，但必须如实报告，且此时不得发布。

## 共享工作区边界

- 不使用 `git reset --hard`、`git clean`、`git restore`、强制切分支、rebase 或 stash 清理未知改动；这些动作可能覆盖同事或其他 Harness 会话的工作。
- 不为了得到 clean 状态删除、移动、忽略或提交归属不明的文件。先识别来源，无法确认时停止并列出阻塞文件。
- 不修改 Git 历史，不使用 `commit --amend` 或强制推送，除非用户针对准确提交和分支明确授权。
- 本地提交不自动授权推送。只有仓库配置了项目专属写入远端且用户明确要求推送时才执行普通 push；没有 `origin` 时保留本地提交并报告即可，不创建或猜测远端。
- 不把“已提交”描述为“已发布”或“已备份到异机”。当前项目目录整体丢失时，本地 `.git` 也会丢失；异机远端和平台备份是后续独立能力。

## 结果报告

报告当前分支、提交 ID、提交文件范围、已执行验证、剩余未提交文件和是否已推送。若未提交，明确说明阻塞原因和仍存在的数据丢失窗口。
