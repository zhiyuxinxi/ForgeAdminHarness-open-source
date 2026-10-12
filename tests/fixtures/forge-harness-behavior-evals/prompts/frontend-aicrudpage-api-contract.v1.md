# Forge Admin 行为验收：AiCrudPage 与相邻 API 合同

Prompt-Version: 1.0.1
Baseline: Forge Admin v1.1.2 / 908e13bdc08ec2cbb071d355a2c33a77c970bdd3
Case-ID: frontend-aicrudpage-api-contract

## 目标

在当前真实工作区选择一个尚未闭环、但具有可复用相邻实现的管理端业务页面，完成一个最小且可运行的前端纵向增量。先读取项目 `AGENTS.md`、现有 `AiCrudPage` owner、至少一个同模块相邻页面及其真实 API adapter、权限和测试，再修改 `forge-admin-ui` 中的实际源码与测试；不得只写方案、伪造示例文件或新建第二套 CRUD 壳。

## 已确定前端与 API 合同

- 页面必须复用项目现有 `AiCrudPage` 及相邻模块的 `apiConfig`/adapter 形状，真实 import 并绑定本次业务 API；不得手写平行表格、复制通用请求层或在测试夹具中冒充生产页面。
- API adapter 保持 Forge 的 POST-safe 约定。分页、详情和行级 mutation 都使用相邻 owner 的真实 endpoint；包含行主键的 endpoint 必须保留 `/:id` 占位语义，并在替换或提交前使用 `String(id)`，禁止 `Number(id)`、一元 `+id` 或其他数值化。
- 分页请求字段固定为 `pageNum`、`pageSize`；页面消费响应的 `rows` 与 `total`，不得静默改成 `page/limit`、`records/count`，也不得把全量结果在浏览器内二次分页。
- Snowflake/Java `Long` 主键在 TypeScript、路由、选择行、编辑回填、删除与批量动作中都保持 string。测试必须使用大于 `Number.MAX_SAFE_INTEGER` 的 ID 验证往返值不变。
- 页面按钮/动作使用真实权限 token，并与 API owner 的权限语义一致；无权限时既不渲染或不可操作，也不能发出请求。前端门禁只改善交互，不能被描述为服务端授权替代品。
- 明确处理并测试 loading、empty、error、disabled/busy、permission-denied 状态；失败请求必须结束 loading，重复提交在 pending 期间禁用，空态与错误态不能互相冒充。

## 实施与验证

1. 先补能失败的最窄 Vitest/项目现有前端测试，覆盖 POST endpoint 与 `:id`、`pageNum/pageSize`、`rows/total`、超安全整数 ID、权限拒绝和上述交互状态，再实施生产源码增量。
2. 保持现有请求封装、错误处理、设计 token、响应式布局和可访问名称；不以硬编码颜色、静默 catch、全局副作用或页面私有 request 实例绕过相邻 owner。
3. 对最终源码分别运行项目真实的前端测试、TypeScript typecheck、lint 和 production build，且只接受受控 `frontend-admin-test`、`frontend-admin-typecheck`、`frontend-admin-lint`、`frontend-admin-build` 回执。若底座或候选没有可执行的 typecheck 脚本，必须 fail-close 并报告能力缺口；不得通过普通 shell、伪造 profile 或把 lint/build 冒充 typecheck。
4. 运行 `forge-governance audit`，并由实现者之外的独立语义 reviewer 复核页面/API/权限/状态合同。静态规则、补丁形状、命令名称或模型自述都不能替代真实命令回执和独立复核。

## 完成边界

- 必须对真实工作区形成受控源码和测试 mutation；只修改完成该前端增量所需的 `forge-admin-ui` 页面、API adapter、类型与测试，不修改 Harness、治理策略、安装的 Skills、发布配置或凭据。
- 不提交、不推送、不部署，不连接 SSH、部署服务器、生产数据库或业务外部系统。构建工具只可按仓库现有 lockfile 和脚本解析已声明依赖。
- 若实际相邻 owner 的命名不同，沿用真实 owner 并在最终说明映射；不得删减 POST-safe、分页、Long ID、权限、状态、验证或独立复核边界。

## 验收闭环

最终答复必须列出 changed paths、复用的 `AiCrudPage` 与相邻 API owner、POST endpoint/`:id`/分页/响应合同、Long ID 与权限状态测试、前端测试/typecheck/lint/production build 的真实命令和退出码、`forge-governance` 结果、独立语义 review 状态，以及仍未由证据证明的浏览器、服务端权限或运行时风险。任何命令或独立复核未执行时明确标为未验证，不得宣称完成。
