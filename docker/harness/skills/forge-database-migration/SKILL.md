---
name: forge-database-migration
description: Design, implement, or review Forge Admin MySQL tables, Flyway migrations, TenantEntity mapping, audit fields, tombstone logical deletion, indexes, dictionary/resource seeds, and schema upgrades. Use whenever SQL, a table, an entity schema, an index, built-in data, or migration compatibility changes.
---

# Forge Admin 数据库与迁移

Policy marker: `FORGE_DATABASE_MIGRATION_V1`.

## 权威与顺序

先读取项目 `AGENTS.md`、`.agents/skills/forge-codegen-crud/SKILL.md` 及其 SQL/checklist references；流程表同时读取项目流程 Skill。权威迁移目录固定为 `forge-server/db/migration/`，不要写到旧文档路径。

1. 先确定表类别、业务键、租户边界、删除/恢复语义、读写路径、并发/幂等、保留期和回滚方式。
2. 普通业务/配置/设计/主数据表默认必须包含 `id, tenant_id, create_by, create_time, create_dept, update_by, update_time, del_flag`，InnoDB、utf8mb4、表/列注释。
3. 默认实体继承 `TenantEntity`，不重复声明其审计/租户字段；新实体或本次改动逻辑删除契约时，声明 `@TableLogic(value="0", delval="id") private Long delFlag`，数据库 `BIGINT NOT NULL DEFAULT 0`。既有实体仅改其他字段，且 `delFlag` 的类型、删除注解及其字段绑定与审查基线完全相同、未进入本次差异时，保留原删除契约并在治理回执列为历史项；不得仅为消除历史项强推墓碑迁移、改列或回填旧数据。删除、移动注解或本次修改删除契约不能按历史项跳过。
4. 活动记录可复用业务键时用 `UNIQUE(tenant_id, business_key..., del_flag)`，删除写主键 tombstone；永久唯一键不得机械加 `del_flag`。这个选择必须写入设计证据。
5. 纯关系、追加账本/事件、第三方框架、平台非租户表不是普通表。只有版本化 policy 精确例外可放宽字段，不接受模型在 SQL 注释里自称“日志表所以跳过”。
6. 只新增下一个未占用 Flyway；历史 migration checksum 不可变。每个 INSERT 显式列、可重放，内置租户数据使用 `tenant_id=1`，禁止业务 `${...}` 占位符。
7. 复杂/分页/联表查询进入 Mapper XML，显式列、`del_flag=0`、稳定排序；普通值用 `#{}`，动态标识符只能经过项目已存在的精确 allowlist resolver。

## 验证

先运行 `forge-governance audit`。随后至少验证：空库构建、上一发布快照升级、重复执行/幂等、最终 schema、Entity-DDL-索引一致、租户隔离、删除后业务键复用、分页查询计划。MigrationContractTest 必须验证 SQL 的业务语义和完整元组，优先使用项目已有解析/规范化 helper、语句级正则或顺序无关集合；禁止用仅在首个 `SELECT` 合法出现的列别名去要求每个 `UNION ALL` 分支重复别名，也禁止用格式、空白或注释敏感的偶然子串代替语义断言。对以 `WHERE NOT EXISTS` 防重的每条 `INSERT`，测试除完整元组及关联键外，还须核对 `NOT EXISTS` 的否定存在条件；仅检查 `tenant_id`、`dict_type`、`dict_value` 等相等谓词不足以证明幂等。只有真实数据库执行 receipt 才能证明 migration 成功。

破坏性 DDL、无条件 UPDATE/DELETE、回填大表、锁表风险、跨版本双写必须停止并转独立 runbook/授权域。详细规则见 [数据库合同](references/database-contract.md)。

## 输出

报告表类别、DDL/Entity/Mapper/Flyway 对应关系、索引依据、迁移与回退、数据兼容、静态结果、实跑结果和例外证据。面向业务人员须区分“迁移脚本已准备”和“数据库已经生效”：未执行时，不能把“SQL 文件生成成功”写成“字典已注册”或“迁移已完成”。技术字段和实际执行 receipt 仍保留在机器合同/证据中。

变更删除契约、列类型或回填旧记录时，说明实际写入与存量数据影响，迁移注释必须与 SQL 一致。仅有 `del_flag=0` 查询条件不变不能证明整体向后兼容；只验证本次直接受影响的删除写入、历史记录、业务键复用和升级/回退边界。声称“下次启动自动生效”须核对目标运行端迁移配置；生效结论仍以该版本迁移的实际执行回执为准。
