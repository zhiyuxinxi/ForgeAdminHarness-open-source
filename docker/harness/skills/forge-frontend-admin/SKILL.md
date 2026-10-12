---
name: forge-frontend-admin
description: Implement or review Forge Admin Vue pages, create/edit forms, details, dialogs, drawers, and popovers using canonical components, code patterns, default interactions, API adapters, dictionaries, permissions, and design tokens. Use for forge-admin-ui pages or shared admin components; do not use for generic visual design or unrelated H5/report clients.
---

# Forge Admin 管理端前端

Policy marker: `FORGE_FRONTEND_ADMIN_V1`.

当前普通开发以用户目标推进：以下参考中的强制 Skill/TDD 顺序、固定阶段比例、反复独审和强制收尾已暂停；未被用户或项目确认为要求的设计偏好只作建议。项目既有 `DESIGN.md`、共享组件约束，以及用户要求的同类页面一致性、设计器维护能力仍是交付要求，不能据此自行另写一套页面。允许先保存修复草稿，再做受影响验证。真实权限、租户、数据完整性、秘密和危险操作授权继续保留；合入与发布须取得实际构建、必要启动、功能测试及源码绑定证据。不要把这段解释成已通过任何验证。

## 权威与选型

1. 先读取项目 `AGENTS.md`、`forge-admin-ui/DESIGN.md`（存在时）、目标模块现有页面和相关项目 `.agents/skills`。以当前项目实际源码为准，不把历史版本、H5、报表端或外部模板的约定混入 `forge-admin-ui`。
2. 新增或调整管理页面、弹窗、抽屉或浮层时，读取 [页面模式与默认交互](references/page-patterns.md)，按真实任务选择列表、主从、新增编辑、详情及其容器模式。普通台账使用 `AiCrudPage`；它也拥有modal/drawer/flat/tabWorkspace及独立新增formOnly，不因打开形式不同重写表单与提交逻辑。主对象决定右侧内容时使用 `MasterDetailWorkspace`；非CRUD任务弹窗与轻量浮层按该参考复用现成入口。核对已有Layout，避免重复外壳；复杂交互只扩展必要业务区域。
3. Naive UI 是管理端主组件体系。Element Plus 仅限项目已有的设计器/适配器边界，禁止在普通业务页混搭形成第二套交互语义。
4. 字典使用 `useDict`、`DictSelect`、`DictTag`；鉴权图片使用 `AuthImage`；API 调用留在 `src/api` 和既有 HTTP 层。不要在页面复制 option、鉴权 URL、分页解析或错误处理。

用户指定HTML原型和MD作为实现目标时，在现有技术栈中落实其页面/菜单结构、布局、交互状态与业务规则；通用容器或CRUD偏好不能把专用页面变成仅换肤的占位页。按实际影响修改必要页面、接口和接线，不因样式检查通过就声称整个模块已完成。原型技术栈、组件名或CSS变量名不必逐字复制，应核对实际效果和行为；复用既有布局也必须保留用户要求的区别。

同类页面由同一套组件和配置决定外框、查询区、表格密度、操作区及表单容器；AI 负责字段语义、业务动作、权限和数据接线。不能用“都用了 Naive UI”代替一致性，也不能仅挂上 `AiCrudPage` 就宣称设计器可以接管。要求低代码维护时，按上述参考接入当前项目真实模型/配置及发布运行协议，说明配置与代码扩展各自的维护边界。

普通列表默认继承原版用户管理的多选、全选、批量删除、常规CRUD、查询重置、分页刷新与列设置，不要求产品逐项描述。读取 `page-patterns.md` 的“普通列表的默认交付”，保留 `hideSelection=false`、`hideBatchDelete=false` 及公共工具栏；核实真实删除接口与权限后接线，不以“只有单删接口”或“示例简化”为由关闭批删。业务例外必须来自真实限制并明确说明。前端生成标准与默认交互是主线，不能把此要求替换为设计器接管建设。

这套标准同样约束新增编辑、详情、弹窗、抽屉和浮层，不能只规范列表。按参考中的“标准代码组织”和“表单、详情与覆盖层的默认交付”，复用字段schema、布局、校验、回填、提交防重、失败保留、取消和滚动/操作区。代码风格、外观与真实行为须同时成立；不能任由每次生成重新选择宽度、列数、footer或另写提交控制器。

按钮的主次样式、相对位置和顺序、搜索控件、反馈、导航上下文与数据表达也属于默认规范，不等用户逐项提醒。按参考中的“默认操作位置与完整体验”复用当前公共实现；产品负责业务含义、流程、权限和真实特殊交互，不能把常规UI细节当成缺失需求，也不能依据UI默认去虚构业务规则。

## 数据与交互合同

