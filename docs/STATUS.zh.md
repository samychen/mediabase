# mediabase 状态说明

> **基座保持中立：`@mediabase/*` 里没有产品代码。** 本仓同时带四棵**产品层实例**（`product/`），
> 它们是"叠在基座上"的示范与真实产品，不被基座包引用。

> 保持本文与代码同步。已完成项皆有测试或实测支撑;未完成项给出"卡点/为何"。


## 本仓范围（mediabase）

已具备并可测：cordis 组合、`@mediabase/*` 基元与宿主/客户端能力、基座 bundle/roster、
`verify:compose` / `verify:base`、handoff 中立性、可选无引擎 Electron 壳。

另有三条已实测的性质（不是计划）：

- **行的挂载点由锚点决定**：检出态启动前，每个裸包名都按 app 自己的清单解析成绝对路径
  （`absolutizeRowSpecifiers`），所以 Loader 自身的位置不能决定某一行挂不挂得上。
- **实战路径已跑通并有输出**：`docs/WALKTHROUGH.zh.md` —— 基座旁边建一个计算器（JS/Python/C++
  三种后端 + 一页含 AI 聊天框的界面，零改动基座）。
- **产品层真的能叠上去**：`product/` 下有四个实例 —— openvideo（剪辑）、mediamtx-console
  （流媒体管理台）、xmedia（C++20 转码/推流）、highlight（Python 侧车高光引擎）。各自有
  scope / bundle / 身份 / 端口，基座零改动；`verify:compose` 与 handoff 中立性测试守住这条界线。

## 不在本仓

- 基座包里**没有**引擎、媒体动词、产品 UI（`ui-media` 等）、python sidecar —— 这些东西只出现在
  `product/<name>/` 的产品层里，`@mediabase/*` 从不 import 它们。
- 各产品的成熟度、已验证项与未交付边界，以 `product/<name>/README.zh.md` 为准（不在本文重复，
  免得两处数字互相打架）。
- 消费仓（如 avstudio）的产品与 GPL 分发实测另算，见那边的 STATUS。

## 跟进

- 基座 tag / 消费仓 pin 策略
- 文档双语精修（非阻塞）
