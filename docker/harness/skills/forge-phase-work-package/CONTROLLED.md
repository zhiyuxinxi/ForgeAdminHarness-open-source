---
name: forge-phase-work-package
description: Produce the inspectable, maintainable, archivable and memory-ready work package for exactly one operator-controlled Forge Admin delivery phase. Use in every requirements, domain-contract, database, ui-design, backend, frontend, access-wiring or cross-layer-acceptance phase; do not use it to advance a phase, self-certify verification or write active Memory.
---

# Forge Admin 阶段工作包

Policy marker: `FORGE_PHASE_WORK_PACKAGE_V1`.

本 Skill 只服务当前一个阶段。先读取 [阶段工作包合同](references/work-package-contract.md)，再只读取 `assets/` 中与当前 phase ID 同名的 Markdown 卡片；禁止一次加载八张卡片或提前完成后续阶段。

## 执行规则

1. 按当前卡片核对最小人工输入、可上传资料、阶段问题、输出和停止条件。缺少业务决定时写入 `unresolvedDecisions` 并暂停，不能猜默认值。
2. 项目源码和结构化 phase artifact 仍由当前领域 Skill 与 controller 合同约束；不要在业务仓库创建第二套过程文档目录，也不要用 Markdown 替代 JSON artifact、patch 或 Runner receipt。
   若当前项目有 `code-copilot/rules/internationalization.md`，读取其中当前阶段对应的要求，放入已有 payload 字段并保持到下一阶段的引用；语言回退不等于英文完成。不存在该项目合同且未要求国际化时不启用此项，不增加其他项目的阶段字段、写权或检查。
3. 只提供可观察事实：读取了哪些逻辑资料、形成了什么产物、修改了哪些仓库相对路径、取得了哪些受控回执、失败在哪里、如何纠偏。不得输出或要求隐藏推理过程。
4. 不写入密码、Token、私钥、完整连接串、生产数据或宿主绝对路径。引用资料时记录稳定逻辑名称、版本和 SHA-256。
5. 最终六份 Markdown 和 `manifest.json` 由受信 controller 在 run-owned evidence 目录确定性生成、校验和封存。模型不得手写 manifest、伪造 hash、修改旧 attempt 或自行宣布阶段通过。
6. `05-memory-candidate.md` 只是 owner 待审核候选。只有跨任务稳定、证据充分且 owner 明确确认后，才允许通过独立受控流程晋升；本 Skill 不调用 MCP Memory 写工具。
7. 当前工作包版本为 `2026.09.12.1`。`01-result.md` 先呈现模型本轮真实业务说明、controller 判定的阶段状态及实际下一步，再后置 artifact、payload、路径和摘要等技术 details。不得用“已记录 N 项结构化明细”或通用字段计数冒充业务摘要；没有模型正文的历史包保持原状，不伪造总结，也不重写旧包。

## 输出边界

模型当前阶段先用用户主要语言给出简短、具体的业务说明，再返回 phase controller 要求的唯一结构化 proposal；业务说明不能替代 proposal，也不能自行宣布阶段通过。Controller 接受或阻塞阶段时生成：`00-input.md`、`01-result.md`、`02-process.md`、`03-verification.md`、`04-handoff.md`、`05-memory-candidate.md` 和 `manifest.json`。

缺文件、额外文件、摘要漂移、宿主路径、Secret-shaped 内容、AI 自证验证或自动晋升 Memory 的声明都必须失败关闭；失败卷宗仍保留，不能删除或改名为通过。
