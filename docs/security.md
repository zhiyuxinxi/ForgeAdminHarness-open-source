# 安全与多人协作

核对日期：2026-09-21。本文区分必须保持的边界、既有实现和未闭合风险；[当前状态](当前状态.md)说明版本与证据，不代表本轮重新巡检服务器。

### 依赖预装与私有缓存边界

服务器既有BuildKit缓存只作为操作者准备输入，以只读mount读取，不执行prune或`--no-cache`。公共固定工具包复用仍须核对包版本、官方SRI与文件摘要；不复制设置文件、凭据、业务数据或其他任务可写缓存。准备失败保留原缓存和候选，不能将缓存存在当作离线可用。

新Host依赖种子仅含普通Maven/pnpm文件，manifest由受保护合同中的SHA绑定，符号链接、共享硬链接、路径越界和不匹配输入均不得作为有效种子。项目稳定种子目录由root持有且不可写，Host只向当前TaskSpace复制独立缓存；业务沙箱仍只写本作业和该舱缓存。版本化pnpm与Host通过同轮已推送回执和已授权发布流程安装，不修改共享current或授权业务模型任意安装。预装已有实际部署和Maven新舱消费证据；这不证明pnpm执行属性/准备副本复用已修，也不证明任意依赖组合离线可用，见[当前状态](当前状态.md)。

2026-09-21候选新增公共预装依赖的直接只读消费，尚未上线。公共来源只接受操作者受保护合同中的精确版本和manifest摘要，不从业务任务可写缓存自动晋升。已安装前端树允许pnpm内部相对链接，拒绝越界链接和共享硬链接；普通包文件及执行文件分别保持0444/0555。bubblewrap只读挂载公共依赖，`.vite/.vite-temp/.cache`单独临时挂载；Maven匹配输入后离线只读使用原仓库。任务代码不能改变公共内容或权限，不开放任意宿主挂载。平台消费者证据与业务验收回执保持区分。

> Harness/业务模型不得获得任意宿主Shell、Docker、生产数据库或部署能力。部署、安装和恢复必须按本次明确范围与实际消费者核实；旧文档中的canary授权、旧receipt与版本号不自动适用于新动作。当前任务见[交接](../TASK_HANDOFF.md)。

## 平台账号、项目成员关系与对话访问边界

公司 VPN 是网络边界，不是人员身份。每个使用 Harness 的人必须使用自己的平台账号；共享账号会使审计与人员撤销失去意义，因此不属于受支持用法。同一账号只维护一套密码，可以被管理员显式授权进入多个 Forge Admin 交付项目。项目卡片对所有已登录人员可见，便于识别服务器上有多少副本；没有 membership 的普通成员只能看到“未授权”，不能读取该项目对话、创建 TaskSpace 或进入动态端口。登录密码使用固定参数 scrypt 加盐哈希，服务端不保存明文。会话为状态化随机 token，12 小时空闲、7 天绝对过期；密码修改/重置、账号停用通过 `sessionVersion` 立即撤销旧会话。

所有 mutation 要求精确登记 Host/Origin 和会话绑定 CSRF；登录另有短期 pre-auth CSRF 与 15 分钟窗口内 5 次失败限制。Cookie 使用 `HttpOnly; SameSite=Strict; Path=/`，HTTPS 场景必须开启 `Secure`。Cookie 因多端口工作舱而对同一主机共享，所以 TaskSpace 代理必须在每个 HTTP/WS 请求前回查归属，并在进入 Harness 前删除全部 `forge_gateway_*` cookie。

权限矩阵：member 只有在拥有项目 membership 时，才可创建/打开/重命名/停止该项目内自己的对话并查看批准资料；auditor 只读平台状态与审计；admin 在 member 权限外可管理账号、项目授权、审计和项目资料批准，并默认进入全部项目。reviewed模式下普通成员不能读取待审资料或调用批准接口；direct模式下同项目SFTP根可只读直达。admin另可按Owner授权只读查阅个人对话输入输出和归档，不能跨所有者打开、停止或代发Harness；不存在可写`open-any`权限。membership 撤销后，已有动态工作舱的下一次 HTTP/WS 请求也返回 403；跨所有者请求返回 403，未知/不可用对话不泄露内部内容；停用/过期会话返回 401。UI 隐藏按钮只改善可用性，任何权限决定都由服务端重新执行。

