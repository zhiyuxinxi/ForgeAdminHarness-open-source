# 工作舱运行版本

平台支持按配置选择运行版本；注册记录描述源码、镜像、Skills 和 Host bundle 的组合。配置中登记版本不代表制品已构建或可从公共镜像仓库拉取。

操作者应先准备所需镜像与依赖，再通过项目运行版本设置和受控升级路径让实际消费者使用同一组合。新建工作舱和已有工作舱分别核对；不要覆盖用户会话或将版本切换当作业务发布。

运行源：[运行版本注册](../docker/harness/harness-runtime-versions.mjs)、[版本配置](../config/versions.env)、[Manager](../docker/harness/conversation-manager.mjs)。具体安装条件和未验证事项见[上手指南](getting-started.md)、[公开版本](release-status.md)。
