# mediabase 学习路径（初学者版）

> 目标读者：第一次接触本基座的开发者。已经会 TypeScript（Node 侧）与基本的 React；
> **不需要**任何 C++ / 音视频 / 媒体领域知识 —— 本基座刻意不含引擎，学习它不涉及媒体细节。
>
> 学习方法只有一条：**每读一节，就在终端里跑一次**。本基座的全部机制都能在
> `http://127.0.0.1:3088` 上摸到，文档里出现的输出都是实测产出。

## 学习地图

| 阶段 | 你学会什么 | 主要材料 | 动手任务 | 过关标准 | 预计用时 |
|---|---|---|---|---|---|
| 0 | 装环境、启动宿主、跑冒烟 | `README.zh.md` · `docs/INSTALL.zh.md` | `pnpm install` → `pnpm run dev` → `verify:base` | 浏览器打开外壳页，冒烟全绿 | 30 分钟 |
| 1 | 四个核心概念（心智模型） | `AGENTS.md` 前半 · `docs/FRAMEWORK.zh.md` · `docs/CONFIG-CATALOG.md` | `--dump-config`、`LOG_LEVEL=debug`、`READONLY=1` | 能说出"一行(row)"是什么、由谁校验 | 1–2 小时 |
| 2 | 核心教程：照抄一遍计算器（宿主侧） | `docs/WALKTHROUGH.zh.md` §0–§8 · `../calculator` | 建 workspace、写身份/入口/能力包/一行 bundle | `pnpm run call '2*(3+4)'` 返回 14 | 半天–1 天 |
| 3 | 组合与覆盖：改配置不改代码 | WALKTHROUGH §6 · §9 · `tests/compose-yml.test.ts` | 写一层 profile patch，覆盖端口与后端 | `--dump-config` 能指出"被谁覆盖" | 2–3 小时 |
| 4 | 子进程后端 + 验证脚本 | WALKTHROUGH §7 · §10 | 跑通 Python / C++ 后端与 `verify.mjs` | 三个后端结果逐个一致 | 2–3 小时 |
| 5 | 加一个页面（前端） | WALKTHROUGH §12 · `docs/HANDOFF.zh.md` §二.6 | client 包 + `client.yml` 名册 + Vite app | 真浏览器渲染、计算、AI 聊天框各走一次 | 1 天 |
| 6 | 读懂基座内部（按需） | `packages/*` 源码 + `tests/*`（推荐顺序见下） | 每个包读完跑它对应的测试 | 能向别人解释 `ctx.api.call()` 的一次调用链 | 2–3 天（可选） |
| 7 | 采纳为产品 | `docs/HANDOFF.zh.md` 全文 | 身份 + bundle + roster + `PRODUCT` 块 | `verify:compose` 两边全绿 | 按产品而定 |

阶段 0–2 是必修主线；3–5 按"要不要做页面/子进程"选学；6–7 进阶。

---

## 阶段 0 · 环境与第一次启动（30 分钟）

**读**：`README.zh.md`（快速开始）、`docs/INSTALL.zh.md`（交付形态：源码 + 工具链，不是一键安装器）。

**做**：

```sh
pnpm install
pnpm run dev             # = build:web + host，http://127.0.0.1:3088
pnpm run verify:base     # 另开一个终端：外壳 + health + 控制面 + 注册表
```

注意用 `pnpm run dev`：`apps/web/dist/` 是 gitignore 的，全新检出里还没有静态页，
只跑 `pnpm run host` 时 `GET /` 会是 404（宿主照常工作，只是没有页面）。
只想跑一次构建可以用 `pnpm run build:web && pnpm run host`。

浏览器打开 `http://127.0.0.1:3088`：你会看到一个"空但能用"的外壳（标题 + 面板区）。
这正是基座中立的体现 —— 它只渲染 `ctx.ui` 注册了的面板，自己不命名任何媒体能力。

