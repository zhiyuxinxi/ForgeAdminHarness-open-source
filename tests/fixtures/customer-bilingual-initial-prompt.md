用户当前明确要求：示例客户项目整体支持中英双语；新的 Harness 及全部直接工具必须与新的双语低代码底座匹配。我已授权你在本任务范围内完成客户业务的必要修改、定向测试、审查、提交、合入本项目 main、推送及正常受控发布。请自主持续执行，不要停在计划或等待再次说继续。一次完成一组直接相关模块并验证，保留有效结果，再推进剩余组。

当前旧 Harness 退役已由平台操作者负责，新环境基础与公共迁移已交付。你不要操作别的项目或宿主服务。下面是已有缺口调查，只用于定位，并非完成实现：请由你读取真实业务源码，完成全部实际显示缺口。若总范围大，按业务模块分组连续推进，保留 TODO 状态，不得做完一个小组就将整体完成。拒绝信息应据当前正常工具路径自行纠正；真实平台阻塞请明确回报原错误与最小恢复条件，不能伪造工具成功。
# 示例客户客户业务中英双语：新 Harness 正常实施需求输入

本文件是用户目标与已取证缺口的输入，不是完成的业务实现、测试、迁移或验收回执。执行主体是新实际 Forge Harness；操作者不代写客户实现。尚未发送本输入，未启动新模型请求。

## 1. 本轮目标、身份与正常入口

请继续实际完成示例客户项目的中英双语：在已经接入公共双语底座的客户主线上，补齐客户业务页面、固定提示及固定显示元数据。允许你在下列实际缺口范围内修改客户显示代码、语言资源，编写直接必要的测试和新的前向显示元数据迁移；没有实际缺口的代码不必为了形成改动而修改。不要停在解释计划或仅查看底座语言按钮。

- 唯一客户项目是 `forge-base`（示例客户），不是 `demoteam-phase2`，不是公共 Foundation。
- 开始基线为客户 main `980d0ced4e28593a0828f3b79ee0c6d010540e54`，双亲是客户原 main `3cd1e4183fb9fccc85a8d4a6a4e30566526986fc` 与公共 `5eb6f287844b4ea982584ec0a8a6e2af867d4ebf`。服务器 main 与原 GitLab main 已正常快进/推送并核一致；原引用和数据库备份已保存。
- 先核自己当前 TaskSpace 的项目、分支、HEAD 与真实工具状态；本输入中的开始基线不能覆盖之后合法的新候选。不得复用旧会话的 request/contract/token、直接写验收状态，或假称旧候选测试验证了新改动。
- 读取当前 `AGENTS.md`、`PROJECT_CONTEXT.md`、`code-copilot/rules/internationalization.md`、`code-copilot/rules/automated-testing-standard.md`，以及现有 `code-copilot/changes/sampleco-main-bilingual/` 的 Spec、Tasks、Test Spec、Execution Log；按仓库约定继续正常需求准备、实施、定向验证和复核。既有 Spec 的“仅准备未提交合并、不提交不部署”是已经结束的公共移植阶段记录，不能当成本轮客户业务补齐的永久冻结条件；保留历史事实，以本条最新需求续接，不改写旧记录为通过。
- 仓库 `/propose`、`/apply`、`/test`、`/review` 描述的是正常职责。使用本次实际 Harness 提供的任务准备和受控验证工具落实职责，由你根据真实文件与当前 profile 目录提出准确范围；不要凭空照抄旧机器参数或要求平台给全局写权限。数据库迁移、服务发布由本轮负责人协调正常受控执行，避免与正在进行的运行维护双跑；不得自行获取宿主凭据、直接改生产库或 SSH 修改现网。

## 2. 已完成结果与仍然缺失的内容

公共 PC/H5/Java 双语底座已合并，并已有客户基础产物和运行部署结果。两条公共 Flyway 迁移 `1.0.20261004`、`1.0.20261005` 已由正常 Admin 启动真实执行成功；新增十个显示列，数据库仍为 440 张表，六张受影响表全部原有列的摘要/行数/主键保持，原 211 条迁移历史摘要不变。不要重跑这些已完成的上游检查来替代客户缺口实现。

差异盘点限定公共5eb6到客户980d：177个生产前端文件（PC164、H5 13；排除测试和词库文件）。静态发现1880处直接中文模板文本、1190处固定显示属性、286处直接通知，共3356处/1798个去重原串；981处原串已能命中中央英文资源，2375处未命中中央资源。另有2321处 JS label/title 等显示元数据候选，须先核真实共享渲染器是否已经本地化，不能把候选数全部当成失效页面。

这些数字是定位输入，不是机器验收门槛，也不是全仓或全页面检查结果。动态表达式、业务模块资源和自定义组件的渲染行为需在实际改动处判断。没有全局 DOM 自动翻译；仅增加英文词条不能使原始 Vue 文本或直接通知自行变成英文。固定文本可见例子包括“退出审批”“领导审批工作台，快速处理待办事项”“当前审批人”“请输入审批意见”等；不能把兼容中文回退当作完成英语显示。

