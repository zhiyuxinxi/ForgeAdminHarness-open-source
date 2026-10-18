---
name: forge-controlled-release
description: Publish an authorized Forge Admin candidate through the project release runner, or prepare an explicitly selected production offline package and isolated installation or upgrade rehearsal. Consult for release commands or a concrete release failure; ordinary development releases do not require production packaging.
---

## 生产离线交付（两种开发模式共用）

仅当用户选择生产发布包、首次生产安装或指定历史生产包的增量升级时，读取 [生产包与发布验证](references/production-delivery.md)。沿已授权的生产交付入口固定版本、架构及升级起点，生成实际材料，在每次新建的独立环境中验证；增量必须先恢复并启动历史系统，再执行拟交付包。普通开发测试发布继续下方原路径，不自动生成生产材料。

业务模型负责当前项目的业务代码、版本化迁移、业务测试及真实业务操作手册；Codex/平台负责通用工具、隔离执行器及权限边界。环境创建、数据库恢复、容器操作由平台受控组件执行，模型不取得 Docker socket、数据库管理凭据或任意宿主 shell。当前没有可用生产入口时报告具体能力缺口，不虚构命令、不用现役测试环境代替。

正式包、历史恢复基线与失败证据永久保存，不能覆盖或随环境回收删除。自动验证通过后提供环境地址等待实际人员验收；模型不能代签、伪造上线回执或把开发发布成功当作生产交付就绪。已获授权的准备和验证直接推进，人工验收与客户生产执行分别保留其实际授权主体。

未启用 `FORGE_DIRECT_DEVELOPMENT_V1` 时，读取 [受控模式原有规则](CONTROLLED.md)，沿用其要求。模式由平台配置与签名上下文决定，模型不能自行切换。以下精简流程仅适用于 direct 模式。

# Forge 受控发布

适用于 直接开发模式 `FORGE_DIRECT_DEVELOPMENT_V1`。Skill 按需参考，不要求先加载其他 Skill、准备任务提案、重复确认、固定阶段或完整验收清单。已有真实用户发布授权就继续；业务选择卡不产生新的发布权限。只读、暂停或缺少发布授权时不执行发布。

Policy markers: `PRODUCT_OPERATOR_ESCALATION_GUARD_V1`, `READ_ONLY_INSPECTION_GUARD_V1`, `STRUCTURED_RELEASE_DIAGNOSIS_V1`, `TEST_DATABASE_SANDBOX_V1`, `TEST_DATABASE_RECOVERY_V2`.

## 最短执行路径

项目已安装输入定义时，保存/集成后的同一候选先用 `forge-release plan` 取得实际服务、保留服务、输入差异及必要检查。复用同一候选的计划；它不构建、不部署、不产生发布授权。以 `selectedServices` 选择服务，`checks` 结合已有有效回执只补受影响检查；无变化时直接说明无需发布。`not-configured` 明确代表旧项目尚未升级，不能据此宣称已完成自动影响分析。缺失依赖、漏选共享消费者、同制品含其他任务改动时，处理工具给出的具体范围，不自行扩成全服务。

