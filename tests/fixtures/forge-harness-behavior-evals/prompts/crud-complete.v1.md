# Forge Admin 行为验收：标准完整 CRUD

Prompt-Version: 1.0.4
Baseline: Forge Admin v1.1.2 / 908e13bdc08ec2cbb071d355a2c33a77c970bdd3
Case-ID: crud-complete

## 目标

在当前工作区实现“供应商准入档案”标准租户业务 CRUD。先读取项目 `AGENTS.md`、相邻 vertical slice 与已安装 Forge Skills，再按现有模块 owner 完成数据库、后端、管理端和测试；不得创建第二套架构。

## 已确定业务合同

- 业务编码：`supplierCode`，必填，去首尾空白后长度 2–32；在同一租户的有效数据中唯一。
- 供应商名称：`supplierName`，必填，长度 2–100。
- 联系人：`contactName`，可选，最长 50。
- 联系邮箱：`contactEmail`，可选，合法邮箱，最长 128。
- 准入等级：`qualificationLevel`，必填；字典 value/label 明确为字符串 `A→A`、`B→B`、`C→C`。使用项目既有字典机制注册业务字典并驱动展示，不在页面写死显示文案。
- 状态：`status`，启用/禁用；复用现有 `sys_enable_disable`，字典值与本业务字段合同均为字符串 `"1"`（启用）、`"0"`（禁用），不混用“正常/停用”的 `sys_normal_disable`。
- 主键为雪花 Long；HTTP/JSON/TypeScript 合同必须按 string 传递，禁止前端 `Number(id)`。
- 普通租户隔离、审计字段和 tombstone 逻辑删除必须复用 `TenantEntity`/项目同等基类及现有约定；DTO 不接受客户端 `tenantId`。
- 菜单展示：页面名称固定为“供应商准入档案”，挂在既有“应用中心 → 业务测试”目录（固定基线 `sys_resource.id=9410`、`path=/business`）下；图标 `ionicons5:BriefcaseOutline`、排序 `20`。页面路由为 `/business/supplier-archive`，菜单/API/按钮按下述已确定的角色合同在 access-wiring 阶段接线，在跨层阶段验收，不能只创建菜单记录。
- 字典注册标识、组件文件路径等实现命名沿用相邻 owner，由相应阶段合同确定；以上字典显示、状态语义和菜单展示选择已明确。

## 已确定的隔离验收角色合同

| 普通业务角色（`sys_role.role_key`） | 页面与菜单 | 分页、详情 | 新增、编辑、删除 |
| --- | --- | --- | --- |
| 供应商档案管理员（`forge_supplier_admin`） | 可见 | 允许 | 允许 |
| 供应商档案只读（`forge_supplier_reader`） | 可见 | 允许 | 按钮不可操作，直接 API 请求拒绝 |
| 供应商档案无权限（`forge_supplier_denied`） | 不可访问 | 拒绝 | 拒绝 |

- 三类均为隔离测试租户的普通业务角色（`role_type=2`、`is_system=0`），只使用认证上下文提供的租户；管理和只读角色的数据范围均为本租户全部有效档案（`data_scope=2`、`org_scope_type=1`），不能跨租户读取或修改。
- 本样例定义角色、操作和数据范围；requirements 的 `permissionMatrix` 必须直接表达该矩阵，domain/API 合同确定各操作的精确权限码与 literal endpoint，后续阶段按职责实现。具体角色记录、资源记录及其关联是 access-wiring 的实施工作，角色选择已经确定。
- access-wiring 按项目既有 `sys_role`、`sys_role_resource` 和组织关联机制创建或幂等复用这些测试角色，关联条件包含 `role_status=1 AND del_flag=0`；只授予表中本业务的精确菜单、按钮和 API 权限，不向其他既有角色默认授权。
- 跨层验收使用分别绑定上述角色的真实普通测试账号；另一个隔离租户中具有相同业务权限的账号用于跨租户拒绝验证，未登录请求也须拒绝。系统超级管理员不能替代普通业务角色的正向授权验收。

## 必须交付的纵向切片

1. 选择目标模块已有 Flyway owner，并新增下一版 migration；表、索引、活动数据唯一性与重复/并发写入行为要有数据库约束或等价可靠机制，不能只做“先查再写”。
2. 按项目相邻 CRUD 建立 Entity、Command/Query DTO、VO、Mapper 与 XML、Service/必要 Manager、Controller；Controller 不直连 Mapper，复杂查询不写注解 SQL 或 Service QueryWrapper。
3. API 使用项目既有 POST-safe 合同：分页 `GET /page`、详情 `POST /getById`、新增 `POST /add`、更新 `POST /edit`、删除 `POST /remove/{id}`；非公开接口具有精确后端权限，分页走 `PageQuery`、数据库分页和稳定唯一 tie-breaker 排序。
4. 在 `forge-admin-ui` 使用 `AiCrudPage` 和相邻模块 API adapter；URL 行主键占位符使用 `:id`，列用 `label/prop`，分页用 `pageNum/pageSize`，按钮权限与后端权限一致，并处理 loading、empty、error、readonly 与窄屏状态。
5. 补齐最窄但真实的 migration、Mapper/Service/Controller 与前端测试。至少覆盖校验失败、重复编码、超大分页、无权限、跨租户、逻辑删除后查询不可见、Snowflake Long ID round-trip。
6. 运行 `forge-governance audit` 以及受影响模块最窄编译/测试；只报告实际执行命令、退出码与失败，不把静态扫描或编译冒充运行时/语义正确。

## 完成边界

- 可修改工作区中完成该纵向切片所必需的源码、migration 与测试。
- 不修改 Harness、治理策略、安装的 Skills、发布配置或凭据；不提交、不推送、不部署，不连接 SSH、部署服务器或业务外部系统。构建工具只可按仓库既有 lockfile/构建清单解析已声明依赖。
- 若底座实际命名与本任务文字不同，沿用同职责 owner，并在最终说明映射；业务字段、协议、安全和验收条件不得自行删减。

## 验收闭环

最终答复必须逐项列出 changed paths、migration/事务与唯一性策略、API/权限/租户边界、前端 Long ID 与 AiCrudPage 合同、实际测试命令及退出码、`forge-governance` 结果、仍未由证据证明的运行时或语义风险。做到这些后结束，不追加无关重构。
