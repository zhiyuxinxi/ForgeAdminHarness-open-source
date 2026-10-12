# Forge Admin 交付编排台账

在正式分派、恢复长任务、接受 handoff 或串行集成时使用。台账可维护在当前响应或获授权的任务文档中；没有协调服务回执时，它只是可审查记录，不是锁或权威状态机。

## 1. 编排头

| Field | Value |
|---|---|
| Orchestration ID | 当前任务稳定 ID |
| Project / Task | 精确项目和唯一目标 |
| Base commit | 完整 commit 与集成基线 |
| Action authority | 只读/设计/实现/测试/提交/发布逐项列明 |
| Coordinator | 负责合同、DAG、冲突和最终结论的人/Agent |
| Integration owner | 唯一候选组装责任人 |
| Hard coordination | TaskSpace、范围租约、handoff/状态服务的实际可用性与版本 |
| Concurrency limit | 实际槽位和 writer 上限 |

平台模板只有在受审地登记 `/.forge-delivery/` ignored 后才允许创建本地状态。记录 `forge-delivery worktree inspect` 的 commit、branch、clean/entries 结果，但不要把 inspect 当成范围租约；共享文件系统没有其他硬租约时 writer 上限为 1。

## 2. Work DAG

| Work ID | Outcome | Depends on | Status | Assignee / TaskSpace | Owned paths | Owned semantic resources | Deliverable | Verification | Stop condition |
|---|---|---|---|---|---|---|---|---|---|

语义资源至少检查：API/DTO、表/列/Flyway、permission、dict、workflow、公共组件、配置 key、共享测试 fixture 和版本/catalog。任何 writer overlap 必须在分派前消解。

## 3. 分派包

每个工作项必须发送以下信息，不依赖接收者阅读整段旧对话：

1. objective 与明确非目标；
2. project、base commit、权威输入及已冻结合同版本；
3. owned paths 与 owned semantic resources；
4. 允许动作、禁止动作和外部权限边界；
5. 需要读取的项目 Skill/规则；
6. 可验证交付物、验证命令/用例和完成条件；
7. 冲突、失败、用户输入变化和上下文不足时的停止条件；
8. handoff 必须返回的证据字段。

## 4. Handoff

| Field | Required content |
|---|---|
| Work ID / actor / TaskSpace | 任务归属；不可反推其他工作舱 |
| Base / candidate | 完整 commit；只读任务写 `no_candidate` |
| Changed files | 精确路径，不用通配摘要替代 |
| Semantic changes | API、schema、permission、dict、workflow、公共 owner |
| Verification | 实际命令/用例、工作目录、退出状态、失败和未执行项 |
| Evidence reference | 可验证 receipt、日志摘要/hash；没有则明确 `none` |
| Risks / decisions | 未决冲突、业务决定、平台阻塞 |
| Recommended next | 只能位于当前合同内，不扩张权限 |

Hash 只能证明内容未变，不能证明内容正确、测试执行过或操作者获授权。

创建/验证 handoff 使用精确 `handoffId`、`changeId` 和逐个仓库相对 source 文件。handoff 在 change state/version、Git commit 或任一 source 漂移后必须失败；不要修改旧 record 来“刷新”它。

## 5. Fan-in 检查

- candidate 是否基于当前集成线，且只包含 owned scope；
- shared contracts 与消费者是否为同一版本；
- migration、permission、dict、workflow 等语义资源是否冲突；
- 单项验证是否可复现，组合验证是否在最终组装 commit 上执行；
- 未执行的 reviewer/model/browser/release 是否仍标为未执行；
- 发布动作是否有独立用户授权、Broker/Runner 回执和 exact candidate。

CLI change 状态严格为 `scoped → designed → implementing → implemented → verifying → evidence-recorded`。最终状态只有在合法 CAS 和对应记录成立时推进；`ready_for_integration` 不是 `integrated`，`integrated` 不是执行已证明，`evidence-recorded` 也不是 verified 或 released。
