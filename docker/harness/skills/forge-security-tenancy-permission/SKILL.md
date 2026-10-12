---
name: forge-security-tenancy-permission
description: Implement or review Forge Admin v1.1.2 authentication, API authorization, menu/button permissions, tenant isolation, data scope, public endpoints, Long IDs, secrets, sensitive logs, and cross-tenant operations. Use whenever a change touches login, identity, resource permissions, tenant context, data visibility, encryption, credentials, or externally reachable APIs.
---

# Forge Admin 安全、租户与权限

Policy marker: `FORGE_SECURITY_TENANCY_PERMISSION_V1`.

## 先建威胁合同

列出 actor、tenant、resource、action、data scope、入口、信任边界、敏感字段、失败模式和审计事件。公开接口、跨租户、服务账号、回调、批量导出、文件和流程动作默认高风险；没有明确合同就停止实现。

## 授权与资源

1. 非公开业务 endpoint 的确定性地板是 `@SaCheckPermission` 或 exact method+path API resource 至少一项。鉴于当前 resource 缺失会放行，新/改业务 endpoint 默认同时配置稳定权限码和 exact resource；选择单层防护必须作为安全语义决定独立复核。
2. 菜单、按钮和 API resource 是三个不同层次：前端隐藏只是 UX，不能代替直接 API 授权；API resource 的 method、path pattern 与实际映射必须一致。Flyway seed 必须先解析业务菜单 ID，再把 `resource_type=3/4` 的按钮/API resource 挂到该菜单，禁止用 `parent_id=0/NULL` 制造根级孤儿权限。
3. 当前 v1.1.2 在 API resource 未配置时会放行，`v-hasPermi` 在权限数据为空时也会保留元素。变更必须用“资源缺失、权限集合空、错误租户、直接调用”负例证明失败关闭，不能继承此行为。
4. `@SaIgnore`、`@ApiPermissionIgnore`、public/anonymous、通配资源和根路径通配都属于安全边界变更。只允许精确、最小的版本化 allowlist，并由安全 owner 复核。

## 租户与数据范围

- 主体使用认证上下文的稳定 userId，展示姓名、用户名和岗位描述不是授权标识。有效成员通过 starter-core 的 `TenantMemberDirectory.findActiveMembers(userIds, directOrgId)` 批量验证，必填直接组织的候选通过 `findActiveMembersByOrg(directOrgId, keyword, afterUserId, limit)` 游标查询；确切上限/返回语义见 `forge-backend-architecture`，必须全员有效时比较 ID 集合。目录不授予业务动作或组织范围权限，岗位/经理/抄送规则仍归领域。默认租户字段不是多租户成员关系，不以业务 Mapper 私查 `sys_user`/关联表复制身份规则；若基线缺该接口先同步公共 owner，不能退回姓名匹配。历史展示保留稳定 ID/快照，停用成员不能使历史消失。
- 读取权限、对象范围、状态动作和字段可写范围分别校验；普通 add/edit DTO 不接受审批终态、签字、办理人、审批历史或服务端派生余额。新增初态由服务端设定，普通修改保留受控字段，确认/签署只由专用授权动作生成。动态 Map/分区表单同样采用当前阶段字段白名单。
- 修改/删除先校验原记录的授权范围，不能只校验请求要迁入的目标组织。列表、详情与批量操作对“全范围/限定组织/空范围”的含义必须一致；看得见不自动表示有办理资格。

- 普通 tenant-owned Entity 继承 `TenantEntity`；DTO/Query 不接受调用者提交的 `tenantId`，从认证后的 TenantContext 取得。SQL、缓存、幂等键、对象存储路径、消息和审计事件都绑定 tenant。
- 严格模式缺少 tenant context 必须失败关闭。禁止 `tenantId == null ? 1L : tenantId`、`Optional.ofNullable(tenantId).orElse(1L)`、`requireNonNullElse(..., 1L)` 等把未知调用者静默落到内置租户的写法；应抛出稳定的未认证/租户上下文异常。异步、定时任务、消息、Flowable callback 和线程池必须显式传播并在 finally 清理上下文。
- `executeIgnore`、ignore table、平台表、跨租户管理员操作必须使用窄作用域 API，绑定 actor、目标 tenant、reason、批准、审计和负例；模型不得自行认定“系统任务”而绕过。
- Data scope 是 tenant 内的第二层约束。列表、详情、导出、批量写、关联选择器和 count 必须使用同一 scope；不能只保护列表。
- 前端 Snowflake Long ID 永远按 string；日志、错误、缓存 key 和资源匹配不做有损数值转换。

## Secret、日志与加密

Secret 只来自项目认可的 secret provider/环境注入，不进 Git、migration、Skill、prompt、日志、URL 或前端 bundle。密码、token、cookie、密钥、完整手机号/证件/银行卡、请求体和解密明文必须按字段级策略脱敏或禁止记录。nonce、token、密码和 security identifier 使用 CSPRNG，不得使用 `Math.random()`。

## 硬门禁与例外

运行：

```text
forge-governance audit --root /workspace --base <approved-base-commit> --format json
```

确定性 audit 对其实际支持的形态失败关闭：endpoint 无后端 enforcement、普通 DTO 接受 tenantId、Long ID 数值化、弱随机、硬编码 Secret/敏感日志和未显式标注的 public 等。跨租户窄作用域是否正确、data scope 是否完整、配置在运行时是否启用必须独立复核并实测。需要放宽确定性 rule 的例外只能由外部批准的版本化 policy 提供，绑定 rule、actor/role、repo/path、hash、reason、expiry；模型不能审批自己的例外，源码注释也不是授权。

第一次写入前确认可信运行时已经为 Task Execution Contract 的全部非 governance profile 注入 ready execution admission；模型不得自行调用 `admit`。仅在批次 ready 后，才用当前 admission ID 逐个调用 `forge-verify run`。后端 profile 的 module/test selector 只能按 `forge-testing-observability` 的类型化规则提供。`RUNNER_INTERNAL_REFERENCE_ONLY_V1`：构建工具、API contract/security tests 的底层 argv 与环境由受控 Runner 固定，模型不得直接执行 Maven 或包管理器 shell。真实角色/租户负例仍需要独立受控运行证据；只有实际请求和存储查询能证明运行时隔离，audit、编译或前端隐藏不能。缺少这类能力时必须标为 blocked，不能用已有 profile 冒充。详见 [安全与租户合同](references/security-contract.md)。

## 输出

输出 threat matrix、资源/权限/tenant/data-scope 映射、public/ignore 例外、敏感数据策略、主/负路径测试、审计事件和未验证项。不得把“有注解”“页面看不到”或“测试代码已写”声称为安全已验证。
