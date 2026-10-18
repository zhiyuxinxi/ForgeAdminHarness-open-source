# Forge Admin 后端合同

## 允许路径

- 技术共用工具：拥有该能力的 `forge-starter-*/src/main/java/.../util/`。
- 插件内部协议/解析/适配：插件 `.../support/`。
- 领域规则：领域 Service/domain policy。
- 应用编排：业务/插件 `manager` 或明确 application service。
- Mapper XML：目标模块 `src/main/resources/mapper/...`。

禁止 Controller 私有 helper 演变成公共逻辑、业务包依赖 starter 上层、starter core 引入业务、跨插件直接复用私有 support。

## 实际运行链路兼容

- 核对当前POM、配置、公开方法及直接消费者，语言或数据库接受的写法不等于项目运行链支持。框架代理、序列化、Mapper动态SQL和租户/数据权限/分页插件是实际执行路径的一部分。
- Mapper使用真实参数生成BoundSql，验证受影响的动态分支及插件解析/改写。当前项目若使用存在已知限制的JSqlParser版本，MySQL的NULL安全等号`<=>`应采用保持语义的`(a = b OR (a IS NULL AND b IS NULL))`；实际依赖升级后以验证结果判断，不能把它扩为所有SQL的永久禁令。
- 联表、子查询、分页count和锁语句保留表别名、租户/删除范围、排序及括号语义；已有`LIMIT + FOR UPDATE`改写问题按当前插件核对，不因为主查询可执行就推断分页或加锁路径可用。不通过关闭安全拦截器、移除过滤或无依据升级依赖绕过失败。
- 事务、校验、鉴权和异步通过实际代理/入口生效，单元测试直接调用方法不证明这些机制已执行。多写失败、提交后副作用、重复请求和超时结果未知只按相关路径验证。
- 输入/输出使用真实JSON和调用方合同核对ID、金额/精度、日期/时区、null/未传/空值及错误语义；不要全局改变既有HTTP错误协议而遗漏消费者。
- 验证证据按[变更验证矩阵](../../forge-testing-observability/references/testing-observability-contract.md)选择，不以编译、XML格式检查或无关用例数量代替。

## 分页

- Request：`PageQuery` 或 `pageNum/pageSize`；新代码无 `page` alias。
- 兼容既有 `page` 时仅在 ingress adapter normalization 存在：`pageNum` 缺省时可采用 alias；两者同时存在且不相等时按公开合同失败关闭，不静默任选；两者相等时归一为唯一 `pageNum`。内部 DTO/Service/Mapper 不传递 alias。
- `pageNum >= 1`，`1 <= pageSize <= 100`，`toPage()`使用规范化值。
- tenant/data scope/permission 在分页前生效。
- Mapper 接受 Page/IPage，数据库执行 limit；稳定 ORDER BY 有唯一 tie-breaker。
- 导出/批处理使用异步任务、游标或专用上限，不用 `pageSize=1000` 绕过。
- shared normalization owner 先加载 `forge-change-design`，检索全部 consumer；测试至少覆盖 standard-only、alias-only、equal/conflicting dual input、null、负数/零和上限。

## DTO/VO/错误

- DTO 具备长度、范围、格式、集合上限；Command/Query 不复用 Entity。
- Long ID 的 JSON/前端合同是 string；计数/页码才是 number。
- `RespInfo` 只表达项目约定包络；HTTP status 与 machine errorCode 必须一致。
- BusinessException 不只携带任意中文字符串；新增错误有稳定 code 与兼容策略。

## 普通维护能力核对

- 在既有 API 说明逐项绑定 page/filter/detail/add/edit/single-delete 的实际路由、权限、参数、响应与失败原因。完整普通台账不能缺删后声称业务禁删；真正只读/归档/审计/审批等例外须有业务依据。
- DTO 字段、ID、集合上限及跨字段规则在实际入口校验；详情/编辑/删除与列表使用一致的租户和数据范围。删除校验引用及当前状态，数据库零行和受限状态返回明确失败，不只隐藏按钮或吞异常。
- 多选可复用已有单删逐项执行并回传每项结果，不强造 batch API。后端批量仅在合同需要时实现，并保持声明的原子性或部分成功语义；不能循环忽略单条失败后返回全成功。
- 公共字典/组织成员/附件能力与前端 ID、code、日期、空值及分页错误语义对齐，保留子表/附件/签字等既有功能。业务保留领域引用与状态规则，不复制公共维护体系。
- 只验证本次实际改动的正常 CRUD、过滤/分页边界、无权限/跨租户/越界访问、引用/状态禁删、零行写入和所采用的多选失败语义。静态、编译、接口行为及未验证边界分别报告。

