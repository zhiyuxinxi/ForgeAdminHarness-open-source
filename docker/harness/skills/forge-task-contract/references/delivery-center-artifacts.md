# 随交付形成的业务过程产物

本说明指导 Harness 在完成当前业务工作时，同步保留实际形成或使用的可追溯定义。同一内容供本次代码生成、后续 AI 复用和需求与交付中心阅读，不在完成代码后另写一套展示说明。协议中的元信息仍为兼容旧产物的可选结构；这不表示本次已明确且用于交付的业务内容可以省略。只保留有据内容，不为填表编造，不新增阶段、模型调用、人工登记、逐条确认或字段完整率门禁；缺少记录不撤销既有执行权限，也不能据此声称业务未完成。

## 放在已有产物中

正式阶段的 `payload` 顶层仍必须恰好符合当前 `requiredPayloadKeys`。不要增加顶层 `deliveryCenter`，不要改变阶段或自动提示合同。本轮已形成的定义在现有业务对象行内携带 `deliveryCenter` 身份和引用；原行保存该对象的业务正文。普通任务复用已授权的既有设计文档，不为了本说明新建人工台账或绕开写入范围；明确只读或当前文档路径未获授权时不擅自写入。

| 当前内容 | 自然承载位置 |
| --- | --- |
| 功能、独立要求、菜单定义 | `requirementTrace.functions[]`、`requirementTrace.requirements[]`、`requirementTrace.menus[]`；保留原有追踪内容 |
| 场景、规则、验收条件 | 既有 `useCases`、`businessRules`、`acceptanceCriteria` 的对象行 |
| 业务模型、行为、接口、字典 | `businessEntities`、`commands`、`queries`、`apiContracts`、`dictionaries` 等当前阶段已有对象行 |
| 表、页面、实现、权限 | 当前阶段已有 `tables`、`pageMode`、`fields`、`actions`、`apiImplementation`、`pageImplementation`、`menuSeed` 等对象行 |
| 验证结果 | 已有 `requirementCoverage`、`testEvidence` 等对象行，关联真实执行证据 |

既有字符串、数组、对象格式继续有效。本轮新增或改动的定义用对象行保留已知业务内容与元信息；未变化的上游定义引用已有身份、具体修订和来源即可，不重写正文、不为字段整齐重做上游。后续 AI 开始相关改动时，先读取本任务实际依赖的原定义及引用修订，沿用稳定身份；新增、纠偏、替代分别记录本次变化和依据，不能从页面名称或现有代码倒推原始要求。阶段提示已提供的前序产物是引用来源；缺失的原始业务解释交由原对话或明确关联的整理对话处理，采集器和平台操作人不得代造业务定义。

普通非阶段任务在本次已授权的 `code-copilot/changes/**/*.md` 过程文档内，使用三个反引号紧接 `json delivery-center` 作为开头行的专用代码块承载同形对象，开头行不缩进。块内是带 `deliveryCenter` 的单个业务对象、此类对象数组，或 `{ "records": [...] }`；不要把模型分析、任意 JSON 示例或完整聊天放入这个专用块。正文和元信息仍是同一份业务定义，不另建登记文件，不为了收录自行提交或发布。

以下仅示意嵌套结构，尖括号内均为占位文字，不是业务定义或可复用身份；实际产物须换成已形成的内容和真实引用。`name`、`description` 等业务正文与 `deliveryCenter` 同层；`schemaVersion`、`id`、`kind`、来源及引用等共同元信息放在每条记录的 `deliveryCenter` 内，不能平铺到记录顶层，也不能只在 `records` 外包一份元信息。

```json delivery-center
{
  "records": [
    {
      "name": "<业务对象名称>",
      "description": "<已有业务正文>",
      "deliveryCenter": {
        "schemaVersion": 1,
        "id": "<项目范围内稳定对象ID>",
        "kind": "entity",
        "revision": null,
        "nature": "unknown",
        "menuRefs": [
          { "kind": "menu", "id": "<实际菜单稳定ID>", "revision": null }
        ]
      }
    }
  ]
}
```

示例没有列出的字段仍按下方约定及已知内容记录；没有真实菜单引用时不保留占位引用，不把缺失关联改成 `menuApplicability: none`。

