# mediabase 学习路径（C++ 工程师平行轨）

> 目标读者：以 **C++** 为主；能读简单 TypeScript，写起来慢；不熟 Node/pnpm；**几乎无前端经验**。
> 终点：能搭完整产品栈——**身份 + 能力包 + C++ 后端**；页面可后补或整段跳过。
>
> 若你已经会 TypeScript（Node）与基本 React，请走主路径：[`docs/LEARNING-PATH.zh.md`](./LEARNING-PATH.zh.md)。
>
> 学习方法：**每读一节，就在终端里跑一次**。本基座刻意不含引擎；C++ 出现在**产品/教程的子进程后端**，不在基座包里。

## 学习地图

| 阶段 | 你学会什么 | 主要材料 | 动手任务 | 过关标准 | 预计用时 |
|---|---|---|---|---|---|
| C0 | 装环境、pnpm 最小词汇、启动宿主 | `README.zh.md` · `docs/INSTALL.zh.md` | `pnpm install` → `pnpm run dev` → `verify:base` | 冒烟全绿；说清 `dev` vs `host` | 45–60 分钟 |
| C1 | TS/Node 最小对照（够改能力包） | 附录 E · [`C1-server-walkthrough.zh.md`](./C1-server-walkthrough.zh.md) | 按导读读 server，再短扫 schema | 能解释 `name`/`inject`/`Config`/`apply` | 1–2 小时 |
| C2 | 四个心智模型（机制优先，C++ 类比只当拐杖） | `AGENTS.md` 前半 · `docs/FRAMEWORK.zh.md` §1/§3 · `docs/CONFIG-CATALOG.md` 挑 3 行 | 四个实验：`--dump-default-config` vs `--dump-config`、`PORT` vs `MEDIABASE_PORT`、`verify:base` 戳三入口、`READONLY`/`LOG_LEVEL` | 四问全答得出（见 C2 末） | 1–2 小时 |
| C3 | 计算器到 JS 后端跑通（最短宿主路径） | `docs/WALKTHROUGH.zh.md` §0–§6、§8 · `../calculator` | 身份/入口/能力包/一行 bundle + `call` | 返回 14 / `backend=js` | 半天 |
| C4 | C++ 子进程 + 行协议（本轨核心） | WALKTHROUGH §7、§10 · `@mediabase/engine-client` · `../calculator/scripts/verify.mjs` | 直喂协议（含坏输入）；删 `flush` 复现超时；`CALC_BACKEND=cpp` 起宿主；`pnpm run verify` | 三后端对 7 个表达式逐个一致（退出码 0） | 半天 |
| C5 | 组合覆盖：改配置不改代码 | WALKTHROUGH §6、§9 · `tests/compose-yml.test.ts` | profile patch 固定后端与端口 | dump 指出「被谁覆盖」 | 2–3 小时 |
| C6 | 加一个页面（**可选，可跳过**） | WALKTHROUGH §12 · `docs/HANDOFF.zh.md` §二.6 | 照抄四件事或跳过 | 跳过不算失败；照抄则浏览器跑通一次 | 0 或 1 天 |
| C7 | 采纳为产品 | `docs/HANDOFF.zh.md` 全文 | 身份 + bundle + 能力 + 引擎边界 | `verify:compose`；能画出引擎归属 | 按产品而定 |

**必修 C0–C5**；C6 默认跳过；C7 在真正采纳时做。不含页面约 2–3 天。
主线阶段 6（通读 `packages/*`）本轨不强制，需要时见 [`LEARNING-PATH.zh.md`](./LEARNING-PATH.zh.md) 阶段 6。

与主线对照见附录 A。

---

## 阶段 C0 · 环境与第一次启动（45–60 分钟）

**读**：`README.zh.md`、`docs/INSTALL.zh.md`（交付 = 源码 + 工具链，不是一键安装器）。

**pnpm 最小词汇（对照 C++）**：

