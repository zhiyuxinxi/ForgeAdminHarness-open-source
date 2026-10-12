# Database 阶段交互卡

## 本阶段需要的上游与数据库资料

- 已验收 requirements 与 domain-contract artifact/manifest。
- 当前 Flyway 版本序列、已有表/索引/权限种子和项目数据库规范。

## 本阶段关注点（提示由 Controller 自动生成）

只完成支撑已确认业务规则的数据库设计与迁移。技术执行仍须先在 `forge-server/forge-business/forge-business-core/src/test/java` 的真实 Maven test classpath 内，参照相邻 `*MigrationContractTest` 写一个会因目标迁移缺失而失败的聚焦 RED 测试；再在 `forge-server/db/migration` 新增下一版 Flyway。测试必须验证完整 SQL 语义或 seed 元组，不能依赖格式/注释，也不能要求 `UNION ALL` 后续分支重复首个 `SELECT` 已声明的列别名。所有普通租户业务表必须核对 `tenant_id`、`create_by`、`create_time`、`create_dept`、`update_by`、`update_time`、`del_flag`，以及 Long ID、业务键墓碑唯一性、索引、字典/Excel seed、幂等与回退边界。禁止臆造 `created_by`、`created_at`、`updated_by`、`updated_at` 或 `is_deleted`。本阶段严禁写菜单、按钮、API resource、任何 `src/main` 后端代码或页面；访问控制数据留给页面和 API 均验收后的 access-wiring 阶段。上述技术提示由 Controller 自动生成，不要求业务人员提供路径、命令或参数。

## 阶段输出与停止条件

- 只修改 catalog 授权的迁移目录和业务核心模块测试目录；测试必须进入该模块真实 compile/test selector，禁止修改任何后端生产源码。模型声明 changedPaths 必须与 operator 观察一致。
- 面向同事先说明本阶段为哪些业务数据规则形成了迁移、当前能否进入下一步及实际影响；命令、路径、回执、`cannotClaim` 和唯一机器 artifact 放在技术区。迁移文件存在或合同检查通过不能说成数据库已经迁移成功。
- SQL 文件存在不等于迁移成功；必须保留 governance/数据库相关受控回执与 cannot-claim。
- 契约测试本身必须先接受反脆弱审查：合法等价 SQL 不得因别名只在首个 `SELECT` 声明、空白或注释变化而失败。
- 任一迁移/审计/租户/逻辑删除硬门槛失败，不进入 ui-design；发现菜单、按钮或 API resource seed 也必须拒绝本阶段。
