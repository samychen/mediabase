# mediabase 能否当通用基础框架？（诚实评估）

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

> 一句话:**当"参考实现 / 脚手架"用,今天就行;当"通用基础框架"直接拿去做第二个
> 产品,还差一层抽象。** 下文分三块:可直接复用的部分、还绑定在 avstudio 业务上的
> 部分、以及三条"通用化"路线。

本仓**已经是**抽出的中立基座（`@mediabase/*`）。下文若仍写「还绑在 avstudio」或「抽 avstudio-base」，视为迁仓前评估原文；引擎/领域动词以消费仓为准。可复用约定以根 `AGENTS.md` 与 `docs/HANDOFF.zh.md` 为准。

## 1. 可直接复用的部分(范式 + 底座代码)

**范式(跨项目可搬)**
- 分层:React UI ↔ cordis 宿主 ↔ **独立 C++ 媒体进程**(实时媒体不进 JS);
  控制面(WS JSON-RPC)与数据面(HTTP 字节)分离;
- DSH 式工程约定:真 `@deepseek-ai/cordis`、`packages/<face>/<capability>`、
  `tsconfig.{host,client,test}` 三平面、插件 = `name/inject/Config/apply`、
  `ctx.reflect.provide` + fiber 生命周期、`ctx.effect` 可逆副作用、service
  config 走组合层注入。

**底座代码(可抽出复用)**
- `packages/protocol/src/rpc.ts`:JSON-RPC 客户端/服务端 + 通知推送(通用)
- host 进程管理范式:`packages/host/media/src/engine.ts` 的子进程线协议客户端 +
  **流式会话**(sopen/sread/sseek/EOF)+ 崩溃不传染宿主
- `packages/host/server`:静态 + WS 路由 + 事件广播骨架(业务路由是示例)
- `@mediabase/plugins` 热加载、`@avstudio/workflow` recipe runner、`@mediabase/agent`
  LLM 工具循环——这三个本质上是"能力无关"的通用层
- 测试骨架(protocol/engine/host 集成)、`doctor`、CI、`build:host`/`package` 打包流程

## 2. 还绑在 avstudio 业务上、要通用必须抽离的部分

| 现状 | 通用框架需要 |
|---|---|
| ~~服务/RPC 面写死,server 里手工映射~~ ✅ 已解:`ctx.api` 方法注册表 + `ctx.capabilities` manifest,能力自注册方法/路由/health/工具,server 只读注册表(32 个方法零硬编码);引擎线协议已有 `hello` 版本协商与崩溃监督重启;控制面有 `CONTROL_PROTOCOL_VERSION` 握手、方法级 ACL(`mutates` + 只读/黑白名单)与唯一审计点;运行时插件可跑在**独立子进程**沙箱里 | ✅ 已补:`@mediabase/confine` 权限限制(Node 权限模型 + OS 层,网络限制依平台如实上报) |
| ~~UI 是单页 `App.tsx`,面板全部内联~~ ✅ 已抽:壳层 `ui-web` 只渲染 `ctx.ui` 注册的面板(header/sidebar/monitor 三区),媒体核心在示例包 `ui-media` | 面板显隐/排序配置、更细的 slot 分区(标签页/口袋) |
| 数据面约定为 `/api/preview.rgb` + RGB24 canvas | 可插拔帧传输(WS/共享内存/GPU),传输策略由宿主决定 |
| ~~新能力 = 手写 插件+service+server RPC+client,重复且易漏~~ ✅ 已解:能力自注册方法/工具/路由/manifest,组合层只是一张表(支持 drop-in 目录与严格 verify);**客户端面板仍手写** | 由 schema 自动生成面板/表单 |
| 引擎线协议动词(probe/decode/session)归 media 包,但**未版本化** | 协议版本化 + 描述文档(如 JSON-RPC schema/OpenAPI) |
| 中文 UI 文案硬编码 | i18n |
| ~~配置只靠 env+localStorage~~ ✅ 已有 `ctx.settings`(宿主侧持久化,落盘 `~/.avstudio/settings.json`) | 仍可加:provider 可插拔、客户端侧同步 |
| 错误只有文本消息 | 错误码体系 + 统一日志/诊断 |
| 桌面壳/打包刚起步(electronDist 本地化、DMG 待出) | 每平台引擎矩阵 + 签名/公证/许可清单 |
| 测试依赖本机 ffmpeg 造 fixture + MediaComponent 检出 | 可注入 fixture provider,CI 已走回退路径 |

## 3. 三条"通用化"路线(按投入递增)

- **A. 直接 fork 改业务(最快)**:把现有代码当起点,改服务名/路由/UI。适合"就是做
  一个类似 OBS+AI 的产品",不追求给第三方二次开发。