- Snowflake `Long`、用户/租户/资源/流程/记录 ID 在 JavaScript、路由、选择器和 API payload 中始终按 string 传递；禁止 `Number`、`parseInt`、一元 `+` 和数值排序破坏精度。
- CRUD API 遵循项目 POST-safe 合同：配置 method、`:id` 占位符、`pageNum/pageSize` 和响应 rows/total 解析必须与 `AiCrudPage` 的真实接口一致。
- 表单字段校验沿用 `AiForm/AiCrudPage` 当前字段 schema 的顶层 `rules`；先读真实 owner，再写 schema，不能把规则误放进不会被消费的 `props.rules`。API adapter 只有被页面或 canonical owner 实际导入/调用才算交付，禁止保留未接线的重复模块。
- 创建、编辑、详情分别验证初值、异步回填、reset、重复打开、保存 busy、防双击、取消、失败后可恢复。列表必须覆盖 loading、empty、error、权限不足和分页边界。
- 前端权限只改善可见性，不能承担授权。权限集合缺失时，新代码必须默认隐藏/禁用受保护动作并等待明确加载态；后端直接调用负例仍是硬要求。
- 主题变量目前分散在 `theme.config.js`、`design-tokens.css` 与 `uno.config.js`。改动先选择一个 canonical owner 并做 changed-file ratchet；普通页面不得新增 raw hex/rgb、重复 token 或局部主题表。
- 所有交互元素有键盘路径、可见 focus、可理解 label；尊重 reduced motion。至少验证常用宽屏和窄屏，不以桌面截图替代可操作性。
- 国际化能力以当前项目源码和合同为准，不能从历史版本推断“只有中文”或“已经支持双语”。若项目存在 `code-copilot/rules/internationalization.md`，先按该合同核对真实语言入口、业务词条加载位置、显示元数据及请求语言；业务词条写在项目既有阶段写域内。没有这份合同、也没有国际化需求的项目继续原流程，不自动增加双语改造或检查。

## 硬门禁与语义边界

静态硬门禁由固定镜像规则执行：普通 CRUD 未复用 canonical owner、字典/API/HTTP 合同漂移、Long ID 数值化、未鉴权文件、生产调试 CDN/`latest`、弱随机、平行业务 UI 库和受控 raw color 等命中即失败。不得用源码 ignore 注释、测试跳过或模型自评放行。

权限加载是否失败关闭、组件 owner、复杂页面例外、设计 token 的特殊品牌/图表颜色、可访问性和浏览器状态属于语义/runtime 判断，必须通过独立复核和真实负例。需要放宽确定性 rule 的例外只能来自版本化项目 policy，至少绑定 rule、仓库/路径、内容 hash、批准人和到期时间；模型不能批准自己提出的例外。

```text
forge-governance audit --root /workspace --base <approved-base-commit> --format json
```

随后只运行 Task Execution Contract 列出的管理端 verification profiles。模型可执行入口固定如下；不得直接进入前端目录运行包管理器、lint、test、typecheck 或 build shell：

```text
forge-verify run --profile frontend-admin-lint --admission-id <current-admission-id> --idempotency-key <current-task-idempotency-key>
forge-verify run --profile frontend-admin-test --admission-id <current-admission-id> --idempotency-key <current-task-idempotency-key>
```

`frontend-admin-lint` 默认由 Runner 依据受保护的任务基线，检查本次新增或修改的 `forge-admin-ui/src` 源文件，包括本任务已提交的改动。首次加载项目不执行全项目 lint；没有适用改动文件时仅确认空范围，不运行 ESLint 或安装依赖。文件较多时由 Runner 分批检查，不回退到全项目扫描。默认使用上面的无 `--file` 命令；当前合同明确列出文件时，也可用显式 `--file` 覆盖合同内全部适用源文件完成该任务的 lint 验收。目录范围或只选部分合同文件的结果仍是诊断，不能冒充完整范围。`--max-warnings=0` 由 profile 固定，模型不得降低；结果只证明本次改动文件的检查范围，不能称为全仓 lint 通过。

`frontend-admin-test` 默认根据受保护任务基线运行受影响测试，含当前已提交和未提交的改动；不是全项目测试。没有关联用例时如实保留0项，不因缺少全量回执而阻塞；实际命令或用例失败则修复当前问题再续接。当前合同明确列出文件时，显式 `--test-file` 覆盖合同内全部测试文件也可完成该任务的测试验收；目录范围或遗漏合同测试文件仍只作为诊断。前一任务已通过且未变化的测试不因当前任务重新执行。普通修改和提交不自动追加全应用 typecheck、build 或后端全量回归；发布所需制品由已有受控发布流程构建，不为同一制品重复运行一次全局检查。

`RUNNER_INTERNAL_REFERENCE_ONLY_V1`：依赖、命令、cwd、cache 与超时由受控 Runner 固定。这些内部实现不是模型命令，模型不能退回直接包管理器 shell。可信运行时签发并注入当前 execution admission；模型不得自行调用 `admit`，也不自行追加合同未要求的全局 profile。局部验证只报告其实际范围，未执行的 typecheck/build 不写成通过；环境不可用时沿现有修复续接路径处理。

浏览器验证必须记录真实路由、角色、视口、主路径和权限/网络失败负例。静态审计、lint、typecheck、Vitest、build 与浏览器行为是不同证据，任何一项都不能代替其他项。完整矩阵见 [管理端前端合同](references/frontend-contract.md)。

## 输出

报告页面类型、共享 owner、API/ID/字典/权限合同、实际验证的状态与响应式范围、修改文件和真实回执。要求设计器维护时，另说明可配置部分、代码扩展及保存发布后运行页的证据；要求视觉一致性时，对照用户指定的原版页面和同类型样本。未运行环境、未作视觉比较或未完成设计器往返时分别写“未验证”，不得以静态审计、构建或模型自评代替。
