---
name: forge-testing-observability
description: Plan, implement, or review Forge Admin v1.1.2 tests and observability across Maven, Vitest, migration, API, browser, logs, metrics, tracing, health, alerts, and completion evidence. Use when adding tests, fixing flaky coverage, instrumenting production behavior, defining release evidence, or evaluating a claim that code works; do not treat static audit or a model summary as runtime proof.
---

# Forge Admin 测试与可观测性

Policy marker: `FORGE_TESTING_OBSERVABILITY_V1`.

当前普通开发以用户目标推进：以下参考中的强制 Skill/TDD 顺序、固定阶段比例、反复独审和强制收尾已暂停；组件选型与普通样式偏好只作建议，职责、模块依赖及关键代码正确性要求仍须落实。允许先保存修复草稿，再做受影响验证。真实权限、租户、数据完整性、秘密和危险操作授权继续保留；合入与发布须取得实际构建、必要启动、功能测试及源码绑定证据。不要把这段解释成已通过任何验证。

## 风险驱动验证

先把每个需求/风险映射到验证层，不以“补几个单测”代替系统证据：

- Java 领域/Service：unit、transaction、idempotency、concurrency、error contract；
- Mapper/tenant/data scope/migration：真实 MySQL 集成、空库、上一版本升级、查询计划和负例；
- API/权限：authenticated contract、错误角色/tenant/direct-call、request/response/HTTP code；
- Vue：本次修改文件的 eslint、受影响的 Vitest component/API adapter；全应用 typecheck、构建和浏览器验证只在本次需求确实要求时执行，不作为普通修改的默认门槛；
- Flowable/外部副作用：真实 engine/adapter、duplicate/out-of-order/retry/compensation；
- 生产性：health/readiness、指标、结构化日志、trace correlation、告警与 runbook。

按定位问题所需的顺序实现修复和聚焦测试，不要求先取得失败回执；测试必须观察公共行为或稳定合同，不复制实现。测试源码本身必须进入目标模块的真实 compile/test selector：从当前 dependency/classpath 或相邻测试确认 import/package，不能凭记忆生成一个未编译的测试。写 Java 测试前，必须读取其 owning module 的 `pom.xml` 并沿 `<parent><relativePath>` 声明的本地父链核对 JUnit/AssertJ/Mockito/TestNG 依赖；`dependencyManagement` 只管理版本，不等于依赖已进入 test classpath。缺依赖时，只有依赖清单路径已被当前合同拥有且变更已获 admission，才可补齐；否则改在一个已经直接依赖生产 owner 且已有相应 test framework 的受控下游测试模块，仍不成立就以 `QUALITY-TEST-004` 阻塞。禁止只生成一个无法编译的测试文件，再把“测试已写”当作回归证据。baseline failure 与本任务 failure 分开记录，不能删测、放宽断言、加 sleep 或 retry 掩盖。

## 后端结构检查与修复

结构审查必须核对本次公共能力是否混入具体客户/业务实现，以及模块、类、方法和直接消费者的实际依赖方向与循环。静态阈值通过不能替代这项代码审查；发现后交原编码模型在所属业务或公共 owner 内整改，不把客户逻辑移进公共层，不以静态查找或延迟注入隐藏循环。只检查本次涉及链路，不扩为无关全仓依赖治理。

审查结构改动时，沿本次容器、`record`、getter 链和转发方法追踪到实际协作者，对照修改前后的行为归属、业务步骤与变化原因。指出哪些职责实际转移到内聚 owner、哪些仍由原调用者掌握；必要时引用具体方法与调用路径。只把多个依赖包装成一个字段、仍由原调用者逐个调用底层服务，不能作为职责或耦合整改完成的证据，即使扫描没有发现问题。组合根的合法装配与领域行为分开判断，不凭类名、包装形式或数值判错；将当前范围内仍存在的职责问题交原编码模型整改，复用未受影响的行为证据。

