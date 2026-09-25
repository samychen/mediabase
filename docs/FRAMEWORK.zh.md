# mediabase 能否当通用基础框架？（诚实评估）

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

> 一句话:**迁仓后它已经是可复用的中立基座** —— 底座包 + 组合机制 + 自注册能力面齐备,
> 当年评估里"要当通用底座还差一层抽象"的那层,**就是第 3 节 B/C 两条路线,现已落地**;
> 剩下的都是细节深化与外部条件(第 5 节)。

本仓**已经是**抽出的中立基座（`@mediabase/*`）。阅读顺序:第 1 节 = 可直接复用的面,
第 2 节 = "曾绑定业务、现已抽离"的对照,第 3 节 = 三条路线为什么这么选,第 5 节 = 最近一次实测。
下文若仍出现「还绑在 avstudio」「抽 avstudio-base」这类措辞,只在引用迁仓前的判断时成立;
引擎/领域动词以消费仓为准,可复用约定以根 `AGENTS.md` 与 `docs/HANDOFF.zh.md` 为准。

## 1. 可直接复用的部分(范式 + 底座代码)

**范式(跨项目可搬)**
- 分层:React UI ↔ cordis 宿主 ↔ **独立 C++ 媒体进程**(实时媒体不进 JS);
  控制面(WS JSON-RPC)与数据面(HTTP 字节)分离;
- DSH 式工程约定:真 `@deepseek-ai/cordis`、`packages/<face>/<capability>`、
  `tsconfig.{host,client,test}` 三平面、插件 = `name/inject/Config/apply`、
  `ctx.reflect.provide` + fiber 生命周期、`ctx.effect` 可逆副作用、service
  config 走组合层注入。

**底座代码(可抽出复用;以下均为本仓当前实存路径)**

- `packages/base/rpc`(`@mediabase/rpc`):JSON-RPC 客户端/服务端 + 通知推送 + 带码错误(通用)
- 宿主子进程范式:`packages/base/engine-client`(`@mediabase/engine-client`)提供**纯线协议传输** +
  **流式会话**(sopen/sread/sseek/EOF)+ 崩溃不传染宿主;媒体动词(probe/decode/session)已下放
  消费仓(`@avstudio/media/engine.ts`),本仓只传线、不含动词
- `packages/host/server`(`@mediabase/server`):纯组合层;静态 + WS 路由 + 事件广播骨架在
  `packages/base/gateway`(`@mediabase/gateway`)
- `packages/host/plugins` 热加载(可跑子进程沙箱)、`packages/host/agent`:LLM 工具循环
  ——它自身不携带工具表,只规划 `ctx.tools` 暴露出来的能力,所以这两个是"能力无关"的通用层
- 测试骨架(`tests/`,含 `tests/support/host.ts`)、`pnpm doctor`、CI、
  `build:host`/`package` 打包流程

## 2. 曾绑定业务、现已抽离的部分（原评估项 → 现状）

| 现状 | 通用框架需要 |
|---|---|
| ~~服务/RPC 面写死,server 里手工映射~~ ✅ 已解:`ctx.api` 方法注册表 + `ctx.capabilities` manifest,能力自注册方法/路由/health/工具,server 只读注册表(基座组合实测 18 个方法,零硬编码);引擎线协议已有 `hello` 版本协商与崩溃监督重启;控制面有 `CONTROL_PROTOCOL_VERSION` 握手、方法级 ACL(`mutates` + 只读/黑白名单)与唯一审计点;运行时插件可跑在**独立子进程**沙箱里 | ✅ 已补:`@mediabase/confine` 权限限制(Node 权限模型 + OS 层,网络限制依平台如实上报) |
| ~~UI 是单页 `App.tsx`,面板全部内联~~ ✅ 已抽:壳层 `ui-web` 只渲染 `ctx.ui` 注册的面板(header/sidebar/monitor 三区),媒体核心在示例包 `ui-media` | 面板显隐/排序配置、更细的 slot 分区(标签页/口袋) |
| 数据面约定为 `/api/preview.rgb` + RGB24 canvas | 可插拔帧传输(WS/共享内存/GPU),传输策略由宿主决定 |
| ~~新能力 = 手写 插件+service+server RPC+client,重复且易漏~~ ✅ 已解:能力自注册方法/工具/路由/manifest,组合层只是一张表(支持 drop-in 目录与严格 verify);**客户端业务面板仍手写** | 由 schema 自动生成面板/表单(通用表单与「接口控制台」已做到,见第 5 节) |
| 引擎线协议动词(probe/decode/session)已随媒体能力下放消费仓,本仓不再定义这些动词 | 产品侧线协议自行版本化(约定见根 `AGENTS.md`:产品引擎线协议单独 bump) |
| 中文 UI 文案硬编码 | i18n |
| ~~配置只靠 env+localStorage~~ ✅ 已有 `ctx.settings`(宿主侧持久化,落盘 `${prefix}HOME/settings.json`,本仓默认 `~/.mediabase/settings.json`) | 仍可加:provider 可插拔、客户端侧同步 |
| 错误只有文本消息 | 错误码体系 + 统一日志/诊断 |
| 桌面壳/打包刚起步(electronDist 本地化、DMG 待出) | 每平台引擎矩阵 + 签名/公证/许可清单 |
| 测试依赖本机 ffmpeg 造 fixture + MediaComponent 检出 | 可注入 fixture provider,CI 已走回退路径 |