## 3. 文件范围分组

下表来自上述177文件原件，附录保留全部相对路径。表中的“直接显示候选”合计模板文本、静态属性和通知；属性在自定义组件上是否已有显示适配仍需直接核对。零候选的差异文件仅是保持相关行为/检查直接消费者的边界，不要求重写。事故、领导力、供方、基础资料、固废/危废流程、安保、工作台及示例客户应用是已发现的客户业务范围；不得把公共目录菜单能切英文当成这些客户模块已完成。

| 相对路径分组 | 差异文件 | 直接显示候选 | 元数据候选 |
|---|---:|---:|---:|
| `forge-admin-ui/src/api` | 3 | 0 | 0 |
| `forge-admin-ui/src/components` | 5 | 0 | 0 |
| `forge-admin-ui/src/composables` | 1 | 0 | 0 |
| `forge-admin-ui/src/layouts` | 2 | 0 | 0 |
| `forge-admin-ui/src/main.js` | 1 | 0 | 0 |
| `forge-admin-ui/src/router` | 1 | 0 | 0 |
| `forge-admin-ui/src/utils` | 6 | 0 | 0 |
| `forge-admin-ui/src/views/accident` | 20 | 823 | 171 |
| `forge-admin-ui/src/views/base-info` | 6 | 159 | 47 |
| `forge-admin-ui/src/views/contract` | 2 | 0 | 48 |
| `forge-admin-ui/src/views/delivery` | 2 | 0 | 43 |
| `forge-admin-ui/src/views/equipment` | 2 | 0 | 51 |
| `forge-admin-ui/src/views/external` | 1 | 0 | 179 |
| `forge-admin-ui/src/views/flow` | 3 | 0 | 0 |
| `forge-admin-ui/src/views/home` | 2 | 0 | 0 |
| `forge-admin-ui/src/views/hw-process` | 3 | 23 | 58 |
| `forge-admin-ui/src/views/leadership` | 32 | 1487 | 644 |
| `forge-admin-ui/src/views/login` | 1 | 0 | 0 |
| `forge-admin-ui/src/views/plan` | 8 | 92 | 71 |
| `forge-admin-ui/src/views/provider` | 13 | 346 | 277 |
| `forge-admin-ui/src/views/security` | 28 | 63 | 413 |
| `forge-admin-ui/src/views/security-guard` | 1 | 4 | 0 |
| `forge-admin-ui/src/views/sw-process` | 9 | 105 | 177 |
| `forge-admin-ui/src/views/system` | 3 | 0 | 53 |
| `forge-admin-ui/src/views/waste-catalog` | 2 | 2 | 74 |
| `forge-admin-ui/src/views/workspace` | 2 | 32 | 13 |
| `forge-admin-ui/src/views/sampleco-app` | 5 | 219 | 2 |
| `forge-h5-ui/src/api` | 1 | 0 | 0 |
| `forge-h5-ui/src/components` | 1 | 0 | 0 |
| `forge-h5-ui/src/pages/app-entry.vue` | 1 | 0 | 0 |
| `forge-h5-ui/src/pages/index` | 1 | 0 | 0 |
| `forge-h5-ui/src/pages/login` | 1 | 0 | 0 |
| `forge-h5-ui/src/pages/lowcode-runtime.vue` | 1 | 0 | 0 |
| `forge-h5-ui/src/pages/mine` | 1 | 0 | 0 |
| `forge-h5-ui/src/pages/todo.vue` | 1 | 1 | 0 |
| `forge-h5-ui/src/utils` | 5 | 0 | 0 |

## 4. 显示翻译和业务数据边界

- 支持 `zh-CN` 与 `en-US`，默认中文。语言选择可持久保存；切换语言不重载编辑器、不清空表单、附件、查询条件、选中记录或待提交草稿。
- 翻译产品固定可见文本：页面/分组/列表/表单标题、字段标签、占位说明、操作按钮、确认弹窗、空态、校验/成功/失败通知、固定错误及导入导出显示标题。动态数量/日期/名称通过参数插值，保留参数原值，不能把已经拼入用户名称的整句送去词表匹配。
- 不翻译也不重命名：数据库列机器名、API/路由、权限串、状态码、枚举 value、租户/流程/资源 ID、字典 type/value、提交载荷键、业务计算和比较条件。原始业务记录、历史自由文本、人员/企业名称、附件、审批意见和用户自定义文案保持原样。
- 不新增业务功能，不调整权限、租户过滤、审批流转、数据校验语义或收费/台账计算。显示层中英投影不得写回表单值或持久化 schema。
- 原有客户安全/兼容修复必须保留，包括主页权限过滤、只读操作限制、流程抄送表单上下文、登录提交防重、H5原生表单、路由载荷校验及鉴权/网络/空态区别。只验证本轮直接影响，不重做旧全量回归。

## 5. 必须复用的实际国际化惯例

