# mediabase

中立、可启动的媒体应用基座：`@mediabase/*` + cordis 组合 + 可选 Electron 壳。  
**不含** C++ 引擎与产品领域能力；那些由消费者（如 [avstudio](../avstudio)）叠在基座上。

默认身份：`bin=mediabase` · 环境前缀 `MEDIABASE_` · 状态目录 `~/.mediabase`。

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
| 客户端 | `connection` · `i18n` · `ui` · `ui-web` |
| 组合 | `@mediabase/bundle-app` · `@mediabase/bundle-ui` |

## 被消费方式

- **本机开发**：与产品仓同级，产品 `pnpm-workspace.yaml` 写入 `../mediabase/packages/...`
- **CI / 可复现**：pin git tag（当前 **`v0.1.5`**），checkout 到旁路目录后再 `pnpm install`
- **不** publish 到公共 npm（`private: true`）；可用 `pnpm run build:base` + `pnpm pack`

## 常用命令

```sh
pnpm run build:base      # 各 @mediabase/* → dist
pnpm run build:host      # 封闭运行时
pnpm run build:web       # 基座 roster 静态页
pnpm run verify:compose  # 组合门禁
pnpm test                # MEDIABASE_NO_BROWSER=1 可跳过浏览器
pnpm run package         # Electron（无引擎资源）
```

浏览器相关缝：`MEDIABASE_NO_BROWSER` · `MEDIABASE_CHROME_ARGS` · `MEDIABASE_CHROME`。

## 许可

自有代码 MIT。不要把 GPL 引擎二进制打进本仓的默认分发物。
