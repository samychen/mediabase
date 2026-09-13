# mediabase 状态说明

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

> 保持本文与代码同步。已完成项皆有测试或实测支撑;未完成项给出"卡点/为何"。


## 本仓范围（mediabase）

已具备并可测：cordis 组合、`@mediabase/*` 基元与宿主/客户端能力、基座 bundle/roster、
`verify:compose` / `verify:base`、handoff 中立性、可选无引擎 Electron 壳。

另外两条已实测的性质（不是计划）：

- **行的挂载点由锚点决定**：检出态启动前，每个裸包名都按 app 自己的清单解析成绝对路径
  （`absolutizeRowSpecifiers`），所以 Loader 自身的位置不能决定某一行挂不挂得上。
- **实战路径已跑通并有输出**：`docs/WALKTHROUGH.zh.md` —— 基座旁边建一个计算器（JS/Python/C++
  三种后端 + 一页含 AI 聊天框的界面，零改动基座）。

## 不在本仓

C++ 引擎、媒体动词、产品 UI（`ui-media` 等）、python sidecar、产品 GPL 分发实测 ——
见消费仓（如 avstudio）的 STATUS。

## 跟进

- 基座 tag / 消费仓 pin 策略
- 文档双语精修（非阻塞）
