# AVStudio 状态与未完成清单(中文)

> 保持本文与代码同步。已完成项皆有测试或实测支撑;未完成项给出"卡点/为何"。

## ✅ 已完成(截至本清单)

**核心链路**
- C++ 媒体引擎(testpattern/decode/probe/pmeta)+ 原生 C-ABI 插件加载(checker)
- MediaComponent 进程内解码(默认)+ ffmpeg CLI 回退(编译期开关)
- 流式播放会话(sopen/sread/sseek/EOF 回绕)+ 实时 seek + 暂停/单帧 + 倍速 + 元数据
- React 中文 UI、进度实时回读(WS 通知)、示例文件选择、localStorage 持久化

**架构(DSH 范式)**
- 真 `@deepseek-ai/cordis`;`packages/<face>/<capability>`;host/client/test 三平面 typecheck
- 能力自注册:**`@mediabase/api` 控制面注册表 + `@mediabase/tools` 工具注册表**。每个能力
  在自己的包里注册 API 方法、数据面路由、health 片段、工具与 manifest;
  `@mediabase/server` 不认识任何能力(只读注册表)。**新能力不再是"改 4 处"**:
  服务/RPC/工具/清单都在能力包内,组合层只加一行 plugin
- 运行时插件热加载(load/unload/reload,基于 fiber dispose)
- LLM agent(`@mediabase/agent`)OpenAI-compatible function-calling 循环(经注册表);mock 端点闭环测试;真模型需 key

**中立底座(route-B)**:`@mediabase/rpc`(JSON-RPC+通知)、`@mediabase/engine-client`
(**纯线协议传输** + 流式会话;媒体动词已下放 `@avstudio/media/engine.ts`,底座不再
认识 probe/decode/session,scratch 路径由组合层注入)、`@mediabase/gateway`(HTTP/WS
网关;`@mediabase/server` 已是纯组合层,只读 `ctx.api`/`ctx.capabilities`)

**壳层能力无关化**:`@mediabase/ui-web` 只剩「标题 + 渲染 `ctx.ui` 面板」(每个面板包在错误
边界里,坏面板不会白屏整页),依赖面收窄为 ui/cordis/react;媒体核心(控制台 + monitor 画布 + `ctx.view` 提供者)迁入示例能力包
`@avstudio/ui-media`,连接徽标改为 `ui-panels` 注册的 header 面板 —— 壳层连 `connection`
都不再依赖。`ctx.ui` 带 `subscribe`/`revision`,挂载**之后**注册的面板同样立即渲染。
组合层去掉该包即得到「空但可用」的外壳。

**契约与错误**:`@mediabase/schema`(schemastery 方言 + JSON-Schema 桥)守每一处边界 ——
API 参数在 handler 前校验、返回值在 handler 后校验、工具参数在执行前校验,同一份声明
还自动生成给 LLM 的 JSON Schema;错误统一带码(`-32602` 参数、`-32001` 不存在、
`-32002` 不可用、`-32003` 引擎失败…),客户端按码分支、UI 显示 `[code] 消息`。

**日志**:`@mediabase/log` 提供 `ctx.log`(分级 + 子作用域),引擎/python stderr 经
`AVSTUDIO_LOG_LEVEL=debug` 可看;组合层启动时用 `capabilities.verify()` 校验
「声明 vs 实际注册」。

**组合与契约门禁**:`apps/cli` 负责「组合(profile/bundle/patch 层)+ 装载 + verify」——
每行在文件里给出自己的配置,能力包用自己的 `Config` schema 校验;`AVSTUDIO_CAPABILITY_DIR`
里的模块作为 drop-in 能力在启动时挂载(无需改宿主,两条组合路径同一套发现逻辑),
`capabilities.verify()` 在 dev 记警告、在 `AVSTUDIO_STRICT_CAPABILITIES=1`(CI/打包)下
**启动即失败**;组合本身另有静态门禁 `pnpm run verify:compose` + 运行时行解析预检;
gateway 的 method map 按请求现取,运行时挂载的能力立刻可调。

**进程可靠性**:引擎是被监督的子进程 —— 启动 `hello` 握手校验协议版本
(`assertProtocol`,不匹配即 `incompatible`)、崩溃后指数退避重启(默认 5 次,
200ms→5s,`config.restart` 可调)、退出即作废播放会话并经 `media.engine.status`
通知客户端、连续失败停止重启并保持 `failed`;`media.engineInfo` 与 `/api/health`
暴露 `state/alive/protocol/restarts/lastExit`,UI 媒体面板实时显示引擎状态。