角色授权确认沿已有 Gateway→Manager→Acceptance 控制通道执行：每次预览和确认都重新核对登录、CSRF、项目成员关系、`workspace:write-own` 和对话所有者，管理员也不能跨所有者确认。Manager 从当前受保护任务范围内的实际 Git/SQL 候选生成预览，浏览器只回传预览标识与摘要，不能指定身份、SQL 或角色。Acceptance 的模型侧 scope socket 不提供确认接口；仅 control socket 接受该请求。确认绑定执行代次、当前合同、任务范围、源快照、完整 SQL 文件/语句及有限角色集，最长十分钟且不超过当前 grant 有效期，源码变化、过期、已使用或角色不明确均拒绝。确认后在原对话下一次续接签发新合同，当前运行合同不被暗改；不执行数据库写入。`roleDecisionTaskIds` 是受保护配置中的精确任务列表，模板默认空列表，只有指定任务初始化空角色决定以拒绝未经确认的授权。现有升级迁移保留该显式配置；未配置任务保持原合同形状。2026-10-02 本地 HTTP/控制套接字/实际 SQL 集成验证通过，部署及真实 Harness 验收状态见 [BEH-10 记录](long-tasks/acceptance-20260929/COVERAGE_BEH10_CHECKER_REVIEW.json)，不能据本文宣称已上线。

统一 `conversation-gateway` 禁止挂载 Docker socket、任何项目 workspace、共享服务 env 和模型 key。它只通过专用 ingress bridge 发布固定 VPN 地址端口，不加入 Forge 应用网络；项目清单只读取公开登记字段，不向浏览器返回数据库/Redis 身份。每项目 `conversation-manager` 是唯一新增高权限进程：只接受项目私有 bearer token、固定 TaskSpace 生命周期与项目资料治理路由、严格 ID/路径/分类校验、无 shell 拼接、串行操作、超时与有界输出，以 `network_mode: none` 运行且不发布端口。Gateway 通过每项目独立 Unix socket 调用 Manager；Operator 账号管理也只通过平台私有 Unix socket 提供。Manager 健康检查执行 `taskspacectl preflight`，只使用项目 `project.env` 注入的非秘密控制变量，不读取或放宽宿主 root-only `platform.env`。

TaskSpace 的逐请求鉴权使用单独的只读 Unix socket 目录。它与 Operator socket、Manager token/socket 物理分离，TaskSpace 既没有 Operator token，也看不到项目 capability 根。所有 TaskSpace 不加入共享跨项目鉴权网络，因此这条控制链不会形成项目间容器横向访问面；鉴权 socket 仅返回允许、401、403 或受限错误，不提供账号、项目或会话枚举。

临时密码只允许在创建/重置响应和 0600 的初始管理员文件中出现一次；不得提交仓库、写日志或粘贴到 AI 对话。管理员应通过批准的密码管理器/安全通道分发。网关审计记录 actor/action/target/result/requestId，不记录密码、session token、CSRF token、模型 key 或完整 Cookie。

浏览器管理面禁止当前管理员重置自己：自助改密必须验证当前密码，并在撤销其他旧会话后为当前浏览器轮换新会话。忘记管理员密码的恢复只允许通过平台私有 Unix Operator socket 和服务器 `conversation-userctl.sh reset-password admin` 命令执行。创建/重置其他账号后，一次性临时密码弹窗在操作员明确关闭前不得触发人员列表刷新或登录跳转。

## TaskSpace强隔离边界