| 词 | 直觉 |
|---|---|
| `package.json` 的 `scripts` | ≈ CMake / Ninja 的具名 target |
| pnpm workspace | ≈ 多包 monorepo（一个仓多个库） |
| `private: true` | 包不发布到公共 npm |

**做**：

```sh
pnpm install
pnpm run dev             # = build:web + host，http://127.0.0.1:3088
pnpm run verify:base     # 另开终端：外壳 + health + 控制面 + 注册表
```

全新检出没有 `apps/web/dist/`（gitignore）时，只跑 `pnpm run host` 则 `GET /` 会 404（宿主仍可用）。需要页面时用 `dev`，或 `pnpm run build:web && pnpm run host`。

**不教**：npm/yarn 选型、Vite/React、浏览器调试进阶。

**过关**：`verify:base` 全绿；能回答「为什么页面上几乎没有东西？」（中性基座没有领域能力面板。）

---

## 阶段 C1 · TS/Node 最小集（1–2 小时）

目标不是学会 TypeScript，而是**能读懂并小改**能力包与 YAML patch。对照表见**附录 E**。

**读**：[`docs/C1-server-walkthrough.zh.md`](./C1-server-walkthrough.zh.md)（带行号：server 四件套 + schema 短扫）。  
可选：若工作根目录有与本仓平级的 `../dsh-术语速查卡.md`，可并行读 cordis 五概念；**没有就跳过**（本轨不依赖仓外文件）。

**做**：按导读打开 `packages/host/server/src/index.ts`，再短扫 `packages/base/schema/src/index.ts` 的 `z` / `parse` / `SchemaError`；答完导读末尾三问。

**过关**：能用自己的话说明四件套各干什么（不必默写）。

---

## 阶段 C2 · 心智模型：四个概念（1–2 小时）

**这一节的目标不是"读懂架构"，而是跑出四个可观察的现象，再回头看概念。**
下面每个概念都配三样东西:**一句话机制**、**一个真实文件**、**你该看到什么**。
C++ 类比只当拐杖 —— 它有时会骗你(例如"身份"不是编译期宏,是**运行时**注入),以机制为准。

**读**（按序，别通读）：
1. `AGENTS.md` 的「The one layering rule」与「Conventions」—— 全部约定的源头；
2. `docs/FRAMEWORK.zh.md` 第 1 节(可直接复用的面)与第 3 节(为什么这么分层)；
3. `docs/CONFIG-CATALOG.md` —— **生成物**,每行(row)一个配置契约,基座共 **7 行**;
   不要通读,只看 `log` / `agent` / `server` 三行,注意每行**只有 `config`,没有行为**。

| 概念 | **它说的是什么**（白话） | 看这个文件 | 你会看到什么 |
|---|---|---|---|
| **一切皆插件** | 一个能力就是一个模块,导出 `name` / `inject` / `Config` / `apply(ctx, config)`;`apply` 里只**登记**(方法挂进 `ctx.api`、面板挂进 `ctx.ui`),不写业务死名 | `packages/host/server/src/index.ts` | 它把 handler 登记进 `ctx.api`,自己**不含任何能力名** |
| **组合是数据** | **装什么、参数是什么,不由代码决定,由一张 YAML 表决定**。启动 = 按顺序读几层表 → 逐行按 `name` import → 调 `apply` | `packages/bundle/app/cordis.patch.yml`(基座的表,7 行) | 每行只有 `id` / `name` / `config`,**没有 import、没有代码** |
| **身份决定词表** | 代码里只写**短名**(`TOKEN` / `READONLY`),**前缀由一个 4 字段对象决定**,所以同一套包换个产品不用改代码 | `apps/cli/src/identity.ts`,对照 `../calculator/apps/cli/src/identity.ts` | 两个文件唯一的差别就是那 4 个字段的**值** |
| **控制面 ≠ 数据面** | 两种流量、两条通道:**命令与状态**走 WS `/rpc`(小、一问一答、必须可靠);**字节**走 `GET /api/<name>` / `WS /stream` / 共享内存环(大、连续、可丢帧) | `packages/base/gateway` · `tests/shm-transport.test.ts` | 启动那行日志同时报三个计数器:`ws /rpc 18 方法, ws /stream 0 通道, /api/* 0 条数据面路由` |

