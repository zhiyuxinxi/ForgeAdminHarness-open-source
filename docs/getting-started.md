# 上手指南

请选择一条路径：

- **已有可用平台和账号**：直接读下面“普通使用者”，无需自己安装 Docker、数据库或模型服务。
- **只想先体验业务系统底座**：从 [ForgeAdminFoundation](https://github.com/zhiyuxinxi/ForgeAdminFoundation) 的 README 与安装文档开始。
- **准备自建交付隔离台**：先核对安装条件和公开快照缺口，再准备部署。

本指南按公开源码核对入口与参数，**尚未完成本公开快照在全新环境中的完整安装、模型对话和发布验收**。下列条件性步骤是部署顺序说明，不是“一键部署”承诺。

## 普通使用者：开始第一次对话

### 1. 获取三个信息

向部署管理员获取平台入口、个人账号和获准项目名称。平台统一入口路径为 `/forge-gateway/`；具体域名、地址和端口由你的部署决定。文档中的示例地址不是公共演示站。

使用自己的账号登录，按页面要求修改临时密码，再选择获准项目。看不到项目时，由管理员核对成员关系，不要借用别人的账号。

### 2. 创建一条只读对话

新建对话后，先用一个小任务确认项目和模型可用：

```text
请先只读了解当前项目，不修改文件、不执行测试、不发布。
告诉我这个项目做什么、主要目录在哪里，并指出一个已有功能的前后端实现入口。
请列出实际读取的文件，把无法核实的内容明确写为未知。
```

预期结果是能够收到模型回复，且引用当前项目中真实存在的源码。页面打开、消息发送成功或模型名称显示出来，不等于该模型已完成有效读取。无法回复时按[故障排查](troubleshooting.md)收集错误。

### 3. 完成一个小的开发任务

只读路径正常后，选择一个范围明确、容易核对的改动，例如调整一个已有表单的说明文字。说明“现在怎样、希望怎样、这次不做什么”，再明确允许修改。不要以第一次使用为由立即开展数据库迁移或全站重构。

有附件时优先使用当前对话上传；完整项目资料目录按管理员提供的文件入口使用。不要上传密码、API Key 或未经授权的客户数据。

需要模板时，从[三分钟快速开始](ai-delivery-playbook/00-开始使用/01-三分钟快速开始.md)或[黄金交付配方](ai-delivery-playbook/06-黄金交付配方/README.md)选择一张工作卡即可。

### 4. 分清完成状态

| 状态 | 至少看什么 |
| --- | --- |
| 代码已修改 | 对应文件及变更内容 |
| 验证已通过 | 本次变更对应的验证结果和未验证范围 |
| 业务已验收 | 使用者按约定角色和步骤观察到结果 |
| 版本已发布 | 对应项目、候选提交、发布任务终态和运行版本 |

只有明确授权发布，且部署配置支持受控发布时，才继续发布。同一项目多人并行时，集成冲突需要在自己的工作舱解决；不要直接覆盖其他人的集成结果。

## 部署者：先核对安装条件

### 当前公开版的具体限制

1. [versions.env](../config/versions.env) 中 Harness、Manager、Broker、受保护验收服务和 Runner 包含维护环境使用的本地镜像引用。这些字符串不等于公开镜像仓库地址，也不证明外部用户能够直接拉取。
2. [sync-baseline.sh](../scripts/sync-baseline.sh) 有基础 Harness 和 overlay 的构建入口，但不能据此认定其一次执行会提供所有独立组件、Host 验证依赖和运行配置。
3. 该脚本首次创建内部 foundation 仓库时，来源是固定的原作者 Forge Admin 上游提交，**不会自动克隆本项目公开的 ForgeAdminFoundation 改造版**。使用改造版需要另行准备、审核并固定对应基线，公开快照尚无本轮全新环境联装验证。
4. [create-project.sh](../scripts/create-project.sh) 明确不创建共享 MySQL 数据库和授权；主库、测试库、初始化数据、Redis 分配及服务配置必须预先准备。
5. 当前创建流程要求每项目独立的私有 SSH Git 远端与写入 Deploy Key；只克隆两个公开仓库不能代替项目交付远端。

上述条件未满足时，先完成缺失的安装材料和适配，不应反复重跑创建命令。查看[公开版本说明](release-status.md)了解可用范围；提交问题时注明是外部全新环境安装。

### 运行环境

| 项目 | 需要准备什么 |
| --- | --- |
| 宿主系统 | 支持 Bash、Unix socket、Linux 文件权限和 Docker 的 Linux 主机；现有脚本不是原生 Windows PowerShell 安装器 |
| 容器与命令 | Docker、Compose 插件，以及 Git、Python 3、jq、OpenSSL、SSH、flock、ss 等脚本使用的工具 |
| 主机账号 | 已存在的交付账号；`DELIVERY_OWNER` 指向它，初始化脚本可创建配置组并调整组成员 |
| 基线与制品 | 固定应用源码、完整控制组件镜像、对应依赖和运行合同；见上方限制 |
| 数据服务 | MySQL 8 系列、Redis；项目主库与测试库、运行与测试 Redis 编号分别规划，具体兼容性以实际底座为准 |
| 模型 | 自行提供账号、网络和凭据；公开代码不附带模型服务。模板包含 DeepSeek/Kimi/GLM Secret 路径，单供应商裁剪不能靠删除文件假定已受支持 |
| 项目 Git | 每项目独立私有仓库、写 Deploy Key 和经可信渠道确认的 SSH 主机指纹 |
| 网络 | 浏览器入口、动态工作舱端口、模型出口和 Git 连接均可达；远程访问采用审核后的可信网络 |

当前没有经过公开环境验证的统一最低硬件规格；资源需求随项目数、并发工作舱和构建负载变化，不把开发者某台服务器配置当作最低要求。

### 1. 获取源码并阅读配置

```bash
git clone https://github.com/zhiyuxinxi/ForgeAdminHarness-open-source.git
cd ForgeAdminHarness-open-source
cp config/platform.env.example config/platform.env
```

仅在新检出、尚未创建本地配置时复制，已有配置需保留。配置的关键字段：

| 字段 | 含义 |
| --- | --- |
| `DELIVERY_ROOT` | 运行数据根目录，示例为 `/srv/forge-delivery` |
| `DELIVERY_OWNER / DELIVERY_GROUP` | 主机交付身份及组 |
| `DEFAULT_BIND_ADDRESS` | 示例为 loopback；远程地址需明确配置 |
| `CONVERSATION_GATEWAY_PORT` | 统一入口端口，示例 13080 |
| `UI_PORT_MIN / UI_PORT_MAX` | 项目应用 UI 分配范围 |
| `SHARED_SERVICES_ENV_FILE` | 受保护的数据库/缓存配置路径 |
| `DEEPSEEK_KEY_FILE / KIMI_KEY_FILE / GLM_KEY_FILE` | 服务器侧模型凭据文件路径 |
| `FILE_GATEWAY_* / PLAYBOOK_*` | 文件入口与只读文档门户配置 |

`platform.env` 是由脚本加载的可信 Shell 配置，只应由部署负责人编辑。实际密码、密钥不要写入公开仓库。应用数据库变量由所采用底座的配置消费，不能仅靠设置一个数据库地址推断初始化完成。

### 2. 准备主机和完整基线

在前述条件明确、配置已审核后，源码提供以下入口：

```bash
sudo bash scripts/bootstrap-host.sh
sudo bash scripts/sync-baseline.sh
```

第一条准备目录、登记文件、权限并调整主机 inotify 配置，不负责安装所有工具。第二条会获取固定上游并构建 Harness 基线，不只是下载文件。它们会写入环境，应在选定的隔离试装主机上执行。

预期产物包括运行根目录中的 `registry/`、`baselines/` 和基线锁。**这仍不足以证明完整平台可启动。** 继续前必须具备所有实际消费者需要的镜像、固定的应用基线、数据库和控制面依赖。上方公开安装缺口没有解决时到此止步，不靠替换标签或关闭校验继续。

### 3. 创建一个试用项目

仅在完整基线已准备好时使用以下参数示例；Git 地址、名称及未占用的 Redis 编号必须替换为自己的值：

```bash
sudo bash scripts/create-project.sh \
  --slug demo \
  --name "演示项目" \
  --git-url ssh://git@git.example.org/team/demo.git \
  --application-runtime pc-only \
  --redis-database 1 \
  --redis-test-database 2
```

首次建议从 `pc-only` 理解项目结构；只有已准备对应移动端源码和构建条件时才选 `pc-mobile`。项目创建完成会输出目录、主/测试库名、应用地址、Gateway 地址和 Deploy 公钥路径。**创建成功不等于数据库已建好、私有远端已绑定或服务已启动。**

### 4. 完成外部依赖和启动

将生成的公钥授权给这个项目的独立私有仓库，按可信渠道核对 Git 服务器主机指纹，再执行：

```bash
sudo bash scripts/project-gitctl.sh demo attach --host-key-sha256 'SHA256:替换为已核实指纹'
sudo bash scripts/project-gitctl.sh demo status --require-synchronized
```

`attach` 会验证写权限并推送当前集成 HEAD，属于真实远端写入。先准备项目专属数据库、授权和初始化数据；文件网关需要先 `bootstrap`，后续新增项目使用 `sync-projects`。这些入口见[运维指南](operations.md)。

相关输入就绪后，项目与统一入口顺序如下：

```bash
sudo bash scripts/projectctl.sh demo validate
sudo bash scripts/projectctl.sh demo up
sudo bash scripts/conversation-control-planectl.sh prepare
sudo bash scripts/conversation-control-planectl.sh up
sudo bash scripts/conversation-control-planectl.sh status
```

已有控制面不得把 `prepare` 当作无影响检查，它包含状态准备和账号迁移。新环境需要确认默认 canonical project 是否适合自己的项目设置。

### 5. 创建成员并核对实际路径

```bash
sudo bash scripts/conversation-userctl.sh create --username demo-user --display-name "试用成员" --role member --project demo
sudo bash scripts/projectctl.sh demo access
```

临时密码只输出一次，应通过安全渠道交给该成员。随后按本页普通使用者流程完成登录、项目选择、创建对话、真实模型读取，再按明确范围验证一个小改动。发布闭环需要另行取得发布任务与实际运行结果，不能用“容器都启动了”替代。

本轮文档整理没有实际执行上述安装、初始化、构建或发布命令。
