# 运行手册

Codex订阅网络出口的当前精确路由、配置位置和后续调整方法见[Harness Codex网络运维说明](codex-network-operations.md)。

> **文档核对：2026-09-21。** 源码目标、候选制品、已部署范围分别见[当前状态](当前状态.md)，不以本文推断服务器实时状态。日常操作按目标项目与当前运行合同执行；历史一次性升级、模型影子资格与旧cache协议见[过期原文](过期/2026-09-21/docs/operations.md)，不作为今天的待执行计划。部署、停启、凭据和恢复均按当次授权范围操作。

日常使用者和新项目负责人先阅读 [多用户、多对话 AI 交付基线](multi-user-delivery-baseline.md)，确认“个人账号 + 新建独立对话”的使用规则、共享/隔离边界和最低验收矩阵；本文只维护可执行命令、维护窗口和故障处理细节。架构、安全和真实结果分别以 `architecture.md`、`security.md` 和 `validation-evidence/` 为准。

<a id="每个人怎样使用才会自动隔离vpn46"></a>

## 每个人怎样使用才会自动隔离

先区分平台入口、项目业务系统和对话工作舱。端口不同不再代表多套 Harness 账号：

| 示例入口 | 身份域 | 日常用法 |
|---|---|---|
| `http://192.0.2.12:13080/forge-gateway/` | 唯一 Harness 平台账号 | 所有人从这里登录，查看服务器上的项目总数，选择已授权项目，再新建或恢复自己的对话 |
| `http://192.0.2.12:18080/forge/login`、`:18081` | 各 Forge Admin 项目的业务账号 | 项目业务应用登录；端口按项目独立，不是 Harness 账号 |
| `http://192.0.2.12:20005/`、`:20006/` 等动态端口 | 某个 `项目 + 用户 + 对话` 的 TaskSpace | 不作为登录入口；只从统一 Gateway 的“打开 Harness”进入 |
| 历史 `13081` 等端口 | 已退役的项目 Gateway | 不再登录、不再维护第二套密码；迁移回滚窗口外应关闭 |

使用者只遵守五条规则：

1. 每个人使用自己的平台账号登录 `13080`，禁止共用账号。
2. 登录后先选择 Forge Admin 交付项目；普通成员只能进入管理员明确授权的项目。
3. 每项需要独立文件、进程和会话状态的新工作，从当前项目的“我的对话”点击“新建独立对话”。
4. 后续工作从同一项目下自己的对话列表恢复。浏览器新标签和上游 Harness 内的“新聊天”都不会创建新文件工作舱。
5. 完整 Axure/HTML 项目使用 SFTP 递归上传整个文件夹；小批量、当前对话私有文件才使用 Harness 页面上传。

因此，A、B 使用各自账号、选择同一个项目并各自新建对话后，默认就是用户隔离 + 项目准入 + 对话隔离。两人共享该 Forge Admin 项目的集成代码、业务应用、数据库和受控发布队列，但看不到对方对话，也不共享未提交文件、`DSH_HOME`、上传、缓存或进程。即使知道对方动态端口，HTTP 和 WebSocket 仍会按当前账号、项目 membership 与所有者返回 403。

如果一个任务需要多个 AI 并行，仍按“每个 AI 一个 Gateway 独立对话”创建 TaskSpace；不要把多个可写执行者放进同一对话。一个 TaskSpace 内的后台命令和子任务共享同一 clone、`target/`、`dist/`，所以 Maven reactor 必须串行。发布前先 fetch/rebase 最新集成 HEAD；若别的对话已经占用计划中的 Flyway 版本号，后到者顺延为新的前向迁移并在rebased HEAD上核对实际影响面并运行必要验证；不因单个后端改动自动增加前端全量。

### 统一入口与历史迁移

控制平面身份由 `config/platform.env` 的 `CONVERSATION_CONTROL_PLANE_COMPOSE_PROJECT_NAME` 指定，默认仍为 `forge-conversation-control-plane`，prepare 将其保存到该安装目录的 `control-plane.env`。隔离安装须在首次 prepare 前同时指定独立 DELIVERY_ROOT、控制平面名称与端口，并将 `CONVERSATION_CONTROL_PLANE_CANONICAL_PROJECT` 指向该安装注册表中自己的账号迁移来源项目（默认仍为 `forge-base`）；旧配置缺字段继续使用默认身份，已有状态不允许通过改名隐式迁移。当前升级脚本按该身份识别 Gateway，临时候选仍使用独立 Compose 项目名。仅改名称不能证明整个项目、Host、任务和会话已经隔离。

现行入口使用统一Gateway。全新平台的首次管理员密码位于服务器控制面state下，权限0600，首次改密后删除。旧平台账号合并、共享历史恢复和批量TaskSpace迁移属于一次性维护，原操作保存在过期文档；必须先确认实际版本差异及精确容器集合，不能见到旧说明就升级全部项目。

### 账号、密码与项目授权

创建账号并一次授权一个或多个项目：

```bash
sudo bash scripts/conversation-userctl.sh create \
  --username zhangsan --display-name '张三' --role member \
  --project forge-base --project customer-copy
sudo bash scripts/conversation-userctl.sh list
```

原子替换某人的项目授权（参数为空表示撤销全部项目）：

```bash
sudo bash scripts/conversation-userctl.sh projects zhangsan forge-base customer-copy
sudo bash scripts/conversation-userctl.sh projects zhangsan
```

停用账号或重置密码会立即撤销其全部平台 session，但不会删除任何项目中的对话数据：

```bash
sudo bash scripts/conversation-userctl.sh status zhangsan disabled
sudo bash scripts/conversation-userctl.sh reset-password zhangsan
```

迁移前共享会话的人员归属不应猜测；原历史恢复脚本及当时的维护条件见过期文档。已登记个人对话继续按原所有者恢复。

创建和重置命令只显示一次临时密码，应通过批准的密码管理器或安全渠道交给本人。网页也可创建账号、勾选项目权限、停用和重置其他账号。当前登录管理员所在行只允许“修改自己的密码”；服务端拒绝自我重置，避免一次性密码弹窗被强制退出覆盖。管理员忘记密码时，由服务器运维人员使用上面的 Operator 命令精确重置。

管理员可进入授权管理范围并查阅受控只读归档；打开可写Harness仍须通过对话所有者校验，不能接管他人的会话。需要交接时，由原人员在 TaskSpace 内生成 clean checkpoint/候选，经 Broker/Runner 门禁晋升；不要共享账号、Cookie 或动态端口。停止对话是非破坏操作，工作区、会话状态、上传和卷全部保留。

