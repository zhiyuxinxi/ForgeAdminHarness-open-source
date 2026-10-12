# Backend 阶段交互卡

## 本阶段需要的上游与后端资料

- 已验收 requirements、domain-contract、database、ui-design artifact/manifest。
- 当前模块 owner、分层约定、分页/异常/事务/权限实现和测试入口资料。

## 本阶段关注点（提示由 Controller 自动生成）

只实现支撑已确认用例的后端能力。技术执行仍须先在 `forge-server/forge-business/forge-business-core/src/test` 形成 RED 测试，再沿该业务核心模块既有 Controller/Application/Domain/Infrastructure owner 在 `src/main` 实现；共享工具放入项目规定的共享 owner，分页复用统一合同。禁止把业务 CRUD 放进 `forge-admin-server`，不要写前端。Controller 自动提供路径与机器合同，不要求业务人员填写。

## 阶段输出与停止条件

- 覆盖租户/RBAC、分页边界、affected rows、异常映射、事务、幂等和并发。
- 面向同事先说明哪些业务操作已获得后端支持、当前影响和下一步；未运行或失败的检查不能说通过。技术路径、命令、回执和唯一机器 artifact 完整后置。
- 只修改 catalog 授权的 backend main/test 路径，禁止创建平行架构或万能工具类。
- Governance、compile、test 任一非零或未执行时，不进入 frontend。