## 3. 三条"通用化"路线的结论

原文给出三条按投入递增的**候选**路线。迁仓后 **B、C 都已落地**,本节保留为"当时怎么权衡"的记录,
不再作为待选方案:

- **A. 直接 fork 改业务(最快)** —— **未采纳**。本仓已抽为中立基座,产品差异由消费仓的
  bundle/patch 层承载;需要 fork 基座才能改业务,说明抽象漏了,那是要修的信号而不是路线。
- **B. 抽公共底座(已完成,主体)** —— 产物就是 `packages/base/*`(rpc · schema · log ·
  protocol · engine-client · gateway · confine · shm)+ `packages/host/*` + `packages/client/*`;
  媒体/引擎动词下放消费仓(`@avstudio/media`),本仓不再含领域能力。
- **C. 对标 DSH 做真正的通用壳(已完成)** —— 组合 = bundle + patch 层(唯一路径)、
  `ctx.api` / `ctx.capabilities` 自注册与启动自检、`ctx.ui` 面板注册表
  (header/sidebar/monitor)、schema 生成表单、i18n、错误码体系均已具备。

仍未做完的已不是"路线",而是细节深化(更细的 slot 分区、面板显隐/排序配置、settings provider
可插拔、客户端侧设置同步等)。

## 4. 建议

- 把它当**已投产的中立基座**用:新产品 = 本仓 + 自己的 bundle/profile 层 + 自己的能力包,
  绝不 fork `profile-boot`,也不在 `@mediabase/*` 里 import 产品 scope。
- 未完成项以 `docs/STATUS.zh.md` 为准,规则以根 `AGENTS.md` 为准;本文只解释"为什么走到这一步"。

## 5. 现状快照(2026-09-20 实测复核)

**本轮实跑的结论(命令 → 结果):**

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | 三平面(`host`/`client`/`test`)全绿 |
| `pnpm run lint` | oxlint **0 警告 0 错误**(75 文件 / 70 规则) |
| `pnpm test` | **238 passed / 29 个测试文件** |
| `pnpm run verify:compose` | 2 个组合文件通过 |
| `pnpm run host` + `pnpm run verify:base` | **BASE OK**:外壳 / health / 控制面 / 注册表 / 能力声明 / 错误契约 / 跨源隔离姿态 12 项全通过 |
| `pnpm doctor` | 环境就绪(不可用项如实上报,如 OS 层网络限制) |

三处口径先纠正(原文有误或已过期):

- `verify:base` 是**对已在运行的宿主**做冒烟,**自己不启动宿主** —— 要先 `pnpm run host` 再跑它;
  本仓也**没有** `pnpm run verify` 这个脚本(只有 `verify:base` / `verify:compose` / `verify:ui`)。
- 原文那句"媒体动词 + 拉取/推送数据面"的检查属产品组合,已随媒体能力迁出本仓;
  基座冒烟只覆盖基座自己的契约。
- **本仓已无真实浏览器测试套件**:只剩没有任何测试引用的 `tests/support/browser.ts`;
  `MEDIABASE_NO_BROWSER` / `MEDIABASE_CHROME_ARGS` 目前无测试使用,直接 `pnpm test` 即全跑。

**已具备的面(以下沿用原文条目,数字按本轮实测校正):**

