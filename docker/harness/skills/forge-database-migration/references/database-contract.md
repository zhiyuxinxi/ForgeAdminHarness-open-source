# Forge Admin 数据库合同

## 普通业务表模板

```text
id BIGINT primary key
tenant_id BIGINT NOT NULL DEFAULT 1
create_by BIGINT NULL
create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
create_dept BIGINT NULL
update_by BIGINT NULL
update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
del_flag BIGINT NOT NULL DEFAULT 0
ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

金额优先使用最小货币单位 `Long`（如 `amountCent`）或有明确精度/舍入的 Decimal，禁止浮点金额。Snowflake 主键进入前端后保持 string。

## 表类别

- 普通业务、配置、设计、主数据：完整字段，无默认例外。
- 纯关系：tenant、组合 PK/唯一键、创建审计；省略 update/delete 需精确 policy。
- 追加审计、事件、outbox：id、tenant、occurred/create time、trace/correlation、保留策略；只追加。
- 第三方：只允许 ACT_/QRTZ/Flyway 等精确前缀/表清单。
- 平台非租户：完整审计与精确 tenant exemption。

## 索引审查

- 基于真实查询/排序，不为每列建索引；组合索引遵循最左前缀。
- 租户表查询/唯一键通常以 tenant 维度开头。
- 活动唯一与永久唯一必须明确；MySQL `NULL` 不能实现单活动行唯一。
- 页面稳定排序至少提供 tie-breaker，例如 `ORDER BY update_time DESC, id DESC`。
- 检查重复/覆盖索引、写放大、选择性与 `EXPLAIN`。

## Migration 门禁

- SQL 文件使用 UTF-8。通过 MySQL CLI 导入或读取中文/多语言种子时显式传入 `--default-character-set=utf8mb4`；建库/建表的 `DEFAULT CHARSET` 不能代替客户端连接字符集。公共初始化复用 `forge-server/scripts/db/init-db.sh`；只修客户端调用不需要修改已执行迁移或重导现有库。验证应区分命令参数检查与真实数据库文本往返，不能仅凭退出码或表数认定中文正确。

- 命名 `Vx.y.z__lower_snake.sql`，版本唯一且高于已存在版本。
- 禁止修改/删除已提交版本，禁止普通任务 DROP/TRUNCATE/RENAME。
- DDL/DML 显式目标；种子用 NOT EXISTS、INSERT IGNORE 或审查后的 ON DUPLICATE KEY。
- 字典、资源、Excel 配置在路径/权限/字段已冻结后生成；默认租户 1。
- raw `${token}` 会被 Flyway 解释；确需字面量时用 SQL 拼接并由静态扫描确认。
- MigrationContractTest 断言表、列、索引、字典/资源 seed 的完整业务语义；`UNION ALL` 后续分支按位置继承首个 `SELECT` 的列名，不得要求它们重复 `dict_value` 等别名。测试不得因等价空白、注释或合法别名省略而失败。

## 必测负例

跨租户读取、无租户上下文、重复种子、并发插入同业务键、删除后重建、旧版升级、部分迁移状态、超长/空值、无权限直接 API、回退后 schema/数据完整性。
