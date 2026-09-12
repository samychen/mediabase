# 产品如何采纳 mediabase（handoff）

本仓是**中立基座**，不是示例产品。消费仓（avstudio、小工具、你的新产品）叠身份、领域能力与（可选）原生引擎。

配套阅读：`README.md`（快速开始）、`docs/FRAMEWORK.zh.md`（架构取舍；产品相关段落见文首说明）。

---

## 一、分层：基座 vs 产品

| | 内容 | 谁改 |
|---|---|---|
| **本仓（mediabase）** | `@mediabase/*`（base/host/client）· `@mediabase/boot` · 基座 bundle/roster · 中性 `apps/cli` / `apps/web` · Electron 通用壳 | ❌ 产品不 fork 这些实现 |
| **产品仓** | 产品 scope 包（如 `@avstudio/*`）· 产品 protocol · 引擎 / sidecar · 产品 bundle 层（叠在基座之后）· 产品 UI 面板 · 自己的 `BootIdentity` / `PRODUCT` | ✅ 产品拥有 |

**判据**：`@mediabase/*` **不允许依赖任何产品 scope**（`tests/handoff-neutrality.test.ts` + `build:base` 守着）。能力无关的放基座；领域动词、预览、引擎监督放产品。

---

## 二、采纳顺序（建议照做）

### 1. 身份（几分钟）

在产品入口传入 `BootIdentity`（或改本仓示例 `apps/cli/src/identity.ts` 做小工具）：

- `bin` / `envPrefix` / `homeDir` / `defaultProfile` / `profileKey`
- 基座默认：`mediabase` · `MEDIABASE_` · `.mediabase` · `mediabase.profile.bundles`
- 产品示例：`avstudio` · `AVSTUDIO_` · `.avstudio` · `avstudio.profile.bundles`（**故意**可这样配；基座代码不写死产品前缀）

桌面壳只改 `packaging/desktop-electron/main.cjs` 顶部的 **`PRODUCT` 块**（标题、`configDir`、`envPrefix`、`resources`）。基座模板的 `resources` **不含**引擎；产品自行追加。

### 2. 组合

- 产品 profile 的 `bundles` = `[mediabase bundle-app, 产品 bundle-app, …]`
- 产品层 `insert` 领域能力，并按需按 `id` 覆盖基座行（覆盖须**整份重写** `config`）
- UI roster：基座名册 + 产品追加；**壳 `@mediabase/ui-web` 必须最后**
- 门禁：两边都跑 `pnpm run verify:compose`

共享启动逻辑只从 **`@mediabase/boot`** 引用 — **禁止**复制 `profile-boot`。

### 3. 能力包（每个：一个包 + 一行）

- `Config`（`@mediabase/schema`）· 在声明该行的清单里写依赖
- `ctx.api.register` / `ctx.capabilities.register` / 可选 `ctx.ui` / `ctx.tools`
- 文案在 `messages.ts`；部署 env 用短名（`!!js ctx.env.str('TOKEN')` → `${前缀}TOKEN`）

### 4. 引擎（仅产品）

本仓**不**含 `engine/`。产品自行选择：无原生 / LGPL 自构建 / 接受 GPL 分发。基座只提供 `@mediabase/engine-client`（线协议传输，无领域动词）。

### 5. 工具链

- `pnpm run build:base` / `pnpm pack`（不 publish 公共 npm）
- `pnpm run notice` 生成归属（勿手改 `NOTICE.md`）
- 含原生二进制的分发义务在**产品仓**文档与门禁里处理

---

## 三、有测试守着的中立性

`tests/handoff-neutrality.test.ts`：

| 属性 | 断言 |
|---|---|
| 无机器绝对路径 | `scripts/**`、`packaging/**` 不含 `/Users/…`、`/home/…` |
| 基座脚本不绑产品 scope | doctor / verify.base / package / build-base 等不出现 `@avstudio/`；端口来自 env |
| 身份可配置 | Electron `PRODUCT` 块；默认前缀 `MEDIABASE_` |
| 基座不依赖产品 | `build:base`：import 产品 scope 即失败 |
| 无写死的 `.avstudio` 默认路径 | `packages/` 源码 |

另：`tests/base-packaging.test.ts`（`private: true`）、`tests/i18n-coverage.test.ts`。

---

## 四、本仓常用命令（基座视角）

| 命令 | 作用 |
|---|---|
| `pnpm run host` | 中性宿主（默认 `MEDIABASE_`） |
| `pnpm run verify:base` | 外壳 + health + 控制面 + 注册表 |
| `pnpm run verify:compose` | 组合门禁 |
| `pnpm run build:base` / `build:host` / `build:web` | 打包基元 / 封闭运行时 / 基座页 |
| `MEDIABASE_STRICT_CAPABILITIES=1 pnpm run host` | 清单对账失败即退出 |
| `MEDIABASE_READONLY=1 pnpm run host` | 拒绝 `mutates` 方法 |
| `MEDIABASE_NO_BROWSER=1 pnpm test` | 无浏览器 CI |

verify 脚本认 `MEDIABASE_URL` / `PORT` / `MEDIABASE_TOKEN`（产品换前缀后认自己的）。

---

## 五、交接上仍由维护者决定的事

1. **git / CI**：基座 tag 与消费仓 pin 策略（path 联调 vs pin tag）。
2. **分发**：本仓默认 MIT、无引擎；产品若捆绑 FFmpeg 链接物，自行选 GPL 路线并文档化。