项目集成库中已提交的上述文档继续由既有入口收录。工作舱提交按受保护任务绑定的所属项目收录：在既有授权下成功完成 `checkpoint` 后，平台从本次提交的上述过程文档提取专用块，按独立“工作舱过程提交”批次进入该项目的中心，无需先集成到主干。真实项目、任务、会话、commit、blob、路径和代码块位置由平台关联；尚未提交的内容不收录，也不为收录自行取得新授权或扩大提交范围。

工作舱批次表示已提交的过程定义，不等于项目 `main` 当前定义、业务采用、验收通过或生产发布；并行工作舱的修订分别保留，不能按提交时间覆盖项目当前定义。提取失败时，已成功的提交仍然保留，平台明确标记该次过程文档尚未收录；不得声称已自动重采或已恢复，只有后续真实采集和同步结果才能证明收录。

正式八阶段继续由阶段产物即时提供，不等待业务提交。首次历史采集有明确数量和时间边界，原历史资料包继续可读；未覆盖旧资料不能声称已经完整梳理。已登记来源读取失败时保留此前中心快照，来源修正后按既有同步继续。

## 共同元信息

| 字段 | 含义 |
| --- | --- |
| `schemaVersion: 1`、`id`、`kind` | 稳定身份及对象种类。新身份使用项目范围内稳定标识；已有身份原样复用，不由可变名称、路由、目录或数组序号重新编号。 |
| `revision`、`contextId` | 已明确的定义修订和业务上下文。未提供修订时中心可计算内容摘要，不要求模型计算摘要；不能把名称相同当成同一上下文。 |
| `recordType` | 同一对象种类内的明确业务类型，例如独立要求 `requirement`、来源章节 `source-section`、场景 `scenario`、流程 `process`、验收条件 `acceptance`、用例 `test-case`、实际执行 `test-execution`。无法确定时 `unknown`。 |
| `nature` | `original`、`interpretation`、`design`、`implementation-observation`、`execution`、`historical-compilation`、`unknown`。来源性质与业务采用分开。 |
| `sources` | 对象数组。文件引用用 `path`、`section`、`lines` 保留实际相对路径、章节及行号/行段；已有真实来源修订用 `revision` 或 `commit`。`evidence` 写该来源支持什么，原文摘录另用 `excerpt`，不把依据说明冒充原文。已有记录/对话定位可保留其真实标识；未知键不补占位值，不复制完整私聊、秘密或无关附件。 |
| `functionRefs`、`menuRefs` | 引用已有功能或菜单；同一功能/要求可有多个使用入口。每个引用为 `{kind,id,revision,localId?}`，修订未知则 `null`，不得猜最新版。要求、页面或接口指向功能的关联记录一次即可，由平台反查；不要求在功能及所有使用方手抄两份关联。 |
| `menuApplicability` | 有明确依据说明业务无需菜单时填 `none`；没有菜单引用时保持 `unknown`，不能把“尚未关联”当成无需菜单。 |
| `adoption` | `{state,sources,supersedes?}`。状态为 `adopted/proposed/withdrawn/superseded/unknown`，保留适用范围等已知内容。采用、撤回、替代必须有相应决定来源；阶段接受和导入顺序不构成采用。 |
| `relations` | 每条为 `{id,revision,type,from,to,conditions,sources}`，双方使用上述引用。关系自身的变化与对象定义变化分别保留；条件、方向、数量、有效时间只记录有据内容。 |
| `origin`、`originSources` | 仅用于菜单来源：`baseline/base-upgrade/business-added/unknown`，必须有来源依据。运行库当前存在、首次被采集或代码修改时间不能证明原生或首次引入。 |
| `businessChange`、`parentRef` | 有明确业务改动依据时记录 `modified/unchanged`，否则 `unknown`；父菜单用稳定引用，不凭页面顺序猜层级。 |

`kind` 的 `menu`、`requirement` 分别进入既有菜单和要求集合；独立资产种类为 `function/scene/entity/table/page/api/permission/test/rule/dictionary/task`。模型类中概念、角色、实体、值对象、行为、状态、事件等用明确 `recordType` 区分，不把所有源码 class 解释成业务实体。字段、步骤、局部属性可通过引用的 `localId` 定位，不必给每个字符串单独创建资产。

## 功能与要求分别表达

功能正文至少说明已知的名称、业务目标、可观察结果、边界和适用条件；详情可以保留目标尚待明确的事实。功能具有独立 `kind:function` 和稳定身份。独立要求通过 `functionRefs` 关联它，功能与要求可以多对多。字段必填、校验规则、菜单、页面、接口、文档章节不因各占一行就分别计为功能。