**过关**：`verify:base` 全绿；能回答"为什么页面上几乎没有东西？"
（答：因为中性基座没有领域能力面板。）

---

## 阶段 1 · 心智模型：四个核心概念（1–2 小时）

**读**（按序）：

1. `AGENTS.md` 的「The one layering rule」与「Conventions」两节 —— 这是全部约定的源头；
2. `docs/FRAMEWORK.zh.md` —— 本仓的架构取舍与现状快照；
3. `docs/CONFIG-CATALOG.md` —— 生成物：每一行(row)的配置契约，共 7 行；
4. 完全没接触过 cordis / TypeScript 偏弱：并行读附录 E 的两份外部预备材料。

**四个概念，配四个真实文件去看**：

| 概念 | 一句话 | 去看这个文件 |
|---|---|---|
| **一切皆插件** | 能力 = `name` / `inject` / `Config` / `apply(ctx, config)` | `packages/host/server/src/index.ts`（最干净的正例） |
| **组合是数据** | 宿主 = 一张行表：bundle 层 → profile 层 → home 层 → `--patch`，后者按 id 整行覆盖 | `packages/bundle/app/cordis.patch.yml`（基座自己的行表） |
| **身份决定词表** | `BootIdentity` 给出 `bin`/`envPrefix`/`homeDir`/`profileKey`；行里只写短名，前缀由身份拼 | `apps/cli/src/identity.ts`（4 个字段决定全套词表） |
| **控制面 ≠ 数据面** | WS `/rpc` 只走命令与状态；字节走 pull/push/共享内存，绝不进 WS 控制面 | `packages/base/gateway` + `packages/base/shm` 的 README/源码头注释 |

**做**（三个实验，都在不写任何代码的情况下体验机制）：

```sh
pnpm run host -- --dump-config      # 不启动，打印组合出来的行表 —— 组合写错时第一个看这里
MEDIABASE_LOG_LEVEL=debug pnpm run host   # 看每次 ctx.api.call() 的审计点
MEDIABASE_READONLY=1 pnpm run host  # 只读模式：mutates 方法被拒（-32021）
```

**过关**：能回答 —— 想给宿主换端口，该改代码还是改数据？（改数据：一层 patch 按 `id: server`
覆盖，见 `docs/CONFIG-CATALOG.md` 的 `server` 行；阶段 3 会亲手做。）

---

## 阶段 2 · 核心教程：照抄一遍计算器（半天–1 天）★ 全路径最重要的一步

**读**：`docs/WALKTHROUGH.zh.md` §0–§8 —— 一条**可以照抄**的路径：在基座旁边新建
`calculator` 项目，把"计算"做成 JS / Python / C++ 三种可互换后端。参考实现就在
`../calculator`（与本仓平级），每一步落在基座哪个机制上都写明了。

**做**（对应 WALKTHROUGH 的节号）：

1. §1 建 workspace：把基座当"旁边的包"，`pnpm-workspace.yaml` 只列真正用到的 glob
   （这条是实测踩出来的，别写宽）；
2. §2 写身份：`apps/cli/src/identity.ts`，全部 4 个字段；
3. §3 写薄入口：给身份、给 anchor、说清启动结果、优雅退出 —— 就这四件事；
4. §4 写能力包：`name` / `inject` / `Config` / `apply`，注册 `calc.eval` 与 `calc.backends`
   两个方法（注意 `package.json` 必须有 `main`/`types`/`exports` 入口声明）；
5. §5 写一行 bundle：`cordis.patch.yml` 里 `insert` 一行，`!!js` 从 `ctx.env` / `ctx.appPaths`
   读部署值；
6. §6 先 `--dump-config` 再启动 —— 养成这个顺序；
7. §8 启动 + 调用：`pnpm run host` 后用 `pnpm run call '2*(3+4)'`（该命令属于 calculator 仓），
   或任何 WS 客户端直连 `ws://127.0.0.1:<port>/rpc` 发 JSON-RPC。