排障顺序：先运行 `conversation-control-planectl.sh status`，再检查目标项目 `conversation-manager` 的 Unix socket、账号状态/membership/审计、对话状态和对应 TaskSpace。401 表示需要重新登录或账号会话已撤销；403 表示没有项目权限或不是对话所有者；409 表示对话未运行或状态冲突；503 表示目标项目 Manager 或鉴权 socket 不可用。不得用静态 TaskSpace token 绕过 conversation 模式。

如果“已有运行中对话正常，但 stopped 对话重新打开或新建对话返回 `CONTROL_FAILED`”，先在目标项目 Manager 内执行真实控制面预检。`healthy` 不能只表示 Node HTTP 进程存活，必须证明 `taskspacectl` 及其精确依赖可读：

```bash
docker exec forge-<slug>-conversation-manager-1 \
  /opt/forge-delivery-platform/scripts/taskspacectl.sh <slug> preflight
```

正确契约为：Manager 只从项目 `project.env` 接收 `DELIVERY_ROOT`、`DELIVERY_OWNER`、`DELIVERY_GROUP` 等非秘密控制变量；宿主 `config/platform.env` 继续保持 root-only，既不挂载给 Manager，也不放宽权限。`project.env`、所有 `taskspaces/*/task.env` 均由 `${DELIVERY_OWNER}:${DELIVERY_GROUP}` 持有且权限为 `0600`；`metadata.json` 和 TaskSpace token 同样不得漂移为 `root:root/0600`。统一升级脚本会在主流程和回滚流程显式恢复这些属主。禁止把文件改成 world-readable、让 Manager 以 root 运行或直接挂载平台秘密来绕过：

```bash
stat -c '%U:%G %a %n' /srv/forge-delivery/projects/*/ops/project.env
find /srv/forge-delivery/projects -path '*/taskspaces/*/task.env' \
  -printf '%u:%g %m %p\n'
```

平台账号、membership、统一审计和每项目 Manager capability 不属于任何单个 Forge Admin 项目恢复包。定期或在账号/授权批量变更后单独生成一致性备份：

```bash
sudo bash scripts/backup-conversation-control-plane.sh \
  --confirm-maintenance-window conversation-control-plane
```

脚本短暂停止统一 Gateway，归档平台 state/audit、Operator token、每项目 Manager token、控制面环境和项目登记快照，排除全部运行时 socket，写入 SHA-256 后恢复 Gateway。备份包含密码哈希、session 状态和 capability token，目录/文件权限固定为 0700/0600，离机前必须加密。恢复会撤销浏览器 session、可能回退账号授权并要求重启所有项目 Manager，属于独立破坏性 runbook；不能把解压覆盖当作普通项目恢复步骤。

## 多人项目的 TaskSpace 标准操作

日常新建与打开对话通过Gateway完成，conversation模式不会输出静态访问token。运维只读核对使用：

```bash
sudo bash scripts/projectctl.sh <slug> taskspace list
sudo bash scripts/projectctl.sh <slug> taskspace status <task-id>
```

旧token模式的CLI create/access与vpn27迁移见过期原文，不能代替个人账号归属。TaskSpace的`/workspace`是业务写目录；集成仓、私有输入和项目资料按合同只读挂载，上传由Sidecar处理。

停止和关闭均保留恢复材料：

```bash
sudo bash scripts/projectctl.sh <slug> taskspace stop order-import-001
sudo bash scripts/projectctl.sh <slug> taskspace start order-import-001
sudo bash scripts/projectctl.sh <slug> taskspace close order-import-001
```

`stop`/`close` 不执行 volume 删除，也不删除工作区。当前版本刻意没有 `delete/destroy`；清理任务数据必须另走备份、目标复核和明确批准的销毁 runbook。项目 `down` 会先停止未关闭工作舱，再移除项目容器/网络并保留数据卷。

发布冲突处理：`TASKSPACE_RELEASE_IN_PROGRESS` 等当前项目作业结束后重新 preflight；`TASKSPACE_REBASE_REQUIRED` 在当前 clone 获取 `/integration` 最新提交，显式 rebase/merge、解决冲突、重测并提交；`CANDIDATE_COMMIT_MISMATCH` 视为检查后候选被改变，不得重试旧请求。数据库失败先 `forge-release diagnose`，修正并提交新的向前迁移后走普通发布，Runner 自动恢复固定 `_test` 沙箱。

## 服务器访问约定

- 主交付服务器：`192.0.2.12`；运维账号：`forge`。
- 当前运维机使用专用 SSH key：`C:/Users/developer\.ssh\id_ed25519_forge_delivery`。
- 密码正文仅保存在项目根目录本地文件 `服务器账号密码.txt`。该文件已被 Git 忽略并限制为当前管理员、SYSTEM 与本机 Administrators 访问。
- 文件网关首批账号分发回执位于项目根目录本地文件 `文件网关初始账号.txt`，采用相同的 Git 忽略与 ACL 保护；服务端原始回执仍位于 `/srv/forge-delivery/file-gateway/bootstrap-credentials.txt`（`0600`）。
- 自动化只允许在进程内读取该凭据，不把密码正文复制到项目文档、Memory、日志或聊天；sudo 继续只执行精确且已审查的运维命令。

## 历史部署记录

旧vpn50/51/55定向部署的镜像、TaskSpace与命令已移入[过期原文](过期/2026-09-21/docs/operations.md)。新的切换仅按当轮已审清单进行，不照抄历史SHA或容器集合。

## 生命周期

