# 设计：C++ 工程师平行学习路径

日期：2026-09-17  
状态：已批准；文档已落地（未 commit）  
相关：`docs/LEARNING-PATH.zh.md`（保留）、拟新建 `docs/LEARNING-PATH.cpp.zh.md`

## 背景与目标

现有 `docs/LEARNING-PATH.zh.md` 默认读者已会 TypeScript（Node）与基本 React，并写明「不需要 C++」。  
本设计服务另一类读者：**以 C++ 为主、能读简单 TS、不熟 Node/pnpm、几乎无前端经验**。

**终点（用户选定 B）**：能搭完整产品栈——身份 + 能力包 + C++ 后端；页面可后补或照抄教程。

**文档策略（用户选定 B）**：保留现有初学者路径；新增平行轨并互链。

**阶段编排（用户选定方案 2）**：环境与最小 TS → 心智模型 → 计算器 **JS 最短路径** → **尽快接 C++ 子进程** → 组合覆盖 → 页面可选跳过 → HANDOFF。

## 非目标

- 不把本轨改成「只学引擎边界」的短路径（那是被否的方案 3）
- 不重写 `docs/WALKTHROUGH.zh.md` 正文结构（避免双份教程漂移；平行轨用「读 §x、跳过 §y」引用）
- 不教 React/CSS/Vite 原理；不把本仓变成 TS 教程全书
- 不删除或挤占现有 `LEARNING-PATH.zh.md`

## 文档交付物

| 动作 | 路径 | 内容 |
|---|---|---|
| 新建 | `docs/LEARNING-PATH.cpp.zh.md` | C++ 平行轨全文（阶段表、C0–C7、C++→TS 附录、与主线对照） |
| 修改 | `docs/LEARNING-PATH.zh.md` | 文首读者说明旁加互链 |
| 修改 | `AGENTS.md` / `CLAUDE.md` | 「Adopting this base」中注明存在 C++ 平行轨，索引保持为真 |
| 修改 | `README.zh.md` / `README.md` | 「第一次接触本仓」处区分两条轨 |
| 修改 | `docs/HANDOFF.zh.md` | 文首学习路径指针补平行轨一行 |
| 不改 | `docs/WALKTHROUGH.zh.md` | 仅被引用 |

## 阶段总表

| 阶段 | 学会什么 | 主材料 | 过关标准 | 预计 |
|---|---|---|---|---|
| C0 | 环境、pnpm 最小词汇、启动宿主 | INSTALL · README | `verify:base` 绿；说清 `dev` vs `host` | 45–60 分 |
| C1 | TS/Node 最小对照（够改能力包） | 文内「C++→TS」附录；可选仓外术语卡 | 能解释 `apply`/`inject`/`Config` | 1–2 小时 |
| C2 | 四个心智模型（C++ 类比） | AGENTS 前半 · FRAMEWORK · CONFIG-CATALOG | 换端口改数据不改代码 | 1–2 小时 |
| C3 | 计算器到 JS 后端跑通（最短宿主路径） | WALKTHROUGH §0–§6、§8 | `call` → 14 / `backend=js` | 半天 |
| C4 | C++ 子进程 + 行协议（本轨核心） | WALKTHROUGH §7、§10 · engine-client | 直喂协议；三后端 verify 一致 | 半天 |
| C5 | 组合覆盖 | WALKTHROUGH §6/§9 · compose 测试 | dump 指出覆盖来源；整行替换语义 | 2–3 小时 |
| C6 | 页面（可选，可跳过） | WALKTHROUGH §12 | 跳过不算失败；照抄则浏览器跑通一次 | 0 或 1 天 |
| C7 | 采纳为产品 | HANDOFF 全文 | 身份+bundle+能力+引擎边界清楚；`verify:compose` | 按产品 |

与现有主线：C0≈0，C1=新增预备，C2≈1，C3≈2 前半，C4≈4（提前），C5≈3，C6≈5，C7≈7。主线阶段 6（读内部）本轨不强制，需要时链回。

必修：C0–C5；C6 默认跳过；C7 按采纳需要。整体不含页面约 **2–3 天**。

## C0 · 环境

**教**：Node ≥ 20、pnpm；交付形态 = 源码 + 工具链。五条命令：`install` / `dev` / `host` / `host -- --dump-config` / `verify:base`。  
`package.json` scripts ≈ CMake target；workspace ≈ 多包仓；`private: true` = 不发布。  
说明全新检出无 `apps/web/dist` 时只 `host` → `GET /` 404，应用 `dev` 或先 `build:web`。

