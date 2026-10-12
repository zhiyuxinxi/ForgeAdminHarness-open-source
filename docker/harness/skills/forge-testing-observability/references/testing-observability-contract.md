# Forge Admin v1.1.2 测试与可观测性合同

## 固定来源

基线 commit：`6eb2881e6f6af85a5348acf3da63cef53a873b0e`。

- `forge-server/pom.xml:67-70,100-122,198-205,243-249`：compiler/test 默认跳过、`enable-tests` profile、其显式 `testExcludes` 和 surefire 绑定；启用 profile 仍需核对目标测试实际被选中。
- `forge-admin-ui/package.json:6-12`：build、test、lint:fix 脚本。
- `forge-admin-ui/vitest.config.js`：jsdom、测试 include 和目前只聚焦 flow-designer 的 coverage include；不是全站 coverage 证明。
- `forge-admin-ui/src/utils/debug-console.js:6-43`：生产可加载 `vconsole@latest` 的风险。
- `forge-admin-ui/src/utils/http/interceptors.js:535-567`：traceId/nonce 弱随机债务。
- `forge-server/forge-admin-server/pom.xml:152` 及多个 server module：Actuator 依赖存在；它本身不证明 readiness、metrics、tracing 或 alert 已落地。
- `forge-server/forge-admin-server/src/main/resources/logback.xml` 与 `forge-server/forge-framework/forge-starter-parent/forge-starter-log/src/main/java/com/mdframe/forge/starter/log/aspect/OperationLogAspect.java:148-237`：已有 traceId/operation log 局部能力，不等于 ingress-to-async 全链路。

## Java 测试依赖闭包

- 测试文件的 owner 是包含其 `src/test/java` 的最近 Maven module；只有该 module 的 `<dependencies>` 或它通过 `<parent><relativePath>` 显式声明的本地父链依赖，才计入静态 test-framework 闭包。
- `dependencyManagement`、plugin dependency、另一个 sibling module 的测试依赖和仓库里“某处已有 JUnit”都不能证明当前测试会编译。
- `QUALITY-TEST-004` 对 JUnit、AssertJ、Mockito、TestNG import 与可见依赖做确定性失败关闭；最终仍须由 `backend-test-class`/`backend-module-test` receipt 证明 compile、selector 和非零 test count。
- 如当前 Task Contract 不拥有 `pom.xml`，不得为绕过 admission 扩大路径或临时加依赖；只能选择已经依赖生产 owner且 test classpath 完整的下游测试模块，否则报告结构化 blocker。

## 验证矩阵

| 变更 | 最小自动化 | 仍需运行环境证据 |
| --- | --- | --- |
| Java 纯逻辑 | targeted JUnit + module compile | 无，除非依赖配置/并发 |
| Controller/permission | Mock/contract + security negative | real auth/resource config direct API |
| Mapper/tenant | repository integration with real MySQL | cross-tenant rows and query plan |
| Flyway | empty + previous snapshot upgrade + repeat guard | final schema/data/checksum |
| Vue component/API | eslint + project typecheck + Vitest + build | browser roles/viewports/network failures |
| Flowable | BPMN parse/engine integration + callbacks | full approval/retry/version path |
| log/metric/health | contract test for names/redaction/cardinality | scrape/query, alert fire/recover, runbook |

## 命令模板

实际 module/test selector 必须来自 diff：

`RUNNER_INTERNAL_REFERENCE_ONLY_V1`：后端编译/测试与前端 lint/typecheck/test/build 的具体 executable、参数、cwd、依赖 cache 和超时属于版本化 Runner 实现，不是模型可执行模板。模型不得从表中反向拼装构建工具 shell，也不得把未执行的内部映射写成 receipt。Migration、API、browser、Flowable 与观测查询需要各自工具和受控环境。

在受管 TaskSpace 内，可信运行时先为 Task Execution Contract 的完整 profile 闭包取得 execution admission；模型不调用 `admit`，只在收到 ready admission 后执行 `forge-verify run --profile <contract-required-profile> --admission-id <current-admission-id> --idempotency-key <current-task-idempotency-key>`；需要 selector 时只使用下表允许的类型化 selector。