三条纪律随教程一起练：错误带 `RpcCode`；副作用全进 `ctx.effect`；边界靠握手验证而不是约定。

**过关**：`calc.eval` 返回 `{"value":14,"backend":"js"}`；故意把 `CALC_BACKEND=cppp` 拼错，
宿主照常启动（`choice` 的语义：拼错回落到默认值，不崩）；把表达式改坏，拿到 `-32602`
而不是一段要人猜的文案。

---

## 阶段 3 · 组合与覆盖：改配置不改代码（2–3 小时）

**读**：WALKTHROUGH §6（dump）、§9（换后端的两条路）、§11（常见坑表）；
`AGENTS.md` 的「Patch layers are the ONLY composition path」一节。

**做**（命令都在阶段 2 建的 calculator 仓里跑；换成基座自己时把 `pnpm run dump` 写全为
`pnpm run host -- --dump-config`）：

```sh
# 一次运行：环境变量
CALC_BACKEND=python PORT=3214 pnpm run host

# 一套部署：编辑 $CALC_HOME/profiles/web/cordis.patch.yml（"用户会改的那个文件"）
#   - id: calc
#     config:            # 覆盖是【整体替换 config】—— 必须重述需要的每个字段
#       root: !!js ctx.appPaths.root
#       backend: cpp
pnpm run dump          # --dump-config 会指出该行"被谁覆盖"
```

**把测试当说明书读**（本基座的习惯：测试冻结行为，读测试就是读规格）：

- `tests/compose-yml.test.ts` —— 冻结了组合后的表面：少一行、漏一个 env 钮都会红；
- `tests/env-prefix.test.ts` —— 词表只有 ONE prefix，没有"两个都认"的兼容层；
- `tests/dump-config.test.ts` —— `--dump-config` 与真实启动走同一个 `planComposition`。

**过关**：能解释 —— 覆盖行之后某个字段"丢了"，是 bug 还是语义？（语义：整行替换；
要么重述该字段，要么依赖 `Config` 默认值。）

---

## 阶段 4 · 子进程后端与验证脚本（2–3 小时，选学：不做子进程可跳过）

**读**：WALKTHROUGH §7（同一套行协议）、§10（把不变式固定成脚本）。

**做**：

1. 先 `pnpm run build:cpp` 编译 C++ 后端，再直接喂协议给它，体会 `@mediabase/engine-client`
   的 `call()` 约定：`printf 'hello\neval\t1+2*3\n' | ./backends/cpp/calc`；
2. 跑 `pnpm run verify`（calculator 仓）：同一批表达式问三个后端，结果必须逐个相同；
3. 理解分工：**排队/超时/死亡拒答是基座给的**（`@mediabase/engine-client`）；
   **重启退避等策略是产品定的**（`AGENTS.md`："the policy belongs to the product capability"）。

**过关**：Python 后端忘了 `flush` 会发生什么？（调用方等到超时 —— 行协议必须一行一响应。）

---

## 阶段 5 · 加一个页面（1 天，选学：要 UI 必学，坑最多）

**读**：WALKTHROUGH §12 全节（含"四件事"）+ `docs/HANDOFF.zh.md` 二.6；再读
`packages/bundle/ui/client.yml`（基座自己的名册：connection → i18n → ui → 壳最后）。

**做**（对应 WALKTHROUGH §12 的动作清单）：

1. 客户端包：`ctx.ui.register` 一个面板；**文案全部进 `messages.ts`（zh-CN + en）**，
   组件里不留字符串（`tests/i18n-coverage.test.ts` 守着）；
2. 名册一行：`client.yml`，**壳 `@mediabase/ui-web` 必须最后一行**；
3. Vite app + 自己一份名册生成器（基座那份写死了 `@mediabase/bundle-ui`）；
4. `pnpm run gen:ui-roster && pnpm run build:web && pnpm run host`，然后 `verify:page`
   用无头 Chrome 真浏览器走一遍。

