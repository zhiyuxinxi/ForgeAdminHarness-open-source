# 阶段工作包合同

`FORGE_PHASE_WORK_PACKAGE_CONTRACT_V1`

当前工作包版本：`2026.09.12.1`。

## 双层事实模型

- 机器事实源：内容寻址 phase artifact JSON、controller receipt、Host Runner receipt、patch digest、上游 artifact digests。
- 人类工作包：同一事实源的 Markdown 投影，用于固定交互、评审、维护、交接、归档和 Memory candidate 准备。

两者冲突时机器事实源优先；Markdown 不能补造未执行验证。工作包必须由 controller 写到当前 attempt 的 run-owned evidence 目录，文件权限、目录位置和生命周期由 operator 管理，不写进客户业务源码。

## 固定文件

| 文件 | 必含内容 | 权威边界 |
|---|---|---|
| `00-input.md` | 需求摘要、来源版本、上游摘要、当前授权、同事检查项 | 不复制原始 Secret 或宿主路径 |
| `01-result.md` | 先呈现模型真实业务说明、controller 阶段状态和实际下一步；后置 details 包含 artifact 身份、patch/changed paths、payload 投影、未决决定 | JSON artifact 为事实源；业务说明不得替代机器状态 |
| `02-process.md` | 可观察动作、决定、纠偏、当前阶段最佳实践 | 不保存隐藏推理 |
| `03-verification.md` | 预期 profile、实际 receipt、失败/未执行、cannot-claim | AI 不能自证 |
| `04-handoff.md` | 下一阶段、携带物、blocker、归档规则 | controller 决定推进 |
| `05-memory-candidate.md` | 候选正文、来源、范围、不确定性、冲突、晋升状态 | 默认 draft，owner-confirmed-only |
| `manifest.json` | 规范版本、身份、全部文件 bytes/SHA-256、artifact/receipt 摘要 | controller 生成并校验 |

## 失败关闭

工作包目录只能包含上述七个普通文件。缺失、额外、符号链接、内容/字节数/摘要漂移、错误 workflow/phase/attempt、过期上游、宿主绝对路径、Secret-shaped 内容或 Memory 自动晋升声明均阻止封存。工作包封存失败时 controller 不推进阶段。

归档后不原地改写。修订通过新 attempt 生成新目录，新旧 manifest 并存。失败、blocked 和 cannot-claim 也是必要证据，不能清理后重写历史。

`01-result.md` 的业务说明来自本次真实 model response 前言，不由通用字段计数或摘要引擎猜造。历史包若没有正文则保持缺失事实，不补写、不伪造，也不因新版本发布而批量重写；六份 Markdown、manifest 摘要密封和证据权威关系保持不变。
