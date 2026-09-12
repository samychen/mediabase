# AVStudio 使用说明(中文)

> 定位先看:`docs/FRAMEWORK.zh.md`(中文)/ `docs/FRAMEWORK.md`(EN)——它是
> "类 OBS + 插件 + AI"应用的**完整参考实现/脚手架**:架构范式与底座代码可复用,
> 但作为"任意第二产品的通用基础框架"还差一层抽象(文档给了三条通用化路线)。
> 安装/打包见 `docs/INSTALL.zh.md`;功能完成度与缺口清单见 `docs/STATUS.zh.md`。

一个面向"C++ 音视频工程师从 Qt 转向 Web UI + 插件宿主"的可运行骨架,构建在
**DeepSeek Harness 同款框架 `@deepseek-ai/cordis`** 之上:

> React 界面 + Cordis 插件宿主,驱动一个**独立的 C++ 媒体引擎进程**。实时媒体
> 永远不进入 JS。一份代码、两种外壳:本地 Node 服务 + 浏览器,或 Tauri 桌面窗口。

所有功能都跑**真实媒体**:C++ 引擎解码真实视频帧(默认走 MediaComponent 进程内解码,
无则回退 ffmpeg CLI),由媒体能力包的 monitor 面板把原始 RGB24 画到 `<canvas>` 上。

---

## 1. 环境要求

| 依赖 | 版本/说明 | 检查命令 |
|---|---|---|
| Node.js | ≥ 22(本工程在 v23 验证) | `node --version` |
| pnpm | ≥ 11 | `pnpm --version` |
| C++ 编译器 | g++ / clang++(C++17) | `g++ --version` |
| ffmpeg | 解码用(引擎按顺序找 `$PATH` 或已知路径) | `ffmpeg -version` |

## 2. 快速开始(Mode B:浏览器)

```sh
cd /Users/chensi/develop/harness/avstudio
pnpm install          # 安装依赖(ws、react/vite、@deepseek-ai/cordis)
pnpm run build        # 编译 C++ 引擎 + 打包 web 前端
pnpm run host         # 启动宿主,监听 http://127.0.0.1:3088
```

浏览器打开 **http://127.0.0.1:3088**。

**准备一个测试视频**(UI 默认文件是 `/tmp/avstudio-sample.mp4`):

```sh
ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=15 -y /tmp/avstudio-sample.mp4
```

### 界面按钮

| 按钮 | 作用 | 验证点 |
|---|---|---|
| **测试图案** | 让 C++ 引擎直接生成一帧(不依赖文件) | 画面出现彩条渐变,证明引擎活着 |
| **探测** | 读取媒体文件时长/分辨率 | 状态栏显示 `(3s)` 之类 |
| **解码当前帧** | 真实解码一帧(播放中取当前播放进度,否则取寻址滑块位置) | 画面上出现视频画面 |
| **▶ 播放 / ⏸ 暂停 / ⏭ 单帧 / ■ 停止** | 连续解码会话播放;暂停只停 ticker、单帧逐帧前进 | 画面动起来;播放中拖动进度条可**实时跳转** |
| **测试图案右侧「解码」位置** | 同一行另有“测试图案/探测” | 进度条实时回读播放时间 |

页面顶部徽标显示 **宿主已连接/离线** 与 **播放中/已暂停**;媒体文件一栏提供**服务器路径输入 + 扫描示例下拉**(默认扫 /tmp,可用 `AVSTUDIO_SAMPLES_DIRS` 指定多个目录,冒号分隔);文件/宽/高会记忆在浏览器 localStorage,刷新不丢。

### 无头验证(不打开浏览器)

```sh
pnpm run host &        # 一个终端先起宿主
node scripts/verify.mjs   # 依次测 ping/probe/decode/testpattern 并拉取 /api/preview.rgb
# 期望输出: ALL CHECKS PASSED — WebView -> host -> C++ engine -> frame pipeline works.
```

---

## 3. 两种部署模式(同一份代码)

```
Mode B   pnpm run host ──> http://127.0.0.1:3088  任意浏览器打开
        (apps/cli 在根 Context 上组合 @avstudio/media + @mediabase/server)

Mode A   desktop/(Tauri 壳)──拉起──> 同一个 pnpm run host
         └─ 原生 WebView 打开 http://127.0.0.1:3088
```

### Mode A(Tauri 桌面窗口)说明

本机没有 Rust 工具链,所以 `desktop/` 目前是**完整可用的脚手架源码**,尚未编译:

```sh
# 一次性准备(在装有 Rust 的机器上)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --locked

# 运行
pnpm run build
cd desktop && cargo tauri dev   # 拉起宿主 + 弹原生窗口
```

