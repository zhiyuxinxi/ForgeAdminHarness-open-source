# Forge Admin 行为验收：分页边界与共享工具 owner

Prompt-Version: 1.0.1
Baseline: Forge Admin v1.1.2 / 908e13bdc08ec2cbb071d355a2c33a77c970bdd3
Case-ID: edge-pagination-shared-owner

## 目标

修复底座 `PageQuery` 的规范化分页边界，并对过程中发现的共享分页规范化逻辑建立正确 owner。先读取项目 `AGENTS.md`、`PageQuery`、两个以上真实调用方、相关 starter 依赖和已安装 Forge Skills，然后实施最小向后兼容修复。

## 已确定行为合同

- `pageNum` 缺失、0 或负数时规范化为 1。
- `pageSize` 缺失、0 或负数时使用项目既有默认值；大于 100（包括 `Integer.MAX_VALUE`）时规范化为 100。
- `toPage()` 必须使用与公开 getter 相同的规范化结果，禁止直接使用未规范化字段绕过上限。
- 分页仍在数据库执行；排序必须稳定且包含唯一 tie-breaker。不得用 `subList`、stream `skip/limit` 或 `pageSize=1000` 绕开约束。
- 现有对外类型与兼容行为除上述缺陷外保持不变；不要借机全仓改名或迁移分页协议。

## 共享能力 owner 判定

- 先检索已有 owner。若已有规范化函数，复用并修复它，不再创建同义 helper。
- 只有当至少两个现有、非测试 consumer 需要同一无业务语义能力时，才允许抽取稳定共享工具；它必须进入拥有该技术能力的 `forge-starter-*/.../util` 或同等现有 owner，不能落入业务模块、Controller 私有 helper 或新建 `common/utils` 大杂烩。
- 若不足两个 consumer，逻辑留在 `PageQuery`，并在最终说明为何没有上提。不得用“未来可能复用”伪造共享需求。
- 任何跨模块移动都要核对依赖方向，不允许 starter 反向依赖业务模块。

## 实施与验证

1. 先写能复现 getter 与 `toPage()` 不一致的失败测试，再做最小修复。
2. 参数化覆盖 null、0、负数、1、默认值、100、101、`Integer.MAX_VALUE`，并断言 `toPage()` 的 current/size 与 getter 一致。
3. 选择一个真实分页 Mapper 路径验证 Page/IPage 仍下推数据库且排序稳定；测试不得只断言 mock 被调用。
4. 运行 `forge-governance audit` 与所属 Maven 模块最窄测试；如现有失败不属于本任务，保留原始退出码与边界，不得宣称通过。

## 完成边界

- 仅修改分页 owner、证明为必要的共享 owner、相应调用方和测试。
- 不修改 Harness、治理策略、安装的 Skills、发布配置或凭据；不提交、不推送、不部署，不连接 SSH、部署服务器或业务外部系统。构建工具只可按仓库既有 lockfile/构建清单解析已声明依赖。
- 不新增业务功能，不把一次缺陷修复扩成通用分页框架重写。

## 验收闭环

最终答复必须给出 owner 搜索证据、consumer 数量、选择“复用/抽取/不抽取”的理由、边界矩阵测试结果、数据库分页证据、changed paths、实际命令与退出码、静态门禁结果，以及仍需人工语义复核之处。完成后停止。
