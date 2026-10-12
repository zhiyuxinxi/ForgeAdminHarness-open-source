# Forge Admin v1.1.2 管理端前端合同

## 固定基线

本参考以 Forge Admin v1.1.2 commit `6eb2881e6f6af85a5348acf3da63cef53a873b0e` 为事实基线。路径是项目相对路径；部署项目若升级版本，先重新审计 owner 和脚本，不能把本参考冒充新版本事实。

关键来源：

- `forge-admin-ui/package.json:6-12,48,57`：真实 build/test 脚本及 Naive UI、Element Plus 共存现状。
- `forge-admin-ui/src/components/ai-form/AiCrudPage.vue:4049-4075`：`pageNum/pageSize` 请求合同。
- `forge-admin-ui/src/components/ai-form/AiCrudPageProps.js`：标准 CRUD 配置 owner。
- `forge-admin-ui/src/components/DictSelect.vue`、`DictTag.vue` 与 `src/components/common/AuthImage.vue`：字典和鉴权图片 owner。
- `forge-admin-ui/src/components/common/SystemPageLayout.vue`、`CommonPage.vue`、`AppPage.vue`：页面壳 owner；实际移动后应按名称重新定位。
- `forge-admin-ui/src/directives/modules/hasPermi.js:19-23`：权限数据为空时当前实现保留元素，是需修复/负测的 fail-open 债务，不是推荐模式。
- `forge-admin-ui/src/utils/debug-console.js:6,16-43`：`vconsole@latest` CDN 和 localStorage 开关是生产供应链/调试面风险。
- `forge-admin-ui/src/utils/http/interceptors.js:9-17,535-567`：UUID、traceId 和 nonce 使用 `Math.random()`，安全相关随机值不得沿用。
- `forge-admin-ui/src/config/theme.config.js:11,154-166`、`src/styles/design-tokens.css`、`uno.config.js:46-55`：主题值存在多个 owner，新增改动必须收敛而非复制。

## Canonical owner 决策表

| 需求 | 默认 owner | 允许自定义的条件 |
| --- | --- | --- |
| 普通列表/筛选/新增/编辑/删除 | `AiCrudPage` | 标准 extension point 无法表达且有交互合同与回归测试 |
| 字典选择/显示 | `DictSelect` / `DictTag` | 非字典协议常量，且写明后端验证 owner |
| 受保护图片 | `AuthImage` | 公共静态资源或已有专用媒体 viewer |
| 系统/内容页面壳 | 同模块 canonical layout | 设计器、全屏工作台等有明确布局例外 |
| HTTP、token、错误 | `src/api` + 既有 HTTP interceptor | 不允许页面级复制 |
| 颜色、间距、字号 | canonical design token | 品牌资产/图表序列且有批准的 token 扩展 |

## 负例清单

- `id`、`tenantId`、`userId`、`resourceId`、`processInstanceId` 经过数值转换。
- 权限数组为空时先显示按钮，加载后再删除；接口可被直接调用成功。
- 页面从 CDN 动态加载未固定版本脚本，或在生产保留 query/localStorage 调试开关。
- CRUD 页面自行实现第二套分页、modal、字典或鉴权图片逻辑。
- create/edit 共用状态但没有 reset/refill 竞争测试。
- 只验证 200/截图，不验证 loading、empty、error、busy、窄屏、键盘和权限负例。

## 验证 receipt

每条命令记录 UTC 时间、cwd、argv、exit code、stdout/stderr 摘要和 diff hash。浏览器记录 build/source SHA、路由、账号角色、租户、视口和预期/实际。命令未执行或服务未启动时只列待验证项，禁止用 audit 0 或 build 0 推断浏览器与授权行为。
