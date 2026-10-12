# Forge Admin Harness

围绕 Forge Admin 的 AI 开发与交付平台，提供对话入口、隔离工作舱、模型接入、验证及受控发布工具。

这是由 [zhiyuxinxi](https://github.com/zhiyuxinxi) 维护的公开源码版本。配套低代码底座见 [ForgeAdminFoundation](https://github.com/zhiyuxinxi/ForgeAdminFoundation)。

## 主要能力

- 对话网关、会话管理与模型连接。
- 按项目隔离工作区、网络、卷及运行状态。
- 可复用的开发 Skills、项目模板、验证工具与发布执行链路。
- PC、移动端及流程项目的开发交付支持。
- 基于容器的运行配置、备份和升级脚本。

## 源码目录

| 目录 | 内容 |
| --- | --- |
| `docker/harness/` | Harness 扩展、网关、管理与执行组件 |
| `templates/` | 项目及工作舱模板 |
| `scripts/` | 通用初始化、管理、升级和验证脚本 |
| `config/` | 版本清单与平台配置示例 |
| `tests/` | 平台源代码测试与夹具 |
| `playbook-portal/` | 交付手册门户源码 |

## 使用准备

运行环境主要面向 Linux、Docker Compose、Git、SSH 和 Bash；Node.js 组件要求 Node.js 24 或更高版本。不同可选组件还需要相应数据库、模型服务和构建工具。

1. 阅读 [架构](docs/architecture.md)、[安全边界](docs/security.md) 与 [运维说明](docs/operations.md)。
2. 从 `config/platform.env.example` 准备本机配置，填写自己的安装目录、用户和网络接口。公开示例默认绑定回环地址。
3. 按实际使用的模型准备自己的凭据文件；示例中的文件路径不包含任何密钥。
4. 按 `config/versions.env` 和 `docker/` 中的构建定义准备镜像。已有私有环境的镜像标签不是公开镜像下载承诺。

本次发布交付源码和经清理的配置示例；未在此次发布中执行完整安装、镜像构建或端到端部署验收。使用前需按自己的环境配置并验证。历史内部运维文档和针对特定部署的脚本不属于公开包。

## 公开范围与凭据

公开仓库从清理后的源码快照建立独立 Git 历史，不包含私有仓库历史、账号清单、API Key、部署回执、客户数据、会话记录或本机助手状态。测试中的明确虚构令牌用于验证隔离与权限行为。

请勿提交 `.env`、真实令牌、私钥或运行数据。发现安全问题时，请使用 GitHub 的私密漏洞报告功能，不要在公开 Issue 中粘贴敏感内容。

## 许可证与上游

本项目采用 [Apache License 2.0](LICENSE)。第三方组件保留各自许可证，参见 [NOTICE](NOTICE)。本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的运行基础，并与 [Forge Admin](https://github.com/yaomindong1996/forge-admin) 生态配合使用；不代表上游官方发行版。