PC 的真实入口是 `forge-admin-ui/src/locales/index.js`：已有 `localizeLabel`、`formatUiText`、`t` 和响应式 locale。固定显示调用应真正消费当前 locale；不要在模块加载时一次翻译后永远冻结。中央兼容词库适合公共已有显示 metadata；客户固定词可复用现存 `sampleco-labels.js` 或模块资源，不要复制整套框架/新增通用翻译机制。

PC 业务资源已经由 `../views/**/locales/zh-CN.js` 与 `en-US.js` 自动收集，统一挂在 `business.*` 下；`business-messages.js` 拒绝重复/冲突的 namespace。业务消息通过对应 `t('business.…')` 消费；只有显式 `business.display` 子空间参与旧中文 metadata 的兼容显示映射。不要假定任意模块词条放入文件就自动翻译任意字符串，也不要让模块覆盖核心消息。按现有命名空间使用中文/英文成对资源，不在输入中预写完成的词库让模型复制。

H5 的真实入口是 `forge-h5-ui/src/locales/index.js` 与 `display.js`：固定文案用现有 `L`（模板已有 `$L`），动态标签用 `localizeLabel` 及可选语言 metadata。保持本地语言偏好、原生导航标题和表单原值。此次H5差异大多已接基础语言链；优先复用，不重写零缺口的登录/路由/请求工具。

请求、下载/上传或其它本轮实际涉及的通道继续携带 `Accept-Language`；不修改业务API协议来翻译显示字符串。新增或修改 metadata 时保留现有 `labelI18n`、`placeholderI18n`、字典英文等显示字段；先核直接共享消费者是否已正确显示，避免重复翻译或重建 schema。

## 6. 数据库固定显示元数据的客户缺口

公共迁移之后的实际只读聚合：`sys_dict_data` 未删除1342条，其中449条英文非空、893条空；`sys_resource` 未删除1350条，其中328条英文非空、1022条空。该结果只说明剩余英文空缺，未把每一条空值分类为必须翻译的系统固定文案；未输出业务正文，也没有声称全部空值都不匹配某条公共规则。

由你结合客户已经提交的业务模块/固定种子，识别确属产品固定菜单、操作、字典和导出配置的显示标签。必要时新增客户前向迁移：绑定稳定身份与预期原中文，仅补空英文，保留已有自定义英文、中文、编码、权限、租户和时间戳。用户自行创建/编辑的业务内容不批量机翻。已经执行的历史迁移及本次两条公共迁移不得改写，不能手改 `forge_schema_history`、repair 或关闭校验掩盖差异。

实际十个显示列已存在，不能重复创建一套相同机制：资源 `resource_name_en`，字典 `dict_label_en`，Excel列 `column_name_en`，模型 `table_comment_en`/`function_name_en`，模型列 `column_comment_en`/`dict_labels_i18n`，Excel导出 `export_name_en`/`sheet_name_en`/`file_name_template_en`。固定 metadata 必须通过真实API/渲染器消费，不能只写SQL后声称界面英文已生效。

## 7. 最小定向验收与交付结果

按模块或共同渲染模式分批实现、分批验证；复用原测试和未变的底座/构建/迁移证据。修改前按自动化测试标准读取当前相关记录，修改后补真实缺口的定向测试，不写只镜像实现或纯自证的用例。

1. 新增/修改语言资源中英键、占位符及直接消费一致。覆盖实际页面固定标题/表单/列表/提示/通知；用户参数、enum value、权限/ID和提交载荷保持，缺词中文回退单列为未完成。
2. 对本批改变的独立交互/渲染模式验证中文→英文→中文，草稿与选择保持；测试真正可见文案而不只断言资源对象有键。自定义组件、计算生成列和一次性初始化文案需验证切换后的响应性。只做必要代表性真实浏览器操作，不扩成无关全页面UAT；静态数量不是浏览器结果。
3. 用当前 Harness 支持的受控 profile 执行本轮直接相关的精准测试、受影响文件 lint、必要 PC 类型/构建及有实际修改的 H5 构建。准确声明所需验证义务，不能把默认 lint/test 当作已经执行 typecheck/build。已有依赖/缓存复用，不重新下载全树；失败保留并定位当前点，不重跑全部平台88项或旧业务整链。
4. 若新增客户显示迁移，先定向核防重复、占位符和仅显示字段增量，再通过受控隔离数据库的正常 Flyway 验新增迁移及保留现有自定义英文/中文/业务身份/旧历史。生产更新由负责人协调，实际正常执行后再读回必要差异；不得直接连接生产库写SQL或操作旧备份。没有新的SQL改动时不重复执行已通过的公共迁移验证。
5. 若本轮真实页面/导出请求直接发现客户Java固定提示未双语，只沿该真实消费者确认范围并向本轮负责人反馈/准备直接必要修复，不扫全后端或将未知项报为通过。这个177文件输入不是Java/所有数据库显示路径的完整覆盖清单。
6. 返回按模块的真实改动、直接验证回执、实际源码提交/指纹、未完成项目及原因。区分源码完成、专项测试、候选构建、部署和真实用户路径验收；不能把公共底座通过或当前运行升级替代客户所有业务已双语。遇同一子问题两轮无进展按既定止损收缩到根因，不换会话/提示清零。