**不教**：npm/yarn、Vite、React、浏览器调试进阶。

**过关**：`verify:base` 绿；回答「页面几乎为空」——中性基座无领域面板。

## C1 · TS/Node 最小集（本轨新增）

自包含附录「C++→TS 对照表」，不依赖仓外文件；若存在 `../dsh-术语速查卡.md` 可并行，没有则跳过。

| 必会 | 不教 |
|---|---|
| `import`/`export`、相对路径带 `.ts` | 泛型体操、装饰器 |
| `type`/`interface` | React / JSX / CSS |
| `async`/`await`；抛 `RpcError` | Promise 全家桶 |
| 读 `Config` 默认值与对象字面量 | 自研模块架构 |
| 读懂 `apply(ctx, config)` + `inject` | 手写 cordis |
| 改 YAML 一行 `config` 与短 `!!js` | 前端构建链 |

**过关**：打开 `packages/host/server/src/index.ts`，用自己的话指出四件套职责。

## C2 · 心智模型

| 概念 | C++ 直觉 | 文件 |
|---|---|---|
| 一切皆插件 | 带 Init 的模块 + 固定导出 | `packages/host/server/src/index.ts` |
| 组合是数据 | 链接脚本；后层按 id 整行替换 | `packages/bundle/app/cordis.patch.yml` |
| 身份决定词表 | 编译期宏前缀 | `apps/cli/src/identity.ts` |
| 控制面 ≠ 数据面 | 控制口令 vs 字节管道 | gateway + shm |

零代码实验：`--dump-config`、`LOG_LEVEL=debug`、`READONLY=1`。

## C3 · JS 最短宿主路径

照抄 WALKTHROUGH §0–§6、§8（§0 为导读）；§7 本阶段不展开。  
纪律：`RpcCode`、`ctx.effect`、边界校验。  
过关：`{"value":14,"backend":"js"}`；错误 `CALC_BACKEND` 不崩；坏表达式 `-32602`。

## C4 · C++ 子进程（核心）

1. 编译并 `printf` 直喂行协议（一行一响应 / flush）  
2. 宿主切到 `backend: cpp`  
3. calculator `verify` 三后端一致  
4. 分清：engine-client 给排队/超时/死亡拒答；重启退避属产品能力  

过关：说明忘 flush → 超时；监督策略不进基座。

## C5 · 组合覆盖

profile patch 整行替换；dump 看覆盖来源；读 `compose-yml` / `env-prefix` / `dump-config` 测试当规格。  
用 patch 固定 `backend: cpp` 与端口。  
过关：字段「丢失」= 整行替换语义。

## C6 · 页面（可选）

默认跳过且不算失败。若做：只指向 WALKTHROUGH §12 + HANDOFF 二.6，警告 roster / `distIndex` / 装完回基座 `pnpm install` 等坑，不展开前端课。

## C7 · 采纳

HANDOFF 六步；引擎在产品侧；页面可后。分发原生二进制前读 LICENSING / GPL-COMPLIANCE。  
过关：能画出「产品拥有引擎、基座只给线协议原语」。

## 平行轨文内必备附录

1. **与主线阶段对照表**（上文映射）  
2. **C++→TS 最小对照表**（C1）  
3. **命令速查**（指向本仓 + 注明 `call`/`verify` 在 `../calculator`）  
4. **常见坑**（可复用主线附录 C 中与宿主/子进程相关的行；前端坑标「仅 C6」）

## 成功标准（本设计落地后）

- C++ 读者按平行轨约 2–3 天（不含 C6）可到：calculator 身份 + 能力 + cpp verify 绿 + 会写一层 patch  
- 全文不假设会 React；TS 仅「最小对照 + 照抄」  
- 主线保留且互链清晰  
- `AGENTS.md` / README / HANDOFF 索引正确  

## 实现顺序（供后续 writing-plans）

1. 撰写 `LEARNING-PATH.cpp.zh.md`  
2. 给 `LEARNING-PATH.zh.md`、README（中/英）、HANDOFF、AGENTS/CLAUDE 加互链与索引句  
3. 通读一遍链接与阶段引用是否与 WALKTHROUGH 节号一致  

（实现计划在用户批准本 spec 后再写；本文件不代替最终学习路径正文。）

## 后续增补

- C1 辅助阅读：`docs/C1-server-walkthrough.zh.md`（server 四件套导读 + schema 短扫；由平行轨 C1 链接）。