**这三个概念最容易卡住的地方（先看这段，再跑下面的实验）**

**① "组合是数据"** —— `--dump-config` 报 `layers: 2` **并不代表有两处被改过**:第二层(profile 文件)
默认就是一个**空数组 `[]`**。"2 层"说的是**读过两个文件**。一次真正的覆盖长这样(WALKTHROUGH §9),
而且 dump 会直接标出**谁赢了**:

```yaml
# == …/packages/bundle/app/cordis.patch.yml, patched by …/profiles/web/cordis.patch.yml
- id: calc
  config:
    root: !!js ctx.appPaths.root
    backend: cpp        # 没被重述的字段会「缺席」→ 交给 Config 默认值兜底,不是报错
```

**② "身份决定词表"** —— "词表"就是这张**映射**;同一行代码,两个部署读到的变量完全不同:

| 行里写的 | 基座(mediabase) | 消费仓(calculator) |
|---|---|---|
| `ctx.env.str('TOKEN')` | `MEDIABASE_TOKEN` | `CALC_TOKEN` |
| `ctx.env.flag('READONLY')` | `MEDIABASE_READONLY` | `CALC_READONLY` |
| `ctx.appPaths.bin`(日志 scope) | `mediabase` | `calc` |
| 状态目录 | `~/.mediabase/` | `$CALC_HOME`(默认 `~/.calc/`) |
| `ctx.env.rawNum('PORT')` | `PORT` | `PORT` ← **例外:不带前缀** |

为什么有这个例外:`raw*` 表示"这个变量属于**环境**"(一套部署只该有一个 `PORT`,所以不前缀),
`str/num/flag/list/choice` 才表示"**本 app 的词表**"。`tests/env-prefix.test.ts` 还禁止"两个前缀都认":
换了前缀,旧前缀必须立刻失效。

**③ "控制面 ≠ 数据面"** —— 一句话判据:**像素/音频字节永远不许进 `/rpc`**。基座不含引擎,所以数据面
在基座里唯一能看到实体的地方是测试:`tests/shm-ring.test.ts`(`hands a VIEW of the shared buffer,
not a copy`、`drops the OLDEST frame when full`)与 `tests/shm-transport.test.ts`。
C++ 类比这次是**成立**的:控制面 ≈ 写 MMIO 寄存器(小、同步、有应答);数据面 ≈ DMA 环形缓冲
(大、连续、满了丢最旧)——你不会把一帧 4K 图像塞进寄存器写。

**做**（四个实验,都不写代码;每条都给出"该看到什么"）：

```sh
# 实验 1 · 组合是数据:对比"只有 bundle"与"又叠了 profile 层"
pnpm run host -- --dump-default-config   # 看头部:# layers: 1 —— 只有基座 bundle
pnpm run host -- --dump-config           # 看头部:# layers: 2 —— 多出 ~/.mediabase/profiles/web/cordis.patch.yml
#   再盯 `- id: server` 那一行:port: !!js ctx.env.rawNum('PORT')
#   "换端口"就落在这一行,不在 server 的源码里 —— 这就是"改数据不改代码"

# 实验 2 · 身份决定词表:同一个端口,加不加前缀的差别
PORT=3214 pnpm run host                  # 生效:这一行读的是环境自己的 PORT(rawNum 不加前缀)
MEDIABASE_PORT=3214 pnpm run host        # 不生效:这一行读不到它
#   规律:前缀属于"部署词表"(TOKEN / READONLY / LOG_LEVEL 这类短名),
#   而 PORT 是环境自己的变量 —— 一套部署只该有一个,所以既不前缀、也不接受两者
#   (见 `docs/DEPENDENCIES.zh.md`;`tests/env-prefix.test.ts` 明确禁止"两个都认")

# 实验 3 · 控制面 vs 数据面:三个入口各是什么
pnpm run verify:base                     # 另开终端(宿主需在运行);它会逐个戳这些入口并打印结果:
#   GET / 外壳 · GET /api/health · ws://127.0.0.1:3088/rpc 控制面

# 实验 4 · 策略在哪一层生效:只读与审计
MEDIABASE_READONLY=1 pnpm run host       # mutates 方法被拒,错误码 -32021
MEDIABASE_LOG_LEVEL=debug pnpm run host  # 每次 ctx.api.call() 打一行审计
```