新增或修改类时，按实际职责控制类规模、方法数、方法长度与认知复杂度；诊断仅选择实际改动和当前已授权审计具名文件。可选 profile 不代表发现可以免处理，要求整改的结构发现仍须按职责修复并保留行为，禁止机械拆碎、NOPMD 或放宽阈值。

本次生成、修改或整改后端 Java 时，必须通过下述 `backend-source-quality` 对当前变化 Java 执行实际 PMD/Checkstyle 检查并读取回执；governance、编译或单测通过不能替代这项源码检查。复用仍与当前源码、工具和范围匹配的有效回执，不重复扫描未变内容；没有 Java 变化时不因此扫描历史文件。检查范围只含当前变化和本任务明确具名的 Java，不扩为全仓；工具失败或准入受限须报告真实阻塞，不能写成已检查。

编码前先按 `forge-change-design` 与 `forge-backend-architecture` 确定职责 owner 和依赖方向；扫描后回到同一职责决定修复，不能把检测独立成只出报告的末尾步骤。用户或当前任务已要求结构整改时，须完成本次新增/受影响类与方法的实际修改，并用既有固定规则的范围化扫描和必要行为证据验证；不新建 requiredProfiles、自动 Hook 或阶段流程。

类规模、方法数、方法长度、认知复杂度及耦合阈值只触发结构审查，不证明低于阈值就设计合理，也不要求通过机械拆分把所有信号清零。结合职责、变化原因、依赖与行为解释结果；仍属本轮整改范围的真实缺陷继续修复，保留尚存信号和证据。无关历史发现不得全局阻塞局部安全补丁，但不能据此搁置本轮明确要求修复的具名大类。修复后的检查只覆盖实际改动与直接影响范围，通过即返回交付，不重复全链验证。

`forge-verify run --profile backend-source-quality --file forge-server/<实际具名Java路径> --admission-id <当前注入ID> --idempotency-key <本次唯一键>` 使用平台固定 PMD 7.17.0 / Checkstyle 10.26.1。重复 `--file` 最多选择 32 个本次改动或原审计具名文件；省略文件时仅使用 Host 已绑定的 reviewBase 变更集，不扫描全仓。沿当前包含 governance 或 backend-module-compile/backend-module-test/backend-test-class 的有效 admission 使用，不为这个范围化诊断重新创建阶段或增加 requiredProfiles；模型不能直接调用 admit。

回执 `sourceQuality.report` 包含文件哈希、findings、errors 和原始报告。`passed/not_applicable` 对应退出码 0，`findings` 对应 1，`error` 对应 2；后两者的 Host 状态均为 failed，必须查看内部状态区分发现问题与工具未完成。超时或缺工具包是平台执行失败，不能称检查通过。此回执不能替代编译、测试、语义审查或阶段验收，也不作为重跑八阶段的前提。

逐项阅读本次范围的真实发现，再由 Harness 修改业务源码。现有 GodClass、方法长度等结构发现保留为 `reviewKind=structure`，不能自动判定局部安全修复行为失败，也不能删掉告警或称无问题；若当前任务已经要求整改该具名大类，应按职责拆分并保留行为。禁止改 scanner、规则、阈值、抑制项或测试断言让自己通过。工具和规则只读取平台版本包，仓库中的同名脚本不参与执行；依赖缺失交平台按固定包一次准备，不在业务会话联网安装。

将本次 `code`、`structure` 发现与工具 `errors` 分开反馈：指出实际文件/位置、规则、职责或关键行为问题、负责修改的 owner 和必要行为反例。由当前 Harness 对话在原授权范围内修复业务代码及测试，平台/公共底座问题反馈其 owner；不得以“报告已生成”结束已要求的整改。路径确需变化时沿已有范围更新入口处理，不能越权代写。重构对照本次实际涉及的接口输出、权限/租户、事务、并发和失败语义；复用未受影响的证据，只重验受改动影响的部分。工具失败保持未完成，尚存结构信号说明是否为当前真实缺陷及依据，不能把信号全绿或编译成功当作行为正确。