**数据面可插拔**:同一份帧两种取法 —— 拉取 `GET /api/preview.rgb` 与推送
`WS /stream`(`ctx.api.stream` 注册通道,网关负责投递与背压:慢客户端丢帧并回
`{type:"dropped",count}`,默认 8MiB 高水位);前端 `ctx.streams` 订阅推送、非 live 时
自动回退轮询并显示当前传输方式;`api.streams` / `/api/health` 暴露订阅者与丢帧计数。

**访问控制与审计**:`AVSTUDIO_TOKEN`(可选)让 `/api/*`、`/api/health` 与两个 WS 端点都要求
`?token=`(常数时间比较;静态外壳保持公开);客户端 `ctx.net` 从 `?token=` 取值并记忆,自动
带上 RPC/流/轮询;运行时插件支持 `requires` 最小权限(未声明服务直接拒绝并提示补声明,自身
`inject` 必须是 `requires` 的子集);`ctx.api.call()` 是所有控制面调用的唯一审计点(成功
debug、失败 warn 带码),插件加载/卸载也有 `ctx.log` 审计。**边界说清楚**:同机信任边界,
不是登录系统;插件同进程,不是沙箱。

**控制面契约与权限**:`CONTROL_PROTOCOL_VERSION` 握手(客户端连上即调 `server.info`,不匹配在
`connection.status` 与徽标上显示"协议不兼容");方法级 ACL —— 能力用 `mutates: true` 声明
"会改状态",`AVSTUDIO_READONLY=1` 只读模式精确拒绝这些方法,`AVSTUDIO_ACL_ALLOW/DENY` 支持
精确名与 `prefix.*` 通配,拒绝发生在 `ctx.api.call()` 这一唯一入口并写审计日志,返回 `-32021`;
`@mediabase/gateway` 补上 9 个独立单测(SPA 回退、路径穿越两种形态、405、原始路由、health 合并、
广播、生命周期、未知 WS 路径)。

**插件沙箱(进程隔离)**:运行时插件可选 `isolation: 'process'`,在**独立子进程**里跑,只有
日志/事件/已声明服务调用/导出的 `api` 四条消息通道;`requires` 由**宿主侧**检查(插件不持有宿主
对象,绕不过);崩溃由宿主发现并显示为 `error`(可选 `restarts`),**卡死在 `apply()` 的插件会在
超时后被强杀**,宿主照常服务;卸载即进程终止(cleanup 先跑,无残留)。子进程入口随包分发
(`Resources/sandbox/sandbox.cjs`),示例插件 `examples/plugins/sandboxed-demo.ts` 可一键加载,
UI 插件面板显示沙箱状态。**边界如实**:进程隔离负责崩溃/卡死,`@mediabase/confine` 再加权限限制
(文件系统限声明根、禁子进程/worker;OS 层可用时禁网络),做不到的如实标注并可 fail closed。

**两条引擎后端都有覆盖**:引擎新增 `caps` 命令如实上报构建能力(解码后端/流式会话/元数据完整度),
宿主握手即读(`media.engineCaps` + health),测试与 doctor 据此适配;`-DAVSTUDIO_USE_MEDIACOMPONENT=OFF`
的纯 ffmpeg-CLI 配置**实测跑通整套**(129 绿 + 2 跳过,只跳过 MediaComponent 专属用例),
并因此抓出两个只在该模式暴露的真 bug(seek 模式不发进度通知、tick 重叠争用 scratch)已修。

**工程**:vitest 131/131(rpc 6 · 注册表/契约 14 · gateway 9 · **插件沙箱 10(真实子进程,打包版与 TS 源码两种入口各跑一遍)** · 引擎监督/传输 9 · 能力装载 6 · 基座打包 3 · 数据面流 6 · 访问控制 6 · i18n 5 · i18n 覆盖 2 · 表单/接口控制台 6 · UI 注册表 4 · 壳层渲染 4 · 真实组合渲染 4 · engine 10 · host 集成 26)· doctor · CI(quality + engine-matrix)· build:host 单文件 ·
package 源码发行包 · Electron 壳代码(packaging/desktop-electron,electronDist 本地化)

## ⬜ 未完成

### A. 媒体能力
| 项 | 卡点/说明 |
|---|---|
| 音频轨解码/出声 | 需 MC 音频解码 + host PCM→WAV/WebAudio + 音画同步(独立子工程) |
| 零拷贝帧传输 | 仍 引擎→临时文件→HTTP 轮询;→ WS 二进制 / 共享内存 / GPU 纹理(需定传输介质) |
| 硬解码 | MC Decoder.SwitchHWDecode 需确认目标设备/API 形态后开 |
| 播放器细分 | 播放中即时切倍速(现在作用于下次播放)、单次结束/区间循环、键帧外精确 seek |
| probe 扩展 | 采样率/声道/HDR 等底层已有未全暴露 |