1. 使用已有的新鲜状态；缺少状态或源码已经变化时读取一次 `forge-release status`。其结果已包含 taskspace、integration、sourceTransition 和 Runner，不连续执行 contract/capability/preflight。只在工具明确缺少某个事实时补读。区分本舱候选、项目集成提交和实际线上版本。
2. 有待续 integration 就继续原 operation；候选不包含 canonical 时受控 integrate，它会保存本舱 dirty source，不先 checkpoint。候选已包含 canonical 且有本任务未提交改动时才 checkpoint。命令细节见协作/保存 Skill，按需读取即可。未知文件保留原状，不能为 clean 删除、隐藏或纳入他人成果。
3. 按实际源码变化做必要检查，复用未变且有效的结果。同内容 checkpoint 只改变 HEAD 时，不重新申请 admission、不加载测试 Skill、不用 `--reuse-receipt` 再验一次。使用 checkpoint/integrate 返回的新状态，不立即重复查询。真实合并或内容变化才补受影响检查；用户明确要求和实际失败仍须处理。
4. 只发布受影响服务：`forge-release release --services forge-admin,forge-ui` 是语法示例，实际从 forge-admin、forge-app、forge-flow、forge-ui 选择；`--services` 只出现一次。涉及移动 API、H5 或其同源路由时核对 forge-app 与 forge-ui 的实际关联，不默认四服务全发。已授权前端发布的候选镜像构建就是唯一正式生产编译，不提前再运行相同源码的 frontend-admin-build，除非用户需要独立制品或实际诊断需要。
5. 提交一次后观察同一操作。直接模式 CLI 的原生后台任务持续等待 Broker；保存返回的 `bash-*`，通过 `job_output` 等待原任务终态，不循环调用 status 或 sleep。只有观察异常/断开时使用 `forge-release status --operation-id <原operationId>` 恢复观察，不能重发来确认状态。`accepted`、退出码 0、构建成功都不是上线成功；必须取得对应 operation 的真实 `success/complete`。
6. 成功后立即说明功能已发布及实际影响。内部保留候选提交、operation/job、镜像与服务结果；只向用户提供需要的凭据。历史本舱结果读 lastTaskRelease，项目当前 operation 可能属于另一舱，不能据此否认本舱历史成功，也不能把历史成功说成当前版本仍在线。

## 只处理实际错误

- 业务系统启动或运行报错时，读取 `forge-release logs --services forge-admin --tail 200`（按实际服务选择；省略 `--services` 查询本项目全部业务服务，按需加 `--since 30m`）。这是所有有效工作舱可用的项目只读日志入口，不要求本舱发起过发布、候选干净或发布权限。使用返回的真实时间和错误，说明截断或无日志；不让用户去服务器取日志，不用发布状态代替应用日志，不据此获得其他项目、宿主或任意容器访问权。
- 工具已给出具体阶段、错误码和恢复动作时直接使用；信息不足才 `forge-release diagnose`。不凭模型猜测迁移超时、数据库损坏或权限撤销。
- 同一发布仍运行就继续观察；另一舱占项目发布锁就等待。保留真实互斥，不重复提交、不修改正在发布的候选。
- 上下文刷新由运行时完成，不要求用户再说“继续/发版”，也不由模型手写 admit/renew。真实权限撤销、来源不匹配或冲突仍按实际错误处理，不能伪造通过。只因 HEAD 变化不增加流程验收。
- 真实 merge 冲突只修当前 conflictPaths，保留双方业务含义；无法确定的业务取舍才向用户说明具体差异。无变化或候选与实际运行版本相同则结束，不重复发布凑证据。
- 前端独立变化由 Runner 判断数据库 `not-required`，不补无关后端检查。数据库适用时仍由 Runner 校验候选增量迁移和项目专属 `_test` schema；失败后的健康快照恢复由 Runner 完成，主库不走自动恢复。
- 迁移版本必须唯一且向前，不改已发布迁移。按具体文件修复真实代码错误；只有工具明确可重试且原作业已结束时才重试。凭据、平台连接或基础设施异常须报告具体阻塞，不让业务用户运行 Docker、SQL 或寻找密钥。

## 必要边界

只操作当前 `/workspace` 和真实候选。发布走项目 Broker/Runner，不运行工作区 Compose、一键部署或基础设施安装脚本，不访问宿主 Docker/Runner socket、其他工作舱或凭据。保留项目私有业务和双语需求。

普通发布不授权建删数据库、用户或权限，也不授权 DROP/TRUNCATE 等破坏性变更；需要销毁数据时另行明确授权与恢复方案。不要因本次发布修改长期记忆、AGENTS 或项目偏好。实际失败和未验证项如实报告，局部检查不能冒充全量或业务验收。
