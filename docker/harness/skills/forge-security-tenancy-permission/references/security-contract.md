# Forge Admin v1.1.2 安全与租户合同

## 固定事实与债务

基线 commit：`6eb2881e6f6af85a5348acf3da63cef53a873b0e`。

- `forge-server/forge-framework/forge-starter-parent/forge-starter-auth/src/main/java/com/mdframe/forge/starter/auth/interceptor/ApiPermissionInterceptor.java:56-100`：可关闭 API 权限、annotation exemption、anonymous config，以及“未配置 API resource 即放行”。后者是 hardening 债务。
- `forge-server/forge-framework/forge-plugin-parent/forge-plugin-system/src/main/java/com/mdframe/forge/plugin/system/service/impl/PermissionServiceImpl.java:52-72`：configured resource 查询与匹配。
- `forge-admin-ui/src/directives/modules/hasPermi.js:19-23`：权限集合缺失时 fail-open。
- `forge-server/forge-framework/forge-starter-parent/forge-starter-tenant/src/main/java/com/mdframe/forge/starter/tenant/handler/DefaultTenantLineHandler.java:47-100`：strict mode、ignore context/table 和自动检测行为。
- `forge-server/forge-framework/forge-starter-parent/forge-starter-tenant/src/test/java/com/mdframe/forge/starter/tenant/handler/DefaultTenantLineHandlerTest.java:19-53`：缺 tenant context 默认失败关闭及显式 ignore 测试。
- `forge-server/forge-framework/forge-starter-parent/forge-starter-tenant/src/main/java/com/mdframe/forge/starter/tenant/config/TenantProperties.java:31-70`：默认 strict、auto-detect 及平台 ignore table 清单。
- `forge-admin-ui/src/utils/http/interceptors.js:9-17,535-567`：现有 nonce/trace 使用非加密随机数。

这些路径描述当前源码，不表示所有运行部署已启用相同配置；必须读取部署配置并实测。

## Access matrix 最小列

| actor/role | tenant source | resource/action | endpoint method+path | permission code | data scope | public/ignore | audit event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 业务用户 | authenticated context | 记录查询 | exact | stable code | org/self/all | no | allow/deny |
| 服务账号 | signed identity | bounded action | exact | explicit grant | exact tenant | no | client/request/idempotency |
| anonymous | none | public metadata only | exact | none | none | approved allowlist | rate/deny |

## 必测负例

- endpoint 已实现但没有 API resource/permission annotation；请求必须被发现并阻断，而不是静默放行。
- 用户有菜单没有按钮、有按钮没有 API、有相邻 tenant 同 ID；分别返回稳定 deny。
- 权限数据未加载/加载失败时，受保护按钮不可操作；直接请求仍 deny。
- list/detail/export/count/batch/selector 使用不同 data scope 的越权尝试。
- async/callback 在线程复用后读取到前一个 tenant；上下文必须清理且测试失败关闭。
- caller 注入 `tenantId`、ownerId、role/resource IDs 或把 Long ID 数值化。
- 日志和错误中出现 Authorization、cookie、secret、完整敏感字段或解密请求体。

## 例外 receipt

允许的例外必须由项目 policy 而非源码承载，包含唯一 ID、适用 rule、精确 method/path 或文件范围、内容 hash、批准角色与身份引用、风险理由、补偿控制和 expiry。过期、hash 漂移、范围扩大或批准缺失都失败关闭。模型、implementer 和被审查代码不能兼任批准者。

## 证据边界

静态 audit 证明规则对当前 diff 的判定；单测证明测试进程内行为；集成/API 测试证明配置加载后的授权路径；跨 tenant 数据查询证明隔离结果；生产健康还需要部署后观测。不得互相替代。