涉及低代码 API 的生成或迁移时，对照 `forge-backend-architecture` 的具体契约，检查新增 Provider、编号和绑定调用是否来自 `forge-lowcode-api`，以及 owning POM 的直接依赖。查询/schema 保留旧 FQN 属兼容事实，不能据包名误判；反过来，generator 兼容桥可编译也不证明新生成代码已使用公共 API。依赖隔离的检查须确认实际类来自 API 产物，避免旧 generator 缓存掩盖缺类；沿现有受控编译/测试入口取得当前生成代码证据，保留接口、权限、租户及失败语义。把错用旧实现、缺失依赖或实际签名不兼容的文件和错误交当前 Harness 编码模型修复，不由审查者代写业务候选，不扩大为全仓迁移。

本次若涉及配置、数据源、公式或单据编号边界，继续沿真实调用确认运行值/执行类型来自对应 API 或运行模块，设计 Mapper、实体、凭据及资源生命周期留在实际适配器。选择改动直接影响的原场景核对配置准入、公式执行/扩展顺序、编号异常与租户来源、借用连接池的归属；不为未涉及的能力追加验证。旧门面保留不等于新代码可以重新依赖它，模块独立编译也不能替代实际应用装配和直接消费者证据。

## Forge 特有陷阱

编写或修复测试时先核目标方法的真实签名与相邻测试用法。重载方法的 Mockito matcher 要有可确定的参数类型，不能凭泛型 `any()` 猜重载；生产代码调用持久化方法时，按既有错误/事务语义处理返回结果，不能为让测试通过而忽略写入失败。这是避免已知编译和行为错误的指导，不要求为每次编辑另跑一次检查。

`RUNNER_INTERNAL_REFERENCE_ONLY_V1`：根构建默认可能跳过编译或测试，前端 lint/typecheck/test/build 也有各自脚本；具体构建参数、脚本、cwd 和离线依赖只存在于受控 Runner 的版本化 profile 中，不是模型命令。`frontend-admin-typecheck` 固定调用项目的 `pnpm run typecheck`；脚本不存在或命令失败时必须保留非零结果并失败关闭，不能退回模型 shell。核对 receipt 中的 profile、显式排除项、选中 module、test count、每步 argv/exit/timeout，确保目标测试未被跳过；BUILD SUCCESS 或单个脚本名称都不能单独证明源码已编译或测试已执行。

## 可观测性合同

- requestId/traceId 在 ingress 校验或生成，贯穿日志、错误响应、异步、消息、流程和外部调用；使用 CSPRNG/标准 tracing，不用时间戳 + `Math.random()`。
- 结构化日志包含 event、result、latency、actor/tenant 的安全标识和 correlation；禁止 token、cookie、secret、完整个人信息、请求/响应体和 prompt 明文。`OperationLog` 不等于全链路 tracing。
- 指标至少覆盖 rate/error/duration/saturation，并按域补充 DB pool、线程池、队列、retry、circuit、workflow lag 和业务失败；标签必须低基数，禁止 record/user/request ID。
- liveness 只表示进程，readiness 表示关键依赖能否接流量；告警绑定可操作阈值、owner、runbook、去噪和恢复条件。Actuator 依赖存在不等于这些信号已配置。

## 硬门禁与证据

```text
forge-governance audit --root /workspace --base <approved-base-commit> --format json
```

确定性 audit 对新增代码缺测试、测试/构建配置禁用检查、生产 debug/`latest`、弱随机和可静态识别的 Secret/敏感日志失败关闭。按实际风险验证 metric、trace、readiness 与告警行为，不因普通开发强制独立AI复审；receipt 真伪由 Evidence Runner/完整性检查器判定，不能靠静态源码扫描。暂时跳过测试、接受 baseline failure 或调低告警属于外部 owner 的语义决策；需要放宽确定性 rule 时只能用版本化 policy 批准并带 hash/scope/expiry，模型和 implementer 不能自批。