重命名保留身份；拆分、合并、停用、恢复保留前后引用和范围。调整尚未采用时仍为提议，不覆盖已有采用定义或生产能力。明确替代时，`adoption.supersedes` 指向具体旧修订，不能仅写“取最新”。同一身份有多项不能确定先后的采用记录时保留并列，不由中心推断冲突或自行择定。

## 本次已知正文的字段位置

以下沿用中心已读取的正文结构，放在记录内与 `deliveryCenter` 同层；收录后对应 `details`，不要再外包一层 `details`。只记录本次确实形成或使用的内容；不要求每个任务涉及全部行，也不为凑字段补设计。已有等义字段仍可复用，不为更名重写旧产物。

| 内容 | 正文字段与含义 |
| --- | --- |
| 功能 | `name`、`businessGoal`、`observableResult`、`boundaries`；分别是名称、业务目标、可观察结果和范围边界，已知限制可用 `knownLimitations`。 |
| 独立要求 | `name`、`statement`；约束正文独立保存，已知功能归属放 `deliveryCenter.functionRefs`，不能仅给章节名。 |
| 页面 | `pageName`、`purpose`、`pageType` 记录已知整页含义；`regions[]` 保存区域的 `name/position/purpose`。区域用途不能替代未明确的整页用途或布局。 |
| 查询、列表与表单 | 分别保留 `queryFields[]`、`listColumns[]`、`formFields[]`，区域内字段可保留 `regions[].fields[]`；字段的 `name/label`、业务含义、`requiredCondition` 或 `required`、`validation`、`optionSource`、`defaultValue`、可见/可编辑条件按实际定义分别记录，不只写字段总数。 |
| 页面操作与接口 | `actions[]` 保存 `name/trigger` 及已知业务条件和结果，`actions[].apiRefs[]` 使用共同引用格式指向实际端点；已有 `apiBindings[]` 可继续使用。菜单/功能归属在该页面、接口各自的元信息中保留。 |
| 模型与保存设计 | 属性保留 `attributes[]` 及含义、约束；表字段保留 `fields[]` 或 `columns[]` 中的 `businessMapping`、`businessAttribute`、`nullable`、`defaultValue` 等已知映射和保存规则，技术补充字段与业务属性分开，不把页面字段直接当数据库字段。 |
| 接口正文 | 每端点的 `method/path/purpose`、`requestFields[]/responseFields[]`、`processing[]` 及已有错误处理；调用依赖按下节记录，字段的业务含义、必传条件、允许值与实际调用目标不能被接口名称代替。 |

字段或操作的依据可随相应对象行用 `sources` 保留；共同元信息的来源仍在 `deliveryCenter.sources`。源码观察用实际来源性质，不把静态校验说明当执行通过；本轮未形成的规则、修订或运行结果应说明缺失，不用空结构冒充已经整理。来源 `lines` 只写实际读取的行号或行段，`evidence` 只解释已有证据，不生成伪造行号、提交摘要或回执。

## 接口与调用依赖分别表达

一条 `kind: api` 记录对应一个可调用端点，具有自己的稳定身份；Controller 或模块是分组，不是一个接口。HTTP 接口已知的方法与完整路径在业务正文中分别用 `method`、`path` 表达，`path` 包含实际控制器前缀，不只写方法局部路径，也不把二者混入名称。输入、输出和错误处理按该端点分别保留本次实际设计或使用的内容；未知内容保持未知，不为本说明增加业务必填规则或猜测接口。

`calls`、`dependencies` 仅记录该端点实际调用或依赖的其他能力，不用来装载同一 Controller 下的所有端点。依赖目标已知时按共同引用格式保留稳定身份与具体修订，关系的 `from`、`to` 继续遵守上述约定；静态调用来源不冒充真实运行记录。接口记录与它实现的功能、要求仍分别保留身份和关联，不合并成一条业务要求或功能。

## 真实外层证据

模型仅记录本次确实形成的业务内容和已知来源。阶段 ID、产物摘要、任务/会话绑定、真实阶段接受、收录时间、执行和发布回执由平台外层关联；不得在元信息内伪造这些事实。草稿可以被查看，不因此成为已采用、已实现或已发布。

测试预期、执行计划、发布说明可以提前记录；只有实际执行结果和状态才关联真实执行证据并说明范围。源码/数据库观察只证明相应实现事实，不倒推成原始要求或业务确认。历史整理保留原来源时间和后来整理性质，不覆盖旧验收、发布快照及失败记录。
