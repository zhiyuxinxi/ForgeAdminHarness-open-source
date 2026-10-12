# Forge Admin CRUD 合同

## 冻结基线的最短 owner 定位

在当前冻结的 Forge Admin 源码中，先读这些真实 owner，再按目标模块适配；它们是定位入口，不是复制模板：

| 责任 | 基线入口 |
|---|---|
| 完整后端垂直切片 | `forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/purchase/`（`SamplePurchaseOrder*`） |
| 管理端相邻 API | `forge-admin-ui/src/api/business/purchase-order-test.js` |
| 管理端页面 | `forge-admin-ui/src/views/business/purchase-order-test.vue` |
| 全局 CRUD owner | `forge-admin-ui/src/components/ai-form/AiCrudPage.vue`、`AiCrudPageProps.js` |
| Flyway 版本邻接 | `forge-server/db/migration/V1.0.133__align_resource_unique_key_with_client_code.sql` |
| 后端测试 owner | `forge-server/forge-business/forge-business-core/src/test/java/` |
| 前端测试 owner | `forge-admin-ui/src/**/__tests__/` |

先核对文件仍存在且合同未漂移；不存在时以当前仓库检索结果为准并停止使用该定位表，禁止创建平行目录来迎合本表。

## 必交付

- `forge-server/db/migration/V...__....sql`
- Entity + DTO/Query + VO
- Mapper interface + Mapper XML
- Service/Application Service + Controller
- backend unit/contract tests
- frontend API module（需要时）+ AiCrudPage page
- dictionary/resource/Excel seed（适用时）
- permission inventory 与负例
- migration/build/API/browser receipts

## POST-safe 档案

| 行为 | 后端 | AiCrudPage |
|---|---|---|
| page | `GET /page` | `get@.../page` |
| detail | `POST /getById` | `post@.../getById` |
| add | `POST /add` | `post@.../add` |
| edit | `POST /edit` | `post@.../edit` |
| remove | `POST /remove/{id}` | `post@.../remove/:id` |
| batch（可选） | 确需后端批量时才提供 `POST /removeBatch` | typed IDs；否则由公共逐项处理复用单删 |

下载、SSE、Webhook、普通 REST 属于其他档案，不强行套 CRUD。

普通可维护台账默认必须具备分页/条件查询/详情/新增/编辑/单删的真实后端支持。在既有 API 合同核对对应权限、DTO 校验、可信租户/数据范围、引用和状态限制及错误反馈；不存在接口不是业务禁删依据。只读、归档、审计流水、审批/签字等真实例外保留并给出依据，不为它们机械补写操作。

多选删除默认可以消费现有单删并逐项报告成功、失败及原因；不要求每个实体新建 batch API。存在 batch API 时才核对 ID 上限、空/重复输入及整批原子或部分成功的已声明语义。无论哪种路径，都不能绕过单删的对象权限、引用、状态和受影响行数检查。

## 必测

- 普通列表默认多选/全选、批量删除、查询重置、常规操作和公共表格工具齐备，不依赖产品逐项描述；对照原版用户管理与 `forge-frontend-admin/references/page-patterns.md`。检查生成配置是否无业务依据地覆盖 `hideSelection`、`hideBatchDelete` 或工具栏默认值；API、权限与记录状态必须真实接线。
- 当前实际使用的新增编辑、详情、modal/drawer/同页表单及浮层须复用对应公共骨架；同类schema、列数/label/间距、标题/滚动/footer与默认交互一致。覆盖初值、编辑回填、真实校验、取消不写、busy防重、失败保留输入与重开；只通过列表检查不能代替这些页面的标准化。例外来自业务内容或真实组件边界，不由模型随机选择。
- 按本次实际改动覆盖 page/filter/detail/add/edit/delete，以及采用的多选处理路径；空 ID/重复业务键/并发写、引用或状态禁删须给明确结果。`IService` boolean 返回 `false` 或 `BaseMapper` 受影响行数不符合预期时必须失败且不能记录成功审计。逐项删除核对部分失败回执；采用整批原子语义时核对回滚，不机械要求另建 batch API。
- `pageNum/pageSize` 默认、0/负数/101、稳定排序、过滤组合。
- tenant A 看不到 tenant B；无租户/无权限失败关闭，禁止把缺失 tenant context 回退到 `1L` 或其他常量租户。
- 删除后活动唯一键按设计复用，墓碑不是固定 1。
- 字典异步加载与未知 code；Excel 导入错误回执/导出 round-trip。
- Long ID `9007199254740993` 不丢精度；fixture 与断言直接使用字符串，禁止 `String(9007199254740993)` 这类已经舍入后的假阳性。
- 页面 loading/empty/error/disabled/busy、窄屏、键盘、无权限。
- 权限树中菜单是实际 owner；每个按钮/API resource 的 `parent_id` 指向该菜单，不能是 0/NULL 孤儿。
- 字段级校验在当前 AiForm owner 中真实触发；API adapter 若生成必须被页面/组件测试实际调用。

## 禁止

Controller 返回 Entity、Service QueryWrapper 拼查询、旧 Flyway 重写、PUT/DELETE generated routes、`{id}`、硬编码 statusOptions、页面内 NPagination、裸 axios/fetch、raw protected image URL、`props.rules` 伪校验、未接线 API adapter、根级按钮/API resource、只隐藏按钮不保护 API、把测试计划写成测试结果。
