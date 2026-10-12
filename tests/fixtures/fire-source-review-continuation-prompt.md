请发布本对话已完成的消防管理 PC 前端标准化候选，并完成正常提交与集成。保持本对话原范围、完整标准、全部现有业务规则和其他 AI 的后端成果，不重新生成或撤回已有代码。

公共附件代码已由操作员以e051d813正常合入项目canonical，后续还可能有他方合法增量；不要把该提交当作必须回退到的固定HEAD。保留当前全部业务修改，重新读取现役forge-taskspace-collaboration与forge-controlled-release Skill，并读取一次forge-release status。若尚未包含当前canonical且没有待续集成，沿受控integrate start保存完整dirty并合入最新canonical，不要先checkpoint；参数、完整路径列表只能取当前status。已有待续集成按其真实operation和状态正常处理。不要直接执行Git同步、全选ours/theirs或清理他人锁。集成成功只证明源码同步，随后才修本次业务接线，并补受影响的必要检查；不得把旧候选READY挪作新源码通过。

上一轮实际验收解析在21:46:19Z已得到 signedVerdictVerified=true、READY，候选 fingerprint 以 e7373274 开头；后续 prepare_task inspect 却返回 CONVERSATION_TASK_SOURCE_CHANGED，挡住收尾。请沿当前源码正常获取新请求的 prepare_task/验收上下文，复用该候选已有正式检查及验收结果，通过现行 checkpoint/integrate/release 机制完成 main 和必要 UI 发布，不手工改合同、grant、回执或准入。

先读取当前实际安装的 forge-frontend-admin/references/page-patterns.md 中既有模块标准化要求，对照已做的页面及共享消防业务组件。没有新的真实差距就保留实现；原生查询、按钮顺序、多选批删、新增编辑浮层、可读详情和失败保留输入等标准继续适用，地图、库存流水等真实业务例外保持。版本或提示更新不是重新生成的理由。

当前只读源码审阅确认两项需要你在原候选上修复：第一，FireCrudPage.vue设施选项加载失败重试、spare-part.vue库存汇总重试及map.vue仍把按钮放在NAlert不支持的action槽；按现役组件真实槽把重试按钮显示出来，并覆盖失败→点击重试的实际组件行为。第二，FireCrudPage生成可读详情时过滤全部fileUpload并隐藏默认详情，设备、检测、维保仍有attachmentFileIds而没有替代入口，导致附件信息被改版移除。请使用实际已合并的公共只读附件展示能力接回这些业务字段、名称及受保护下载，不展示原始ID、不恢复整页disabled表单，也不再复制附件实现。公共附件能力由操作员负责，你只接业务字段；若当前舱尚未得到该公共代码，沿支持的源码同步机制保留你的dirty成果再接入，不自行虚构公共属性。

本候选未被新改动影响的通过检查复用；只针对上述真实修复及集成变化补必要检查，不把旧候选READY挪用为新改动通过。按现行支持的回执复用及最小验证机制处理，前端范围不夹带无关后端/数据库检查。后台检查保留原 jobId，查询同一作业终态，不因等待超时重投。共享发布正常串行，不清理其他人的锁、候选或镜像。

本次是原工作续接，提交发布授权一直有效，无需再向 Owner 确认。若平台仍阻塞，给出当前直接工具错误、是否有在途 job 和已有候选状态，不以反复修改提示、全量测试或改业务规避平台错误。完成后仅报告真实 main 提交、必要 UI 发布结果及未验边界；浏览器实际页面由操作员随后复验。