### B. 产品级 UI
- host 原生文件/目录选择(DSH directory-picker 思路;现为手输+扫描下拉)
- ✅ i18n 外部化:`ctx.i18n`(每包 `messages.ts`,zh-CN/en,切换即时重绘,覆盖守卫测试)
- 面板显隐/排序配置(运行时开关面板);monitor 多面板编排
- ✅ 面板重渲染钩子:`ctx.ui.subscribe`/`revision`,React 挂载后注册的面板立即渲染
  (jsdom 壳层测试覆盖:无 subscribe 时该用例失败)

### B+. 通用基座(最小化路线,已排除媒体能力与桌面壳)
- ✅ 底座去业务耦合:`@mediabase/engine-client` 只剩传输层;scratch 路径走 config
- ✅ 壳层能力无关化:媒体核心迁入 `@avstudio/ui-media` 示例包
- ✅ **能力 manifest + 自动装载**:patch 层行表 + drop-in 目录 + 严格 verify
  门禁(CI);新增能力 = 一个包 + 一行(或丢一个文件进 `AVSTUDIO_CAPABILITY_DIR`)
- ✅ **基座 scope 中立化 + 可打包(不发布)**:可复用包统一为 `@mediabase/*`(18 个包;
  原先叫 `@avbase/*` —— `av` 是 AVStudio 的缩写,身份漏进了声称中立、要被别的产品**原样采纳**
  的那一层;重命名是 155 个文件的机械替换,lockfile 与 node_modules 由 `pnpm install` 重建)。
  中立名让 HANDOFF 里"基座包不受影响、只改产品 scope"这句话真正成立,且**基座包不依赖任何
  `@avstudio/*`**;
  `@mediabase/protocol`(中立契约)与 `@avstudio/protocol`(media/python/workflow)分离;
  `pnpm run build:base` 产出 `dist/`(ESM + d.ts),packed tarball 由外部项目用纯 Node 装上
  并跑通客户端↔服务端往返(测试固化);**所有包 `private: true` → `pnpm publish` 被拒绝,
  本仓库不发布**(测试断言);`license` = MIT(已定)
