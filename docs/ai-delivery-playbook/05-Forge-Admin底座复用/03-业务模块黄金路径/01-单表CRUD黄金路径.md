# 单表 CRUD 黄金路径

模板编号：`FA-CRUD-01`  
Skill 依赖：`forge-codegen-crud` 的 `single-table` 路由  
平台依赖：`TenantEntity`、Mapper XML、AiCrudPage、字典、资源、Excel（按需）

## 谁来使用

产品人员只需描述一个业务对象、字段含义、允许动作、角色和验收，不负责判断它是否真是“单表”。协调 AI 读取需求和项目后选择本路径；技术人员复核数据、权限、迁移和测试。下面是 AI/技术执行合同。

## 可直接复制给 AI

```text
请按 Forge Admin 官方 forge-codegen-crud Skill 的 single-table 模式，实现 {{业务对象}}。先完成 Skill/源码预检，再修改代码。

需求与验收：{{产品材料；AI 负责定位路径和版本}}
字段表：{{人确认业务含义/必填/唯一；技术类型和字典映射由 AI 补}}
业务动作：{{查询/详情/新增/编辑/删除/批删/导入/导出}}
权限与数据范围：{{角色和范围}}
非目标：{{本期不做}}

强制合同：
1. 顺序为 migration → backend → frontend → menu/resource；
2. 业务实体继承 TenantEntity，不重复继承字段；查询写 Mapper XML；
3. 生成型接口使用 GET /page 和 POST /getById/add/edit/remove/{id}/removeBatch；
4. 前端优先 AiCrudPage，apiConfig 使用 post@... 且主键占位符与 rowKey 一致；
5. 有限取值走字典；文件存 fileId；金额使用最小货币单位；时间类型按 Skill；
6. 需要删除后复用业务编码时，del_flag 使用主键墓碑和唯一键 (tenant_id, business_key, del_flag)；
7. migration 初始化字典、Excel、目录/菜单/按钮/API 和批准角色授权时必须幂等；
8. 编写并执行后端测试、前端契约测试、Lint/build，输出真实结果。

跨层易错合同：
- 日期组件必须按固定版本 owner 使用 formatted value，显式约定 API 日期/时间字符串，禁止依赖 epoch 或隐式时区转换；
- API BigDecimal/Long 字符串在 DTO→表单边界集中规范化，数字组件不直接接字符串；派生金额、净重和系统状态由后端拥有；
- JSON 字段不仅要可解析，还要验证 array/object 和内部 schema；
- 同类弹窗复用 canonical 表单 owner，宽屏和 720px 都要验证；动作集合必须与 API、权限和当前状态一致。

开始前先输出：复用点、新增文件、接口/字段/字典/权限合同、风险、停止项。发现需求与源码/Skill冲突时不要自行选边。
```

## 交付物

- 版本化 migration；
- Entity、DTO、Query、VO、Mapper/XML、Service/Impl、Controller；
- AiCrudPage 页面与前端契约；
- 字典、Excel、资源授权（涉及时）；
- 测试、构建、人工验收步骤和未解决项。

## 人工验收

除正常 CRUD 外，至少检查：重复业务编码、字典非法值、跨租户/跨组织 ID、批量删除、删除后重建同编码、日期提交/编辑回显、十进制回显和后端派生值、JSON 数据形状、导入错误行、导出数据范围、无权限按钮和直接 API 请求。浏览器必须执行新增→查询→编辑→详情→状态动作→删除/终止闭环，不能用页面能打开或 HTTP 200 代替。
