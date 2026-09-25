# C++ 工程师平行学习路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 C++ 工程师平行学习路径文档，并在现有学习路径 / README / HANDOFF / AGENTS 上加互链，不改 WALKTHROUGH。

**Architecture:** 保留 `docs/LEARNING-PATH.zh.md`（TS/React 读者）；新建 `docs/LEARNING-PATH.cpp.zh.md`（C++ 为主、弱前端）；编排按已批准 spec「方案 2」——JS 最短宿主路径后尽快接 C++，页面可选跳过。索引句只改引用点，正文结构不双份维护 WALKTHROUGH。

**Tech Stack:** Markdown 文档；无代码、无测试套件变更。验证手段为人工通读 + `rg` 链接/节号检查。

## Global Constraints

- 遵循 `docs/superpowers/specs/2026-09-17-learning-path-cpp-design.md`；不扩大范围
- **不改** `docs/WALKTHROUGH.zh.md`
- `CLAUDE.md` 是 `AGENTS.md` 的符号链接 —— **只改 `AGENTS.md` 一次**
- 文风对齐现有 `LEARNING-PATH.zh.md`：过关标准可验证、命令可复制、中文简体
- **暂不 git commit**（用户明确要求）；计划中的 Commit 步骤一律跳过，直到用户另行要求
- NEVER PUBLISH / 不引入产品 scope；文档保持基座中立

## File Structure

| 文件 | 职责 |
|---|---|
| `docs/LEARNING-PATH.cpp.zh.md` | **新建**：C++ 平行轨全文（C0–C7 + 附录） |
| `docs/LEARNING-PATH.zh.md` | 文首加互链到 cpp 轨 |
| `README.zh.md` / `README.md` | 「第一次接触本仓」区分两条轨 |
| `docs/HANDOFF.zh.md` | 配套阅读补平行轨一行 |
| `AGENTS.md` | Adopting + 设计决策索引两处注明平行轨 |
| `docs/WALKTHROUGH.zh.md` | 不改 |
| `docs/superpowers/specs/2026-09-17-learning-path-cpp-design.md` | 已存在；实现时可将状态改为「已批准 / 实现中」，可选 |

---

### Task 1: 撰写 `LEARNING-PATH.cpp.zh.md`

**Files:**
- Create: `docs/LEARNING-PATH.cpp.zh.md`
- Modify: （无）
- Test: 无自动化测试；本任务结束时文件存在且含 C0–C7 与四个附录标题

**Interfaces:**
- Consumes: spec `2026-09-17-learning-path-cpp-design.md`；WALKTHROUGH 节号 §0–§12（以仓内文件为准）
- Produces: 完整平行轨文档，供 Task 2 互链目标路径 `docs/LEARNING-PATH.cpp.zh.md`

- [ ] **Step 1: 写入完整文件**

用 Write 工具创建 `docs/LEARNING-PATH.cpp.zh.md`，内容必须如下（可微调措辞，但阶段编号、过关标准、WALKTHROUGH 节引用、可选跳过 C6 不可删）：

