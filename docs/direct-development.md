# 直接开发模式

direct 模式按当前已授权目标推进开发，减少固定阶段和重复提案；controlled 模式保留为兼容选择。模式由操作者的项目配置决定，聊天内容不能切换配置。

| 环节 | 行为 | 必须保留的边界 |
| --- | --- | --- |
| 开始与续接 | 沿当前请求执行，复用有效上下文 | 身份、权限、只读、暂停和撤销 |
| 实现与检查 | 选择相关技能及定向检查 | 工作区隔离、真实错误和凭据保护 |
| 保存与集成 | 复用同内容候选，处理并发冲突 | 保存不等于验收或发布 |
| 发布 | 观察同一获准发布作业到真实终态 | 独立发布授权、锁、迁移、备份及健康检查 |

对应实现：[direct运行模块](../docker/harness/forge-direct-development.mjs)、[项目模板](../templates/project/project.env.tpl)、[worker隔离安装](../scripts/install-direct-worker-isolation.sh)。专业技能保留技术合同，非direct模式按需读取各技能的 `CONTROLLED.md`。

启用需对齐 Manager、Harness、worker、Acceptance Service、Broker、Runner 和现有项目配置。必须通过版本化制品升级实际消费者，不能仅改一处变量就认定已启用。direct worker 需要 Linux、Bubblewrap、AppArmor ABI 4.0 及仓库固定 seccomp 配置；Harness 本体仍保留容器隔离。

当前目标、语义意图及授权由各执行和验收组件核对。资料、引用、历史请求不构成新写入授权；解释服务不可用不等于允许执行。模型叙述不能代替任务终态或运行结果。

本页说明源码行为及启用条件；本次公开同步没有执行新环境部署。详见[公开版本边界](release-status.md)。