四个必踩的坑（教程里都有实测输出）：工作区要加 `client/*`（装完回基座跑一次
`pnpm install` 还原链接）；`distIndex` 要么不写要么写绝对路径（相对路径 → `GET /` 直接
403）；改了影响文案的东西必须重新 `build:web`；名册生成器要自己复制一份改两处。

**过关**：页面渲染、算一个表达式、AI 聊天框收到一条回复（没配 key 时是带码错误
`-32002` —— 这也算过，前端正确渲染了错误即达标；配 `CALC_LLM_KEY=sk-…` 即有真答案，
后端就是基座自带的 `agent.run`，一行不用写）。

---

## 阶段 6 · 读懂基座内部（2–3 天，按需）

推荐顺序 = 依赖顺序，每个包读完立刻跑它对应的测试（测试就是可执行的规格）：

| 序 | 包 | 读什么 | 配套测试 |
|---|---|---|---|
| 1 | `packages/base/rpc` | JSON-RPC 客户端/服务端、`RpcError` + `hasRpcCode`（跨边界用结构检查） | `tests/protocol-rpc.test.ts` |
| 2 | `packages/base/schema` | 边界校验：`parse` 失败 → `INVALID_PARAMS` 带路径 | `tests/api-registry.test.ts` |
| 3 | `packages/base/log` | `ctx.log`、`child(scope)`、stderr 汇入 | `tests/log.test.ts` |
| 4 | `packages/base/gateway` | 前门：收包上限、连接预算、`close()` 先排空 WS(1001) 再关监听 | `tests/gateway.test.ts` · `tests/gateway-limits.test.ts` |
| 5 | `packages/host/api` | `ctx.api.register` / `ctx.api.call()`（唯一审计点、ACL 在此执行） | `tests/access-control.test.ts` |
| 6 | `packages/host/server` | 纯组合层：只读注册表，零能力名（它的行为由前门与组合两头的测试间接覆盖） | `tests/gateway.test.ts` · `tests/access-control.test.ts` · `tests/compose-yml.test.ts` |
| 7 | `packages/host/boot` | profile→bundle→patch 解析、`absolutizeRowSpecifiers`、`assertEntriesActivated` | `tests/composition-gate.test.ts` · `tests/capability-loading.test.ts` |
| 8 | `packages/host/plugins` + `packages/base/confine` | 运行时插件、进程沙箱、权限模型（probe by execution） | `tests/plugin-sandbox.test.ts` · `tests/plugin-confinement.test.ts` |
| 9 | `packages/host/settings` · `agent` | 运行时设置；AI 是基础设施：`agent.run` 只计划 `ctx.tools`，不写死任何能力 | `tests/settings.test.ts` · `tests/agent.test.ts` |
| 10 | `packages/base/shm` + `engine-client` | 共享内存环（SPSC、满环丢最旧）；线协议传输原语 | `tests/shm-ring.test.ts` · `tests/shm-transport.test.ts` |
| 11 | `packages/client/connection` → `i18n` → `ui` → `ui-web` | 断线排队/重连；错误码→文案；面板注册表；壳 | `tests/connection-rpc.test.ts` · `tests/i18n.test.ts` · `tests/ui-registry.test.ts` |

**过关**：能完整讲一遍"一次 `calc.eval` 调用"经过的层：
client `connection` → WS `/rpc`（gateway 收包上限/token）→ `ctx.api.call()`（ACL + 审计）→
方法 handler（schema 校验）→ 返回；以及每一层出错时错误以什么形态（码？key？）到达浏览器。

---

## 阶段 7 · 采纳为产品（进阶）

**读**：`docs/HANDOFF.zh.md` 全文（采纳顺序 + 有测试守着的中立性清单）、
`docs/LICENSING.zh.md` 与 `docs/GPL-COMPLIANCE.zh.md`（要分发原生二进制前必读）。

