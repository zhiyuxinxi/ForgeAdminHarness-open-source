---
name: forge-release-acceptance
description: Verify a released Forge Admin version through real login, menus, browser interactions, APIs, permissions, and representative business data. Use after a release or when the user asks to verify deployed pages and CRUD; HTTP 200 smoke alone is never sufficient.
---

# Forge Admin 发布后业务验收

Policy markers: `FORGE_RELEASE_ACCEPTANCE_V1`, `PRODUCT_UAT_BOUNDARY_V1`.

本 Skill 验证“用户能完成业务”，不是重复 Runner 存活探测。它不授权再次发布、改代码、改基础设施或清理非本轮数据。

## 产品 UAT 与技术门禁分工

- 产品/业务人员确认业务目标、流程、文案、可见数据含义、角色体验和验收结果；不要求其审查类、SQL、表结构、构建日志或服务器命令。
- AI/研发与测试负责代码、接口、迁移、事务、幂等、并发、权限负例和自动化证据；平台 Runner 负责候选来源、测试库迁移、定向发布和回退证据。
- “产品认为功能可用”不能替代技术门禁；技术测试通过也不能替代业务 UAT。任一必需层缺失时只能给条件结论。
- 面向产品的验收清单使用业务步骤和可观察结果；技术证据单独列出来源、状态和责任人，不让产品人员根据陌生术语猜测通过。

## 验收前确认

1. 加载 `forge-task-contract`，确认目标环境、批准版本、验收范围和是否允许创建可回收测试数据。
2. 读取 `forge-release contract` 与最近一次发布结果，核对项目 slug、Git 提交、版本、镜像 ID、服务、迁移和冒烟；历史聊天或页面标题不能替代当前运行证据。
3. 加载 `forge-requirement-coverage`，从已批准要求生成菜单/业务链路清单。若没有需求清单，明确本轮只能做代表性验收，不能声称全量覆盖。

## 浏览器与 API 验收

- 使用真实浏览器从登记的 Forge 入口登录；记录测试角色和权限范围，禁止在报告中输出密码或令牌。
- 对范围内每个菜单确认路由、标题、列表加载、空态/错误态、按钮权限和浏览器控制台；根页面或健康接口 200 不计为菜单通过。
- 对适用业务执行新增、查询、详情、编辑、删除/终止、状态动作、导入、模板、导出和跨页面生成。记录业务测试数据前缀、记录 ID、关键请求/响应和可观察副作用。
- 测试数据只能使用本轮唯一前缀并通过业务 UI/API 创建；只清理由本轮创建且合同允许删除的数据。审计型或不可删除记录保留并在报告中列明，不使用清库、直接 SQL 或删除他人数据“恢复现场”。
- 权限至少包含一个允许角色和一个禁止动作/资源负例；服务端必须拒绝，不能只依赖前端隐藏按钮。
- 字典、日期、金额、JSON、状态和 Excel 场景按对应合同检查显示、回填、非法输入和往返，不接受常量、零值或占位结果。

## 结论等级

每项只能标为 `passed`、`failed`、`blocked`、`not_applicable` 或 `not_tested`。浏览器不可用、账号权限不足、需求不完整或证据缺失时降低结论并报告阻塞；不得把静态代码检查、单元测试或 API 200 冒充浏览器验收。

最终报告先给产品一页摘要：业务范围、通过/失败/未测、需要其确认的业务项和阻断；再附目标 URL、版本/提交/镜像、角色、逐菜单结果、CRUD/状态/导入导出/权限结果、测试数据及清理状态、失败证据和未覆盖项。若发现代码缺陷，用户未授权修复时停在缺陷报告；授权修复后仍需重新发布并重跑受影响验收。