`host` 是前台常驻进程,看完 **Ctrl-C** 收工;`--dump-*` 不启动宿主,跑完自己退出。

**过关**（能答出这四问即可,不必背）：

1. 想给宿主换端口,改代码还是改数据? → **改数据**:patch 里按 `id: server` 整行覆盖 `port`;
   只想临时跑一次,`PORT=3214` 也行(注意它是**不带前缀**的,见实验 2)。
   —— C5 会亲手做这次覆盖。
2. 为什么 `--dump-default-config` 是 1 层、`--dump-config` 是 2 层? → 后者叠加了 profile 层;
   层越多,后层越能按 `id` 覆盖前层。
3. 行里写 `ctx.env.str('TOKEN')`,实际读的环境变量叫什么? → `MEDIABASE_TOKEN`
   (前缀来自 `BootIdentity`;同一个基座换个身份就是另一套词表)。
4. 一帧视频该走哪个入口? → **数据面**(pull/push/shm),不是 `/rpc`。

---

## 阶段 C3 · 计算器最短宿主路径（半天）★

**读**：`docs/WALKTHROUGH.zh.md` §0–§6、§8。§7（多后端）本阶段**不展开**，点到「后端可换」即可。参考实现：`../calculator`。

**做**：按 WALKTHROUGH §1–§6、§8 建 workspace、身份、薄入口、能力包、一行 bundle；先 `--dump-config` 再启动；`pnpm run call '2*(3+4)'`（在 calculator 仓）。

三条纪律：错误带 `RpcCode`；副作用进 `ctx.effect`；边界靠 schema/握手，不靠口头约定。

**过关**：`{"value":14,"backend":"js"}`；故意拼错 `CALC_BACKEND` 宿主不崩（`choice`）；坏表达式得到 `-32602`。

---

## 阶段 C4 · C++ 子进程与行协议（半天）★ 本轨核心

**一句话**:后端是**独立进程**,与宿主之间只有一条**行协议**;基座给的是"把这条线说清楚"的原语
(`@mediabase/engine-client`)——**排队 / 超时 / 进程死亡时拒绝在途调用**是它的职责,
而**重启 / 退避 / 上限**这类监督策略属于产品能力包,**不许**塞进基座。

**读**:WALKTHROUGH §7(同一套行协议)、§10(把不变式固定成脚本)。

**协议只有两条**(一行一请求一响应,`\t` 分隔):

| 请求 | 响应 |
|---|---|
| `hello` | `ok\tcalc-cpp` |
| `eval\t<表达式>` | `ok\t<数值>` 或 `err\t<原因>` |

**做 1 · 先单独喂后端**（不需要宿主;在 `../calculator`）：

```sh
cd ../calculator
pnpm run build:cpp     # = bash backends/cpp/build.sh(一条 g++ -O2 -std=c++17,零依赖)
printf 'hello\neval\t1+2*3\neval\t(1+2)*3.5\neval\t1+(\n' | ./backends/cpp/calc
```

**该看到**（本轨实测）:

```text
ok	calc-cpp
ok	7
ok	10.5
err	表达式不完整          ← 坏输入转成 err,进程不崩
```

这条命令**全程没有宿主参与** —— 这就是"后端是独立进程"最直接的证据。

**做 2 · 三个自己可复现的观察**：