1. `bootstrap-host.sh`：只准备宿主机目录、组和登记表，不安装或重装 Docker；
2. `sync-baseline.sh`：在线环境验证上游ref/commit并准备固定基线。历史12号机曾采用离线种子/镜像导入；新项目安装源覆盖欠项见TODO-044，不能从已完成的同项目新舱创建推断全新项目链路全部通过；
3. `conversation-control-planectl.sh`：准备/启动唯一 Gateway、平台账号状态、项目目录和分离的 Operator/鉴权 Unix socket；
4. `create-project.sh`：要求项目独立私有 Git SSH URL，原子创建项目目录、独立 Git 工作库/分支、项目 Deploy Key、Forge UI 端口、数据库名、Redis 运行/测试 DB、项目 Manager capability、受控发布运行契约和 Compose 配置；新项目在 Deploy Key、Git Host Key 与初始远端 HEAD 验证完成前保持 pending，不自动改共享服务，也不自动启动；
5. `projectctl.sh validate/up`：人工复核后构建并启动；项目登记会被统一 Gateway 动态读取，再用 `conversation-userctl.sh projects` 授权成员；
6. `backup-project.sh` / `restore-project.sh`：在精确项目恢复锁和维护窗口内生成/恢复带 SHA-256 的完整项目恢复包；恢复前保留安全副本，失败自动回滚，不归档运行时 socket；平台账号/membership 状态属于独立控制面备份对象，不能用任一项目包替代；
7. `file-gatewayctl.sh`：维护共享 SFTPGo、项目上传目录、初始用户和上传组权限；
8. `playbookctl.sh`：构建、校验和运行只读 AI 交付作业门户，镜像按内容哈希留痕并固定到本地不可变 image ID；
9. `projectctl.sh <slug> controlled-release`：在维护窗口把已有项目迁移到白名单 Runner；脚本会先检查近期会话写入并在发现活跃会话时回滚退出；
10. 下线、恢复和删除：一期只提供保留应用卷的 `down`，不可逆动作必须另行评审。

## AI 交付作业门户

在已获准发布门户的范围内执行（本轮仓库文档整理不执行）：

```bash
sudo bash scripts/playbookctl.sh bootstrap
sudo bash scripts/playbookctl.sh validate
sudo bash scripts/playbookctl.sh status
sudo bash scripts/playbookctl.sh access
```

门户把 `docs/ai-delivery-playbook` 在镜像构建阶段编译为静态站点，不在运行时读取仓库，
也不接受在线修改。需要让修订内容出现在网页时，须按独立发布授权重新构建并执行`bootstrap`；仅提交文档不会更新现网。脚本计算完整来源哈希、
构建固定标签镜像，再把实际 image ID 和来源哈希写入权限为 `0600` 的
`/srv/forge-delivery/playbook-portal/playbook.env`。启动时会再次校验镜像标签中的来源哈希。

公司 VPN 用户访问 `http://192.0.2.12:15080`。门户支持目录树、中文搜索、任务提示词复制、
全文复制、Markdown 下载、分享链接和打印；不提供上传、编辑、模型调用和发布能力。
停机使用 `sudo bash scripts/playbookctl.sh down`，该命令不删除文档源文件、镜像或其他项目数据。

## 基线升级

上游基线升级须固定ref/commit，不使用浮动`latest`。通常采用独立评估分支；Owner明确要求直接main时遵循授权。升级流程：

1. 在独立评估分支更新 `config/versions.env` 的 ref、commit 和版本；
2. 检查上游 CHANGELOG、许可证、Dockerfile、数据库迁移和安全变更；
3. 运行 `tests/validate.ps1`，在隔离项目执行构建、登录、权限、CRUD、流程、备份恢复和 Harness 黄金任务；
   Harness 验收不能停在 Web 200，必须覆盖工作区选择、模型选择、真实模型响应、文件写入/读取、服务器侧内容核对和测试文件清理；普通 HTTP 入口还要验证 `crypto.randomUUID` 兼容层与 WebSocket 实时会话；
4. 记录镜像 ID/摘要和验证结果；
5. 只影响之后创建的新项目。已有客户项目通过单独升级任务迁移，不能被基线同步隐式覆盖。

## 项目创建与启动

```bash
bash scripts/create-project.sh \
  --slug demo-project \
  --name '演示项目' \
  --git-url 'ssh://git@<git-host>/<namespace>/demo-project.git' \
  --redis-database 2 \
  --redis-test-database 15
sudo bash scripts/projectctl.sh demo-project validate
sudo bash scripts/projectctl.sh demo-project up
sudo bash scripts/projectctl.sh demo-project status
sudo bash scripts/file-gatewayctl.sh sync-projects
```

首次 `up` 之前必须人工完成并复核：

1. MySQL 创建 `forge_demo_project` 和 `forge_demo_project_test`，两个库都必须使用 `utf8mb4` / `utf8mb4_0900_ai_ci`；
2. 给项目运行账号仅授予上述两个库的权限；
3. 确认 Redis 运行逻辑库 2 和测试逻辑库 15 彼此不同，且均未登记给其他项目；
4. 在私有 GitLab 建立同项目独立空仓库，把 `/srv/forge-delivery/git-remotes/<slug>/id_ed25519.pub` 登记为可写 Deploy Key；
5. 从独立可信渠道核对 Git SSH Host Key 的 SHA-256 指纹，执行 `projectctl.sh demo-project git attach --host-key-sha256 <SHA256:...>`；
6. 核对 `/srv/forge-delivery/registry/projects.tsv`、项目 `ops/project.env` 和私有远端分支 HEAD 一致。

MySQL 8 建库示例（由 DBA 使用具备授权能力的账号执行，账号名和密码不得写入脚本或台账）：

```sql
CREATE DATABASE `forge_demo_project`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE `forge_demo_project_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

不要沿用服务器或旧库的默认排序规则。Forge Admin 初始化表使用 `utf8mb4_0900_ai_ci`；混用其他排序规则会在后续 Flyway SQL 的字符串比较中触发 collation 冲突。

`sync-projects` 是幂等的：它为登记表中的每个 slug 创建上传目录，并更新共享上传
组的路径权限。创建项目本身仍不依赖 SFTPGo；文件入口暂时故障不会让项目创建
回滚或修改客户代码。

## 产品与业务文件入口

首次部署：

```bash
sudo bash scripts/file-gatewayctl.sh bootstrap
sudo bash scripts/file-gatewayctl.sh validate
sudo bash scripts/file-gatewayctl.sh status
sudo bash scripts/file-gatewayctl.sh access
```

`bootstrap` 固定使用 `config/versions.env` 中带 digest 的 SFTPGo 镜像，只绑定
平台批准的 VPN 地址，创建所有登记项目目录、共享上传组以及
`product-upload`、`business-upload`、`delivery-upload` 三个初始账号。若目标机
无法访问 Docker Hub，先离线导入同一 digest 的镜像再重试，禁止改用 `latest`。

管理员在 WebAdmin 中创建、禁用账号或调整组；普通用户只使用 WebClient。新增
个人账号也可执行：

```bash
sudo bash scripts/file-gatewayctl.sh add-user product-zhang
```