死亡 writer 恢复使用版本化 `recover-forge-dead-writer.mjs` 宿主操作员入口（运行验收状态见当前 B 交接）。该 CLI 要求 Linux root、私有且精确绑定任务/permit/执行代次/容器 ID 与镜像的描述；模型和 Broker 工具接口仍仅有 acquire/settle，不接收死亡证明。操作员持有既有生命周期锁并设置持久维护 fence，核对实际写挂载及明确列出的受信控制面，拒绝存活、自动重启或身份不符的 writer；只移除已死亡的精确目标容器。停止且禁用自动重启的历史容器出现缺失挂载时，仅在逐级确认路径缺失并解析最近现存祖先后判别交叠，保留缺失路径证据；权限错误及悬空链接不视为无交叠。恢复与永久代次撤销在原租约状态锁内原子记录，保留工具结果未知，不自动重放、不启动容器、不解除隔离；较新受保护代次仍须来自真实授权请求。root 恢复必须保留原 state/lock 的 UID、GID 和 0600 权限，普通 writer 的属主检查不放宽。

- 禁止多人继续使用同一个可写项目 Harness。旧 `harness`/`harness-upload` 只保留在 `legacy-shared-harness` profile，默认生命周期不启动；TaskSpace 升级会移除旧容器但保留状态和卷。
- 每个TaskSpace使用独立clone、`dsh-home`、私有上传区、宿主缓存、Compose名和端口。现行conversation模式沿用Gateway个人身份逐请求鉴权，不发静态浏览器token；旧token模式才通过`/forge-access`建立工作舱cookie。代理在转发前剥离平台身份信息，外部访问另需HTTPS和适用身份接入。
- TaskSpace 只读挂载项目集成 workspace 为 `/integration`、当前项目 SFTP 根为 `/project-ftp-inputs`、预留审核共享区为 `/project-shared-inputs`；可写挂载仅限自己的 `/workspace`、`dsh-home`、上传 Sidecar 和缓存。`/project-ftp-inputs` 的宿主来源只能是精确项目 slug 对应的 File Gateway 目录，并固定 `read_only`，不得挂载上级目录或其他项目。它不挂载其他 TaskSpace、项目 `ops`、Release Socket、Docker Socket、数据库/缓存账号或宿主机秘密。
- Maven/npm/pnpm/XDG 缓存只挂载到当前 clone 下的 `/workspace/.forge-cache`；宿主源仍位于当前 TaskSpace 根，不因容器内路径位于 `/workspace` 而与源码或其他工作舱共享。模板必须把该目录加入 clone 私有 `.git/info/exclude`，并预建 Jansi、pnpm data/home 与 XDG state 子目录。禁止用 Full Access、改 `HOME`、命令行仓库参数或复制依赖到源码树来绕过默认沙箱；这些做法会掩盖平台缺陷并破坏可复制性。
- Broker 令牌只从 0600 文件注入，metadata 只保存 SHA-256；模型不得读取、回显或索取令牌。Broker 以恒定时间比较令牌，并把 Task/Actor/Conversation/Candidate Commit 传给 Runner 审计。
- 候选晋升采用 clean HEAD、包含最新集成 HEAD、fast-forward-only、晋升前 HEAD 二次比较、Runner exact-commit 二次校验。项目发布使用共享文件系统原子锁；Broker 崩溃后的过期锁只有在 Runner 明确空闲时才能回收。
- 数据库操作不按“每个 AI 一个账号”开放。迁移只允许进入单一受控队列和固定 `_test` 沙箱；失败后的快照恢复、前向迁移、主库禁 reset/repair 边界保持不变。

## 私有 Git 远端与 Deploy Key

