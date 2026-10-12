# Access Wiring 阶段交互卡

## 本阶段需要的权限与已验收产物

- 已验收 requirements、domain-contract、database、ui-design、backend、frontend artifact/manifest。
- 已存在的页面组件路径、后端 literal API 方法/路径、权限码、业务菜单父节点和角色可见性合同。

## 本阶段关注点（提示由 Controller 自动生成）

只把已经存在且已验收的页面和 API 接到正确角色与权限。技术执行仍须先在 `forge-server/forge-business/forge-business-core/src/test/java` 的真实 Maven test classpath 内写权限接线迁移的聚焦 RED 合同测试，再在 `forge-server/db/migration` 新增下一版追加式 Flyway；只写菜单、按钮、literal `perms/api_method/api_url`、`resource_type=3/4` 父子关系与角色可见性，`sys_role` 关联和保护条件必须约束 `role_status=1 AND del_flag=0`。禁止修改或重命名 database 阶段 migration，禁止修改后端/前端源码。Controller 自动提供机器字段和路径，不要求业务人员填写。

## 阶段输出与停止条件

- 只修改 catalog 授权的迁移目录和业务核心模块迁移测试目录；新增 migration 版本必须晚于 database 阶段版本。
- 面向同事先说明哪些角色将看到哪些入口和操作、当前权限影响及仍需确认的业务可见性；只有真实验证支持时才能说接线通过。技术命令、回执和唯一机器 artifact 完整后置。
- 菜单 `component` 必须解析到已存在页面；API resource 必须逐条对应已存在 Controller literal mapping 与权限码，模型变量或拼接不能代替 literal 合同。
- Governance、迁移测试或 backend module test 任一非零/未执行时，不进入 cross-layer-acceptance。
