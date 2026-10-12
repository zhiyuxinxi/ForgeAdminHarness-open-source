# Forge Admin 后端合同

## 允许路径

- 技术共用工具：拥有该能力的 `forge-starter-*/src/main/java/.../util/`。
- 插件内部协议/解析/适配：插件 `.../support/`。
- 领域规则：领域 Service/domain policy。
- 应用编排：业务/插件 `manager` 或明确 application service。
- Mapper XML：目标模块 `src/main/resources/mapper/...`。

禁止 Controller 私有 helper 演变成公共逻辑、业务包依赖 starter 上层、starter core 引入业务、跨插件直接复用私有 support。

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