## 8. 原始证据引用（操作者侧，按需提供给 Harness）

以下均为平台 ignored `output/validation/sampleco-bilingual-20261004/` 下实际原件，不保证新TaskSpace已挂载这些路径；操作者可提供本需求摘要或显式只读附件。不得猜客户仓库中有这些文件、请求宿主密钥或为了取证扩大权限。SHA用于保持来源，不能代替实际消费结果。

| 原件相对路径 | SHA-256 | 事实/边界 |
|---|---|---|
| `customer-ui-bilingual-gap-inventory-01.json` | `fb0b672a936d03ab44183f7c167ac49129b374442f65a5fb1d9509a29ee12332` | 177前端差异文件及固定显示候选；静态盘点，不是浏览器验收 |
| `database-label-coverage-02.json` | `0eef0b810dc7b8aae94b847c4fa24a4130db54fcc00d37374308c3a419ed305d` | 公共迁移后真实英文空值聚合；无业务正文 |
| `customer-source-publish-03.json` | `39dad65298c6227573d3e4814b6300b516b786a89edaf962fb283b632ee08e8d` | 客户main980d正常FF/push与远端核验；保留前两预检失败 |
| `database-backup-02.json` | `a7004ced92523a892b3e3a968b925ea8c191dfdd1b43b59faffc7a5b630eaee9` | 实际升级前单库gzip备份已校验；未执行恢复演练 |
| `database-metadata-before-01.json` | `18615a04df2e0b1e0d15bc49ddfa3443b8fa874ec838f0d19b95c5c6f72c177f` | 六表原列/PK/行数摘要和原211条历史前像 |
| `database-metadata-after-02.json` | `89d1daf0c3ec03121e577e11a12da05fcdc2da21c1a869d4c04257e9be72f013` | 两新Flyway成功、10列新增、六表原值及旧history保持；after01落盘错误保留 |
| `customer-runtime-deploy-01.json` | `876b7e0cd46bc1e37bf0be30466ce53356e2048ffb5270bdb270bdd266bf9cb1` | 基础运行服务真实切换；不是客户全部固定UI已双语 |

## 附录：盘点177文件的完整相对路径分组

路径清单仅定位实际范围，不包含逐文件实现或指定改法。词库、必要定向测试和新的显示迁移按实际实现增加；不要把所有列出的辅助文件都机械改写。

### `forge-admin-ui/src/api`

- `forge-admin-ui/src/api/business-app.js`
- `forge-admin-ui/src/api/flow.js`
- `forge-admin-ui/src/api/system/password.js`

### `forge-admin-ui/src/components`

- `forge-admin-ui/src/components/ai-form/AiCrudPage.vue`
- `forge-admin-ui/src/components/ai-form/AiCrudPageProps.js`
- `forge-admin-ui/src/components/ai-form/business-action-runtime.js`
- `forge-admin-ui/src/components/image-upload/image-upload-value.js`
- `forge-admin-ui/src/components/image-upload/index.vue`

### `forge-admin-ui/src/composables`

- `forge-admin-ui/src/composables/useDict.js`

### `forge-admin-ui/src/layouts`

- `forge-admin-ui/src/layouts/components/MessageNotification.vue`
- `forge-admin-ui/src/layouts/components/UserAvatar.vue`

### `forge-admin-ui/src/main.js`

- `forge-admin-ui/src/main.js`

### `forge-admin-ui/src/router`

- `forge-admin-ui/src/router/guards/permission-guard.js`

### `forge-admin-ui/src/utils`

- `forge-admin-ui/src/utils/attachment-extensions.js`
- `forge-admin-ui/src/utils/attachment-size.js`
- `forge-admin-ui/src/utils/boolean-label.js`
- `forge-admin-ui/src/utils/h5-barcode-scanner.js`
- `forge-admin-ui/src/utils/investigation-mode.js`
- `forge-admin-ui/src/utils/query-params.js`

### `forge-admin-ui/src/views/accident`

- `forge-admin-ui/src/views/accident/ApprovalFlowModal.vue`
- `forge-admin-ui/src/views/accident/accident-batch-a-contract.js`
- `forge-admin-ui/src/views/accident/accident-contract.js`
- `forge-admin-ui/src/views/accident/accident-investigate-stages.js`
- `forge-admin-ui/src/views/accident/accident-rca-marks.js`
- `forge-admin-ui/src/views/accident/app.vue`
- `forge-admin-ui/src/views/accident/assess.vue`
- `forge-admin-ui/src/views/accident/bulletin.vue`
- `forge-admin-ui/src/views/accident/classify.vue`
- `forge-admin-ui/src/views/accident/copyto.vue`
- `forge-admin-ui/src/views/accident/index.vue`
- `forge-admin-ui/src/views/accident/investigate.vue`
- `forge-admin-ui/src/views/accident/investigators.vue`
- `forge-admin-ui/src/views/accident/ledger.vue`
- `forge-admin-ui/src/views/accident/overview.vue`
- `forge-admin-ui/src/views/accident/point.vue`
- `forge-admin-ui/src/views/accident/rca.vue`
- `forge-admin-ui/src/views/accident/report-form/[type].vue`
- `forge-admin-ui/src/views/accident/report.vue`
- `forge-admin-ui/src/views/accident/stats.vue`