```markdown
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
| C1 | TS/Node 最小对照（够改能力包） | 本文附录 E；可选仓外术语卡 | 读 `packages/host/server/src/index.ts` | 能解释 `name`/`inject`/`Config`/`apply` | 1–2 小时 |
| C2 | 四个心智模型（C++ 类比） | `AGENTS.md` 前半 · `docs/FRAMEWORK.zh.md` · `docs/CONFIG-CATALOG.md` | `--dump-config`、`LOG_LEVEL=debug`、`READONLY=1` | 换端口改数据不改代码 | 1–2 小时 |
| C3 | 计算器到 JS 后端跑通（最短宿主路径） | `docs/WALKTHROUGH.zh.md` §0–§6、§8 · `../calculator` | 身份/入口/能力包/一行 bundle + `call` | 返回 14 / `backend=js` | 半天 |
| C4 | C++ 子进程 + 行协议（本轨核心） | WALKTHROUGH §7、§10 · `@mediabase/engine-client` | 直喂协议；宿主切 cpp；`verify` | 三后端结果一致 | 半天 |
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

**做**：打开 `packages/host/server/src/index.ts`，找到 `name` / `inject` / `Config` / `apply`。  
可选：若工作根目录有与本仓平级的 `../dsh-术语速查卡.md`，可并行读 cordis 五概念；**没有就跳过**（本轨不依赖仓外文件）。

**过关**：能用自己的话说明四件套各干什么（不必默写）。

---

## 阶段 C2 · 心智模型（1–2 小时）

**读**（按序）：`AGENTS.md` 的「The one layering rule」与「Conventions」；`docs/FRAMEWORK.zh.md`；`docs/CONFIG-CATALOG.md`。

| 概念 | C++ 直觉 | 去看 |
|---|---|---|
| **一切皆插件** | 带 Init 的模块 + 固定导出符号 | `packages/host/server/src/index.ts` |
| **组合是数据** | 链接脚本：后层按 `id` **整行替换** `config` | `packages/bundle/app/cordis.patch.yml` |
| **身份决定词表** | 编译期宏前缀（env / 家目录名） | `apps/cli/src/identity.ts` |
| **控制面 ≠ 数据面** | 控制口令走 `/rpc`；字节走 pull/push/shm | `packages/base/gateway` · `packages/base/shm` |

**做**：

```sh
pnpm run host -- --dump-config
MEDIABASE_LOG_LEVEL=debug pnpm run host
MEDIABASE_READONLY=1 pnpm run host
```

**过关**：想换端口 —— 改 patch 数据（按 `id: server` 覆盖），不改 server 源码。

---

## 阶段 C3 · 计算器最短宿主路径（半天）★

**读**：`docs/WALKTHROUGH.zh.md` §0–§6、§8。§7（多后端）本阶段**不展开**，点到「后端可换」即可。参考实现：`../calculator`。

**做**：按 WALKTHROUGH §1–§6、§8 建 workspace、身份、薄入口、能力包、一行 bundle；先 `--dump-config` 再启动；`pnpm run call '2*(3+4)'`（在 calculator 仓）。

三条纪律：错误带 `RpcCode`；副作用进 `ctx.effect`；边界靠 schema/握手，不靠口头约定。

**过关**：`{"value":14,"backend":"js"}`；故意拼错 `CALC_BACKEND` 宿主不崩（`choice`）；坏表达式得到 `-32602`。

---

## 阶段 C4 · C++ 子进程与行协议（半天）★ 本轨核心

**读**：WALKTHROUGH §7、§10；理解 `@mediabase/engine-client` 只提供线协议原语。

**做**（在 calculator 仓）：

1. `pnpm run build:cpp`，再直喂协议，例如：  
   `printf 'hello\neval\t1+2*3\n' | ./backends/cpp/calc`
2. 经宿主切到 cpp 后端（环境变量或等 C5 用 patch）
3. `pnpm run verify`：同一批表达式三后端结果一致
4. 分清：**排队 / 超时 / 死亡拒答** = 基座 `engine-client`；**重启退避等策略** = 产品能力包（见 `AGENTS.md`）

**过关**：能说明「后端忘了 flush → 调用方等到超时」；能指出监督策略不应写进基座。

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
pnpm test                     # MEDIABASE_NO_BROWSER=1 可跳过浏览器
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
```

- [ ] **Step 2: 确认关键锚点存在于文件中**

Run:

```sh
rg -n '^## 阶段 C[0-7]|^## 附录 [A-E]' docs/LEARNING-PATH.cpp.zh.md
```

Expected: 恰好 8 个阶段标题（C0–C7）与 5 个附录标题（A–E）。

- [ ] **Step 3: 核对 WALKTHROUGH 节引用**

Run:

```sh
rg -n 'WALKTHROUGH §|§[0-9]+' docs/LEARNING-PATH.cpp.zh.md
```