```sh
# 观察 A · 坏输入不许弄死后端(最后一行仍应答 = 它还活着)—— 本轨实测
printf 'hello\neval\t@@@\nhello\n' | ./backends/cpp/calc
#   ok	calc-cpp
#   err	无法解析第 1 个字符
#   ok	calc-cpp

# 观察 B · 忘 flush = 调用方一直等到超时
#   先看 backends/cpp/calc.cpp 里那一行:
#     std::cout << handle(line) << '\n' << std::flush;   // 行协议:必须立刻 flush
#   把 std::flush 删掉、重编、再喂同一条 printf:stdout 接管道时是全缓冲,
#   后端"算完了"但字节没出门,宿主的 call() 只能等到超时
#   (WALKTHROUGH §7 在 Python 后端上记的就是这个坑)

# 观察 C · 经宿主切到 cpp 后端(两条路;第二条留给 C5 固化成部署默认)
CALC_HOME=$PWD/.calc CALC_BACKEND=cpp PORT=3213 pnpm run host
```

**做 3 · 把不变式变成脚本**（不是靠眼睛看）：

```sh
pnpm run verify        # = node scripts/verify.mjs
```

**该看到**（本轨实测:退出码 0,13 项检查）:

```text
✓ js / python / cpp: 生效的后端是它自己        {"active":"…","available":["js","python","cpp"]}
✓ js / python / cpp: 7 个表达式都算出来了      7, 10.5, 12.5, 6, 12, 6, -3
✓ js / python / cpp: 坏表达式返回 INVALID_PARAMS  -32602
✓ python 的结果与 js 逐个相同
✓ cpp    的结果与 js 逐个相同
CALC OK — JS / Python / C++ 三个后端的结果逐个一致。
```

前置条件:**python3 可用**(它依次跑三个后端,不是只跑 C++)。

**顺手看一眼** `scripts/verify.mjs` 的头注释:它**复用基座**的 `scripts/lib/host-rpc.mjs`
(`connect` / `checker`),唯独 URL 前缀自己拼 —— 因为基座那个 `hostUrl()` 读的是 `MEDIABASE_`,
而这里词表是 `CALC_`。**这是 C2 第 3 条的现场版:身份决定词表,连基座给的工具都得跟着换。**

**过关**：

1. 能口述「后端忘了 flush → 调用方等到超时」的因果 —— 不是"它坏了",是字节没出门;
2. 能指出监督策略(重启/退避/上限)**不应**写进基座,理由:基座不拥有你的进程;
3. `pnpm run verify` 退出码 0(三后端结果逐个一致)。

---

## 阶段 C5 · 组合与覆盖（2–3 小时）

**读**：WALKTHROUGH §6、§9、§11；`AGENTS.md` 中 patch 层是唯一组合路径一节。

**做**：写 `$CALC_HOME/profiles/.../cordis.patch.yml`，按 `id` **整行替换** `config`（必须重述需要的字段）；用 dump 看「被谁覆盖」；建议在此把 `backend: cpp` 与端口写进 patch。

把测试当说明书：`tests/compose-yml.test.ts`、`tests/env-prefix.test.ts`、`tests/dump-config.test.ts`。

**过关**：覆盖后字段「丢了」是整行替换语义，不是 bug。

---

## 阶段 C6 · 页面（可选，默认跳过）

**默认：跳过。跳过不算本轨失败。**

若必须做 UI：只跟 WALKTHROUGH §12 + `docs/HANDOFF.zh.md` §二.6 照抄；本轨**不教** React。已知坑：workspace 要含 `client/*`、装完回基座 `pnpm install`、`distIndex` 勿写相对路径、改文案后要 `build:web`、名册生成器需自备。

**过关（若做）**：页面能算一次；无 LLM key 时聊天框显示带码错误（如 `-32002`）也算前端过关。

---

## 阶段 C7 · 采纳为产品

**读**：`docs/HANDOFF.zh.md` 全文；分发原生二进制前读 `docs/LICENSING.zh.md`、`docs/GPL-COMPLIANCE.zh.md`。

**做**：身份 → 产品 bundle（叠在 `@mediabase/bundle-app` 之后）→ 能力包 → **产品引擎（你的主场）** → 工具链 → 页面（可后）。两边 `pnpm run verify:compose`。