### `forge-admin-ui/src/views/base-info`

- `forge-admin-ui/src/views/base-info/device.vue`
- `forge-admin-ui/src/views/base-info/enterprise.vue`
- `forge-admin-ui/src/views/base-info/hw.vue`
- `forge-admin-ui/src/views/base-info/material.vue`
- `forge-admin-ui/src/views/base-info/product.vue`
- `forge-admin-ui/src/views/base-info/sw.vue`

### `forge-admin-ui/src/views/contract`

- `forge-admin-ui/src/views/contract/payment-ledger-contract.js`
- `forge-admin-ui/src/views/contract/payment-ledger.vue`

### `forge-admin-ui/src/views/delivery`

- `forge-admin-ui/src/views/delivery/project-ledger-contract.js`
- `forge-admin-ui/src/views/delivery/project-ledger.vue`

### `forge-admin-ui/src/views/equipment`

- `forge-admin-ui/src/views/equipment/repair-ledger-contract.js`
- `forge-admin-ui/src/views/equipment/repair-ledger.vue`

### `forge-admin-ui/src/views/external`

- `forge-admin-ui/src/views/external/manage.vue`

### `forge-admin-ui/src/views/flow`

- `forge-admin-ui/src/views/flow/cc.vue`
- `forge-admin-ui/src/views/flow/todo.vue`
- `forge-admin-ui/src/views/flow/utils/taskFormPresentation.js`

### `forge-admin-ui/src/views/home`

- `forge-admin-ui/src/views/home/home-access.js`
- `forge-admin-ui/src/views/home/index.vue`

### `forge-admin-ui/src/views/hw-process`

- `forge-admin-ui/src/views/hw-process/report.vue`
- `forge-admin-ui/src/views/hw-process/trace.vue`
- `forge-admin-ui/src/views/hw-process/transfer-inspect.vue`

### `forge-admin-ui/src/views/leadership`

- `forge-admin-ui/src/views/leadership/action-plan.vue`
- `forge-admin-ui/src/views/leadership/archive.vue`
- `forge-admin-ui/src/views/leadership/assess-approval.vue`
- `forge-admin-ui/src/views/leadership/assess-plan.vue`
- `forge-admin-ui/src/views/leadership/assess-result.vue`
- `forge-admin-ui/src/views/leadership/check-item.vue`
- `forge-admin-ui/src/views/leadership/commit-template.vue`
- `forge-admin-ui/src/views/leadership/commitment-all.vue`
- `forge-admin-ui/src/views/leadership/commitment-president.vue`
- `forge-admin-ui/src/views/leadership/components/CheckItemConfigEditor.vue`
- `forge-admin-ui/src/views/leadership/components/ConfigAssetPage.vue`
- `forge-admin-ui/src/views/leadership/components/EngineRulesEditor.vue`
- `forge-admin-ui/src/views/leadership/components/LeadershipPage.vue`
- `forge-admin-ui/src/views/leadership/components/OrgChart.vue`
- `forge-admin-ui/src/views/leadership/components/OrgNodeEditModal.vue`
- `forge-admin-ui/src/views/leadership/components/TemplateDesigner.vue`
- `forge-admin-ui/src/views/leadership/device-assess.vue`
- `forge-admin-ui/src/views/leadership/device-summary.vue`
- `forge-admin-ui/src/views/leadership/duty-score.vue`
- `forge-admin-ui/src/views/leadership/fee-accrual.vue`
- `forge-admin-ui/src/views/leadership/fee-budget.vue`
- `forge-admin-ui/src/views/leadership/fee-stat.vue`
- `forge-admin-ui/src/views/leadership/leadership-contract.js`
- `forge-admin-ui/src/views/leadership/org-chart.vue`
- `forge-admin-ui/src/views/leadership/personal-plan.vue`
- `forge-admin-ui/src/views/leadership/resp-book.vue`
- `forge-admin-ui/src/views/leadership/resp-list.vue`
- `forge-admin-ui/src/views/leadership/resp-template.vue`
- `forge-admin-ui/src/views/leadership/sign-status.vue`
- `forge-admin-ui/src/views/leadership/target-task.vue`
- `forge-admin-ui/src/views/leadership/task-engine.vue`
- `forge-admin-ui/src/views/leadership/task-exec.vue`

### `forge-admin-ui/src/views/login`