生成的密码只追加到服务器的 `bootstrap-credentials.txt`。脚本发现同名用户时
不会覆盖其密码。停机使用 `file-gatewayctl.sh down`，该命令只删除容器和网络，
保留 SQLite、主机密钥、上传文件及本地配置。

新增项目后，先运行 `file-gatewayctl.sh sync-projects`，再启动项目应用/Broker 并创建 TaskSpace。文件网关的 `<slug>/` 目录是该项目的 SFTP 输入根；当前默认 `PROJECT_MATERIAL_ACCESS_MODE=direct`，同项目 TaskSpace 以只读 `/project-ftp-inputs` 直接读取，不需要管理员审核。不同项目仍使用不同宿主目录和 membership，不能跨项目读取。

### 递归上传完整 Axure/HTML 文件夹

协议必须选择 **SFTP**，不是传统明文 FTP。SFTPGo WebClient `http://192.0.2.12:14080/web/client` 支持文件夹拖放：先进入精确项目 `<slug>/`，打开 **Upload Files**，再从文件资源管理器把整个文件夹拖入上传框；确认队列显示 `顶层目录/子目录/文件` 且停止增长后再提交。普通点击选择文件不会表达“选择整个目录”，不要用它代替文件夹拖放。

大目录也可使用 WinSCP 或 FileZilla；连接参数为服务器 `192.0.2.12`、端口 `14022`、分配给个人的上传账号。无论使用网页还是客户端，都必须保留 `index.html`、页面 HTML、`files/`、`resources/`、`data/`、图片、CSS 与 JavaScript 的相对层级。不要只挑 HTML 文件，也不要求先压 ZIP。面向产品人员的完整步骤与可复制 Harness 指令见 [上传完整原型文件夹并让 AI 复刻](ai-delivery-playbook/00-开始使用/05-上传原型文件夹并让AI复刻.md)。

OpenSSH 客户端可使用：

```text
sftp -P 14022 <upload-user>@192.0.2.12
sftp> cd <project-slug>
sftp> put -R <local-axure-folder>
```

上传账号是 append-only 权限：可以列目录、创建目录和新增文件，不能下载、覆盖、删除、重命名或修改服务器时间戳。每批使用带时间的唯一顶层目录名；大目录中断后不要盲目覆盖，应换一个新目录名重新上传，或由管理员核对残留目录后处理。不要为了“续传方便”放开覆盖/删除权限。

上传完成后，在该项目任一 TaskSpace 中让 AI 执行：

```bash
forge-prototype-index /project-ftp-inputs/<local-axure-folder>
```

命令先等待默认 2 秒目录稳定窗口，并在发布索引前再次核对全树。上传仍在继续或扫描期间新增/修改文件时返回 `PROTOTYPE_DIRECTORY_INCOMPLETE`，不会把半成品目录标记为 ready。成功后返回 `/workspace/.forge-cache/prototype-index/prototype-<fingerprint>/README.md`。AI 先读该 README，再按页面表读取 `pages/*.md`；需要精确复刻时才回到 `/project-ftp-inputs/<文件夹>` 读取对应 HTML、`files/<页面>/data.js`、CSS、SVG 和图片。索引器只静态分析，不执行上传目录中的 JavaScript；第二次对同一内容运行应返回 `idempotent: true`。ZIP 仍支持安全解压与索引，但只是可选兼容路径。

TaskSpace Harness 页面同时提供私有直接文件上传：点击输入框工具栏的“上传文件”，或把文件
拖到输入区。文件逐个显示校验、进度、取消、失败重试和完成状态；成功路径先回填到
输入框，由使用者确认后再发送给模型。默认限制为单文件 50 MiB、每批 20 个且合计
200 MiB、TaskSpace 累计 10 GiB。这些值在项目 `project.env` 中可按评审结果调整：

```text
HARNESS_UPLOAD_MAX_FILE_BYTES=52428800
HARNESS_UPLOAD_MAX_BATCH_FILES=20
HARNESS_UPLOAD_MAX_BATCH_BYTES=209715200
HARNESS_UPLOAD_MAX_PROJECT_BYTES=10737418240
```

MD/Markdown、TXT、CSV、JSON、YAML、XML、SQL 和 LOG 在上传后直接作为 AI
可读输入。PDF、Word DOCX 和 Excel XLSX 会由 `harness-upload` 生成同目录
`<原文件>.extracted.md`，页面显示“已上传并生成 AI 可读副本”，并同时回填
原件和副本路径。旧式 `.doc` 不在当前解析范围，需先转为 `.docx`。文档解析的
默认硬限额如下：

```text
HARNESS_DOCUMENT_MAX_SOURCE_BYTES=26214400
HARNESS_DOCUMENT_MAX_OUTPUT_BYTES=1048576
HARNESS_DOCUMENT_MAX_PDF_PAGES=200
HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS=2000
HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS=100
```

模型应加载镜像内置的 `project-document-reader` Skill，对 PDF/DOCX/XLSX 优先 `Read`
`*.extracted.md`。若早期上传的二进制文件没有副本，可在 Harness 中对其只读路径执行：

```bash
harness-document-extract /project-inputs/incoming/<date>/<batch>/<file.pdf>
```

该命令只向标准输出返回有界文本，不写工作区。对新上传文件应使用 Sidecar
预生成副本，以保持用户界面、审计记录与模型读取路径一致。

上传排障先用对话页确认 TaskSpace ID，再检查该 TaskSpace 的 Harness/Sidecar 健康和日志；不要把上传目录改为 Harness 可写。项目级 Compose 中的旧 `harness`/`harness-upload` 位于退役 profile，不能代表当前对话：

```bash
sudo bash scripts/projectctl.sh <slug> taskspace status <task-id>
docker compose \
  --env-file /srv/forge-delivery/projects/<slug>/taskspaces/<task-id>/task.env \
  --file /opt/forge-delivery-platform/templates/taskspace/compose.yaml \
  logs --tail 200 harness-upload harness
```

当前对话上传位于 `projects/<slug>/taskspaces/<task-id>/uploads/incoming/<date>/<batch>/`，审计位于同一 TaskSpace 上传根的 `.upload-audit.jsonl`，schema v2 应包含 `projectSlug/taskspaceId/actorId/conversationId`。文件网关原始资料则位于 `file-gateway/data/<slug>/`，两者不能混为同一归属。