## 事务与幂等选择

- 单表标准 CRUD：事务按实际写路径，唯一键/乐观锁处理竞争。
- 多聚合写：Service 事务 + 明确锁顺序；跨服务用 outbox/event/补偿，不假装本地事务覆盖远端。
- 写 API：业务幂等键、重复请求一致返回；高风险能力可用项目 idempotent starter。
- 流程 callback：按 tenant + businessKey 幂等，允许重复/乱序回调修复。

## 负向测试

空/越界 DTO、超页大小、跨租户、无权限、重复提交、并发更新、Mapper 空结果/多结果、事务中间失败、日志脱敏、Snowflake 超 JS 安全整数。

按本次涉及行为选择必要用例，禁止机械全跑：普通保存注入终态/签署字段应拒绝或忽略且保留服务端状态；同名不同 ID 不能互办、改名不丢历史关联；有效跨默认租户成员可选、禁用成员不可办理；列表可见范围与详情一致，修改/删除检查原对象范围；相同幂等键同内容返回原结果、异内容失败；普通属性编辑与余额入账并发不丢写；会签驳回重提不跳过未批准者、并发汇合可推进；实际数据源的主从第二步失败不留下主表；提交后任务能读到已提交记录；删除、同键重建、再次删除符合墓碑约定。静态断言/编译不能冒充这些行为已动态验证。


## 双语错误与业务消息

业务消息归 `forge-business-core/src/main/resources/forge/i18n/business/messages.properties` 与 `messages_en.properties`，显式错误复用 `UiMessages.message("business.<module>.<key>", ...)`。现有 DTO 的中文校验文本经公共异常处理器 `UiMessages.translate` 消费时，以 `business.display.<module>.<key>` 成对登记中文原文和英文译文；普通 `business.*` 词条不自动成为中文文本别名。核心词条优先，未知文本及名称、备注等业务数据不翻译。先核当前公共 `UiMessages.translate` 已读取业务显示别名；旧基线缺此接线时同步公共底座，不在业务内复制消息服务、另写异常处理器或把业务词条放到核心资源。

只修改业务 bundle 时验证该业务的直接语言消费者；修改公共消息实现时同时运行已有 `UiMessagesTest`。词条存在、只测显式 message 调用或更改英文断言为中文都不能证明校验错误已正确本地化。

## 异步、调度、外部调用和附件的实际入口
只在需求涉及该能力时应用；本节不要求普通CRUD额外建设异步或任务系统。

- **容器停机：**Java 启动脚本经 shell 展开参数时必须用 `exec java`，让停止信号到达 JVM。容器停止宽限期须覆盖应用任务排空及资源关闭时间；公共 Compose 默认 60 秒，实际调整应用等待配置时同步核对。验证实际进程和停止退出结果，不能以应用内 shutdown 单测或启动成功代替容器停机证明。
- **进度订阅的生命周期：**订阅登记及释放归同一拥有者；多个客户端订阅同一对象时不得互相覆盖，旧连接退出只能注销自己的订阅，不能按对象ID删除其他活动订阅。进度流是即时通知，持久任务状态仍从原状态入口读取，不把单机SSE缓冲称为持久事件或跨实例广播。