- `forge-admin-ui/src/views/login/index.vue`

### `forge-admin-ui/src/views/plan`

- `forge-admin-ui/src/views/plan/ApprovalFlowModal.vue`
- `forge-admin-ui/src/views/plan/ApproveModal.vue`
- `forge-admin-ui/src/views/plan/DeptPlanEditor.vue`
- `forge-admin-ui/src/views/plan/config.vue`
- `forge-admin-ui/src/views/plan/hw-dept.vue`
- `forge-admin-ui/src/views/plan/plan-contract.js`
- `forge-admin-ui/src/views/plan/sw-apply.vue`
- `forge-admin-ui/src/views/plan/sw-dept.vue`

### `forge-admin-ui/src/views/provider`

- `forge-admin-ui/src/views/provider/ProviderAggregateEditor.vue`
- `forge-admin-ui/src/views/provider/ProviderDetailModal.vue`
- `forge-admin-ui/src/views/provider/appointment.vue`
- `forge-admin-ui/src/views/provider/disposal-check.vue`
- `forge-admin-ui/src/views/provider/index.vue`
- `forge-admin-ui/src/views/provider/inspection-report.vue`
- `forge-admin-ui/src/views/provider/manage.vue`
- `forge-admin-ui/src/views/provider/provider-contract.js`
- `forge-admin-ui/src/views/provider/provider-date.js`
- `forge-admin-ui/src/views/provider/provider-form-utils.js`
- `forge-admin-ui/src/views/provider/settlement.vue`
- `forge-admin-ui/src/views/provider/weigh-record.vue`
- `forge-admin-ui/src/views/provider/weigh-ticket.vue`

### `forge-admin-ui/src/views/security`

- `forge-admin-ui/src/views/security/chemical-stats-map.vue`
- `forge-admin-ui/src/views/security/chemical-stats.vue`
- `forge-admin-ui/src/views/security/civil-defense-map.vue`
- `forge-admin-ui/src/views/security/civil-defense.vue`
- `forge-admin-ui/src/views/security/components/SecurityArchivePage.vue`
- `forge-admin-ui/src/views/security/components/SecurityChemicalPage.vue`
- `forge-admin-ui/src/views/security/components/SecurityDefensePage.vue`
- `forge-admin-ui/src/views/security/components/SecurityDossierPage.vue`
- `forge-admin-ui/src/views/security/components/SecurityListPage.vue`
- `forge-admin-ui/src/views/security/components/SecurityMapDefensePage.vue`
- `forge-admin-ui/src/views/security/components/SecurityRadioactivePage.vue`
- `forge-admin-ui/src/views/security/contract.js`
- `forge-admin-ui/src/views/security/counter-terror-basic.vue`
- `forge-admin-ui/src/views/security/counter-terror-record.vue`
- `forge-admin-ui/src/views/security/drug-precursor-dossier.vue`
- `forge-admin-ui/src/views/security/drug-precursor.vue`
- `forge-admin-ui/src/views/security/explosive-precursor-dossier.vue`
- `forge-admin-ui/src/views/security/explosive-precursor.vue`
- `forge-admin-ui/src/views/security/physical-defense-map.vue`
- `forge-admin-ui/src/views/security/physical-defense.vue`
- `forge-admin-ui/src/views/security/public-order-check.vue`
- `forge-admin-ui/src/views/security/radioactive-dossier.vue`
- `forge-admin-ui/src/views/security/radioactive.vue`
- `forge-admin-ui/src/views/security/security-map.vue`
- `forge-admin-ui/src/views/security/technical-defense-map.vue`
- `forge-admin-ui/src/views/security/technical-defense.vue`
- `forge-admin-ui/src/views/security/unit-security-dossier.vue`
- `forge-admin-ui/src/views/security/utils/security-chemical-precision.js`

### `forge-admin-ui/src/views/security-guard`

- `forge-admin-ui/src/views/security-guard/overview.vue`

### `forge-admin-ui/src/views/sw-process`

- `forge-admin-ui/src/views/sw-process/disposal-apply.vue`
- `forge-admin-ui/src/views/sw-process/factory.vue`
- `forge-admin-ui/src/views/sw-process/flow-stat.vue`
- `forge-admin-ui/src/views/sw-process/out.vue`
- `forge-admin-ui/src/views/sw-process/record.vue`
- `forge-admin-ui/src/views/sw-process/report.vue`
- `forge-admin-ui/src/views/sw-process/source.vue`
- `forge-admin-ui/src/views/sw-process/store.vue`
- `forge-admin-ui/src/views/sw-process/transfer-inspect.vue`

### `forge-admin-ui/src/views/system`

- `forge-admin-ui/src/views/system/client.vue`
- `forge-admin-ui/src/views/system/profile.vue`
- `forge-admin-ui/src/views/system/user.vue`

### `forge-admin-ui/src/views/waste-catalog`

- `forge-admin-ui/src/views/waste-catalog/hw.vue`
- `forge-admin-ui/src/views/waste-catalog/sw.vue`