- 每个交付项目使用独立私有仓库和独立 Ed25519 Deploy Key，不复用个人密码、个人 Token 或跨项目写入密钥；
- 私钥只保存在项目根之外的 `/srv/forge-delivery/git-remotes/<slug>/id_ed25519`，避开 Manager 的项目根挂载和 Runner 的 `ops` 挂载；目录 `0700`、私钥和 `known_hosts` 为 `0600`，仅 Broker 直接只读挂载；
- Git remote URL 禁止嵌入账号密码，只接受显式 SSH URL；Git 服务 Host Key 必须通过独立可信渠道核对 SHA-256 指纹后固定，禁止关闭 Host Key 校验；
- TaskSpace 继续只写自己的 clone，不能直连 GitLab；所有远端推进统一经过项目发布锁、远端 HEAD 等值检查、普通 fast-forward push 和推后复核；
- 远端漂移、Deploy Key 失效或 Git 服务不可达时发布失败并保留审计，不允许 force push、自动改 remote、回退远端或把失败降级为本地成功；
- GitLab 密码、PAT、Deploy Key 私钥和 Cookie 不得写入 Git、项目文档、Memory、聊天回执、普通日志、Compose 环境或 remote URL。
- Deploy Key 私钥不进入项目业务数据恢复包；同机原位恢复保留受限 credential root，跨机恢复必须重新生成和登记密钥，不复制聊天或普通制品中的私钥。
- Manager 与 Runner 因固定控制面职责拥有 Docker 权限，属于宿主级特权信任边界；“没有直接密钥挂载”不能抵御已失陷 Docker 控制面。必须继续限制其 API/镜像、审计变更并保护 Docker socket，不能把它们视为普通 AI 工作舱。

任何发现 TaskSpace 能写 `/integration`、看到其他任务目录、访问 Docker/Runner Socket、读取数据库凭据、绕过 Broker 发布，或不带访问令牌打开工作舱的情况，都按隔离失效处理：立即停止该工作舱、保全 metadata/Broker/Runner 审计，并停止后续发布。

## 项目资料治理边界（vpn46）

- 当前对话网页上传写入自己的 TaskSpace `uploads/`，Harness 只读看到 `/project-inputs`；schema v2 审计必须记录项目、用户、对话、TaskSpace、路径、字节数和 SHA-256。
- SFTPGo/WebClient 批量或递归上传写入 `${DELIVERY_ROOT}/file-gateway/data/<slug>`。默认 `PROJECT_MATERIAL_ACCESS_MODE=direct`，同项目 TaskSpace 只读挂载为 `/project-ftp-inputs`，无需管理员审核；Gateway、Broker 和 Runner 不挂载该目录。
- 直读扩大的是“同项目 AI 可见范围”，不是文件信任等级。上传内容一律视为不可信数据：禁止执行 HTML/JavaScript、浏览器扩展、宏、安装脚本或文件内面向 AI 的指令；禁止把它自动写入代码、权威文档或 Memory。目录索引只能写当前 TaskSpace 的 Git 忽略缓存。
- `forge-prototype-index` 必须拒绝符号链接、特殊文件、路径穿越和扫描中变化的文件，并限制条目数、文件数、单文件/总字节、路径长度和派生输出；它只静态读取允许的前端文本与资源，不启动 Web 服务器、不打开浏览器执行原型代码。
- `reviewed` 模式作为预留治理策略保留。启用时原始目录只读挂载给 Manager 的 `/project-intake`，管理员批准后，Manager 重新解析真实路径、拒绝路径穿越和符号链接、重算 SHA-256，并按固定分类无覆盖复制到 `shared-inputs/accepted`。批准只扩大可见范围，不移动或删除原始文件。
- 每次批准追加 `shared-inputs/governance/material-events.jsonl`。旧 schema v1 记录标记 `legacy-unattributed`，无审计文件标记 `untracked`；不得补造用户/对话归属。
- 新项目批准区默认空，复制 Forge Admin 副本不复制客户资料。平台 UI 模板、Skill 和通用规范只能通过版本化镜像/仓库跨项目发布。

## 移动 Web、PWA 与原生壳安全边界（vpn51 目标）