需要核对完成证据时参考 `forge-evidence-truth`，不要求重复加载。每条 fresh receipt 绑定 source/diff hash、cwd、完整 argv、开始/结束时间、exit code、测试数和受控输出摘要；旧日志、只存在的报告文件或模型转述不算新执行。矩阵见 [测试与可观测性合同](references/testing-observability-contract.md)。

用户可以要求先完成草稿、稍后验证；不能把未执行或失败的检查声称为通过。依赖或网络不可用时，保留原始非零退出码并报告有界阻塞，不能把“已写测试”“语法看起来正确”或外部 runner 后补的静态扫描写成模型已经完成验证。

## 依赖失败止损与最终验证

TaskSpace 中的后端与前端验证只能走受控工具，不直接调用构建工具或解析网络依赖：

```text
forge-verify run --profile <profile> --admission-id <current-admission-id> --idempotency-key <current-task-idempotency-key> [--module forge-server/<module>] [--test <TestClass[#method]>]
```

已有通过结果且内容、依赖及适用范围仍匹配时，在上述 `run` 命令保留原profile与选择器，使用当前admission及新的复核幂等键，并追加 `--reuse-receipt <原receiptId>`；它进行当前合同下的正式复核，不重跑检查。可信同内容checkpoint可沿此路径续接，只有平台实际接纳才计入验收。没有独立的 `reuse-receipt` 子命令，不能把旧回执直接当新执行或伪造通过。

`forge-verify receipt` 只读取回执；`forge-verify review` 请求当前合同要求的独立语义审查，都不替代 `run --reuse-receipt`。`VERIFY_REVIEW_NOT_READY` 或 `REVIEW_SCOPE_UNSUPPORTED` 只说明独审入口的前提，不证明测试回执无法复用；不能反复调用独审来做回执复核。后端输入未变而仅前端源码变化时，平台可正式复核后端原执行，但不能把该结果外推为旧治理或前端回执有效。若 `VERIFY_RECEIPT_REUSE_INVALID` 明确指出源码、范围或其他绑定真实失效，保留原失败并只补当前范围内失效的检查；其余已正式接纳且仍有效的结果继续复用。不得因任务清单尚未收口而重跑全部检查。

`--idempotency-key` 必须为 8–128 个字符：首字符是 ASCII 字母或数字，后续仅允许 ASCII 字母、数字、`.`、`_`、`:`、`-`。为不同 profile 使用不同的有效键；加载 Skill 不会使不符合格式的参数变为合法。

上例的 `--module` / `--test` 是后端 selector，不能套用到前端 profile。前端 Admin lint 默认只检查本任务修改的源码，首次加载不全扫，空范围不安装或运行lint，文件多时自动分批：

```text
forge-verify run --profile frontend-admin-lint --admission-id <current-admission-id> --idempotency-key <current-task-idempotency-key>
```

`--file` 仅用于lint诊断。默认前端测试也不带 selector，由Runner依据可信任务基线选择受影响用例：

```text
forge-verify run --profile frontend-admin-test --admission-id <current-admission-id> --idempotency-key <current-task-idempotency-key>
```

确有已存在且进入真实测试发现范围的聚焦测试文件时，可使用 `--test-file forge-admin-ui/<real-test-path>`，不能写 `--file`。当前合同明确列出文件且选择器覆盖全部合同测试文件时，定向回执可闭合本任务验收；少测或目录合同仍保留为诊断。默认测试回执闭合本次受影响范围，无关联用例则记录0项，不追讨全量测试。后端只选择本次修改所在模块及必要依赖，不另跑全reactor重复回归。普通修改和提交不自动运行全应用typecheck或build，发布制品由受控发布流程构建；不得把这些未执行项宣称通过。

