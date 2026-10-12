# 官方 Skills 调用与证据规则

模板编号：`FA-GOV-01`  
面向角色：产品经理、实施、负责执行的 AI  
适用阶段：任何 Forge Admin 代码或流程任务开始前

> AI/技术执行规则：普通产品人员不需要记住或手工选择全部 Skill。协调 AI 应根据任务自动加载并回报实际依据；使用者只需在 AI 跳过规则时指出“请先做项目与 Skill 预检”。

## 为什么必须先调用 Skill

Forge Admin 的官方 Skill 已经固化了项目特有契约。例如 CRUD 不是泛化的 REST 示例，而是 POST-safe 路由；流程也区分低代码和代码优先模式。跳过 Skill，AI 很容易写出“看起来标准、实际不兼容”的代码。

这里存在两层能力，不能混用：

- 项目源码内 `.agents/skills/`：与当前 Forge Admin 固定提交一起演进，负责 CRUD、流程等源码细节；
- Harness 版本化能力包：由平台镜像提供，负责项目/阶段/授权、需求追踪、字典跨层合同、UI 一致性、Git 恢复、受控发布和发布后验收。

当前 Harness 能力包的用户用法见 [Harness 版本化 Skills 使用清单](Harness版本化Skills使用清单.md)。`pilot` 表示可以在真实任务中使用并收集证据，不表示对应的机器门禁已经实现。

## 可直接复制给 AI

```text
你正在 Forge Admin 项目中工作。先执行规则和证据预检，不要立即写代码：

1. 读取当前项目根目录 AGENTS.md；确认当前提交/分支和工作区状态。
2. 多阶段任务、阶段切换或“检查/修复/继续/测试/发版”等短句先加载
   forge-task-contract；完整性审查加载 forge-requirement-coverage。
3. 如果任务涉及 CRUD、库表、后端接口、AiCrudPage、菜单资源或 Excel：完整读取
   .agents/skills/forge-codegen-crud/SKILL.md
   并按 Skill 路由读取本次模式所需 references。
4. 如果任务涉及审批、Flowable、流程表单、BPMN、业务绑定或回调：完整读取
   .agents/skills/forge-business-flow-development/SKILL.md
   并读取对应模式和验证清单。
5. 枚举/字典/状态加载 forge-dictionary-contract；CRUD 页面、表单、弹窗或抽屉加载
   forge-ui-consistency-review。检查至少一个当前提交中的相似模块、相关 migration 和测试。
6. 输出“证据预检”：固定提交、加载的 Skill/引用、相似模块、准备复用的底座能力、仍未确认的事实。
7. 发版加载 forge-controlled-release；用户要求发布后逐菜单/CRUD 验证时再加载
   forge-release-acceptance。若 Skill 不存在、版本不匹配或需求与 Skill/源码冲突，停止并输出合同差异表。

任何外部模板和历史对话只可作为结构参考。当前项目 AGENTS、明确需求、官方 Skill 和固定源码优先。
```

## AI 继续实施前必须回报

- 当前仓库、分支、提交和工作区是否唯一；
- 任务属于单表、主子表、左树右表、低代码流程还是代码优先流程；
- 会复用哪些实体基类、组件、字典、权限、Excel 或流程能力；
- 哪些内容来自源码/Skill，哪些只是建议；
- 本轮允许修改什么，明确不修改什么；
- 最低验证命令和人工验收路径。

## 停止条件

Skill 内容与源码不一致、目标项目不是预期版本、已有迁移版本冲突、相似模块契约互相矛盾时，不得继续批量生成。先让技术负责人决定采用哪个权威来源。
