# Frontend 阶段交互卡

## 本阶段需要的上游与前端资料

- 已验收 requirements、domain-contract、database、ui-design、backend artifact/manifest。
- 当前 API adapter、全局组件、设计 token、权限指令、字典和前端测试入口资料。

## 本阶段关注点（提示由 Controller 自动生成）

只实现已确认的页面用例。技术执行仍须先形成 RED 测试，复用已有 API adapter、全局组件、设计 token、权限指令和字典；闭合 Long ID、加载/空/错/成功状态与可访问性。不要修改数据库或后端。Controller 自动提供写入范围和验证要求，不要求业务人员填写 phase ID、路径或命令。

## 阶段输出与停止条件

- 只修改 catalog 授权的 `forge-admin-ui/src/api`、`forge-admin-ui/src/views`，以及 `forge-admin-ui/package.json`、`forge-admin-ui/pnpm-lock.yaml`、`forge-admin-ui/jsconfig.json` 三个文件；禁止在页面内复制请求、权限、分页或组件基础能力。
- 面向同事先说明哪些页面操作和状态已经实现、用户会看到什么及下一步；检查通过只能说明当前候选满足相应检查，不能说成已经发布。技术配置、回执和唯一机器 artifact 完整后置。
- 基于现有 `jsconfig.json` 补齐真正的 typecheck 入口，固定 vue-tsc/TypeScript 依赖并同步 lockfile，修复实际诊断；不得省略 typecheck、扩大 exclude 或用 skipLibCheck 掩盖问题。
- 该写域与验证约束由阶段 catalog 定义，由 frontend 阶段实现；Host Runner 的 `frontend-admin-typecheck` profile 直接消费上述入口、lockfile 和配置，固定执行 `pnpm run typecheck`；Controller 核验绑定当前阶段 artifact/patch 的 Host 回执后决定接受。
- API 字段、错误合同、权限码和 Long ID 必须与已验收上游一致。
- Lint、test、typecheck、build 或 governance 任一非零/未执行时，不进入 access-wiring。