profile catalog 来自当前任务合同；模型不猜测 profile、命令、cwd、env 或镜像。可信运行时准备验证准入，真正运行验证时必须使用 current admission ID。普通任务的验证环境暂不可用时，可以继续当前身份和 owned paths 允许的修复草稿；不能因此获得验证通过、合入或发布权限。保留 typed reasonCode，后续由可信服务恢复验证环境。不得退回任意 Maven/pnpm shell、下载镜像源或搜索其他人的缓存。

实现期间先完成连贯改动，用能定位当前问题的聚焦测试验证；不要在每次编辑后重跑全量。真实失败先读取其编译错误、失败用例或环境原因，再修对应问题；没有相关改动或新证据时，不重复运行相同失败。局部修复从失败点续接，不重启需求分析或已完成的无关阶段。

最终源码、测试、依赖或配置写入会使此前相关结果过期。最终 candidate 按当前合同补足 governance audit、受影响测试及其他必要检查；中间聚焦通过不替代最终必跑 profile。未变化且仍匹配候选、工具链与策略的结果只沿受保护复核入口复用，模型不能自己宣布旧回执有效。`candidate-only`、test-shadow、cache-miss 探针或 mutation 前的 receipt 只能证明诊断边界。最终候选必须取得 cache-ready admission 和绑定当前源码、实际选中范围及真实计数的验证证据。受控变更分析确认没有关联用例时，接受该范围的0项结果，不为凑非零数量扩大到全项目；测试启动失败或实际失败仍按失败处理。不得以固定编辑次数、工具次数或时间比例强制结束必要修复。

## 输出

收到Host作业的`active: true`和`nativeObserver`时，先按返回的`tool`及`arguments`登记一次原生bash观察器，再结束等待轮；同一job已登记则复用。只有拿到原生bash任务ID后，才能告知用户“完成后会自动续接”。单有Host jobId不会自动触发会话通知；登记失败时保留jobId和具体错误，续聊观察原job，不重新提交检查。

输出需求-风险-测试矩阵、命令与 receipt、覆盖不到的运行环境、日志/指标/health/alert 设计、baseline 分流和仍需 owner 判断的门禁。清楚区分 static pass、compile、unit/integration、browser、deploy health 与长期观测。

后端编译、模块测试与定向测试、full-regression、frontend-admin-build、未指定测试文件的frontend-admin-test默认使用Host后台作业。保存jobId，再用bash的`run_in_background: true`启动一次`forge-verify watch --job-id <jobId>`并保存原生bash任务ID；原生完成通知会返回当前会话，届时读job_output和终态对应的`forge-verify receipt`。观察器只读状态，停止观察不取消Host验证。需要即时状态时使用`forge-verify status --job-id <jobId>`，不反复调用`--wait-seconds 60`占满一轮。等待期间可继续独立只读工作或简短告知待验证，续聊先读取同一job，不能重启同一验证。运行中不修改验证输入，提交成功或观察器退出不等于验证通过。定向后端测试使用`backend-test-class --module <模块> --test <测试类或类#方法>`，不能给`backend-module-test`传`--test`；当前合同要求backend-test-class时，核对并覆盖合同内全部测试类即可正式验收，不追加整模块测试；方法级或漏类结果仅算诊断。合同仍明确要求backend-module-test时，不能把单类结果冒充模块通过。

Host回执中的`logs.path`是宿主私有日志索引，不是工作舱可读取的文件路径。使用同一job返回的receiptId执行`forge-verify receipt`，读取受保护返回的`logs.excerpt`和实际结果；舱内路径不存在不能证明日志丢失、作业未执行或需要重跑。若现有摘要不足以定位，保留jobId、receiptId和具体错误，报告缺失的诊断，不搜索宿主秘密或重新提交相同验证。