Harness 分析当前对话私有资料时使用 `/project-inputs/<相对路径>`；分析 SFTP 项目目录时使用 `/project-ftp-inputs/<相对路径>`，不得改走
SFTPGo WebClient、分享 URL 或 SFTP 下载。预留审核模式的批准资料使用 `/project-shared-inputs/<分类>/<文件>`。共享上传组有意不授予 `download`，所以
通过文件网关下载/分享端点读取会返回 `403 permission denied`；这表示网关下载策略
生效，不表示 Harness 的只读挂载或宿主机文件权限异常。排障时应在 Harness 工具链
内对目标路径执行可读性检查，并以实际读取/哈希结果作为验收证据。

### 预留的项目资料审核模式与迁移

当前默认 `direct` 模式不要求管理员审批，Gateway 会隐藏审核面板。以下能力保留给未来合规项目切换 `PROJECT_MATERIAL_ACCESS_MODE=reviewed` 使用：管理员在统一 Gateway `13080` 的项目卡片进入“项目资料”；普通成员只看到已批准资料，管理员额外看到待审区、来源状态、哈希与批准按钮。旧 schema v1 审计显示 `legacy-unattributed`，手工放入的文件显示 `untracked`，均不得猜测上传人或对话。

服务器运维可用同一 Manager capability 执行等价操作：

```bash
sudo bash scripts/project-materialctl.sh <slug> list --include-intake
sudo bash scripts/project-materialctl.sh <slug> promote \
  --source 'incoming/<date>/<batch>/<file>' \
  --category business \
  --actor <operator-id>
```

分类只允许 `business`、`standards/ui`、`reference`。批准会重算 SHA-256、拒绝路径穿越/符号链接/覆盖，复制到 `projects/<slug>/shared-inputs/accepted/` 并追加 `shared-inputs/governance/material-events.jsonl`；不会移动或删除原始文件。删除、归档或改分级仍是单独资料治理动作。

资料隔离、目录直读和vpn44缓存迁移的历史脚本保存在过期原文。现有项目先核实际模式、挂载和缓存消费者；只处理获准项目，保留失败现场与昂贵缓存，不将单项目问题扩成全平台注册项目升级。

项目创建后即有完整本地 Git 历史、独立交付分支和项目身份配置，无需再次执行 `git init`。达到一个已验证的业务里程碑、准备把工作移交给其他会话/人员、高风险修改前或发布前，在 Harness 中加载 `forge-git-checkpoint`：显式分类和暂存本轮文件，检查 staged diff 后提交。禁止后台定时器在模型仍编辑时强行提交，也禁止用 `git add .`、`git clean` 或 `git reset --hard` 处理共享工作区。

### Skills、运行镜像与项目上下文

Skills由版本化镜像交付，也支持独立只读bundle；激活指针和运行中会话是否加载必须另行核实。21项清单、成熟度、源码与线上差异见[能力目录](harness-skill-catalog.md)。当前部署边界见[当前状态](当前状态.md)。

平台私有`governance/PROJECT_CONTEXT.md`在创建、启动、恢复与升级时核对路径、managed marker和SHA-256，再只读挂载。不得覆盖客户Git跟踪的`AGENTS.md`。旧全量升级及其一致性/回滚条件保存在过期原文；当前采用拆分组件的精确切换，不要求35个旧舱随本轮自动重建。

私有 Git 远端不是可选备份，而是项目发布契约。新项目必须传入不含密码的 SSH URL；创建后先登记 Deploy Key，再固定 Host Key 并完成初始推送：

```bash
sudo bash scripts/projectctl.sh demo-project git prepare \
  --git-url 'ssh://git@<git-host>/<namespace>/demo-project.git' \
  --branch delivery/demo-project

# 把命令输出的公钥登记到这个 GitLab 项目，权限只开 write_repository。
sudo bash scripts/projectctl.sh demo-project git attach \
  --host-key-sha256 '<从独立可信渠道核对的 SHA256 指纹>'

sudo bash scripts/projectctl.sh demo-project git-remote-runtime \
  --confirm-maintenance-window project-git-remote
sudo bash scripts/projectctl.sh demo-project git status --require-synchronized
```

每个项目使用独立 Ed25519 Deploy Key；私钥只在项目根之外的 `/srv/forge-delivery/git-remotes/<slug>` 中保存，避开 Manager 的项目根挂载和 Runner 的 `ops` 挂载，并直接只读挂载给 Broker。Broker在发布锁内核远端HEAD与集成HEAD一致，先完成候选准备检查，再普通fast-forward推送并推进本地集成线；后续迁移与部署仍可能独立失败。Manager/Runner 的 Docker 权限仍是特权信任边界，不得把“无直接挂载”宣传为已失陷控制面也无法访问宿主。禁止把 GitLab 密码或 PAT 写入 remote URL、`project.env`、Git credential helper、文档、Memory 或聊天。

已有项目迁移也使用上述三步。`prepare` 只生成密钥并登记 pending，不重启容器；`attach` 只在 Host Key、Deploy Key 权限和初始 HEAD 全部通过后标记 ready；`git-remote-runtime` 需要无发布作业的维护窗口，只更新版本化 Compose 并以 `--no-deps` 重建 Broker，不重建 Harness、Runner 或 Forge 应用。远端已有不同历史时必须停止并人工评审，任何脚本都不会 force push。

## 当前受控验证与依赖准备

普通任务按明确需求和实际变更面选择最少必要profile；纯后端任务不因背景提到页面就扩大到前端。模型提交给Broker/Host的请求只能使用受控动作和固定profile，不能携带任意宿主argv/env/cwd。真实测试失败保留首次日志与责任分类，业务缺陷回到Harness对话修复；平台能力缺失由平台修复。

原vpn71影子writer资格、强制RED顺序、预算次数与旧admission/cache协议是历史实现快照，不是当前普通开发的统一前提。当前仍须真实测试、来源/范围核验、凭据隔离和明确发布授权；暂停流程阻断不等于取消这些边界。最新范围与Skills修复已进候选但尚未全部启用，详见总TODO003/078/079。

依赖同时有版本化seed和TaskSpace私有缓存：优先保留兼容私有缓存，缺失时从只读seed恢复；服务器BuildKit缓存用于准备seed，不直接共享给模型。Maven消费已验证；pnpm执行位及重复install的准备产物复用仍待077/075。耗时记录须区分下载、索引检查、安装、编译、模型推理及工具等待，不能把日志出现仓库URL说成重新下载。昂贵资源复用与配置格式见[容器操作经验](packaging-container-operations.md)。