| 目标 | `forge-verify` profile | Selector |
| --- | --- | --- |
| 静态完整变更审计 | `governance` | 无 |
| Java module 编译 | `backend-module-compile` | `--module forge-server/<module>` |
| Java module 测试 | `backend-module-test` | `--module forge-server/<module>` |
| 指定 Java 测试 | `backend-test-class` | `--module ... --test Class[#method]` |
| Admin ESLint | `frontend-admin-lint` | 可选；每个真实改动文件重复 `--file forge-admin-ui/<source-path>` |
| Admin Vitest 最终完整测试 | `frontend-admin-test` | 无 |
| Admin Vitest 聚焦诊断 | `frontend-admin-test` | 可选 `--test-file forge-admin-ui/<real-test-path>`；不能替代最终完整测试 |
| Admin typecheck / build | `frontend-admin-typecheck` / `frontend-admin-build` | 无 |
| H5 build | `frontend-h5-build` | 无 |
| 全后端回归 | `full-regression` | 无 |

执行验证需要可信运行时为当前合同 profile 闭包签发的 `ready` 短租约；模型不自行选择 command/cwd/env/image/URL，也不用逐 profile `capability` 替代准入。普通任务只有在运行时明确允许 `draftBeforeVerification`、当前写入身份及 owned paths 有效时，才可先保存授权草稿；cache miss/invalid/unavailable 阻塞验证，不自行撤销既有草稿权限。正式阶段或运行时未授予该能力时仍遵守原写入准入。租约、依赖/cache、Runner revision、TaskSpace identity 或安全边界不符时，不能宣称验证有效或借草稿能力合入/发布。Runner receipt 固定保留 `semanticCorrectnessProven=false`、`databaseIntegrationProven=false`、`releaseProven=false`，这些范围仍按验证矩阵补证。

`frontend-admin-typecheck` 的 Runner 内部命令固定为 frozen install 后的项目脚本 `pnpm run typecheck`。项目未声明该脚本或脚本退出非零时必须产生失败 receipt；禁止模型直接执行包管理器、临时选择其他 typechecker，或以 lint/build 回执替代。

### 依赖解析失败

运行时 admission 返回 `cache_miss`/`cache_invalid` 时保留具体平台 blocker，交由平台 operator 按现有准备流程恢复；模型不循环请求相同准入，也不修改缓存配置。若已有有效草稿权限，可以继续该范围内独立工作，但不得冒称通过。Runner 返回编译或测试非零结果时，先定位实际失败，再修复并按受影响 module/test selector 验证；必要修复不受“只准重跑一次”的机械限制，相同输入且没有新证据的重复运行则应停止。依赖/环境尚未恢复时不要重跑业务测试碰运气；禁止新增镜像源、下载二进制/依赖、修改用户级 Maven/pnpm 配置或无界搜索其他 cache。保留每次原始失败、退出状态和仍未取得的最终证据。

## Receipt schema

至少记录：`sourceSha`、`diffSha256`、`cwd`、`argv[]`、`startedAt`、`finishedAt`、`exitCode`、`testCount/passed/failed/skipped`、`artifactSha256`、脱敏输出摘要和 runner identity。只记录存在性、mtime、自报 PASS 或复制旧报告均不足。

Receipt 只覆盖生成它时的候选。其后任一源码、测试、依赖锁或相关配置写入都使该范围 receipt 失效；最终声明必须绑定最后一次写入后的 candidate 和新执行结果。`candidate-only`/test-shadow/cache-miss receipt 明确属于诊断，不得作为最终行为矩阵的 cache-ready 或 post-mutation verification。

## 观测验收

- 同一 request 在 API、Service、async/flow/external span 可相关；错误响应带 safe requestId。
- 日志脱敏测试含失败路径；指标标签 cardinality 有上限测试。
- readiness 在 DB/Redis/必要依赖不可用时按批准策略拒绝流量，liveness 不随普通依赖短暂失败抖动。
- 告警可在测试环境触发并恢复，通知指向 owner/runbook；没有实际查询/触发证据时只声称设计完成。