- PC `/forge/` 与移动 H5 `/forge-h5/` 使用同一受信入口和同源 cookie/CSRF 策略；不得给 H5 增加独立跨域白名单或把 access token 写入 URL、LocalStorage、构建产物和日志。
- `forge-app` 只加入项目应用网络并 `expose 8583`，不发布宿主机端口；外部流量必须经过版本化 Nginx 路由、安全响应头、请求体上限和审计链路。
- 移动端必须复用服务端租户、RBAC、菜单/按钮、数据权限和流程状态机。隐藏按钮、禁用控件或客户端路由守卫不是授权，所有负例必须由服务端拒绝。
- H5 manifest 只保留已使用的最小权限。相机等能力按需声明；通讯录、电话状态、写系统设置、挂载文件系统等未使用权限不得进入生产包。
- 当前公司 VPN 内 HTTP 只足以进行受控 H5 验收，不满足 PWA 安装、外部客户或公网交付的传输安全要求。PWA/原生交付前必须建立受信 HTTPS、证书续期与强制跳转，并重新验证 cookie、WebSocket、缓存清除和深链。
- 原生 App ID、Android/iOS 签名私钥、推送证书和商店凭据是外部高敏身份，不写 Git、TaskSpace、Memory、聊天或镜像。签名应在受控 CI/发布机完成，并保存包哈希、依赖清单和可追溯版本。
- 390/430/768 像素浏览器视口是布局回归，不是真机安全验收。至少还需覆盖 iOS/Android 的系统 WebView、权限拒绝/撤销、后台恢复、弱网切换、文件/相机输入和升级覆盖安装。

## 不可突破的边界

- DSH本体仅监听容器回环。对外的是受鉴权的Gateway/TaskSpace代理，按已登记的指定地址提供VPN访问，不得直接将DSH绑定到非回环地址、`0.0.0.0`或公网网卡；
- Harness 不得获得 Docker socket、Docker CLI、项目 `ops`、平台目录或共享服务 Secret。TaskSpace 发布只允许调用 `forge-release`，由客户端使用只读注入的任务令牌连接 Broker，再由 Broker 经项目私有 Unix capability socket连接白名单 `release-runner`；模型不接触也不索取令牌。Runner 校验固定 Compose、合同声明的PC三服务或移动四服务集合、运行契约、候选 Commit、受保护文件、禁用的管理 SQL 和破坏性迁移；发布执行由Runner使用Docker权限，Manager另因生命周期职责持有Docker权限；二者都是受信控制面，均不得向Harness开放任意命令、工作区 Compose、数据库/缓存容器或宿主机变更；
- Runner 返回的迁移诊断只允许包含限长、去 ANSI/控制字符并对口令、Token、API Key 和 URL userinfo 脱敏后的摘要。发布状态文件权限固定为 `0600`，不得通过 Harness 直接挂载或读取项目 `ops`；Harness 只能通过 capability socket 查询结构化诊断。
- Harness 和 `forge-release` 不提供 Flyway repair、任意 SQL、数据库创建/删除或主库 reset 入口。普通发布内部允许 Runner 管理固定测试 schema 的健康快照与失败恢复：目标必须满足运行契约中的精确 `<主库>_test`、Runner 空闲、无外部连接、恢复状态与快照相对路径/字节数/SHA-256/对象数一致；只有检测到 failed history、`migration-pending` 或 `restore-required` 时，固定操作器才在 named lock 下清理该测试 schema 内对象并导入已登记快照。它不能删除数据库本身、触碰主库，也不接受用户提供的库名、路径或 SQL。
- 每个项目只挂载自己的工作区和 Harness 状态，不能挂载 `/srv/forge-delivery/projects` 上级目录；
- Forge Admin 应用服务使用项目独立网络与密钥卷；共享 MySQL 按项目独立主库/测试库与账号授权隔离，共享 Redis 按逻辑库编号隔离；
- `project.env`、DeepSeek/Kimi/GLM Harness 凭据和备份都属于敏感资产，不进入 Git、不通过聊天或工单明文传播。GLM 密钥必须保持在 root:root、0600 的 Docker Secret 源文件中；Harness 只在启动时导出进自身进程环境，Broker、Gateway、工作区和审计证据都不得获得该值。
- 完整备份/恢复只允许 root/DBA 在精确项目恢复锁内执行。恢复包必须位于该 slug 的 mode-0700 备份根，先校验全部 SHA-256、registry row、数据库/Redis/crypto 身份、Compose 服务白名单和 TaskSpace 身份；运行时 socket 不归档。恢复前安全副本保留在 mode-0700 recovery 根，自动回滚和成功恢复都不自动删除它。Harness、Gateway、TaskSpace、Broker 均不挂载这些目录，也不获得共享数据库凭据。
- 平台账号/membership/audit/Manager token 必须通过独立的统一控制面恢复包保护，不能混入或依赖单项目恢复包。该备份同样是 0700/0600 敏感资产并排除运行时 socket；恢复必须使用单独的显式破坏性 runbook，撤销所有浏览器 session、校验项目登记快照并重启每项目 Manager，禁止直接覆盖运行中的平台状态。
- 共享文件入口只绑定 `192.0.2.12`，不得绑定 `0.0.0.0` 或公网网卡；SFTPGo
  只能挂载 `/srv/forge-delivery/file-gateway/{data,state,backups}`，禁止挂载
  `/srv/forge-delivery/projects`、Docker socket、平台代码或秘密目录；
