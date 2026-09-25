# mediabase

中立、可启动的媒体应用基座：`@mediabase/*` + cordis 组合 + 可选 Electron 壳。  
**不含** C++ 引擎与产品领域能力；那些由消费者（如 [avstudio](../avstudio)）叠在基座上。

默认身份：`bin=mediabase` · 环境前缀 `MEDIABASE_` · 状态目录 `~/.mediabase`。

英文版见 [README.md](./README.md)（内容相同）。

## 快速开始（小工具）

```sh
pnpm install
pnpm run host          # http://127.0.0.1:3088
pnpm run verify:base   # 对已启动的 host 做中性冒烟
```

做一个新产品 / 小工具时，通常只改：

1. **`apps/cli/src/identity.ts`**（或你自己的薄入口）— `bin` / `envPrefix` / `homeDir` / `profileKey`
2. **`packages/bundle/app/cordis.patch.yml`** — `insert` 你的能力行（或另做产品 bundle 叠在 `@mediabase/bundle-app` 之后）
3. **`packages/bundle/ui/client.yml`** — 面板名册（壳 `@mediabase/ui-web` 必须最后）
4. **`packaging/desktop-electron/main.cjs` 的 `PRODUCT` 块** — 窗口标题、`configDir`、`envPrefix`、`resources`

共享启动逻辑在 **`@mediabase/boot`**：产品入口只传入自己的 `BootIdentity`，不要复制 `profile-boot`。

## 包一览

| 层 | 包 |
|----|-----|
| 中立基元 | `rpc` · `schema` · `log` · `protocol` · `engine-client` · `gateway` · `confine` · `shm` |
| 宿主能力 | `boot` · `api` · `server` · `tools` · `plugins` · `settings` · `agent` |
| 客户端 | `connection` · `i18n` · `ui` · `theme`（皮肤令牌+一键换肤，内置 dark/midnight/light/studio） · `ui-web` |
| 组合 | `@mediabase/bundle-app` · `@mediabase/bundle-ui` |

## 被消费方式

- **本机开发**：与产品仓同级，产品 `pnpm-workspace.yaml` 写入 `../mediabase/packages/...`
- **CI / 可复现**：pin git tag（当前 **`v0.1.6`**），checkout 到旁路目录后再 `pnpm install`
- **不** publish 到公共 npm（`private: true`）；可用 `pnpm run build:base` + `pnpm pack`
- **照着做一遍**：`docs/WALKTHROUGH.zh.md` —— 在基座旁边新建一个计算器，计算部分有 JS / Python / C++ 三种可换后端（参考实现 12 个文件，零改动基座）
- **第一次接触本仓**：
  - 已会 TypeScript / 基本 React → `docs/LEARNING-PATH.zh.md`
  - 以 C++ 为主、弱前端 → `docs/LEARNING-PATH.cpp.zh.md`

## 仓库内产品层：OpenVideo

`product/openvideo/` 是在本基座上落地的第一个产品（agent 友好的视频剪辑器，移植自
clawnify/OpenVideo，MIT）：`@openvideo/*` scope、自己的 bundle 层与身份（`OPENVIDEO_` /
`~/.openvideo` / 端口 3090），基座包保持中立、零改动。它是 `docs/HANDOFF.zh.md`
采纳清单的**仓内实例**——消费仓可以照着它的形状叠自己的产品层。

```sh
pnpm run build:openvideo   # 名册 + 页面
pnpm run dev:openvideo     # http://127.0.0.1:3090
pnpm run test:openvideo    # 产品测试套件
pnpm run verify:openvideo  # 端到端冒烟
```

详见 `product/openvideo/README.zh.md`（设计、边界与规范落点）与 `product/openvideo/AGENT.md`（agent 指南）。

## 常用命令

```sh
pnpm run build:base      # 各 @mediabase/* → dist
pnpm run build:host      # 封闭运行时
pnpm run build:web       # 基座 roster 静态页
pnpm run verify:compose  # 组合门禁
pnpm test                # MEDIABASE_NO_BROWSER=1 可跳过浏览器
pnpm run package         # Electron（无引擎资源）

# 产品层（product/openvideo）
pnpm run dev:openvideo       # 产品宿主 + 页面（:3090）
pnpm run test:openvideo      # 产品测试套件
pnpm run verify:openvideo    # 产品端到端冒烟
```

浏览器相关缝：`MEDIABASE_NO_BROWSER` · `MEDIABASE_CHROME_ARGS` · `MEDIABASE_CHROME`。

更细的采纳清单见 `docs/HANDOFF.zh.md`。

## 许可

自有代码 MIT。不要把 GPL 引擎二进制打进本仓的默认分发物。