## 访问

部门成员连接公司 VPN 后，用 `projectctl.sh <slug> access` 查看 Forge UI 和 Harness 的直接访问地址。服务只绑定服务器指定网卡地址，不绑定 `0.0.0.0`；SSH 仅用于服务器运维，并继续要求个人账号。

模型菜单与真实连接以当前项目配置和对话证据为准；不能用旧DeepSeek/Kimi列表限制已接入的Codex。模板还支持 `GLM-5.3` 菜单项，使用智谱 OpenAI-compatible 基址 `https://open.bigmodel.cn/api/paas/v4` 和 `GLM_API_KEY`；只有在 root 以交互方式安装 `/srv/forge-delivery/secrets/glm-api-key`、完成受控维护升级并通过真实账号调用验证后，才能称服务器已启用 GLM。Gateway 创建 TaskSpace 时会自动登记并打开当前对话专属的 `/workspace`，使用者不需要选择或新建文件夹；如果页面仍要求手工选择，应按生命周期缺陷处理并检查 `seed-default-workspace`，不能让多人指向宿主共享目录。模型配置保存在项目 `dsh-home/settings.yaml`，只引用环境变量；真实 Key 来自 `/srv/forge-delivery/secrets/` 下的 Docker Secret。不要在浏览器设置、会话提示词或项目文件中粘贴 Key。

公司 VPN 内的项目把 `HARNESS_PRIVILEGED_API_MODE=trusted-host` 写入 `ops/project.env`，TaskSpace 继承该设置并额外要求私有访问令牌。若设置页出现 `credentials.describe` 或 `settings.describe` 403，依次检查：是否使用 `taskspace access` 生成的 URL 建立 cookie、浏览器地址是否与工作舱端口完全一致、`project.env` 是否启用 `trusted-host`、运行镜像是否为当前版本。其他环境使用 `loopback-only`；工作舱令牌不能替代 HTTPS 和个人身份认证。

vpn11 对会话历史继续使用上游原生的 `beforeSeq/maxMessages/hasMore` 分页：首次加载最新 5 个消息边界，向上滚动进入顶部阈值时自动再取 5 个，并保持当前位置；页面顶部“加载更早”按钮继续作为键盘访问和异常情况下的兜底。适配器只响应可信用户滚动，每次到顶最多触发一个请求，离开顶部区域后才重新启用，避免并发重复加载；代理同时对 JSON/JS/CSS 启用 gzip。历史验收至少要逐条打开项目现有会话、对最长会话向上滚动连续自动加载 3 页、确认网络中每次只有一个 `session.history`、滚动锚点不跳、无 `The user aborted a request`，并检查浏览器控制台。

业务功能的正常交付路径是：在 Harness 会话里明确指定模型和验收目标，由模型写代码并执行测试；达到可验证里程碑后加载 `forge-git-checkpoint`，只提交已核实的本轮文件。用户明确要求发布后，模型依次运行 `forge-release contract`、`forge-release preflight` 和 `forge-release release`。用户只要求检查、评审或预检时，模型只能执行只读命令并报告问题，不得顺手改代码、提交或发布；如果发生过写入，不得声称全程只读。项目专属 Runner 固定使用平台 `ops/compose.yaml`，先构建版本化候选镜像，再用同一候选 Admin 镜像在登记的 `_test` 库迁移；门禁通过后才更新主库、定向发布应用服务并冒烟。服务器终端只用于一次性能力准备和只读排障，不能把终端人工部署伪装成对话流水线成功。每次发布都要能从 Harness 会话回溯 Runner jobId、Git 提交、迁移版本、镜像 ID、健康状态与回退文件。

业务构建与测试通过当前受控Host profile执行。排查缓存时核对实际消费者、依赖指纹、私有目录、seed和执行权限；不要在Harness内临时安装、修改HOME或切Full Access。普通`job_output wait`仅表明后台作业仍运行，必须结合阶段日志判断下载、编译或进程停滞；不以持续轮询当作进展。

同一 TaskSpace 不得并行启动两条会写同一源码树输出目录的 Maven reactor。出现“上游模块偶发失败、顺序重跑立即成功”时，先检查同一工作舱是否有并发 `mvn`/Surefire 进程和共享 `target/`，不要直接把它归因于业务代码或用无限重试掩盖。确需并行时必须创建独立 Git worktree 并隔离构建输出。

vpn11设置页升级、旧共享Harness受控发布迁移均是历史操作，已归入过期文档。现在新增能力必须通过版本化镜像/模板及精确升级范围交付。

## 项目级备份与恢复

vpn37 已在独立 `forge-replica-acceptance` 上完成“备份 → 全状态损坏 → 精确恢复”，并完成一次“恢复已经开始、后续运行计划失败 → 自动回到恢复前安全状态”的真实演练。操作仍是明确维护窗口，不是定时任务，也不能替代异机加密备份：

```bash
sudo bash scripts/projectctl.sh <slug> backup \
  --confirm-maintenance-window <slug>

sudo bash scripts/projectctl.sh <slug> restore \
  /srv/forge-delivery/backups/<slug>/<timestamp> \
  --confirm-destructive-restore <slug>
```

备份前要求集成 workspace clean、没有项目发布锁、Runner 无运行作业；脚本取得项目 recovery lock，记录当前核心服务和 active TaskSpace，依次停止 TaskSpace/服务后导出精确登记的主库、`_test` 库、两个 Redis 逻辑库、项目 bind-state、共享上传和 crypto 卷。`manifest.json` 和 9 个数据 payload 写入 `SHA256SUMS`，所有文件 0600、目录 0700；Unix socket、TaskSpace 可重建缓存和项目 Git 私钥不归档。原位恢复保留 `/srv/forge-delivery/git-remotes/<slug>`；跨机恢复必须重新生成/登记 Deploy Key、复核 Host Key 并重新 `attach`。无论成功或失败，备份脚本都会尝试恢复原运行集合。

恢复只接受解析后位于 `/srv/forge-delivery/backups/<slug>/` 的目录，先校验 checksum、slug、registry row、数据库/Redis/crypto 身份、服务集合和 TaskSpace ID。真正修改前在 `/srv/forge-delivery/recovery/<slug>/<timestamp>-pre-restore` 保存当前目录、主/测试库、Redis、上传和 crypto 安全副本；任一步失败，trap 会恢复安全副本并重启恢复前的服务/TaskSpace。成功后还必须在 180 秒内通过服务 running、TaskSpace `metadata.json` 为 `${HOST_UID}:${HOST_GID}:0600`、Forge UI、API 和 Gateway 健康门禁，回执写到 `ops/restore-receipt.json`。安全副本与失败现场不会自动删除。

