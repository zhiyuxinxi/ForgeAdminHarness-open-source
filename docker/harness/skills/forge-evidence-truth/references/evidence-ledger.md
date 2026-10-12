# Forge Admin 证据台账

在多阶段交付、版本/运行态核对、正式 handoff 或证据矛盾时使用。本台账帮助审计，不自动成为项目权威；机器回执缺失时不能靠填写表格补足。

## 1. 审计身份

| Field | Value |
|---|---|
| Audit ID | 当前任务稳定 ID |
| Project / TaskSpace | 精确项目与工作舱 |
| Claimed candidate | 分支与完整 commit |
| Audit scope | implementation / test / migration / git / package / runtime / UAT / handoff |
| Allowed actions | 本轮能读取或执行的检查 |
| Observation time | 带时区；不反填过去时间 |

## 2. 声明台账

| Claim ID | Atomic claim | Object identity | Required evidence | Observed evidence | Result | Gap / contradiction |
|---|---|---|---|---|---|---|

结果只用：

- `proven`：对象一致，所需直接证据完整且结果支持声明；
- `supported_with_gaps`：部分直接证据支持，但非关键覆盖仍缺失；
- `unverified`：缺少足以判断的直接证据；
- `contradicted`：直接证据与声明冲突，或证据属于另一对象/版本；
- `not_applicable`：合同明确不适用，并记录依据。

## 3. 证据来源等级

| Level | Examples | Can prove |
|---|---|---|
| Controlled receipt | Broker/Runner structured result、类型化协调/检查器回执 | 该受控边界实际接受和执行的固定动作 |
| Direct observation | Git object/status、实际命令退出状态、镜像 inspect、真实 API/浏览器结果 | 指定对象在观察时的状态或行为 |
| Derived artifact | hash、报告、coverage、截图、日志摘要 | 只证明其可追溯内容；需绑定原始对象和生成方式 |
| Narrative | 模型总结、人工描述、计划、文件名、状态字段 | 只能提出待验证声明 |

`OPERATOR_ONLY_REFERENCE_V1`：平台/operator 通过独立授权的 `forge-delivery` 类型化动作产生的 verify/evidence receipt 属于 derived/self-recorded integrity 记录；标准模型不执行该 CLI。此类 receipt 可证明 record、commit 和日志 hash 在检查时一致，但固定返回 `executionProven=false`、`verificationProven=false`，不能提升为 Controlled receipt。

`forge-verify` receipt 属于 Controlled receipt，但只有 source fingerprint 当前、profile/selector 覆盖声明、不可变 image/cache 一致、退出成功且测试 profile 非零执行时，才证明对应的固定验证。它从不证明业务语义、数据库集成、发布或 UAT。

Receipt 也只证明其职责范围：Runner 技术发布证据不能替代产品 UAT，浏览器 UAT 不能替代迁移安全，hash 不能证明内容正确。

## 4. 阶段最小证据

| Stage | Minimum identity and evidence |
|---|---|
| Local change | base/candidate、精确 diff、task-owned paths、工作区状态 |
| Verification | candidate、命令/用例、cwd、工具版本、退出结果、失败/未执行项 |
| Migration | candidate image、Flyway 集合、登记 `_test`、Runner stage/result、恢复状态 |
| Git checkpoint | branch、commit、staged scope、验证、提交后状态、push 是否实际发生 |
| Package | source commit、catalog/bundle、构建退出、不可变 image digest、镜像内发现检查 |
| Runtime | project、容器/服务、image digest、runtime contract、观察时间；不得由源码推断 |
| Release | jobId、candidate commit、service allowlist、migration、image digest、smoke、rollback result |
| Business UAT | URL、runtime version、role/tenant、业务步骤、数据 ID、允许/拒绝结果、清理状态 |
| Handoff | Work ID、actor/TaskSpace、base/candidate、changed files、验证、未决风险 |

Change 状态 `evidence-recorded` 只说明至少一个 exit-code-zero 的 self-recorded record 被完整性检查并消费；它不是 verified、CI passed、released 或 accepted。真实执行仍需直接测试/CI 回执，发布仍需 Broker/Runner，业务结果仍需 API/浏览器证据。

## 5. 漂移与基线

证据生成后如果候选源码、依赖锁、迁移、部署配置或共享合同发生变化，受影响证据失效并需要重跑。只改变说明文档时仍核对它是否改变验收合同。

基线失败必须有同环境、同命令或可比较历史证据。否则写 `unverified_baseline`；不要把所有失败归到本轮，也不要以“可能是旧问题”免除当前候选放行要求。

## 6. 最终摘要

分别报告：

1. 本地源码候选；
2. 最终 candidate 上的验证；
3. Git/远端状态；
4. Skill bundle 或应用镜像打包状态；
5. 服务器/运行态状态；
6. 发布后业务验收；
7. 缺失硬门禁和不可证明项。

未进入某阶段就写“未执行/未授权”，不要用“待确认”掩盖根本没有证据。

依赖或环境阻塞时仍完成本摘要，并附首次失败与唯一最窄重试（如发生）的 argv、退出码、缺失坐标和停止原因。阻塞后的静态 PASS 只能证明静态范围，不能把 compile/test 声明升级为 `proven`。