- **短时异步：**使用应用中已配置的受管理执行器。新增执行器确有必要时明确线程/队列上限与拒绝处理、停机等待及任务失败状态；禁止每个请求或业务Service自行new线程池，禁止把内存队列宣称为重启可恢复。数据库提交后才执行依赖该写入的任务；回滚不得派发。拒绝发生在afterCommit时数据库已提交，必须留下可重试失败或明确反馈，不能假定回滚撤销了任务记录。任务取消/超时区分未开始、运行中与结果未知，不伪造成功。
- **上下文：**`forge-starter-tenant`的`com.mdframe.forge.starter.tenant.datasource.TenantBusinessDataSourceTaskDecorator.decorate(Runnable)`捕获租户、数据源和`ExecutionIdentity`并在finally恢复；它不传播Locale。异步导出/通知另捕获`LocaleContextHolder.getLocaleContext()`并在finally恢复旧值。持久调度不能复制在线用户凭据；由既有执行身份与任务所属租户恢复授权。
- **提交后的失败回写：**afterCommit仍可能绑定已提交事务的资源，持久化失败状态应经独立代理的REQUIRES_NEW等明确事务边界，不依赖同类自调用或原事务继续提交。入队和重试用持久请求/批次标识及预期状态进行CAS，拒绝、超时或旧完成回调只能影响自己的批次；等待用户确认与已请求处理须可区分。停机先等待/处理尚未开始的任务，再销毁数据源等依赖；运行中或远端结果未知不能直接当作安全取消并重复副作用。
- **持久调度：**复用`forge-plugin-job`注册/调度/日志与`forge-starter-job`注解。现成Handler入口为`com.mdframe.forge.plugin.job.executor.IJobExecutor.execute(String param)`，使用`@JobHandler`注册后通过现有任务管理绑定；Bean直连采用`@ScheduledJob`。业务拥有幂等键、分批游标、成功/失败与重试规则，异常向调度器传播；不能另写sleep轮询或直接维护Quartz表。审批待办仍使用FlowClient/BPMN，不混成普通定时任务。
- **外部HTTP：**复用`forge-starter-outbound`的`com.mdframe.forge.starter.outbound.client.SecureOutboundClient.execute(OutboundRequest)`；请求提供真实scene、URL、方法及有限的connect/read/write/call timeout，沿现有白名单与目标校验。需取消时使用`execute(request, Consumer<Runnable> cancellation)`，null回调表示调用已结束并解除注册。读取`OutboundResponse`的实际状态，不把HTTP失败包装成功，不关闭平台借出的客户端。非幂等写入超时视为可能已执行，按对方幂等键/查询协议恢复，不盲重试、不泄露凭据与响应敏感内容。
- **流程未知结果：**使用现有`FlowClient`带startRequestId/previousProcessInstanceId的启动合同和`getProcessStartStatus(businessKey, startRequestId)`查询；`FlowStartOutcomeUnknownException`不能当作确定失败重开实例。本地业务链接补偿仍由已有拥有者处理，普通模块不复制流程恢复器。
- **附件：**`forge-starter-file`的`FileManager`拥有上传/下载/访问链接与删除；元数据来自真实fileId。关联前通过`FileMetadataPersistence.checkPermission(fileId, userId)`核当前读取权限，修改/删除使用`checkWritePermission`及对应公共入口，不能从public可读推导可写。`getMetadata/getFileMetadata`只是取元数据，不能单独当授权证明。业务拥有必填、类型/数量与引用规则，删业务引用不自动删共享物理文件。
- **导入导出：**复用`ExcelImportService.importData(file, configKey, DTO.class)`与`DynamicExportEngine.export(response, configKey, queryParams)`及现有字典/Excel元数据。持久化前对成功解析DTO执行与新增相同的实际校验；成功解析不等于数据库导入成功，原子导入任一行失败需回滚，部分导入须有明确逐项结果。异步导出沿上述租户、语言、失败与资源释放合同，不能绕分页上限查全表替代专用导出。

本轮只验证实际涉及的拒绝/回滚、上下文隔离、超时/失败、权限与字段边界，不为本节自动添加全量回归。知识库容量/拒绝/停机与重启恢复的源码和运行状态见当前专项交接；规范本身不证明机制已修复或运行端已更新。

## 代码与设计器的后端维护边界

仅当任务明确要求可视化维护时应用，普通代码CRUD不因此接入设计器。先声明哪些模型、页面、表单配置归设计器，哪些持久化映射、业务校验、权限和扩展归代码；读取当前真实DTO和保存接口，不将任意Java反向转换或改写数据表当作现成功能。

`BusinessObjectDesignerService.saveDesigner`保存设计草稿；正式应用运行由`BusinessApplicationRuntimeService`按`lastPublishVersion`读取发布快照。使用现有发布服务，不由业务代码手填发布版本、直接修改快照表或将草稿配置当正式运行配置。代码表单仅在该场景需要时按`forge-lowcode-api`的`BusinessCodeFormProvider`注册资产；它不是普通CRUD持久化或发布服务的替代者。

验证所选路径中一次真实保存→发布→后端运行消费，记录对象/配置标识与发布版本；同时证明未发布草稿不影响正式行为、再次发布或生成保留已声明代码扩展及原业务校验。保存成功、mock返回或源码包含Provider名称分别只能证明局部事实，不能冒充完整往返。当前入口不支持的配置应明确边界并报告直接缺口，不生成第二套设计器。