**过关**：能画出「产品拥有引擎进程；基座只给线协议原语」；中立性约束心里有数（`tests/handoff-neutrality.test.ts`）。

---

## 附录 A · 与主线阶段对照

| 本轨 | 主线 `LEARNING-PATH.zh.md` |
|---|---|
| C0 | ≈ 阶段 0（本轨多给 pnpm 词汇） |
| C1 | 主线无（TS 预备） |
| C2 | ≈ 阶段 1 |
| C3 | ≈ 阶段 2 前半（到 JS 跑通） |
| C4 | ≈ 阶段 4（提前到组合之前） |
| C5 | ≈ 阶段 3 |
| C6 | ≈ 阶段 5（可选） |
| C7 | ≈ 阶段 7 |
| （按需） | 阶段 6 读内部 |

## 附录 B · 文档索引

| 文档 | 何时读 |
|---|---|
| `README.zh.md` · `docs/INSTALL.zh.md` | C0 |
| `docs/C1-server-walkthrough.zh.md` | C1（server + schema 导读） |
| `AGENTS.md` | C2 起；遇事回查 |
| `docs/FRAMEWORK.zh.md` · `docs/CONFIG-CATALOG.md` | C2 |
| `docs/WALKTHROUGH.zh.md` | C3–C6 |
| `docs/HANDOFF.zh.md` | C6（若做）、C7 |
| `docs/LEARNING-PATH.zh.md` | 需要读内部或你已会 TS/React 时 |
| `docs/LICENSING.zh.md` · `docs/GPL-COMPLIANCE.zh.md` | 分发前 |

## 附录 C · 命令速查

```sh
pnpm run host -- --dump-config
MEDIABASE_LOG_LEVEL=debug pnpm run host
MEDIABASE_READONLY=1 pnpm run host
pnpm run verify:base && pnpm run verify:compose
pnpm test                     # 29 文件 / 238 用例;本仓已无浏览器套件,直接跑即可
```

`pnpm run call` / `pnpm run verify` / `pnpm run verify:page` 属于 `../calculator`，不在本仓。

## 附录 D · 常见坑（宿主 / 子进程）

| 症状 | 原因与解法 |
|---|---|
| `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` | workspace glob 写宽了；改成显式包路径 |
| 「组合行无法从安装锚点解析」 | 能力包缺 `main`/`types`/`exports`，或未进锚点 `dependencies` |
| 覆盖后字段「丢了」 | 整行替换 `config`；重述字段或依赖 `Config` 默认值 |
| `spawn failed` | 脚本未 `chmod +x`，或 C++ 未编译 |
| 调用一直超时 | 后端忘了 `flush`；行协议一行一响应 |
| `GET /` 404 | 未 `build:web` / 未用 `dev`（仅 C0） |
| `GET /` 403 | `distIndex` 写了相对路径（仅 C6） |
| 页面文案没变 | 改完需重新 `build:web`（仅 C6） |

## 附录 E · C++ → TypeScript 最小对照

| TypeScript / Node | C++ 直觉 |
|---|---|
| `import` / `export`，相对路径带 `.ts` | `#include` + 翻译单元导出；本仓约定扩展名写全 |
| `type` / `interface` | 头文件里的结构/概念约束 |
| `async` / `await` | 协程式异步；失败时抛 `RpcError`（带码），不要只抛字符串 |
| `Config` 默认值对象 | 结构体默认成员 |
| `apply(ctx, config)` | 模块 Init：注册方法/服务，生命周期跟 fiber |
| `inject: ['api', …]` | 硬依赖：依赖未就绪则 fiber 等待 |
| `ctx.effect(() => () => cleanup())` | RAII / 析构登记；子进程与定时器必须走这里 |
| YAML 行 + `!!js ctx.env.str('X')` | 部署期配置；短名由 `BootIdentity` 加前缀 |
| `ctx.env.choice` vs `str` | choice：非法值 → 默认（typo 不崩）；str：缺席即缺席 |

**刻意不教**：泛型体操、装饰器、React/JSX/CSS、Vite 原理、Promise 细节全书。