- ✅ **组合是 bundle + patch 层(路线 C 完成)**:宿主由 profile 组合 ——
  `$AVSTUDIO_HOME/profiles/<name>/` 下的 `package.json`(`avstudio.profile.bundles`)、
  `cordis.yml`(include 根,空表)、`cordis.patch.yml`(用户层);层序 **bundle 层 → profile 层
  → `$AVSTUDIO_HOME/cordis.patch.yml` → `--patch` 叠加 → drop-in 层**,后者**按 id 覆盖**
  前一层的整行 config —— 部署改一行不必 fork bundle。装载用 DSH 同款的 vendored 组合
  (`@deepseek-ai/cordis-plugin-loader` + `cordis-plugin-include`),机制在
  `apps/cli/src/profile-boot.ts`,宿主行表在 `packages/bundle/app/cordis.patch.yml`。
  **旧能力表与各能力的 `resolveConfig` 已删除**,`AVSTUDIO_COMPOSE` 也随之消失 —— 只剩这一条路径。
  三层职责:(a) **行 = 配置**:`!!js ctx.appPaths.root` 给出应用根,部署值用组合层提供的
  `ctx.env`(str/num/flag/list)从环境读进文件里(`port: !!js ctx.env.num('PORT')`),
  读不到就是 `undefined`(字段缺席 → 能力自己的默认生效),读到读不通就在启动时报出变量名;
  (b) **能力 = 校验**:每个能力用自己的 `Config` schema 守住本行配置(缺字段/类型错 →
  启动失败并给出路径),依赖应用根的默认路径在 `apply` 里解析;
  (c) **启动 = 审计**:`assertEntriesActivated`(从 harness 启动流程移植)+ 行解析预检
  (解析不到就点名行 id 与包名)。
  **行列契约有生成物**:`pnpm run gen:config-catalog` → `docs/CONFIG-CATALOG.md` +
  `docs/config-catalog.json`(每行"陈述了什么"+"这个能力的 `Config` 接受什么":类型/必填/默认值;
  `pnpm test` 会在过期或漏行时失败)。
  **不启动即可查看组合**:`--dump-config` / `--dump-default-config`(同一份 `planComposition`,
  用 include 自己的 `applyEntryPatches` 逐层做前缀快照,打印"哪一层插入/改写了哪一行",
  `!!js` 按表达式原样打印且可**回灌**成 patch 文件;不挂载、不 import 能力、不求值 `!!js`、
  不占端口。`--dump-default-config` 连用户层都不解析,用于"用户层写坏了怎么救")。
  **组合门禁** `pnpm run verify:compose`(裸包名必须能从所属清单解析、`!!js` 只允许出现在
  `config`/`disabled`、覆盖的 id 必须存在、客户端名册必须以外壳收尾;CI 与 `pnpm doctor` 里都跑);
  **drop-in 统一实现**(`apps/cli/src/dropins.ts`,由组合层合成为一层 insert 行)。
  **客户端也改成数据驱动**:`packages/bundle/ui/client.yml` 是浏览器名册(挂载顺序),
  `scripts/gen-client-roster.mjs` 生成 `apps/web/src/roster.generated.ts`(静态 import,
  浏览器 bundle 无法在运行时解析包名),入口只做"按名册挂载";生成文件过期 `pnpm test` 会失败,
  真实 Chrome 套件(8 个用例)跑在按名册构建的页面上。
  实测:起宿主 → **api 37 / tools 6 / 8 个 manifest**;`verify:base`(12 条)与 `verify`
  (媒体管线)全通过;`AVSTUDIO_READONLY=1` 经 `server.info` 的 acl 与 `media.play` 的 -32021
  实证生效;`--patch` 覆盖 `log`(level/scope)与 `settings.file` 实证生效(3 层);
  patch 丢 `root` → 启动失败并点名行与路径。
  `tests/compose-yml.test.ts` 24 用例 + `tests/composition-gate.test.ts` 12 用例 +
  `tests/client-roster.test.ts` 3 用例。
  **单文件宿主的封闭运行时(已完成)**:`build/host.cjs` 旁边没有 `node_modules` 可解析裸包名,
  所以 `pnpm run build:host` 会把 bundle 层里每个裸包名各自打成 `build/plugins/<slug>.cjs`、
  写出 `build/plugins.json`,并把唯一的共享单例 `@mediabase/rpc` 放进
  `build/node_modules/@mediabase/rpc`;宿主启动时按 **`AVSTUDIO_PLUGIN_MANIFEST` → 运行入口同目录
  → 安装锚点的 `build/`** 顺序找清单,找到就把行挂到打包文件上(找不到则按老路解析)。
  实测:把 `build/` 整目录(约 850KB)拷到 `/tmp`、用**纯 node**(无 tsx、无仓库 node_modules)
  启动 → `{"api":37,"tools":6,"组合":"patch 层","封闭运行时":"/tmp/avstudio-pkg/plugins.json"}`,
  `verify:base` 与 `verify` 全通过。共享单例只有 `@mediabase/rpc`:网关 `makeServer` 用
  `instanceof RpcError` 分辨带码错误(实测两份副本会把 `-32001/-32602` 降级成 `-32603`,
  并丢掉 `messageKey`)。
  **打包链路已实测(路线 B)**:`engine/build.sh -DAVSTUDIO_USE_MEDIACOMPONENT=OFF` + 
  `AVSTUDIO_BUNDLE_FFMPEG=0` → 门禁 exit 0(引擎 66KB,无 fdk-aac/x264);`electron-builder --mac dir`
  产出 `.app` 后,包内宿主与 Electron 壳(`AVSTUDIO_SMOKE=1`)都跑通,`verify:base`/`verify` 全过;
  把安装锚点指向不存在的路径(模拟目标机没有仓库)后仍能靠 `host/bundles/` + `host/plugins.json`
  组合。DMG 那一步在本机沙箱内跑不了(`hdiutil create` 对任何镜像都失败),沙箱/CI 用
  `pnpm run dist:dir`。详见 `docs/INSTALL.zh.md` 与 `docs/GPL-COMPLIANCE.zh.md`。
  与 DSH 0.1.5 **刻意不同的地方(逐条记录,不是漏做)**:不做 patch 热重载(patchReload=startup)、
  没有 `.env` 分层与遥测行、没有 per-profile `node_modules` 投影
  (改为从**安装锚点**(`apps/cli/package.json`)解析裸名,profile 在仓库外也能跑)、
  不用 `cordis:group` 的 isolate 域。客户端名册已是 UI bundle 的数据(`client.yml` → 生成的
  静态 import),不再是入口模块里的手写列表。