Expected: C3 引用 §0–§6、§8；C4 引用 §7、§10；C5 引用 §6、§9（及可选 §11）；C6 引用 §12。仓内 `docs/WALKTHROUGH.zh.md` 确有对应 `## N.` 标题（§0–§12 均存在）。

- [ ] **Step 4: Commit —— 跳过**

用户要求暂不 commit。不要执行 `git commit`。

---

### Task 2: 互链与索引

**Files:**
- Modify: `docs/LEARNING-PATH.zh.md`（文首引用块）
- Modify: `README.zh.md`（「第一次接触本仓」条目）
- Modify: `README.md`（同上英文/中英条目）
- Modify: `docs/HANDOFF.zh.md`（配套阅读段）
- Modify: `AGENTS.md`（Adopting this base + Where design decisions live；勿单独改 `CLAUDE.md`）
- Test: `rg LEARNING-PATH.cpp` 在上述文件均有命中

**Interfaces:**
- Consumes: Task 1 产出的路径 `docs/LEARNING-PATH.cpp.zh.md`
- Produces: 从主路径 / README / HANDOFF / AGENTS 可达的平行轨入口

- [ ] **Step 1: 改 `docs/LEARNING-PATH.zh.md` 文首**

在开篇 `>` 引用块中、读者说明之后插入一行互链（保持引用块连贯）。将文首改为：

```markdown
# mediabase 学习路径（初学者版）

> 目标读者：第一次接触本基座的开发者。已经会 TypeScript（Node 侧）与基本的 React；
> **不需要**任何 C++ / 音视频 / 媒体领域知识 —— 本基座刻意不含引擎，学习它不涉及媒体细节。
>
> 以 C++ 为主、几乎无前端经验：请走平行轨 [`docs/LEARNING-PATH.cpp.zh.md`](./LEARNING-PATH.cpp.zh.md)
> （尽快接到子进程后端；页面整段可跳过）。
>
> 学习方法只有一条：**每读一节，就在终端里跑一次**。本基座的全部机制都能在
> `http://127.0.0.1:3088` 上摸到，文档里出现的输出都是实测产出。
```

- [ ] **Step 2: 改 `README.zh.md`**

将「第一次接触本仓」那一行替换为：

```markdown
- **第一次接触本仓**：
  - 已会 TypeScript / 基本 React → `docs/LEARNING-PATH.zh.md`
  - 以 C++ 为主、弱前端 → `docs/LEARNING-PATH.cpp.zh.md`
```

- [ ] **Step 3: 改 `README.md`**

将对应「第一次接触本仓」行替换为：

```markdown
- **第一次接触本仓**：
  - Already comfortable with TypeScript / basic React → `docs/LEARNING-PATH.zh.md`
  - C++-first, little frontend → `docs/LEARNING-PATH.cpp.zh.md`
```

- [ ] **Step 4: 改 `docs/HANDOFF.zh.md` 配套阅读**

将第 5–6 行附近改为：

```markdown
配套阅读：`README.md`（快速开始）、`docs/FRAMEWORK.zh.md`（架构取舍；产品相关段落见文首说明）、
`docs/LEARNING-PATH.zh.md`（分阶段学习路径；已会 TS/React）、
`docs/LEARNING-PATH.cpp.zh.md`（C++ 为主、弱前端的平行轨）。
```

- [ ] **Step 5: 改 `AGENTS.md` 两处**

（1）`## Adopting this base` 首段改为同时点名两条轨，例如：

```markdown
## Adopting this base

`docs/LEARNING-PATH.zh.md` is the staged on-ramp for newcomers who already know
TypeScript (Node) and basic React: seven stages (environment → mental model → the
calculator tutorial → composition overrides → child-process backends → a page →
product adoption), each naming what to read, what to run, and how to tell it worked.
C++-first engineers with little frontend should use the parallel track
`docs/LEARNING-PATH.cpp.zh.md` instead (minimal TS prep, C++ subprocess earlier,
UI optional). Keep both stage lists and the doc index true when docs move.
```

