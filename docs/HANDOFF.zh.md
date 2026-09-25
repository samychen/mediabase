# 产品如何采纳 mediabase（handoff）

本仓是**中立基座**，不是示例产品。消费仓（avstudio、小工具、你的新产品）叠身份、领域能力与（可选）原生引擎。

配套阅读：`README.md`（快速开始）、`docs/FRAMEWORK.zh.md`（架构取舍；产品相关段落见文首说明）、
`docs/LEARNING-PATH.zh.md`（分阶段学习路径；已会 TS/React）、
`docs/LEARNING-PATH.cpp.zh.md`（C++ 为主、弱前端的平行轨）。

**仓内实例**：`product/openvideo/` 是按本清单落地的产品层（agent 友好的视频剪辑器，
移植自 clawnify/OpenVideo，MIT）：产品 scope、身份、bundle 层、自己的名册生成器、
测试与冒烟一应俱全，基座零改动——采纳前可对照它的形状。

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

**工作区只列你真正用到的包**（`../mediabase/packages/{base,host,bundle/app}`；要页面时再加
`client/*`，别写 `bundle/*`）：`pnpm install` 会按**你的**工作区给这些包解析依赖，并把
**基座自己 `node_modules` 里的链接**改指到你的 store。动过之后回基座跑一次它自己的安装
（`cd ../mediabase && CI=true pnpm install --ignore-scripts`；若链接已被删掉，先清掉各包的
`node_modules` 再装）。基座 v0.1.6 起**启动**不再依赖这些链接（行的裸包名在挂载前按锚点解析成
绝对路径），但基座自己的测试仍然依赖。

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

### 6. 页面（要的话；这一段坑最多）

- 一个客户端包（`ctx.ui.register` 一个面板）+ 名册一行（`client.yml`，**外壳最后**）+ 一个 Vite app
- **名册生成器要自己一份**：基座的 `scripts/gen-client-roster.mjs` 写死了 `@mediabase/bundle-ui`
  与 `manifest.mediabase.uiBundle`
- **`distIndex` 要么不写**（默认 `<root>/apps/web/dist/index.html`），**要么写绝对路径** ——
  相对路径会被静态服务判为越界，`GET /` 直接 403
- 改了基座里影响页面文案的东西（i18n 字典、面板组件）要重新 `build:web`：页面是静态包
- AI 聊天框不必自己写后端：基座自带 `agent.run`（工具来自 `ctx.tools`）；没配 key 时前端显示
  带码错误，且文案里的变量名按你的身份前缀生成（`AVSTUDIO_LLM_KEY` / `CALC_LLM_KEY`）
- 完整动作与实测输出见 **`docs/WALKTHROUGH.zh.md` 第 12 节**

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