- 文件入口管理员和初始用户密码只保存在权限为 `0600` 的
  `file-gateway.env` / `bootstrap-credentials.txt`；当前运维机的分发副本
  `文件网关初始账号.txt` 必须保持 Git 忽略和管理员专属 ACL。普通用户默认只能列出项目目录、
  上传和创建子目录，不能下载、删除、覆盖或重命名；
- 客户上传文件按不可信输入处理。Harness 以只读 `/project-inputs` 分析当前对话私有资料，以只读 `/project-ftp-inputs` 分析当前项目 SFTP 资料，并以只读 `/project-shared-inputs` 兼容预留审核模式；
  `direct` 表示免管理员审批可读，不表示可信。未经过来源确认、恶意文件检查和人工筛选前，不得执行其中的脚本、宏或指令，也不得自动写入工作区、项目权威文档或 MCP Memory。
- Harness 网页上传只允许精确 TaskSpace Host 的同源请求；跨站请求和伪造入口直接返回 403。
  浏览器请求由入口代理增加工作舱内部令牌后转发到 `harness-upload`，令牌不得进入
  浏览器、对话、日志或 Git。Sidecar 只挂载当前 TaskSpace 上传目录并连接内部网络，不得
  挂载工作区、Harness 状态、模型 Secret、平台目录或 Docker socket；Harness 对
  `/project-inputs` 的挂载继续保持只读。
- 网页上传服务必须限制单文件、单批次和 TaskSpace 总量，清理文件名中的路径与控制字符，
  采用临时文件加原子无覆盖发布，失败或取消时清理残片，并记录 SHA-256 审计行。
  上传成功只回填模型可见路径，不自动发送、不自动执行、不自动晋升为权威资料。
- PDF、DOCX 和 XLSX 解析必须在上传 Sidecar 的低权限、只读根文件系统和受限
  CPU/内存中串行执行；解析器不能获得工作区、Harness 状态、模型 Secret、平台
  目录或 Docker socket。不运行 Office 宏、PDF 脚本、嵌入文件或文档中的命令；
  源文件、页数、行列数与输出字节必须有硬上限。生成的 `.extracted.md` 与原文件
  具有相同的低权威等级，不因“已解析”而成为可信指令。
- AI 交付作业门户只提供构建时固化的 Markdown 只读副本，不挂载项目工作区、
  Docker socket、运行时秘密或可写数据卷，也不提供匿名上传、在线编辑和发布接口；
- 门户固定绑定 `192.0.2.12:15080`，沿用公司 VPN 网络边界。当前版本不提供个人身份、
  文档级授权或操作审计，因此不得对公网或客户网络开放；扩大访问范围前必须增加 HTTPS、
  个人认证、权限控制、访问日志和内容发布审核。

## 受控执行、验证与当前缺口

业务草稿写入依据真实用户授权、项目/对话身份、当前源码与owned paths。普通模式下暂停的强制独审、RED顺序、Skill次数及无进展规则不能再作为默认安全要求；权限、隔离、签名、源码绑定和最终必要验证仍保持。模型不得用提示词、自然语言自述或资格shadow等级获得额外能力。