### `forge-admin-ui/src/views/workspace`

- `forge-admin-ui/src/views/workspace/components/LeadershipTodoPanel.vue`
- `forge-admin-ui/src/views/workspace/todo.vue`

### `forge-admin-ui/src/views/sampleco-app`

- `forge-admin-ui/src/views/sampleco-app/components/AppPhone.vue`
- `forge-admin-ui/src/views/sampleco-app/components/PhotoLightbox.vue`
- `forge-admin-ui/src/views/sampleco-app/components/PhotoUploader.vue`
- `forge-admin-ui/src/views/sampleco-app/inspection.vue`
- `forge-admin-ui/src/views/sampleco-app/weigh.vue`

### `forge-h5-ui/src/api`

- `forge-h5-ui/src/api/index.js`

### `forge-h5-ui/src/components`

- `forge-h5-ui/src/components/NativeForm.vue`

### `forge-h5-ui/src/pages/app-entry.vue`

- `forge-h5-ui/src/pages/app-entry.vue`

### `forge-h5-ui/src/pages/index`

- `forge-h5-ui/src/pages/index/index.vue`

### `forge-h5-ui/src/pages/login`

- `forge-h5-ui/src/pages/login/index.vue`

### `forge-h5-ui/src/pages/lowcode-runtime.vue`

- `forge-h5-ui/src/pages/lowcode-runtime.vue`

### `forge-h5-ui/src/pages/mine`

- `forge-h5-ui/src/pages/mine/index.vue`

### `forge-h5-ui/src/pages/todo.vue`

- `forge-h5-ui/src/pages/todo.vue`

### `forge-h5-ui/src/utils`

- `forge-h5-ui/src/utils/login-submit-guard.js`
- `forge-h5-ui/src/utils/route-payload.js`
- `forge-h5-ui/src/utils/route.js`
- `forge-h5-ui/src/utils/todo-load-state.js`
- `forge-h5-ui/src/utils/validation.js`



# 示例客户业务双语：后端补充需求输入

本文件补充既有 `harness-customer-bilingual-requirement-input-01.md`，不替代其中已确认的业务范围、受控提交、合 main、推送及发布授权。交付主体仍为新 Harness 中的业务模型；本文仅为只读盘点和需求，不含实现、SQL 或测试代码。

目标项目为 forge-base / 示例客户。盘点绑定公共基线 `5eb6f287844b4ea982584ec0a8a6e2af867d4ebf` 与客户提交 `980d0ced4e28593a0828f3b79ee0c6d010540e54`，不包括后续模型修改。

## 已确认的消费机制与缺口

公共 `RespInfo` 构造器调用 `UiMessages.translate`；业务异常和参数异常通常经 `GlobalExceptionHandler` 转为 `RespInfo`，Bean Validation 消息也经过该翻译函数。因此，不能因业务类没有显式调用 UiMessages 就判为未覆盖。

但 `UiMessages.translate(source)` 只对公共核心词库中的中文原串做精确映射，未知原串原样返回；不会自动把任意业务句子送入业务资源包，也不能自动翻译拼接后的动态消息。公共核心词库实际有 3583 项。`UiMessages.message(key,args)` 支持业务资源命名空间 `business.*`；`UiMessages.label(chinese,english)` 优先使用已有显式英文，另支持 `business.display.*`。应沿现有机制补客户固定显示资源，保留动态业务参数，不另建翻译框架。

只读盘点选取上述两提交之间变更的 595 个生产 Java 文件，其中客户业务核心 579 个；另列出 78 个历史迁移文件。对这些变更文件的完整上下文进行有限消息语法识别，结果为：

- 118 处固定消息已被公共核心原串映射覆盖，可复用该机制，不要求重复改写。
- 889 处固定消息未命中公共核心词库，沿现有 translate 路径会保留中文；包括业务异常、显式响应错误和校验提示。
- 99 处拼接或格式化消息需要结合实际调用点绑定固定模板与动态参数。

以上是静态出现次数，不是独立句子数、接口数或已运行失败数；范围是变更文件上下文，不把其中每一行都称为客户新增。注释、日志、OpenAPI 说明和任意业务数据不计为应翻译失败。间接调用、未列入语法的动态路径与接口可达性未穷举。

代表性直接缺口：`forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/accident/dto/AccidentDTO.java` 中 `@NotBlank` 的“事故名称不能为空”，在当前核心精确原串映射中未覆盖。业务模块生产资源目录中未找到已有 `*messages*.properties`；公共加载器已提供业务资源包消费入口，模型可按客户实际约定使用。

## 客户模块范围

下表路径均相对 `forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/`。精确文件、行号和源码摘要见原始 inventory；无需扩大为未变公共模块审计。