- **B. 抽"avstudio-base"公共底座(推荐)**:把 protocol(rpc+通知)、server 骨架、
  engine 子进程会话客户端、plugins/workflow/agent 层、打包脚本抽成与业务无关的
  `base/` 包并中立命名;`media/python/…` 降级为"示例能力包"。以后每个新产品 =
  底座 + 自己的能力包 + 自己的 UI。投入中等。
- **C. 对标 DSH 做真正的通用壳**:深化 Slot/UI 注册(已有 header/sidebar/monitor 三区
  注册表 + 热注册重绘,仍需更细 slot、显隐/排序配置与 slot props)、loader/manifest、schemastery
  校验、settings/i18n/错误码等基建(即把 DSH 的部分模式再搬一层)。投入最大,
  得到的是"框架级"通用层。

## 4. 建议

- 若目标是**沉淀一个你能反复用的起点**:先做 **B**(底座 + 示例包),这是性价比最高、
  也最符合"一切即插件"哲学的一步。
- 在 B 完成前,请把本仓库当 **"参考实现/脚手架"**,README 与本文档保持一致口吻。

## 5. 现状快照(2026-09-11 更新)

- typecheck 三平面全绿;lint 0 警告 0 错误;测试 **281 passed / 33 个文件**(含真实浏览器一套 8 个);
  `pnpm run verify:base`(外壳+health+控制面+注册表+能力声明)、`pnpm run verify`
  (媒体动词 + 拉取/推送数据面)、`pnpm doctor` 全部实跑通过
- **组合就是 bundle + patch 层(路线 C 完成;唯一路径)**:宿主由 profile 组合 ——
  `$AVSTUDIO_HOME/profiles/<name>/` 声明 bundle 层,层序 **bundle → profile → home → `--patch`**,
  后者按 id 覆盖前一层的整行 config(部署改一行不必 fork bundle);装载用 DSH 同款 vendored
  Loader+Include,机制在 `apps/cli/src/profile-boot.ts`,行表在
  `packages/bundle/app/cordis.patch.yml`;旧的 TS 能力表与各能力的 `resolveConfig` 已删除,
  只剩这一条路径(**api 37 / tools 6 / 8 个 manifest**,由 `tests/compose-yml.test.ts` 冻结守着)。
  阶段 2 起配置有契约:行在文件里给出配置(应用根 `!!js ctx.appPaths.root`,部署值经
  `ctx.env.str/num/flag/list` 从环境读入),能力用自己的 `Config` schema 校验(缺字段/类型错
  即启动失败并给出路径),启动收尾还会审计每个条目是否 ACTIVE(`assertEntriesActivated`,
  从 harness 移植)——`ctx.rowDefaults` 桥已删除,环境变量不再在 `apply` 里偷偷叠加。
  并加了组合门禁 `pnpm run verify:compose`(裸包名须能从所属清单解析、`!!js` 只能在
  `config`/`disabled`、覆盖的 id 必须存在)+ 运行时行预检(解析不到就点名行 id);
  drop-in 能力由 `apps/cli/src/dropins.ts` 发现后合成一层 insert 行
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
  (`@mediabase/shm`:零拷贝视图读取、满环丢最旧、句柄即 buffer;真实引擎帧已验证)
- 访问控制已落地到「本机信任边界」这一层:token 门禁、方法级 ACL(deny/allow/只读)、
  运行时插件最小权限(`requires`)、JS 运行时插件**进程级沙箱**(崩溃/卡死不影响宿主)+
  **权限限制**(`@mediabase/confine`:文件系统限声明根、禁子进程/worker,OS 层可用时禁网络;
  做不到的如实上报,可 fail closed)、唯一审计点(`ctx.api.call()` 打点)
- i18n 已外部化(每包自带字典 + 即时切换 + 覆盖守卫),错误码→文案表从 `RpcCode` 推导,
  宿主文案可带 key 由客户端按用户语言渲染;表单与「接口控制台」面板由 JSON Schema 生成
- 基座可本地打包(`pnpm run build:base` + `pnpm pack`,全包 `private: true`,**本仓库不发布**);
  `@mediabase/*` 每个包都有直接单测,且不依赖任何 `@avstudio/*`
- 桌面打包:Electron 壳已能本地启动(需带 GUI 的终端 `pnpm start`),DMG 出包待你本机确认
- 基座能力本轮清空;仍缺的都是产品侧接线(媒体面板接环)或外部条件(git/CI、DMG、
  去 fdk-aac 重建、真模型、浏览器内实测);OS 层**网络**限制依平台机制而定(如实标注)
  另有签名/公证,以及需要你或外部条件的三件事:git 基线 + 真实 CI 一次、
  Electron DMG 实测、引擎去 fdk-aac 后重建再分发
  (许可已定:自有代码 MIT + 分发物 GPL-3.0-or-later,见 `docs/GPL-COMPLIANCE.zh.md`)