- ✅ **能力 manifest + 自动 RPC + schema 校验**:`ctx.api`(方法/路由/health 自注册)、
  `ctx.capabilities`(manifest 声明 + `verify()` 启动自检)、`@mediabase/schema` 守参数/返回值/
  工具参数;server 只剩「读注册表」。新增能力仍要写 client 面板(UI 面另计)
- ✅ **错误码体系**:`@mediabase/rpc` 的 `RpcCode`/`RpcError` 贯穿引擎→宿主→客户端,UI 显示码
- ✅ **统一日志/诊断**:`ctx.log` 分级 + 子作用域;引擎/python stderr 收口到 logger
- ✅ **引擎线协议版本化**:`hello` 宣告 `kProtocolVersion`(C++ 侧)与
  `ENGINE_PROTOCOL_VERSION`(宿主侧),`assertProtocol()` 拒绝错配并给出两侧版本号
- ✅ **引擎监督重启**:退避重启 + 上限 + 状态事件 + health 暴露(见上,含**子进程 pid**,
  让监督者/测试能指名道姓地检查"这个引擎是否残留",而不是数全机器进程 —— 后者会被并行的
  另一套宿主冲掉,已改);测试用可编排的假引擎脚本覆盖崩溃重启、放弃重启、协议不兼容三条路径
- ✅ **数据面可插拔**:三态可选 —— 拉取(`GET /api/<name>`)、WS 二进制推送(带背压丢帧)、
  **共享内存环**(`@mediabase/shm` + 客户端 `openRingStream`):帧落在同一块 `SharedArrayBuffer`,
  读路径给的是**视图而非副本**(实测 `view.buffer === ring.buffer`),满环丢最旧并计数。
  真实管线已验证(引擎→宿主→网关→环,64×24 帧 4608B 零拷贝读出),另有 worker 共享用例。
  浏览器需跨源隔离:网关 `crossOriginIsolation`(COOP/COEP,默认关,`AVSTUDIO_CROSS_ORIGIN_ISOLATION=1` 开)
- ✅ **客户端控制面连接的静默丢包已修**(真实浏览器套件逼出来的真 bug):
  `@mediabase/connection` 的 `send` 在 socket 未 OPEN 时**直接丢弃**请求 —— 面板挂载时的
  `api.list` 正好落在初次握手窗口里,于是既不发送也不报错,只能干等 30s 超时,面板一片空白
  (实测:控制台的方法下拉只有占位项,页面 0 异常,宿主侧一切正常)。修法:socket 未开时
  **有界排队**(200 条,超出即抛错而不是无声增长),`onopen` 后按序 flush;**重连/断线时
  `client.fail()`** 把已在路上的请求立刻以"连接丢失"拒绝,而不是让调用方等超时。
  新增 5 个用例(`tests/connection-rpc.test.ts`)固化排队/顺序/上限/断线/重连五种情形
- ✅ **浏览器内已实测**(不再只有 jsdom):`tests/browser.e2e.test.ts` 用 CDP 直驱真实
  Chrome(自写几十行驱动,零新依赖),验证构建产物真的能启动、页面自己的 WS 连上宿主(徽标 `.on`)、
  语言切换能重绘**已经画出来**的面板、`?lang=` 优先于 localStorage、生成表单走完 `server.info` 往返;
  共享内存那条**用引擎自己判**:隔离关 → `typeof SharedArrayBuffer === 'undefined'` 且
  `crossOriginIsolated === false`,隔离开 → COOP/COEP/CORP 到位且**真能分配**、页内环可读写。
  本机 Chrome 的自身沙箱起不来(`sandbox initialization failed: Operation not permitted`,嵌套沙箱),
  驱动**如实申报**后回退 `--no-sandbox` 重试(警告里写明),因此 8/8 真跑而非跳过
- ⬜ 仍未做:**引擎→宿主**这条仍在走 stdout 管道(要零拷贝需 Node 侧 mmap 原生模块,
  与本仓库"零原生依赖"的取向冲突,故未做);媒体监控面板仍用逐帧路径消费(接环是产品侧小改动,
  按"先纯基座"的要求暂缓)
- ✅ **门面硬化(基座自身)**:WS 收包上限(默认 1 MiB,超限以 1009 关闭而非缓冲)、
  连接预算(默认 64,超出 503)、方法表/路由/health 抛异常时回 500 / -32603 而不是拖垮宿主进程
  (Node 的未处理 rejection 会直接结束进程);`close()` 改为**优雅排空**:先给 WS 客户端 1001 道别、
  等在飞响应写完(用 FIN 而不是 destroy)、最后才关监听,并有超时兜底。
  这个顺序是实测结论:Node 23 的 `server.close()` 会关闭"空闲"连接,而**响应仍在排队**的连接也被算作
  空闲(64 MiB 只发出 1.7 MB 就被 RST)——先关监听就会截断它本该保护的响应
  (`tests/gateway-limits.test.ts` 8 个用例固化)