| 客户模块路径 | 变更 Java 文件 | 未命中固定消息 | 动态消息候选 |
| --- | ---: | ---: | ---: |
| accident/ | 61 | 59 | 13 |
| baseinfo/ | 26 | 18 | 4 |
| catalog/ | 14 | 16 | 4 |
| contractpayment/ | 8 | 23 | 8 |
| deliveryledger/ | 8 | 21 | 9 |
| disposalcheck/ | 12 | 10 | 0 |
| envprovider/ | 49 | 75 | 15 |
| eqrepair/ | 8 | 25 | 11 |
| hwprocess/ | 17 | 1 | 2 |
| inspectionreport/ | 20 | 13 | 3 |
| leadership/ | 151 | 227 | 2 |
| plan/ | 46 | 49 | 9 |
| providersettlement/ | 8 | 27 | 3 |
| securityarchive/ | 14 | 50 | 0 |
| securitychemical/ | 17 | 52 | 1 |
| securitydefense/ | 12 | 38 | 2 |
| securitymap/ | 8 | 29 | 1 |
| securityradioactive/ | 8 | 29 | 0 |
| swprocess/ | 58 | 43 | 3 |
| vehicleappointment/ | 10 | 23 | 4 |
| weighrecord/ | 16 | 24 | 3 |
| weighticket/ | 8 | 23 | 2 |

上述客户组之外，还有 16 个已修改公共/插件生产 Java 文件，原件单列其现有消息候选；不据此授权审计全部公共代码。

## 导出与结构化错误的具体边界

正常 Excel 导出已有直接消费：`ExcelExporter` 通过 `UiMessages.label` 消费 sheetNameEn、columnNameEn 和注解 valueEn，数据库列配置优先。因此不能概括为“导出字段全部缺翻译”，也不能只因 Java 中没有英文注解就批量添加。当前这批变更 Java 中未发现 ExcelColumn / ExcelProperty / ExcelExport 注解使用；客户导出应优先核对实际数据库配置和消费结果，保留已填自定义英文。

已读的 `forge-server/forge-framework/forge-starter-parent/forge-starter-excel/src/main/java/com/mdframe/forge/starter/excel/service/impl/ExcelImportServiceImpl.java` 显示：普通模板列部分已本地化，但导入错误报告仍含固定中文表头、中文工作表名，以及固定 errorType / suggestion。精确两提交 diff 仅修改导入许可判断；这些报告显示路径是继承的公共基线内容，不是客户此次差异新增。若客户实际导入错误报告纳入本轮已用功能，应沿现成 UiMessages 做必要补齐并定向验消费；当前未运行报告，不能称其端到端失败，也不扩大为全 Excel 重验。

## 给 Harness 的执行补充要求

1. 在原前端和数据库固定 metadata 需求之外，同时覆盖上述客户变更 Java 的对用户固定错误、校验、提示及实际导出显示路径。先使用已有公共包装与资源，确有未覆盖再改直接调用点；不要为已被精确映射覆盖的 118 处制造修改。
2. 默认中文、英文请求返回相应固定英文。动态模板只翻译固定部分；姓名、记录内容、文件原始值、业务编号、权限字符串、字典编码、状态机器值、金额和日期等参数保持真实值。不得翻译或改写用户数据，也不得修改异常状态码和业务判断来获得英文结果。
3. 复用现有业务资源命名空间、异常处理链和 Excel 元数据。客户菜单/字典等固定 metadata 使用必要的前向迁移并保留自定义英文、原编码/权限/主键/关系；不得重写本次清单中的 78 条历史迁移、旧 history 或重放全量种子。此前两条公共双语迁移及旧数据保持证据继续有效。
4. 按真实修改选择定向验证：至少覆盖实际改动的普通业务错误、Bean Validation、带动态参数消息和实际涉及的导出/导入报告消费者；核对中文/英文、参数及业务身份保持。未改路径复用有效证据，不自动全仓回归、全页面 UAT 或重跑公共双语验证。
5. 记录各批真实完成范围、尚未覆盖路径和阻断；资源齐全不等于运行消费者已经生效。受控提交、main 推送、必要发布沿初始输入的已授权正常路径执行，不手工制造验收回执。

## 原始证据

- Java 与历史迁移清单：`output/validation/sampleco-bilingual-20261004/customer-java-bilingual-gap-inventory-01.json`，SHA256 `f0a0dc7680dd450081d062d5c9fc0247a300a23821b358d1ea3c6664a0afd3e7`。
- 前端原件：`output/validation/sampleco-bilingual-20261004/customer-ui-bilingual-gap-inventory-01.json`，SHA256 `fb0b672a936d03ab44183f7c167ac49129b374442f65a5fb1d9509a29ee12332`。
- 数据库显示字段聚合：`output/validation/sampleco-bilingual-20261004/database-label-coverage-02.json`，SHA256 `0eef0b810dc7b8aae94b847c4fa24a4130db54fcc00d37374308c3a419ed305d`。只表示缺英文数量，不能把全部空值判成固定产品词条。

本补充仅写入 ignored output。未修改客户源码、测试、迁移、Git、远端或数据库，未执行接口或浏览器验证。此有界只读审计结束。