- **组合就是 bundle + patch 层(路线 C 完成;唯一路径)**:宿主由 profile 组合 ——
  `${prefix}HOME/profiles/<name>/` 声明 bundle 层(本仓默认 `~/.mediabase/profiles/<name>/`,
  profile 默认 `web`),层序 **bundle → profile → home → `--patch`**,
  后者按 id 覆盖前一层的整行 config(部署改一行不必 fork bundle);装载用 DSH 同款 vendored
  Loader+Include,机制在 `packages/host/boot/src/profile-boot.ts`(`@mediabase/boot`),行表在
  `packages/bundle/app/cordis.patch.yml`;旧的 TS 能力表与各能力的 `resolveConfig` 已删除,
  只剩这一条路径(组合面由 `tests/compose-yml.test.ts` 冻结守着)。
  基座组合的实测计数:**api 18 个方法 / tools 0 / 5 个能力 manifest / 2 个插件**
  (基座不含领域工具,所以 tools 是 0);精确清单与每行契约以生成的 `docs/CONFIG-CATALOG.md`
  为准,不在这里手写数字。
  阶段 2 起配置有契约:行在文件里给出配置(应用根 `!!js ctx.appPaths.root`,部署值经
  `ctx.env.str/num/flag/list` 从环境读入),能力用自己的 `Config` schema 校验(缺字段/类型错
  即启动失败并给出路径),启动收尾还会审计每个条目是否 ACTIVE(`assertEntriesActivated`,
  从 harness 移植)——`ctx.rowDefaults` 桥已删除,环境变量不再在 `apply` 里偷偷叠加。
  并加了组合门禁 `pnpm run verify:compose`(裸包名须能从所属清单解析、`!!js` 只能在
  `config`/`disabled`、覆盖的 id 必须存在)+ 运行时行预检(解析不到就点名行 id);
  drop-in 能力由 `packages/host/boot/src/dropins.ts`(`@mediabase/boot`)发现后合成一层 insert 行
- **路线 B 主体已完成**:中立底座包齐备 —— `@mediabase/rpc`(JSON-RPC+通知+带码错误,
  可带 `messageKey` 供客户端本地化)、`@mediabase/engine-client`(**已收敛为纯线协议传输**,
  probe/decode/session 等媒体动词下放到 `@avstudio/media/engine.ts`)、
  `@mediabase/gateway`(HTTP/WS 网关,`@mediabase/server` 已是纯组合层)、
  `@mediabase/protocol`(中立契约)、`@mediabase/schema`、`@mediabase/log`
- **门面已硬化**:WS 收包上限 / 连接预算 / 抛异常的插件只影响自己那一次请求、
  `close()` 优雅排空(WS 1001 道别 → 等在飞响应写完 → FIN → 最后关监听);
  顺序来自实测:Node 的 `server.close()` 把"响应仍在排队"的连接也算空闲,先关会截断响应
- **壳层已能力无关**:`@mediabase/ui-web` 只做「标题 + 渲染 `ctx.ui` 面板」,
  媒体核心迁入示例包 `@avstudio/ui-media`,连接徽标由 `ui-panels` 注册。
  `ctx.ui` 带 `subscribe`/`revision`,挂载后注册的面板立即渲染(jsdom 覆盖)
- **控制面已自注册**:`ctx.api`(方法/路由/health)+ `ctx.capabilities`(manifest + 启动自检);
  `@mediabase/server` 只读注册表、不含任何能力名;`RpcCode`/`RpcError` 让客户端按码分支;
  `ctx.log` 收口分级日志(含引擎/python stderr)
- 数据面已三态可插拔:拉取 + WS 二进制推送(背压丢帧)+ **共享内存环**
  (`@mediabase/shm`:零拷贝视图读取、满环丢最旧、句柄即 buffer;端到端的真实引擎帧验证在消费仓做,
  本仓只提供环与传输原语)
- 访问控制已落地到「本机信任边界」这一层:token 门禁、方法级 ACL(deny/allow/只读)、
  运行时插件最小权限(`requires`)、JS 运行时插件**进程级沙箱**(崩溃/卡死不影响宿主)+
  **权限限制**(`@mediabase/confine`:文件系统限声明根、禁子进程/worker,OS 层可用时禁网络;
  做不到的如实上报,可 fail closed)、唯一审计点(`ctx.api.call()` 打点)
- i18n 已外部化(每包自带字典 + 即时切换 + 覆盖守卫),错误码→文案表从 `RpcCode` 推导,
  宿主文案可带 key 由客户端按用户语言渲染;表单与「接口控制台」面板由 JSON Schema 生成
- 基座可本地打包(`pnpm run build:base` + `pnpm pack`,全包 `private: true`,**本仓库不发布**);
  `@mediabase/*` 每个包都有直接单测,且不依赖任何 `@avstudio/*`
- 桌面打包:Electron 壳可本地启动(`cd packaging/desktop-electron && pnpm start`,需带 GUI 的终端),
  DMG 出包待你本机确认
- 基座能力本轮清空;仍缺的都是产品侧接线(媒体面板接环)或外部条件(git/CI、DMG、
  去 fdk-aac 重建、真模型、浏览器内实测);OS 层**网络**限制依平台机制而定(如实标注)
  另有签名/公证,以及需要你或外部条件的三件事:git 基线 + 真实 CI 一次、
  Electron DMG 实测、引擎去 fdk-aac 后重建再分发
  (许可已定:自有代码 MIT + 分发物 GPL-3.0-or-later,见 `docs/GPL-COMPLIANCE.zh.md`)
