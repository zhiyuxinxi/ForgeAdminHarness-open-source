# 运维指南

本页面向部署管理员；普通使用者从[上手指南](getting-started.md)进入。以下命令以源码仓库根目录为当前目录，以 `demo` 为项目示例，执行时替换为真实 slug。需要 Docker、受限目录或主机权限的命令使用经授权的运维身份。

## 先分清四种身份

- 平台源码版本：当前公开或维护仓库提交。
- 控制组件版本：Harness、Manager、Broker、Host 验证服务、验收服务和 Runner 实际消费的版本。
- 项目代码版本：工作舱候选、集成提交与私有远端提交。
- 已发布应用版本：发布任务绑定的提交、镜像及运行结果。

升级其中一种不代表其他三种已同步。公开更新节奏见[公开版本说明](release-status.md)。

## 日常观察

```bash
sudo bash scripts/conversation-control-planectl.sh status
sudo bash scripts/projectctl.sh demo status
sudo bash scripts/projectctl.sh demo access
sudo bash scripts/project-gitctl.sh demo status --require-synchronized
```

按问题读取直接相关日志：

```bash
sudo bash scripts/projectctl.sh demo harness-logs
sudo bash scripts/projectctl.sh demo logs forge-admin
```

日志命令持续跟随输出，可用 Ctrl+C 退出。不要为排查某个对话，重启所有项目或删除共享缓存。

## 账号与项目准入

```bash
sudo bash scripts/conversation-userctl.sh list
sudo bash scripts/conversation-userctl.sh create --username alice --display-name "Alice" --role member --project demo
sudo bash scripts/conversation-userctl.sh projects alice demo
sudo bash scripts/conversation-userctl.sh reset-password alice
sudo bash scripts/conversation-userctl.sh status alice disabled
```

`projects` 用给定列表设置成员项目关系，调整前核对已有授权。重置密码和停用账号影响该成员访问，不能作为无副作用排障。临时密码不应进入公开 Issue、共享日志或文档。

平台账号与文件网关账号是不同入口，不能假定创建其中一个就已获得另一个权限。

## 文件资料与文档门户

文件网关提供完整文件夹上传入口，源码命令包括：

```bash
sudo bash scripts/file-gatewayctl.sh bootstrap
sudo bash scripts/file-gatewayctl.sh sync-projects
sudo bash scripts/file-gatewayctl.sh status
sudo bash scripts/file-gatewayctl.sh access
```

首次使用 `bootstrap` 会创建状态、启动服务并创建初始用户；已存在的环境按需要使用 `sync-projects`。保持项目目录和授权对应，使用者上传前确认目标项目。对话附件和项目目录资料的区别见[架构](architecture.md)。

[AI 作业手册](ai-delivery-playbook/README.md) 可直接在 GitHub 阅读，无需先部署门户。`playbook-portal/` 是可选网页源码；网页内容随构建更新，修改 Markdown 不代表已部署网页自动更新。公开仓库不提供维护环境的公共访问地址。

## 验证、发布和停止

`projectctl.sh demo validate` 核对项目 Compose、资料目录、私有 Git 同步与应用运行合同。它不是业务测试，不应把“配置有效”报告为“功能已验收”。

初次启动入口 `projectctl.sh demo up` 会构建并启动应用；日常业务候选应沿当前项目配置的 Broker/Runner 受控发布路径，保持对话、候选、验证和发布任务的对应关系。

`start`、`stop`、`restart` 操作现有容器。`down` 移除服务容器及网络并保留卷；它会影响当前访问，不是清理磁盘或修复未知状态的常规办法。运行中有其他使用者时，先安排维护窗口。

## 备份与恢复

源码入口为 [projectctl.sh](../scripts/projectctl.sh) 中的 `backup` 与 `restore`，分别要求维护窗口确认及破坏性恢复确认。首次恢复前需核对项目身份、数据范围、数据库、卷、工作舱和 Git 密钥的恢复方式；没有经过试恢复，不宣称具备灾备能力。

不要从公开文档直接复制带真实项目名的恢复命令。不要把备份包、凭据目录或运行状态提交到公开仓库，也不要在故障恢复时删除唯一有效副本。

## 更新维护

按要变更的组件核对固定版本与直接消费者；更新模板不会自动迁移既有项目，基础镜像升级也不表示旧工作舱已更换。维护前记录版本与恢复依据，维护后核对目标组件实际版本和受影响路径即可。

私有开发仓库到此公开仓库采用阶段性源码快照；公开同步是维护者整理与发布的工作，不是使用者在业务环境运行 `sync-baseline.sh` 的同义词。该脚本维护宿主基线，不负责从私有仓库导出 GitHub 开源版。

遇故障保留当前候选、任务标识和脱敏错误，按[故障排查](troubleshooting.md)处理直接问题，不盲目重建整个平台。