备份/恢复脚本通常由 root 执行，但 conversation-manager 使用项目 `HOST_UID:HOST_GID` 读取 TaskSpace 控制文件。任何以临时文件 + 原子换名更新 `metadata.json` 的路径都必须在换名前恢复该 owner；仅校验 `0600` 不足以证明 Manager 可读。维护结束至少从 Gateway 真实点击一次历史对话的“打开 Harness”，确认 open API 为 200；直接访问已经打开的 200xx 标签、只看容器 healthy 或只请求 Gateway 首页都不能替代这项检查。

恢复完成后的最小人工验收是：集成 HEAD/clean、账号/会话/对话数量、每个所有者列表、A/B TaskSpace 页面、未认证直连 401、主/测试数据库对象和业务哨兵、Redis 两个 DB 的哨兵、共享上传/crypto 哈希、应用 image ID、UI/API/Gateway 200。服务器本地恢复包和 safety copy 仍处于同一故障域；复制离机前必须加密、授权、记录校验和并做定期异机恢复演练。

受控发布生成的 `backups/test-database-snapshots/*.sql.gz` 是候选迁移前的测试 schema 健康恢复点，不是主库备份，也不能替代上述项目恢复方案。每个快照在迁移前完成普通文件、字节数与 SHA-256 复核，并与对象数、Job、提交一起原子登记到 `ops/test-database-recovery.json`；Harness 不挂载快照或状态目录。迁移失败/中断后，下一次普通发布校验该恢复点并自动还原，再执行修正版增量迁移。当前不自动删除快照，容量与留存策略应在高频发布前单独评审。

候选准备成功仍不等于生产发布。新准备登记 `lastAttempt.published=false`，保留已迁移测试库供该候选验收；后续重新准备时，先恢复该候选开始前的已验证快照。同一 prepared 候选的显式运行复验继续复用，不重建或重迁移。只有实际发布包含 `forge-admin` 且部署、冒烟和成功记录均完成，才按准备 Job 与候选提交标记已发布，供后续准备继承；仅发布前端不会晋升数据库基线。历史无此标记的状态保留兼容，已证实的旧恢复点混用须绑定原始快照做受保护纠正，不能靠修改迁移历史消除校验错误。

文件入口不会改变上述结论。项目恢复包必须额外包含
`file-gateway/data/<slug>` 的上传资料和对应校验和；共享的 SFTPGo SQLite/配置
应导出后按项目记录用户、组和权限映射。服务器本机的
`file-gateway/backups` 仍只是暂存区，不是异机备份。

## 故障处理

- 构建失败或重复下载：先记录提交、镜像ID、任务和阶段日志，按实际Host/镜像合同核对Maven localRepository、seed和私有缓存，正式构建另核BuildKit cache；不要直接改基础镜像标签重试；
- 端口冲突：通过登记表重新分配，不手工复用其他项目端口；
- 测试库迁移失败：先用 `forge-release diagnose` 按稳定错误码修正并提交向前迁移，再重试正常发布。Runner 会依据 failed history 和持久 `migration-pending` / `restore-required` 状态，自动从上一次迁移前的已验证健康快照恢复专属 `_test` schema，再执行增量迁移；禁止要求业务人员手工删 failed history、执行 Flyway repair 或直接改库。`TEST_DATABASE_BUSY` 仅在占用消失后重试；恢复点缺失/校验失败时保留证据并走平台恢复，而不是绕过。主库迁移失败仍须停止应用写入、保留现场和备份并走单独恢复评审，绝不自动 reset/repair；
- TaskSpace Harness 异常：只停止对应 TaskSpace，不影响其他工作舱和 Forge 应用栈；保留该任务 `dsh-home`、workspace、上传和日志后再升级或回滚；
- Harness 历史加载失败：先用 Session ZIP 验证数据仍在，再测 `session.history` 响应大小/耗时；核对实际运行版本、`HARNESS_HISTORY_PAGE_MESSAGES=5`、HTML 的 `history-auto-load` 标记、gzip 和 `hasMore`。不得优先把前端超时调大或删除历史；
- Harness 设置/凭据 API 返回 403：不要修改上游 DSH。核对 `HARNESS_PRIVILEGED_API_MODE`、精确访问Host和实际镜像；代理会有意拒绝伪造 Host、跨站 Origin 和非登记入口；
- Harness “设置 → 模型”显示 `settings are unavailable in this browser`，但受信入口直接调用 `settings.describe` 为 HTTP 200：这不是 Secret 丢失或 Runner 故障。固定 DSH 客户端会在 `connection.isLoopback=false` 时把设置镜像切到内存模式，页面因而根本不发出 `settings.describe`。已配置模型仍可从会话模型选择器使用；不要靠重启、改 Secret 或放宽代理绕过。修复必须锁定上游客户端资源版本，在 `trusted-host` 边界内提供版本化兼容层，同时保留 `loopback-only` 和跨站/伪造 Host 负例，并在无活跃会话的维护窗口升级；
- Harness 上传失败：检查目标 TaskSpace 的 `harness-upload` 是否 healthy、TaskSpace `uploads/` 是否存在且属主正确、工作舱总量是否达到上限，再检查同源请求是否返回 403；不得把目录改为 Harness 可写来绕过 Sidecar；
- 项目资料列表/批准失败：先执行目标 Manager 的 `taskspacectl <slug> preflight`，再用 `project-materialctl.sh <slug> list --include-intake` 核对 capability；检查 `/project-intake` 只读挂载、批准区/治理目录权限、来源 SHA-256 和分类。reviewed模式不能以未批准原始资料绕过审批；direct模式只读挂载本项目原始资料是设计行为。不得放宽`platform.env`；
- Harness 显示已上传但文档解析失败：原文件仍在，先查看页面错误码和
  `.upload-audit.jsonl` 的 `readable` 字段，再核对格式、25 MiB 解析上限、PDF 页数或
  表格行列数。不得执行文档内容、提高容器权限，或在主 Harness 中安装临时
  解析器来绕过基线；确认是平台缺失时，应优先通过 DSH 自身 Skill/插件目录和
  版本化镜像增补，并同步模板、升级脚本与回归测试；