**做**（HANDOFF 的六步）：身份 → 组合（产品 bundle 叠在 `@mediabase/bundle-app` 之后）→
能力包 → （仅产品）引擎 → 工具链 → 页面。两边都跑 `pnpm run verify:compose`。
桌面壳只改 `packaging/desktop-electron/main.cjs` 顶部的 `PRODUCT` 块。

**过关**：`tests/handoff-neutrality.test.ts` 在你的产品仓里同样通过
（无机器路径、基座脚本不绑产品 scope、身份可配置）。

---

## 附录 A · 文档索引：什么时候读哪份

| 文档 | 是什么 | 什么时候读 |
|---|---|---|
| `README.zh.md` | 快速开始 + 包一览 | 第 0 阶段 |
| `docs/INSTALL.zh.md` | 交付形态与打包 | 第 0 阶段 |
| `AGENTS.md` | 全部约定的源头（规则集） | 第 1 阶段通读；此后遇事回来查 |
| `docs/FRAMEWORK.zh.md` | 架构取舍、现状快照 | 第 1 阶段 |
| `docs/CONFIG-CATALOG.md` | 生成的行契约（`pnpm run gen:config-catalog`） | 第 1、3 阶段；改行后必看 |
| `docs/WALKTHROUGH.zh.md` | **核心教程**：计算器全流程 | 第 2–5 阶段，逐节照抄 |
| `docs/HANDOFF.zh.md` | 产品采纳清单 | 第 5、7 阶段 |
| `docs/STATUS.zh.md` | 已测性质 vs 未完成项 | 第 1 阶段末尾快速过一遍 |
| `docs/DEPENDENCIES.zh.md` | 依赖面 | 需要时 |
| `docs/LICENSING.zh.md` · `docs/GPL-COMPLIANCE.zh.md` | 许可义务 | 分发前 |

## 附录 B · 概念速查表

| 术语 | 含义 |
|---|---|
| 插件 (plugin) | `name` / `inject` / `Config` / `apply(ctx, config)`，一切能力的形态 |
| 行 (row) | 组合表里的一个条目：`id` + 包名 + `config`；`id` 是覆盖的键 |
| bundle | 一个带 `cordis.patch.yml` 的包 = 一层组合；`@mediabase/bundle-app` 是基座行表 |
| profile | `$<prefix>HOME/profiles/<name>/`：声明用哪些 bundle 层 + 自己的 patch |
| patch 覆盖 | 后层按 `id` 整行替换前层的 `config`（不是合并 —— 必须重述需要的字段） |
| `!!js` | 行激活时对 loader 上下文求值的表达式：`ctx.appPaths` / `ctx.env` |
| 短名规则 | 行里写 `ctx.env.str('TOKEN')`，实际读 `<前缀>TOKEN`；前缀由 `BootIdentity` 决定 |
| `env.choice` vs `env.str` | `choice`：值不在集合内 → `undefined` → 默认值（typo 不崩）；`str`：未设置 → 字段缺席 |
| `ctx.api` | 方法/数据面路由/health 注册表；`ctx.api.call()` 是唯一审计点 |
| `ctx.capabilities` | 能力自述 manifest，`capabilities.verify()` 启动对账 |
| `ctx.tools` / `agent.run` | AI 是基础设施：agent 只计划 `ctx.tools` 暴露的工具，不写死能力 |
| `ctx.effect` | 可逆副作用登记：子进程/定时器/服务器/临时文件全走这里 |
| `ctx.reflect.provide` / `inject` | service 提供与硬依赖（fiber 等待、出现即重激活） |
| `RpcError` + `messageKey` | 错误带码可分支；`messageKey/Params` 让客户端按用户语言渲染细节 |
| 控制面 / 数据面 | `/rpc` 只走命令与状态；字节走 pull(`GET /api/<name>`) / push(`WS /stream`) / `@mediabase/shm` |
| `mutates: true` | 状态变更声明 → `READONLY=1` 策略可拒绝（-32021） |
| `BootIdentity` | `bin` / `envPrefix` / `homeDir` / `defaultProfile` / `profileKey`，产品词表的唯一来源 |

