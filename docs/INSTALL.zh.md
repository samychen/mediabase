# mediabase 打包与安装

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

> 先给结论,别被"打包"二字误导:
> **当前交付形态 = 源码 + 工具链**(Mode B),不是一键安装器。
> 真正"双击安装"的桌面安装包依赖 Mode A(Tauri)或 Node 打包(sea/pkg),
> 那两块仍是脚手架/未立项(见 `desktop/README.zh.md`)。本文把**现在能用的**
> 打包/部署方式写清楚。


## 本仓交付物

`@mediabase/*`、基座 web roster、薄 CLI、可选 Electron 模板。**不含**引擎与产品 sidecar。

## 新机器

1. Node ≥ 20、pnpm
2. `pnpm install` → `pnpm run host`（`http://127.0.0.1:3088`）
3. 环境前缀默认 `MEDIABASE_`；换产品身份见 `docs/HANDOFF.zh.md`

## 打包

`pnpm run build:base` / `build:host` / `package`。带引擎的安装包与 GPL 义务在消费仓。

> 下文若仍出现引擎 / `AVSTUDIO_*` 长文，视为迁仓前遗留，以消费仓文档为准。