（2）在「Where design decisions live」列举学习路径处，改为同时列出两份，例如：

```markdown
`docs/HANDOFF.zh.md` (adoption checklist), `docs/LEARNING-PATH.zh.md` /
`docs/LEARNING-PATH.cpp.zh.md` (staged on-ramps for newcomers), `docs/CONFIG-CATALOG.md`
```

不要编辑 `CLAUDE.md`（它是指向 `AGENTS.md` 的 symlink）。

- [ ] **Step 6: 验证互链命中**

Run:

```sh
rg -n 'LEARNING-PATH\.cpp' docs/LEARNING-PATH.zh.md README.zh.md README.md docs/HANDOFF.zh.md AGENTS.md
```

Expected: 每个文件至少 1 处命中；`AGENTS.md` 至少 2 处。

- [ ] **Step 7: Commit —— 跳过**

用户要求暂不 commit。

---

### Task 3: 终检与 spec 状态

**Files:**
- Modify (optional): `docs/superpowers/specs/2026-09-17-learning-path-cpp-design.md`（状态行改为「已批准并落地」）
- Test: 下列检查命令全部通过

**Interfaces:**
- Consumes: Task 1–2 全部改动
- Produces: 可交付的文档集（未 commit）

- [ ] **Step 1: 确认未改 WALKTHROUGH**

Run:

```sh
git diff --name-only docs/WALKTHROUGH.zh.md
```

Expected: 空输出（无改动）。

- [ ] **Step 2: 断链抽查**

Run:

```sh
test -f docs/LEARNING-PATH.cpp.zh.md && test -f docs/LEARNING-PATH.zh.md
rg -n 'LEARNING-PATH\.(zh|cpp)\.zh\.md' README.zh.md README.md docs/HANDOFF.zh.md AGENTS.md docs/LEARNING-PATH.zh.md docs/LEARNING-PATH.cpp.zh.md
```

Expected: 两个学习路径文件存在；引用路径拼写无 `LEARNING-PATH.cpp.zh.zh.md` 之类笔误。

- [ ] **Step 3: 对照 spec 覆盖清单（人工）**

打开 `docs/superpowers/specs/2026-09-17-learning-path-cpp-design.md`，确认每条交付物已落地：

| Spec 交付物 | 落地位置 |
|---|---|
| 新建 cpp 轨 | `docs/LEARNING-PATH.cpp.zh.md` |
| 主路径互链 | `docs/LEARNING-PATH.zh.md` 文首 |
| AGENTS 索引 | `AGENTS.md` 两处（CLAUDE 经 symlink 自动一致） |
| README 中/英 | `README.zh.md` · `README.md` |
| HANDOFF 指针 | `docs/HANDOFF.zh.md` |
| 不改 WALKTHROUGH | `git diff` 为空 |

- [ ] **Step 4（可选）: 更新 spec 状态行**

将 spec 头部 `状态：待用户审阅` 改为 `状态：已批准；文档已落地（未 commit）`。

- [ ] **Step 5: Commit —— 跳过**

用户要求暂不 commit。完成后向用户报告改动文件列表，询问是否开始 commit 或还要改文案。

---

## Self-Review (plan author)

**Spec coverage:**
- 平行轨全文 / 互链 / AGENTS+README+HANDOFF / 不改 WALKTHROUGH / C0–C7 顺序与可选 C6 / C++→TS 附录 → 均有 Task
- 「成功标准 2–3 天」是文档声称，非本 plan 可自动化验证 → Task 1 正文已写入该声称

**Placeholders:** 无 TBD；Commit 步骤显式「跳过」而非空承诺

**Consistency:** 路径统一为 `docs/LEARNING-PATH.cpp.zh.md`；CLAUDE 仅经 symlink；WALKTHROUGH 节号与仓内 `## 0.`–`## 12.` 一致