- ✅ 注册表/壳层的独立单测(`tests/ui-registry` 4 · `ui-shell` 4 · `ui-composition` 3,后两者
  走 jsdom;真实组合渲染 = ui-media + ui-panels 挂到真壳上,会话销毁后面板随之消失),
  外加**真实浏览器**一套 7 个(`tests/browser.e2e.test.ts`,CDP 直驱 Chrome,可选且按执行探测:
  没有浏览器 / `AVSTUDIO_NO_BROWSER=1` → 跳过并写出原因,绝不让环境事实把套件变红)
- ✅ 每个基座包都有**直接**测试:`gateway` 9 + `gateway-limits` 8、`rpc` 8、
  `protocol` 7(常量唯一来源、与 `@mediabase/rpc` 同一对象、错误码块与工厂、浏览器侧不引 Node、
  中立词汇里不出现产品概念)、`shm` 9(零拷贝视图、环绕、丢帧计数、句柄校验、真 worker 消费)、
  `confine` 11(规划器纯函数 + 受限子进程实测 + fail-closed)、`log` 15(级别过滤/作用域组合/
  记录结构/stderr 行格式/env 词表/fiber 回收)、`i18n-host-errors` 4(宿主 45 处
  抛点全 key 化 + 双语可解析 + 字典完整性 + 端到端渲染)、`settings` 13(磁盘契约/删除语义/
  损坏文件/写失败不许撒谎/manifest)、`agent` 16(发给模型的工具面与消息序列 + 回包各失败模式 +
  步数上限 + 设置覆盖 + 运行中注册的工具下轮可见;**不依赖 ffmpeg**,而 host.integration 里那条
  `agent.run` 用例是 `skipIf(!FFMPEG_OK)`)、`engine-client` 由 `engine-supervision` 9 个覆盖
- ✅ 顺手修掉一个只有直接单测才会暴露的问题:`settings.set` 过去**先改内存再写盘**,
  写盘失败时 `list()` 仍会报出那个从未落盘的值;现在改成**先写盘、成功后才提交内存**
  (`tests/settings.test.ts` 有对应用例钉住)
- ✅ **错误文案可本地化(机制 + 全量覆盖 + 守卫)**:`RpcError` 可携带 `messageKey`/`messageParams`,
  宿主保留自己的中文文案(日志/CLI/报错单可用),客户端按 key 用**用户语言**渲染;
  **客户端能收到的线错误已全部 key 化:60 处构造 = 宿主 45(8 个包)+ 基础层 15**
  (`@mediabase/rpc` 的 `makeServer` 解析/非法请求/未知方法/超时 4 处、`@mediabase/engine-client` 7 处等);
  中立键(`api.*`/`tools.*`)进 `CORE_MESSAGES`,`settings`/`plugins`/`python`/`agent` 进 `ui-panels`,
  `media`/`engine.*` 进 `ui-media`(引擎由 media 能力拥有),
  `tests/i18n-host-errors.test.ts` 三条规则把它固定住:①**会生成线错误的源码**(host 包 +
  `base/rpc` + `base/engine-client` + 沙箱子进程入口)里每个 `RpcError` 构造必须指名 key
  (允许显式标注 `// i18n: forwards|pass-through` 的转发/透传,静态扫描,扫不到足够多的抛点也算失败);
  ②引用的每个 key 必须在**两种语言**里都能解析(否则 UI 会渲染出裸 key);③每本字典必须双语齐备。
  端到端复验(真实宿主 + WS):`settings.unknownKey{key}`、`plugins.unknownId{id}`、
  `api.methodNotFound{method}`、`tools.unknownTool{tool}`、`media.fileUnreadable{file}` 全部带 key 抵达客户端。
  过程中顺带修了五处连带问题:
  **沙箱 IPC 现在传递 `code`/`messageKey`/`messageParams`**(此前插件在子进程里抛的带码错误
  会退化成 INTERNAL 且只剩散文)、`errorText` 接受线格式的普通对象(不再渲染 `[object Object]`)、
  以及"key 解析成功时不再把宿主原文拼在本地化文本后面"(英文界面里不再夹中文);
  还有 `@mediabase/rpc` 的 `makeServer` 生成的线错误此前完全没有 key(未知方法走的是它,不是 `ctx.api.call`,
  所以线上永远拿不到 key —— 端到端探针发现的)、以及 `scripts/lib/host-rpc.mjs` 这个校验脚本客户端
  只搬 `code` 而丢掉 `messageKey/messageParams/data`(脚本看到的比浏览器少)
  客户端"错误码 → 文案"表改为**从 `RpcCode` 推导**(此前手写表已漏掉 FORBIDDEN、
  还把 PARSE_ERROR 标成了参数不合法),`tests/i18n.test.ts` 断言每个码在每种语言都有文案。
  已迁移三处(基座 ACL 拒绝 / settings 未知键 / plugins 未知 id),面板经 `ctx.i18n.errorText` 显示;
  其余宿主文案可继续迁移,未迁移的不受影响