- 跨项目访问或密钥泄露：立即隔离相关账号/容器、轮换凭据并保全审计证据。

## `forge-base` 当前运维入口

服务器路径：`/srv/forge-delivery/projects/forge-base`。部门成员连接公司 VPN 后访问 Forge UI；Harness 使用固定 `13080` 交付隔离台登录入口，再由自己的对话列表进入系统分配的 TaskSpace 端口。旧 `taskspace access <task-id>` 只服务于迁移前的 token 模式工作舱，conversation 模式不会输出静态访问 token。TaskSpace 只能修改自己的 clone，发布通过Broker/Runner的“契约/preflight → clean candidate → 候选准备检查 → 快进晋升 → 绑定候选的测试库/主库迁移 → 定向Compose发布 → 健康检查”路径，所有步骤必须关联 Task/Actor/Conversation/Commit。

## 拆分式 Skills / 宿主 Runner 运维入口

外置 Skills 先在本地生成并复核，不覆盖已有版本：

```bash
node scripts/forge-skill-bundle.mjs build \
  --skills-root docker/harness/skills \
  --catalog docker/harness/skills.catalog.json \
  --output output/forge-skills-<version> \
  --dsh-version 0.1.1-rc.2

node scripts/forge-skill-bundle.mjs validate \
  --bundle output/forge-skills-<version> \
  --dsh-version 0.1.1-rc.2
```

服务器维护事务依次执行 `install → doctor/target → activate → doctor/current → 仅 canary Harness restart → skill.list/行为验收`。install root 固定为 `/srv/forge-delivery/skill-bundles`；版本目录只读，`current` 是指向该根下单层 `versions/<version>` 的相对符号链接。任何一步失败立即停止并保留证据；若指针已切换，按当轮已审回滚步骤恢复，再核对精确canary。旧 Skills、原 Harness image ID、原容器配置和旧 Runner 版本不得删除。

宿主 Runner 也是独立版本包，而不是复制若干脚本到服务器：

```bash
node scripts/forge-host-runner-bundle.mjs build \
  --source-root . \
  --output output/forge-host-runner-<version> \
  --bundle-version <version> \
  --profile-catalog-version <profile-catalog-version> \
  --node-major 22,24

node output/forge-host-runner-<version>/bin/forge-host-runner-bundle.mjs validate \
  --bundle output/forge-host-runner-<version> \
  --profile-catalog-version <profile-catalog-version> \
  --node-major <server-node-major>
```

Runner manifest 精确绑定入口、治理 CLI、固定 policy/settings、每文件 SHA、tree hash、兼容 Skills/profile catalog 与 Node major。服务器使用项目交付账号依次执行 `install → activate → doctor/current → systemd canary start`；默认 install root 为 `/srv/forge-delivery/host-runner`，隔离安装显式选择自己的 install root，版本目录冻结为只读，`current` 原子切换，旧版本保留回滚窗口。激活失败按已审回滚步骤恢复原指针；通过 `current` 执行 doctor 没有结构化输出或 Runner 入口静默退出均判失败。

宿主 Runner contract 使用 `templates/project/host-verification-contract.json.tpl`，systemd 单元使用 `templates/systemd/forge-host-verification@.service`。启用前必须把模板中的 Java/JAVA_HOME/Maven/Node/pnpm/Git/forge-governance 路径替换为 `readlink -f` 后的绝对路径，逐一运行固定 version probe，并保存安装前软件清单。缺失软件按当次明确授权从受信包源安装固定版本，旧2026-09-03授权不自动扩展到新范围；禁止运行远程脚本安装器，禁止读取或复用全局 Maven/npm 凭据。`compose.host-verification.yaml` 只把旧容器 Runner 放到显式 rollback profile，Broker 继续消费同一项目 `runner.sock`，因此切换不要求修改 Harness 或把 Docker socket交给它。

systemd 模板通过 `scripts/render-host-verification-unit.mjs` 渲染，避免遗漏固定目录。使用已审核的实际路径执行：

```bash
node scripts/render-host-verification-unit.mjs \
  --delivery-root "${DELIVERY_ROOT}" \
  --delivery-owner "${DELIVERY_OWNER}" --delivery-group "${DELIVERY_GROUP}" \
  --host-node-path "${HOST_NODE_PATH}" --host-runner-root "${HOST_RUNNER_ROOT}" \
  > /tmp/forge-host-verification@coverage-upgrade-b.service
systemd-analyze verify /tmp/forge-host-verification@coverage-upgrade-b.service
```

省略 `--delivery-root` 时保留 `/srv/forge-delivery` 默认值；其余四参数必须显式提供，渲染器只输出完整单元，不安装或启动服务。隔离项目使用唯一 slug，安装为对应实例单元，不覆盖现役全局 `@.service`。渲染 Host 合同模板时，将 `__DELIVERY_ROOT__` 与 `__PROJECT_SLUG__` 替换为相同安装目录和项目 slug；该项目 `host-contract.json` 的 `taskspacesRoot`、`stateRoot`、`host-runner.env` 及 Broker 的 IPC 路径必须同根。项目创建入口会为 project.env 与容器验证合同替换该目录；Host 合同仍按本节人工配置，不能遗漏占位符。systemd verify 只证明单元可解析，真实服务身份、沙箱和 Runner 健康仍须沿当前交付要求验证。

当新建或升级的Host合同启用 `processIsolation=bubblewrap` 时，必须同时把 `templates/systemd/forge-host-verification-bubblewrap.conf` 安装为该项目实例的drop-in，并先完成真实服务身份下的隔离与工具链探针。这个可选配置解决父systemd的proc屏蔽与业务沙箱冲突，保留syslog限制、`/sys`只读及非root/NNP等防护；未启用该隔离的旧Host继续原单元配置。具体顺序及本次失败恢复边界见[独立审查与宿主隔离部署说明](独立审查与宿主隔离部署说明.md)。只更新合同、漏装服务配置，会重现停服前探针失败。

服务器 canary 必须使用新 TaskSpace、独立任务分支、隔离 Runner state/cache/log 和测试数据边界。先验证 unknown profile、request-supplied argv/env/cwd、跨 TaskSpace admission 和 Secret 读取均被拒绝，再执行真实 Harness→DeepSeek 代表场景。成功也只证明 canary 与已执行 profile；在没有现网长期健康、生产数据库和全部业务语义证据时，不得扩大结论。
