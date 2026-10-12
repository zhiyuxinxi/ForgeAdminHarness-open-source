# Forge Admin v1.1.2 工作流生产合同

## 固定来源

基线 commit：`6eb2881e6f6af85a5348acf3da63cef53a873b0e`。

项目权威 Skill：

- `.agents/skills/forge-business-flow-development/SKILL.md`
- `references/code-first-workflow.md`、`lowcode-workflow.md`
- `references/status-and-callbacks.md`
- `references/bpmn-configuration.md`
- `references/sql-templates.md`
- `references/validation-checklist.md`

源码 sample owner 位于 `forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/purchase/`，迁移位于 `forge-server/db/migration/V1.0.81...V1.0.84...`，管理端页面/API 位于 `forge-admin-ui/src/views/business/purchase-order-test.vue` 与 `src/api/business/purchase-order-test.js`。这些是参考实现而不是可盲复制的业务规则。

## 必须冻结的合同

| 区域 | 必填决定 | 失败模式 |
| --- | --- | --- |
| identity | tenant + objectCode + recordId + businessKey | 重复实例、跨租户串单 |
| state | 合法 transition、terminal、repair | 乱序 callback 造成漂移 |
| BPMN | model key/version/node keys/default flow | 覆盖 designer 配置、重复 task |
| variables | name/type/source/required/default | expression 缺值或 Long 精度丢失 |
| form | asset/provider/node readable/writable/required | 越权写字段、history 可编辑 |
| actor | assignee/candidate/delegate/return | 无人任务、越权审批 |
| side effect | idempotency/outbox/retry/compensation | 重复扣减、部分提交 |
| version | new instance/in-flight policy | 历史实例语义突变 |

## 最小验证序列

1. create 为 DRAFT；double-submit 只产生一个 instance。
2. submit 保存 businessKey/processInstanceId 并进入 IN_PROCESS。
3. todo 解析正确 asset；只有 readable 字段可见、只有 writable 字段可保存，required server-side 生效。
4. approve 全路径到 APPROVED；reject 进入 NEED_MODIFY；modify/resubmit 回 IN_PROCESS。
5. applicant terminate、cancel/withdraw、admin terminate 分别进入批准的终态。
6. duplicate/out-of-order/late callback 绑定当前实例且不重复副作用；query 只读检测漂移，持久修复由既有回调、调度或明确授权动作按预期状态/version 完成并审计，不由列表/详情写表。
7. done/history readonly；错误 tenant、错误 actor、直接 API、篡改 node/record ID 均 deny。
8. non-empty designer BPMN 在重启/init 后 byte/semantic owner 不被覆盖；新部署不改写已有运行实例。

## 建议命令形态

根据实际模块选择，不复制占位符为成品：

`RUNNER_INTERNAL_REFERENCE_ONLY_V1`：业务核心与流程模块的构建顺序、启用测试的参数、依赖模块展开和退出码检查由受控 Runner 的版本化 profile 固定；它们不是模型可复制执行的 shell。可信运行时先为 Task Execution Contract 的完整 profile 闭包注入 ready execution admission；模型不调用 `admit`，只用当前 admission ID 逐个执行 `forge-verify run`，并为合同要求的后端 profile 提供精确 `forge-server/<module>` selector。

还需真实 MySQL/Flyway、Flowable engine、API 和浏览器场景。Maven 0 不能证明 BPMN 已部署或业务副作用正确；没有服务环境就明确留待验证。