### C. 外围
- C1 **真模型端到端**:agent 代码已 mock 闭环;真 DeepSeek 验证待你填入 `AVSTUDIO_LLM_KEY` 实跑确认
- D3 完整化:原生插件单实例、无目录/事件;⬜ **原生**插件(.dylib/.so)仍在引擎进程内 —— 它崩了会带走引擎(宿主会监督重启,但插件本身无隔离)
- ✅ **JS 运行时插件沙箱已做**(`isolation: 'process'`,独立子进程 + 宿主侧 `requires` 检查 + apply 超时可强杀 + 卸载无残留)
- ✅ **子进程限制/权限沙箱已落地**:`@mediabase/confine` 把声明式策略变成 spawn 参数 ——
  Node 权限模型(**文件系统限声明的根**、禁止子进程/worker/原生 addon)+ OS 层
  (macOS Seatbelt / Linux Bubblewrap,负责 Node 模型表达不了的**网络禁止**)。
  机制可用性**按执行探测**:本机 `sandbox-exec` 实测 `sandbox_apply: Operation not permitted`,
  于是如实报"网络未限制"而不是假装。请求了却做不到的禁止进 `unavailable` 且**不算已生效**,
  `confinement.required: true` 可 **fail closed**(本机实测:拒绝加载并给出机制原话)。
  子进程自报实测:`read-outside`/`write-outside`/`spawn`/`worker` = `ERR_ACCESS_DENIED`,
  自己的模块与数据目录可读可写,网络可连(因为本机 OS 层不可用)。
  两个实测坑已固化:Node 按**字面路径**比较(故同时给原样与 realpath 两种形式)、
  `tsx` 需要 worker 线程(故受限子进程优先无 loader 的入口,放弃 worker 禁止时必须明说)
- ⬜ 仍缺:没有 OS 机制的平台上**网络**不受限(状态与日志如实标注,不是静默);
  Windows 无对应实现,且报告写 `no-os-mechanism`(不是"bubblewrap 不可用"那种误诊 ——
  类型上也分开:`available`/`layers` 只收真实机制,非机制只能进报告)
- Python 工具扩充(ASR/字幕/ML 需模型或外部依赖)

### D. 工程质量
- ✅ **git 已有基线**:两个提交(基线 + 打包修复),工作树干净;`.gitignore` 覆盖构建产物
  (`build/`、`release/`、`engine/bin/`、`vendor-ffmpeg/`),`.agents/notes/` 与 `.claude/skills/`
  随仓库交给接手的人。⚠️ 作者是占位身份(仓库级 `AVStudio baseline <baseline@localhost>`),
  换成你自己的名字;⚠️ **没有远端,所以两个工作流都还没真正跑过**(push 后才开始守)
- ✅ 浏览器级 UI 自动化已上,但**不引入 playwright**:`tests/support/browser.ts` 用 Node 自带
  WebSocket 直连 CDP(启动 headless Chrome + 附加页面 + evaluate),依赖面不变;
  没有浏览器时跳过并给出原因
- vitest 不 typecheck 测试→已补 `tsconfig.test.json`(✅)之外:测试对本机 ffmpeg/MediaComponent 产物的依赖仍需按 README 备齐
- ✅ 能力 schema 校验已接(`@mediabase/schema` 守参数/返回值/工具参数)
- ✅ 许可已定:**自有代码 MIT**(根 `LICENSE` + 26 个包 `license: MIT` + 打出的 tarball 带正文);
  ⚠️ 但**随包分发的原生产物**另有义务:引擎静态链接的 FFmpeg 与打包脚本捆绑的 ffmpeg 是
  `--enable-gpl --enable-nonfree` 构建(GPL + 不可再分发),详见 `docs/LICENSING.zh.md`
  (prepare-ffmpeg.mjs 现在会就此告警)