详见 `desktop/README.md`(英文,含打包 sidecar 等后续说明)。

---

## 4. 目录结构

```
apps/
  cli/       宿主入口:**组合(profile/bundle/patch 层)+ 装载 + 启动自检**
             (apps/cli/src/profile-boot.ts;行表在 packages/bundle/app/cordis.patch.yml)
  web/       Vite 壳:组合客户端插件(组合顺序=能力集合)
packages/
  base/      @mediabase/* 能力无关底座:rpc · schema · log · protocol · engine-client
             (仅线协议传输,无媒体动词) · gateway
  protocol/  @avstudio/protocol:领域契约(media/python/workflow)+ 再导出 @mediabase/protocol
  host/      @mediabase/tools 工具注册表(ctx.tools,能力自注册)
             @mediabase/api   控制面注册表(ctx.api 方法/路由/health)+ 能力清单(ctx.capabilities)
             @mediabase/settings 持久化设置(~/.avstudio/settings.json)
             @mediabase/agent  LLM agent 循环(只认注册表)
             @mediabase/plugins 运行时插件热加载
             @mediabase/server 纯组合层(@mediabase/gateway;方法/路由/health 全部来自注册表)
             ——— 以上可复用(不依赖任何 @avstudio/*);以下为产品能力 ———
             @avstudio/media  持有并**监督** C++ 引擎进程 + 媒体动词表;ctx.media + ctx.previewState
             @avstudio/python python sidecar 工具进程(ctx.python)
             @avstudio/workflow recipe 编排器(内置 recipe 走 media 工具)
  client/    @mediabase/connection 控制面通道 + 数据面推送订阅 + ctx.net(令牌/URL)
             @mediabase/i18n 文案字典与语言切换(ctx.i18n)
             @mediabase/ui UI 面板注册表 + JSON Schema → 表单工具
             · @mediabase/ui-web **壳(能力无关)**:标题 + 渲染注册面板(注册后自动重绘)
             @avstudio/preview  ctx.preview 控制面包装
             @avstudio/ui-media 示例媒体能力包:ctx.view 提供者 + 控制台 + canvas monitor
             @avstudio/ui-panels 示例外部 UI 包:连接徽标(header)+ 各工具面板

> `@mediabase/*` = 可复用、可**本地打包**(`build:base`,见下);`@avstudio/*` = 本产品能力。
> **本仓库不发布**:所有包 `private: true`,`pnpm publish` 会被直接拒绝。
> 目录的 face(base/host/client)决定 typecheck 平面,scope 决定可复用性。
engine/     C++ 媒体引擎(g++/CMake,可选 MediaComponent)
desktop/    Tauri 脚手架(模式 A);packaging/desktop-electron(Electron 打包,可出 DMG)
scripts/    verify.mjs / doctor / package
```

## 5. C++ 引擎协议(engine/)

引擎 stdin/stdout 走 tab 分隔的行协议(诊断只走 stderr,不污染协议):

```
ping                                -> pong
probe\t<file>                       -> probe\t<时长>\t<宽>\t<高>
testpattern\t<宽>\t<高>\t<输出.rgb> -> ok\t<宽>\t<高>\t<字节数>
decode\t<file>\t<时间>\t<宽>\t<高>\t<输出.rgb> -> ok\t<宽>\t<高>\t<字节数>
                                     (或) error\t<信息>
```

`decode` 目前通过子进程调用 `ffmpeg` 写出一帧原始 RGB24。以后换成进程内 libav / 你自己的
编解码管线即可,**宿主的契约不用改**。

## 6. 常用开发命令

```sh
pnpm run typecheck    # tsc -p tsconfig.host.json && tsc -p tsconfig.client.json && tsc -p tsconfig.test.json
pnpm run lint         # oxlint
pnpm doctor           # 新机器体检:工具链/MediaComponent/产物/LLM key 一目了然
pnpm run build:engine # 只编 C++ 引擎
pnpm run build:web    # 只打包前端
pnpm test             # vitest 全量(protocol/engine/host 集成)
PORT=3090 pnpm run host   # 换端口(默认 3088,特意避开 DSH GUI 的 3080)
```

换机器:先 `pnpm doctor`,缺什么它会直接告诉你(ffmpeg 可 `AVSTUDIO_FFMPEG` 指定;
无 MediaComponent 会自动走 ffmpeg CLI 回退解码,CI 就是这种模式)。CI 见
`.github/workflows/ci.yml`。

**打包与安装**:完整说明见 `docs/INSTALL.zh.md`(中文)/ `docs/INSTALL.md`(EN)。
一句话:当前是"源码+工具链"交付,换机重编引擎即可;打便携源码发行包用
`pnpm run package` → `release/avstudio-src-<版本>.tar.gz`(14MB 级,不含
node_modules/.git)。真·安装器(Mode A Tauri/Node 单文件)仍是脚手架,见文档如实说明。

## 7. 常见问题(FAQ)

1. **`node scripts/verify.mjs` 连不上**:宿主没起,或端口被占。先 `pnpm run host`,或换
   `PORT=xxxx pnpm run host` 并把脚本里的端口一起改。
2. **点 Decode / Play 报错**:错误信息现在会给出真实原因(ffmpeg 横幅已剥离):
   - `No such file or directory` → 文件路径不对,先 `ls` 确认;
   - `file has no decodable video stream` → 该文件没有视频流(如纯音频 m4a/mp3),Play 会直接拒绝;
   - `Output file #0 does not contain any stream` → 同上,解码阶段报的;
   - 其他 `ffmpeg exit 1` → 文件损坏或编码不支持,可先用 `ffprobe/ffmpeg -i` 确认。
3. **页面显示 "no frame yet"**:先点 Test Pattern(不依赖视频文件)确认链路,再试 Decode。
4. **之前踩过的坑已修复**(均有回归验证):pnpm workspace 双 glob、cordis v4 `ctx.get`
   用法、ChildProcess 空值、probe 解析重定向、play/stop 异步竞态崩溃、SIGINT 后引擎
   进程孤儿。详见各文件注释与 `AGENTS.md`。
5. **TS 报模块找不到**:先 `pnpm install`;workspace 链接由 `packages/*` + `packages/*/*`
   两条 glob 提供(两级能力包)。

## 8. 路线图(未做部分)

1. ~~自研运行时换成真 @deepseek-ai/cordis~~ ✅ 已完成,结构/模式对齐 DSH
2. ~~解码/元数据/变速~~ 部分完成:连续解码会话+实时 seek(已完成);新增 `pmeta` 元数据(fps/编码/像素格式/是否有音轨,UI「元数据」展示)与**倍速播放**(0.5×–2×,作用于下次播放);音频轨解码出声、硬解码、WS 二进制/共享内存/GPU 纹理共享仍留待后续
3. ~~Python sidecar~~ ✅ 已完成(D1:ctx.python、静音检测),工具可继续扩充
4. ~~工作流 runner~~ ✅ 已完成(D2:media/python 之上的 recipe 编排 + WS 通知);真正接入 LLM agent 循环留待后续
5. ~~原生渲染 C-ABI 插件加载~~ ✅ 已完成最小版(D3:dlopen .dylib/.so + avplugin_* 导出 + checker 示例);OBS 级 source/filter 目录、事件与 UI 留待后续
6. ~~CMake + ffmpeg 路径可配~~ ✅ 已完成(engine/CMakeLists.txt,build.sh 优先 cmake、无 cmake 回退 gcc;ffmpeg 走 `AVSTUDIO_FFMPEG` 环境变量)
7. ~~工具注册表 + 自动 RPC~~ ✅ 已完成(media/python/workflow 自注册,`tools.list/run`)
8. ~~UI 面板注册表~~ ✅ 已完成(`ctx.ui`,header/sidebar/monitor 三区;壳 `ui-web` 能力无关,媒体能力在 `ui-media`;挂载后注册的面板经 `subscribe`/`revision` 自动重绘);剩余:面板显隐/排序配置
9. ~~Electron 桌面打包 + App 内设置 key~~ ✅ 已完成(可出 DMG;设置写 ~/.avstudio/settings.json)
10. ~~能力 manifest + 自动 RPC + schema 校验~~ ✅ 已完成:`ctx.api` 自注册方法/路由/health
    (server 里不再有任何能力名,31 个方法零硬编码)、`ctx.capabilities` manifest 启动自检、
    `@mediabase/schema` 守参数/返回值/工具参数并自动生成给 LLM 的 JSON Schema
11. ~~错误码 + 统一日志~~ ✅ 已完成:`RpcCode`/`RpcError` 贯穿引擎→宿主→客户端(UI 显示
    `[code] 消息`)、`ctx.log` 分级 + 子作用域(引擎/python stderr 收口,`AVSTUDIO_LOG_LEVEL`)
12. ~~引擎线协议版本化 + 崩溃监督重启~~ ✅ 已完成(`hello` 握手 `v1` + `assertProtocol`;
    指数退避重启、`media.engine.status` 通知、`media.engineInfo`/health 暴露、UI 显示)
13. ~~scope 拆分 + 基座可打包~~ ✅ 已完成:可复用包统一为 `@mediabase/*`(基座包不依赖
    任何产品包)、`@mediabase/protocol` 与产品契约分离、`pnpm run build:base` 产出 `dist/`
    (packed tarball 已被外部项目用纯 Node 装上并跑通)。**不发布**:`private: true` 让
    `pnpm publish` 直接失败,测试也断言了这一点
14. ~~manifest 驱动的组合/装载 + 严格 verify~~ ✅ 已完成,并已迁到 **patch 层组合**:
    行表在 `packages/bundle/app/cordis.patch.yml`(每行在文件里给出配置,能力用自己的
    `Config` schema 校验;部署值经 `!!js ctx.env.*` 从环境读入)、
    `AVSTUDIO_CAPABILITY_DIR` 支持 drop-in 能力、`AVSTUDIO_STRICT_CAPABILITIES=1`
    作为启动门禁(CI 已接入)、`pnpm run verify:compose` 静态门禁组合层;
    `gateway` 的 method map 改为按请求取,运行时挂载的能力立即可调
15. ~~数据面可插拔 + 访问控制~~ ✅ 已完成:拉取 + WS 二进制推送(背压丢帧)、
    `AVSTUDIO_TOKEN` 门禁、运行时插件最小权限(`requires`)、控制面唯一审计点
16. ~~i18n 外部化 + 由 schema 生成面板~~ ✅ 已完成:`ctx.i18n`(每个 UI 包自带 zh-CN/en 字典、
    切换即时重绘、错误按码本地化、覆盖守卫测试)+ `@mediabase/ui` 的 JSON Schema 表单与
    「接口控制台」面板(任何已注册方法都能用生成的表单调用)
17. ~~插件沙箱(进程隔离)+ 方法级 ACL + gateway 独立单测~~ ✅ 已完成:运行时插件可
    `isolation: 'process'` 跑在独立子进程(越权检查在宿主侧、崩溃不带走宿主、apply 卡死可强杀、
    卸载无残留);控制面有协议握手 + `mutates`/只读/黑白名单 ACL + 唯一审计点
18. OS 级权限沙箱(容器/seccomp)、共享内存/GPU 纹理零拷贝:未做

## 9. 关键环境变量

| 变量 | 作用 |
|---|---|
| `AVSTUDIO_LOG_LEVEL` | 日志级别 `debug`/`info`/`warn`/`error`(默认 info;debug 可见引擎/python stderr) |
| `AVSTUDIO_CAPABILITY_DIR` | 冒号分隔的目录:其中的 `*.mjs/cjs/js` 模块会在启动时作为能力挂载(第三方 drop-in,无需改宿主) |
| `AVSTUDIO_STRICT_CAPABILITIES` | `1` = 启动时 `capabilities.verify()` 不通过则直接失败(CI/打包门禁) |
| `AVSTUDIO_TOKEN` | 设置后 `/api/*`、`/api/health` 与两个 WS 端点要求 `?token=`(本机信任边界;UI 用 `?token=` 打开一次即会记住) |
| `AVSTUDIO_SANDBOX_ENTRY` | 沙箱插件子进程的入口脚本(默认自动解析:打包版 `Resources/sandbox/sandbox.cjs`,仓库内由 Node 直接跑 TS 源码;需转译加载器时才回退 tsx) |
| `AVSTUDIO_SANDBOX_CONFINE_REQUIRED` | `1` = 沙箱插件声明的限制(文件系统/子进程/网络)无法完全生效时**拒绝加载**(fail closed),而不是降级运行 |
| `AVSTUDIO_PLUGIN_DATA_ROOT` | 受限插件唯一可写目录的根(默认 `~/.avstudio`,不可写时依次回退到应用根、临时目录并写警告) |
| `AVSTUDIO_CROSS_ORIGIN_ISOLATION` | `1` = 每个响应带 COOP/COEP/CORP,使页面可用 `SharedArrayBuffer`(共享内存环的前置条件;默认关,因为跨源隔离会拒绝未 opt-in 的外部子资源) |
| `AVSTUDIO_READONLY` | `1` = 只读宿主:拒绝所有声明了 `mutates` 的方法(播放/写入/加载/执行),返回 `-32021` |
| `AVSTUDIO_ACL_ALLOW` / `AVSTUDIO_ACL_DENY` | 逗号分隔的方法白/黑名单(支持 `media.*` 通配;deny 优先),拒绝同样返回 `-32021` 并写审计日志 |
| `PORT` | 宿主监听端口(默认 3088) |
| `AVSTUDIO_FFMPEG` | ffmpeg 可执行文件路径(默认取 `$PATH` 的 `ffmpeg`;仅"CLI 回退解码"与 python 工具用) |
| `AVSTUDIO_LLM_BASE` | LLM chat 端点(base,默认 `https://api.deepseek.com/v1`;兼容任何 OpenAI-compatible 端点) |
| `AVSTUDIO_LLM_KEY` | LLM API key(未配置时 agent 报错提示) |
| `AVSTUDIO_LLM_MODEL` | 模型名(默认 `deepseek-chat`) |
| `AVSTUDIO_SETTINGS_FILE` | 设置文件路径(默认 `~/.avstudio/settings.json`) |
| `AVSTUDIO_PYTHON` | python 解释器(默认 python3) |
| `AVSTUDIO_CHROME` / `AVSTUDIO_CHROME_ARGS` | 真实浏览器测试用的 Chrome 路径 / 额外启动参数(外层沙箱挡住 Chrome 自身沙箱时用 `AVSTUDIO_CHROME_ARGS=--no-sandbox`,省掉一次失败尝试) |
| `AVSTUDIO_NO_BROWSER` | `1` = 浏览器测试直接跳过(无浏览器的 CI 用,避免白等探测) |

> **AI 助手 key**:界面「设置(AI 助手)」可填并保存(明文存设置文件,立即生效);
> 也可用 `~/.avstudio/env` 或 shell env(后者优先级更高)。

> 解码后端(构建期):CMake 选项 `AVSTUDIO_USE_MEDIACOMPONENT`(默认 ON)让 C++
> 引擎**进程内**调用你的 MediaComponent(`/Users/chensi/develop/MediaComponent`,
> 可用 `-DMEDIACOMPONENT_ROOT=...` 指向别的检出)解码/探测,替代"每帧新起
> ffmpeg 子进程";设为 OFF 或无该检出时自动回退 ffmpeg CLI。

## 10. 想拿它当基座?先看交付清单

`docs/HANDOFF.zh.md`:哪些是基座(不动)、哪些是产品(要改)、fork 顺序、开箱可用的工具,
以及**有测试守着的四条中立性属性**(脚本里没有机器相关路径、基座脚本与产品解耦、产品身份集中在
标记块、`@mediabase/*` 不依赖 `@avstudio/*`)。

## 11. 依赖边界与引擎后端

引擎有两条可切换的后端,且**自己声明能力**:`printf 'caps\n' | engine/bin/engine` 回
`caps	mediacomponent=1	session=1	pmeta=full`(用 `-DAVSTUDIO_USE_MEDIACOMPONENT=OFF` 构建则
`mediacomponent=0 session=0 pmeta=basic`,此时引擎只链 libc++/libSystem)。宿主握手即读
(`media.engineCaps`、`/api/health`、`pnpm doctor` 都会显示)。

"谁在哪一层、怎么换掉它"(ffmpeg / MediaComponent / 原生插件 / python sidecar / npm 依赖 /
brew 库,以及三种"去掉原生依赖"的处方)见 **`docs/DEPENDENCIES.zh.md`**。

## 12. 许可

自有代码(26 个包 + `apps/` + `engine/` + `scripts/`)全部 **MIT**,见根目录 `LICENSE`;
npm 运行时依赖实测也全是 MIT(`pnpm licenses list --prod`)。

**已选的分发路线**:应用按 **GPL-3.0-or-later** 分发(引擎链接了 FFmpeg + x264),本仓自有代码保持
MIT。由于带 `--enable-nonfree` 的 FFmpeg 构建不可再分发,`pnpm run check:native --gate` 会拒绝
此类产物(打包 `dist` 已内置该门禁)—— 两步重建与"随包要给什么"见 `docs/GPL-COMPLIANCE.zh.md`。

`pnpm run notice` 生成第三方归属清单 `NOTICE.md`;`pnpm doctor` 会就分发相关的许可事实给出提示。

**原生二进制是另一回事**:引擎静态链接 FFmpeg,打包脚本还会把一份 ffmpeg 拷进 app bundle。
带 `--enable-gpl`(libx264)的构建整体按 GPL;带 `--enable-nonfree`(libfdk-aac)的构建按 FFmpeg
自己的说法**不可再分发** —— 本机 MediaComponent 里那份正是如此,所以**今天打出的 DMG 会带上这些义务**。
三条路线(不发原生二进制改用用户自带 ffmpeg / 自出 LGPL 构建 / 整体接受 GPL)与实测证据见
`docs/LICENSING.zh.md`。