## 附录 C · 常见坑速查（全部实测）

| 症状 | 原因与解法 |
|---|---|
| `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` | workspace glob 写宽了（`bundle/*` 拉进 bundle-ui）；改成显式 `bundle/app` |
| 基座 UI 测试报 `useCallback` of null | 消费方的 install 把基座 `client/*` 的 react 链接改走了 → 回基座跑一次 `pnpm install` |
| 「组合行无法从安装锚点解析：行 "calc"」 | 能力包缺 `main`/`types`/`exports`，或没加进锚点 `dependencies` |
| 覆盖行之后某字段"丢了" | 覆盖整行替换 `config`；重述字段或依赖 `Config` 默认值 |
| `spawn failed` | Python 脚本没 `chmod +x`，或 C++ 没编译 |
| 调用一直等到超时 | 后端忘了 `flush`；行协议一行一响应 |
| `GET /` 返回 403 | `distIndex` 写了相对路径；要么不写（默认约定布局）要么绝对路径 |
| 页面文案没变 | 页面是静态包，改完要重新 `build:web` |
| `EPERM mkdir ~/.calc/…` | 状态目录不可写；用 `<前缀>HOME` 指到可写目录 |
| 启动失败看哪里 | 看日志最后缩进最深那几行：基座会把失败链打全（行名 + 原因） |

## 附录 D · 命令速查（本仓）

```sh
pnpm run host -- --dump-config   # 不启动，打印组合（排组合错第一步）
MEDIABASE_LOG_LEVEL=debug pnpm run host
MEDIABASE_READONLY=1 pnpm run host            # mutates 全拒
MEDIABASE_STRICT_CAPABILITIES=1 pnpm run host # 说谎的 manifest = 启动失败
MEDIABASE_ENV_PREFIX=EXPT_ pnpm run host      # 整体换词表（测试/嵌入）
pnpm run verify:base && pnpm run verify:compose
pnpm test                     # MEDIABASE_NO_BROWSER=1 跳过浏览器
pnpm run typecheck && pnpm run lint
pnpm run gen:config-catalog   # 改了行/Config 后重新生成（stale 会让 pnpm test 红）
```

注意：`pnpm run call` / `pnpm run verify`（三后端比对）/ `pnpm run verify:page`
属于教程参考实现 `../calculator`，不在本仓。

## 附录 E · 外部预备材料（不在本仓，按需）

本基座用**真 cordis**（`@deepseek-ai/cordis`）做组合，所以有几份上游材料对初学者有用。
它们与 `mediabase` 平级放在工作根目录下（不在本仓内 —— 本仓刻意不带任何产品/上游笔记）：

| 文件（与 `mediabase` 平级） | 是什么 | 什么时候读 |
|---|---|---|
| `../dsh-术语速查卡.md` | cordis 五大概念（plugin / ctx / inject / event / effect）+ 事件四种分发模式 + C++ 类比 | 阶段 1 之前或并行；`inject` / `ctx.effect` 第一次看不明白时先读它 |
| `../dsh-learning-plan.md` | 上游框架的八周学习计划，含 TypeScript 速成（C++ 视角对照表）与 cordis 官方教程主线 | 完全没接触过 cordis 或 TypeScript 偏弱时；已经会 TS 且读完本文阶段 1 的话可跳过 |

**读它们时的心态**：这两份讲的是**上游 DSH**，不是本仓。本仓的约定以 `AGENTS.md` 与
`docs/` 为准 —— 例如上游用 `@deepseek-ai/cordis` 的 loader/manifest，而本仓的组合是
**bundle + patch 层（唯一路径）**，且行表在 `packages/bundle/app/cordis.patch.yml`。
概念（插件形态、fiber 生命周期、`ctx.effect`）共通用；具体做法照本仓文档。