- ✅ **分发路线已定:整体 GPL-3.0-or-later**(自有代码 MIT);`pnpm run check:native --gate`
  与 `prepare-ffmpeg.mjs` 拒绝含 `--enable-nonfree`(fdk-aac)的产物,`dist` 内置该门禁;
  随包带 GPL 全文/MIT 全文/分发声明/NOTICE;两步重建与随包清单见 `docs/GPL-COMPLIANCE.zh.md`
  ⚠️ 当前引擎二进制仍含 fdk-aac(实测),按该文档重建后才能对外分发;
  ✅ 自有代码**保持 MIT**(已决定;让基座包仍可被闭源项目采用)
- ✅ 第三方归属清单已生成:`NOTICE.md`(`pnpm run notice`;npm 依赖取自锁文件,原生条目读本机
  license 文件核实);`pnpm doctor` 提示 ffmpeg 标志与引擎是否静态链接 FFmpeg;
  `AVSTUDIO_BUNDLE_FFMPEG=0` 可打出不含原生二进制的包
- ✅ `verify.base.mjs` 的中立冒烟已扩到 12 条:外壳/health/控制面握手/注册表/能力声明之外,
  还查**错误契约**(未知方法必须带 `code` + `messageKey` —— 客户端本地化的线上契约)、
  **跨源隔离姿态**(默认无 COOP/COEP;`AVSTUDIO_CROSS_ORIGIN_ISOLATION=1` 时三者齐备 —— 共享内存环
  在浏览器里的前置条件)、以及**插件管理器**(目录条目形状、未知 id 的带码+带 key 拒绝、
  已加载沙箱插件的限制报告;当前没有隔离插件时明确打印"不适用"而不是静默通过)。
  两条分支都实跑过:默认姿态 + 隔离开/已加载沙箱插件姿态
- ✅ 打包/校验脚本已中立化(`doctor.mjs`/`verify.base.mjs`/`package.mjs`/`build-base.mjs`/
  `notice.mjs`/`check-native-licenses.mjs`/`lib/host-rpc.mjs` 不含机器路径与产品 scope;
  APP_NAME/端口/路径取自环境或 package.json)。产品身份收敛到
  `PRODUCT IDENTITY` / `APP CHECKS` / `CAPABILITIES` 三个标注块,交接清单见
  `docs/HANDOFF.zh.md`,`tests/handoff-neutrality.test.ts` 4 个用例守住这条不变量

### E. 模式与盲区(如实)
- **Mode A(Tauri)** 仍脚手架未编译(要装 Rust 才出窗口);Electron 壳(packaging/desktop-electron)
  **已实测**:`pnpm run dist:dir` 产出 `.app`(257MB),包内宿主直接跑通 `verify:base`/`verify`,
  Electron 自身 `AVSTUDIO_SMOKE=1` 跑到 `[electron] smoke ok`;把安装锚点指向不存在的路径
  (模拟目标机没有仓库)后仍能靠 `host/bundles/` + `host/plugins.json` 组合。
  ⚠️ 本机沙箱内 `hdiutil` 无法建镜像(任何镜像都失败),所以 DMG 请在普通会话用 `pnpm run dist`;
  `release/electron/` 里 9 月 9 日那份 dmg 是迁移前的旧产物
- 真浏览器交互(语言切换/生成表单/跨源隔离)已在真实 Chrome 里实测(见上);
  本机需要 `--no-sandbox` 回退(外层沙箱挡住 Chrome 自身沙箱),驱动会**打印该偏差**,
  也可用 `AVSTUDIO_CHROME_ARGS=--no-sandbox` 直接省掉那次失败尝试
- MediaComponent 链接机器相关(brew/系统 frameworks),OFF 回退可用
- 15fps 轮询拉帧,非 60fps 实时渲染

## 推荐顺序
纯基座这一轮**已清空**(剩余的都是产品侧接线或外部条件):
- 数据面三态齐备(拉取 / WS 推送 / 共享内存环),环已对真实引擎帧验证;
- 权限限制已落地(文件系统 + 子进程 + worker;网络限制依平台机制,如实上报,可 fail closed)
仍待**产品侧接线**(按你"先纯基座"的要求未动):把媒体监控面板接到环上(小改动)、
音频轨、硬件解码、播放器细化等;以及外部条件:git 基线 + 真 CI、Electron DMG 实测、
引擎去 fdk-aac 重建分发、真模型一次
其余待办(需要你或外部条件):git 基线 + 真实 CI 一次、Electron `pnpm run dist` 出 DMG、
引擎去 fdk-aac 后重建再分发、C1 真模型一次。
产品能力(明确排在这些之后):音频轨、硬件解码、播放器细化、探针扩展、原生插件多实例、
Python 工具扩充、UI 面板显示/排序配置。
