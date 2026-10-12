# UI Design 阶段交互卡

## 本阶段需要的业务与界面资料

- 已验收 requirements 与 domain-contract artifact/manifest。
- 现有全局组件、设计 token、页面范式、权限指令和可访问性规范资料。

## 本阶段关注点（提示由 Controller 自动生成）

只设计用户将如何完成本次业务操作：先定位项目已有全局 owner，再定义页面模式、字段、动作、加载/空/错/成功状态、响应式、可访问性、API 和权限绑定；不写页面源码，不复制第二套组件。同事只需确认实际场景、信息和交互取舍，不需要构造技术 prompt。

## 阶段输出与停止条件

- 明确每个复用组件 owner 和设计 token 来源，禁止页面局部硬编码替代全局规范。
- 面向同事先说明页面将支持哪些用例、关键交互和异常反馈，以及仍需确认的具体文案或操作规则；设计结果不能说成页面已经开发。唯一机器 artifact 与完整 payload 继续后置。
- API/权限/字典/Long ID 绑定必须与 domain-contract 一致。
- Controller 封存工作包后才能进入 frontend。