本轮续租修复要求当前账号仍活跃、仍有项目成员关系且角色能力覆盖原任务上限；历史RPC角色快照不能证明当前授权。Manager只读核对受保护任务/对话/执行身份，通过现有私有Unix入口查询Gateway，并复核查询期间源码及代数未变；TCP不能访问该入口，其他Manager控制入口仍须原凭据。查询不修改状态、不提高任务权限，单次有5秒期限；不可达与明确拒绝分别反馈，不能一律重试。该查询不等于验证原登录cookie或sessionVersion。发布仍须实际验收和有效发布授权；修复是否已部署见[两端对齐核对](validation-evidence/2026-09-21-执行与验收两端对齐核对.md)。

Broker只向Host发送当前任务的受控动作，Host以固定profile/selector编译argv和环境，并在隔离作业里验证源码。模型不能注入任意Shell、cwd、环境、下载地址、镜像或数据库身份。Host不继承用户的全局Maven/npm/Git凭据；日志按既有边界脱敏。实际Host沙箱与历史network-none容器Runner是不同执行方式，不能把所有验证笼统写成断网。

验证与验收入账分开。只有真实执行且满足当前profile的回执才能证明通过；启动确认、零测试、超时、签发拒绝或模型生成的JSON不构成通过。同一候选的既有回执可沿支持入口复核，不能手工改账、放宽签名或用新成功覆盖原失败。

外置Skills与工具链使用不可变版本和摘要，operator负责安装/切换；同版本不同内容不能覆盖。旧缓存、镜像和回滚材料按资源保留规则处理，不执行宽泛prune。原vpn53/71测试预算、候选镜像和固定模型样本保存在[过期安全原文](过期/2026-09-21/docs/security.md)，不当作现行生产授权或全部能力完成证据。

**尚未闭合：**同舱模型工具可读自身凭据（TODO-047）；0600只能隔离不同OS用户，不能把同用户读取隔离说成已完成。代理节点外层TLS的`skip-cert-verify=true`仍在TODO-066；目标内层TLS开启不消除外层风险。历史后端租户/数据范围风险需按TODO-015取证，不能只依据旧审查宣称存在漏洞或已修复。

Redis 逻辑库不是强安全边界：同一 Redis 凭据通常可切换到其他 DB。当前用它解决一期命名与数据碰撞，不应把不同保密等级的客户数据仅靠 DB 编号隔离。需要强隔离时应改为独立 Redis 实例或 ACL 账号/Key 前缀组合，并验证服务端支持情况。

## 身份与审计

“所有人共用项目空间”不应解释为“所有人共用账号”。建议：

1. 每位交付人员建立个人 Linux/SSH 账号，禁用共享密码登录；
2. 逐步切换到 SSH 公钥并禁用密码认证；
3. 每人配置真实 Git 姓名和邮箱，任务使用独立分支与合并请求；
4. Harness 发布动作保留完整会话、结构化 Runner 请求、镜像摘要和回退点；Runner 审计必须能关联项目、审批说明、Git 提交和发布 jobId；
5. Harness 会话按人员/任务命名，关键交付保留会话、diff、测试和审批证据。

历史记录曾报告服务器账户口令在对话中传递，应按暴露处置。当前材料未给出轮换与登录审查的完整闭合证据；后续按明确授权核实，不回显口令、不在本次文档整理中操作账号。

SFTPGo WebClient 一期沿用公司 VPN 内普通 HTTP 的既有信任边界；SFTP 客户端使用
独立的 SSH 协议端口，不启用传统明文 FTP。若访问范围扩大、VPN 不再等价于受信
部门成员，必须先切换受信任 HTTPS、个人账号、项目组授权和访问日志审查。

部分旧项目曾共用数据库管理账号，最小权限收尾未有全覆盖证明；示例企业二期与安全生产项目的独立账号已有专项验收，不能据此称旧项目全部修复。正式客户项目应由有权DBA按精确主库/测试库授予运行账号权限并核实际消费者。台账只记录秘密定位和权限，不记录明文。

## Forge Admin 首次开放门禁

Forge Admin 上游示例存在默认体验账户。项目所有者已接受当前公司 VPN 内部阶段继续使用现有账号；这不作为本阶段开放的阻塞项。每个正式客户项目仍建议核对：

- 修改默认管理员密码、关闭或删除无关体验账户；
- 核对租户、RBAC、菜单/按钮和数据权限；
- 配置真实环境密钥并确认没有进入 Git/日志；
- 验证文件上传、接口加密、审计日志和跨租户访问；
- 备份并完成一次恢复演练。

现有入口面向受控公司VPN；VPN连通不等于管理员身份。Gateway已有人员账号、membership和对话归属检查。接入外部人员、客户网络或公网前仍需明确HTTPS、身份集成、来源限制、审计和部署边界，不能把现有内网访问直接推广出去。

Harness 当前为满足部门内网直连要求使用普通 HTTP。容器入口只注入一个 `crypto.randomUUID` 浏览器兼容实现，未降低 DSH 的容器回环绑定，也未向页面暴露模型 Key。普通 HTTP 本身不提供端到端传输加密，因此只能用于受控公司 VPN；若访问范围扩大，必须切换到受信任 HTTPS、增加独立认证，并重新验证兼容代理是否仍有保留必要。

## AI 权限与人工复核

Harness 的默认权限只覆盖当前项目代码目录。数据库迁移和项目发布必须先获得当前会话中的明确用户要求，再通过 `forge-release` 完成运行契约、干净 Git 提交、白名单候选构建、候选镜像测试库迁移、定向发布、冒烟和回退门禁；不得直接调用 Docker。以下其他动作仍必须由人执行或逐次批准：

- 客户真实数据修复、跨项目数据操作、批量导入导出；
- 访问客户真实数据、生产凭据或其他项目目录；
- 合并保护分支、改变其他项目栈或平台安全策略；
- 修改安全策略、认证、租户隔离、加密和审计逻辑；
- 向客户或外部系统发送信息。

质量指标至少包括构建成功率、AI 产出合并通过率、人工返工率、回归缺陷、越权尝试和敏感信息事件。模型或 Harness 升级后必须跑同一组黄金任务和越权用例。

## 外置 Skills 与宿主工具链的安全边界

Skills bundle 是只读规则输入，不是可执行安装脚本。operator 在 Harness 外完成逐文件 SHA、tree hash、Secret-shaped 内容、符号链接和 DSH 兼容性校验；TaskSpace 只能读取 `current/skills`，不能修改版本目录或切换指针。坏 manifest、错误 current、未完成 activation transaction 或相同版本内容漂移全部失败关闭。旧版本保留用于回退，不能用自动清理或 Docker/package-manager prune 擦除回退证据。

宿主 Runner 使用服务器软件不等于把服务器 shell 交给模型。Harness 无 Runner socket、Docker socket、宿主路径或安装权限；Broker 只有项目私有只读 Unix capability；Runner 以项目服务账号运行，固定 contract 声明工具路径和 profile catalog。Runner 版本包以逐文件 SHA、tree hash、兼容 profile catalog/Node major 和只读 `versions/<version>` 约束，`current` 只允许落在该版本根；通过链接入口静默退出、额外文件、内容漂移、符号链接或未完成激活事务均失败关闭。请求不能携带 argv、环境变量、下载地址、镜像或数据库身份。Runner 子进程环境是封闭 allowlist，不继承 proxy、Token、`~/.m2/settings.xml`、`.npmrc` 或全局 Git 配置；日志在持久化前脱敏，测试 profile 的零测试结果一律失败。

工具链安装需符合当前具体任务的授权，不能把早期canary授权当成长期任意安装许可。保留安装前清单，使用受信来源和固定版本，禁止`curl | sh`；路径、版本和工具链摘要进入实际回执。已有全局配置和凭据不得复制给Runner，安装不扩大模型权限。本轮未安装软件。

## 主机基线待办

早期只读盘点记录UFW未启用、存在待安装更新及重启标记；本轮没有现场复核，不能继续称作‘当前’状态。补丁、SSH、防火墙、时间同步、资源告警、日志轮转和异机加密备份的整体闭合证据仍需核对，纳入[全局TODO](../00-全局总待办-TODO.md)及[P0-11](p0-delivery-governance-backlog.md)。维护需单独按实际范围安排，不因更新本页停机或改安全配置。
