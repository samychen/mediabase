# 依赖边界:每样东西在哪一层、怎么换掉它

本仓有**四个进程/世界**,依赖按"离媒体多近"分层。搞清楚边界后,"换掉 ffmpeg""不用 MediaComponent"
这类需求的改动面是可以精确到文件的 —— 这张表就是为此写的。

```
浏览器(React)  ──WS/HTTP──  Node 宿主(Cordis 插件树)  ──行协议──  C++ 引擎(进程)
   ①纯 JS                      ②纯 JS                          ③原生解码
                                 └──行协议── python sidecar(进程)  ④分析工具
```

层次规则(AGENTS.md 第一条):**逐帧媒体数据只在③/④ 里流动,宿主 JS 从不解码**。

---

## 速查表

| 依赖 | 在哪一层 | 必需? | 换掉 / 去掉要动什么 | 许可与分发 |
|---|---|---|---|---|
| **MediaComponent** | ③ 引擎(可选解码后端) | 否,默认 ON,缺失自动回退 | `engine/CMakeLists.txt`(链接)、`engine/src/mediacomponent.{cpp,h}`(适配层)、`scripts/doctor.mjs`(探测文案) | ⚠️ 检出里**无 license 文件**;GPL 链路要求它许可兼容 → 待与其维护者确认 |
| **FFmpeg** | ③ 引擎(进程内静态库 或 CLI 回退)、④ sidecar(分析)、打包(捆绑 binary)、测试(造素材) | ③ 二者必居其一;④ 与静音/响度有关 | 见下节"三种形态" | ⚠️ 当前那份是 `--enable-gpl --enable-nonfree` → **不可再分发**;`pnpm run check:native --gate` 会拦 |
| **native C-ABI 插件(.dylib/.so)** | ③ 引擎 `dlopen` | 否 | 关掉 `media.pluginFrame` 一个动词即可;路径 `AVSTUDIO_CHECKER`,示例 `examples/native/checker.c` | 你自己的插件,自己定 |
| **python sidecar** | ④ 独立进程 | 否(去掉后 `python.*` 方法消失、相关面板报错) | 从行表移除 `python` 一行(或写进 profile 层 `disabled: true`) | 仅用 Python 标准库 + 外部 ffmpeg |
| **brew 库**(glog/gflags/jsoncpp/cJSON/SDL2/lz4)+ macOS frameworks | ③ 引擎,且**只在 MediaComponent=ON 时链接** | 否 | `-DAVSTUDIO_USE_MEDIACOMPONENT=OFF` 后引擎只链 `libdl` | BSD-3/MIT/Zlib/BSD-2,frameworks 属系统 |
| **npm 运行时依赖**(10 个,全 MIT) | ① ② | 是 | 见 `NOTICE.md`(`pnpm run notice` 生成) | 全部 MIT |
| **Electron / electron-builder** | 打包工作区(非运行时) | 否(只有出安装包时需要) | 删 `packaging/desktop-electron` 不影响 Modes A/B | MIT |
| **cmake** | 构建工具 | 否 | `engine/build.sh` 无 cmake 时直接 g++/cc | — |

---

## FFmpeg 的三种形态(最容易混)

1. **进程内解码(默认)**:MediaComponent 的静态 FFmpeg 库被链进引擎 → 引擎二进制自带
   `libavcodec/x264/fdk-aac...`,**宿主完全看不见**。
   替换:`engine/src/mediacomponent.cpp` 换实现(如 GStreamer / 自研解码器),只要保持
   `decode/probe/pmeta/sopen/sread` 的列布局与 RGB24 输出,宿主与基座都不用改。
2. **CLI 回退**:`-DAVSTUDIO_USE_MEDIACOMPONENT=OFF`(或该检出不存在)时,引擎改为 spawn
   `ffmpeg`(路径 `AVSTUDIO_FFMPEG` 优先,否则 `$PATH`),每帧一次。
   替换:改 `engine/src/main.cpp` 的 `ffmpegPath()` / 单帧解码函数;或把它换成调用任意 CLI。
3. **分析工具**:python sidecar 用 `ffmpeg -af silencedetect` / `volumedetect` 做静音与响度,
   路径由组合层那一行注入(`AVSTUDIO_FFMPEG` → `python.ffmpeg`)。
   替换:改 `python/sidecar/main.py` 里那两个工具(换成 librosa/ffmpeg-python 都行,注意别把
   Python 变成必需依赖 —— 现在是标准库 + 外部工具)。

外加两处**非能力**用途:打包脚本把一份 ffmpeg 拷进 app bundle(`prepare-ffmpeg.mjs`,
`AVSTUDIO_BUNDLE_FFMPEG=0` 可关),测试用 ffmpeg 造素材(`tests/engine.test.ts`、`tests/host.integration.test.ts`)。

---

## 引擎两条后端的**能力矩阵**(`caps` 命令如实上报)

引擎有两条解码后端,宿主握手时就会问一次(`media.engineCaps`;也进 `/api/health` 与
`media.engineInfo.caps`),测试与 `pnpm doctor` 据此决定断言与提示 —— 不再靠猜机器上有没有检出。

| 能力 | MediaComponent=ON(本机默认) | `-DAVSTUDIO_USE_MEDIACOMPONENT=OFF`(ffmpeg CLI 回退) |
|---|---|---|
| `decode` / `testpattern` / `probe` / 原生插件帧 | ✅ | ✅ |
| `pmeta` 扩展元数据(fps/codec/pixelFmt/音轨编码) | ✅ `pmeta=full` | ⚠️ `pmeta=basic`:只给时长/分辨率/是否有音轨 |
| 流式会话 `sopen/sread/sseek` | ✅ `session=1` | ❌ `session=0`:播放退回**逐帧 seek**(每帧一次 ffmpeg 子进程) |
| 引擎二进制链接 | FFmpeg 静态库 + brew 库 + macOS frameworks | **只链 libc++/libSystem**(实测 `otool -L`) |
| 测试套件 | 131/131 全绿 | 129 绿 + 2 跳过(只跳过上面两个 MediaComponent 专属用例) |

实测一句话:`printf 'caps\n' | engine/bin/engine` → `caps	mediacomponent=1	session=1	pmeta=full`。

回退路径是**受支持、有测试覆盖**的第二配置(CI 正是用它:CI 没有那个本机检出)。写这套覆盖时
抓出两个只在回退模式暴露的真 bug,都已修:

1. **seek 模式完全不发进度通知** —— `seekTick` 只解码不 `notifyTick()`,UI 时间轴永远停在 0;
   流式模式掩盖了它。
2. **tick 会重叠** —— 回退模式下一帧 = 一次 ffmpeg 子进程(~200ms),而 tick 间隔 100ms,
   两次解码会争用同一个 scratch 文件,循环立刻报错并停机。现在加了"同一时刻只解一帧"的守卫,
   忙不过来就跳过这一拍(帧率降级,而不是崩)。

## 三种"去掉原生依赖"的处方

### 处方 1:纯 MIT 分发(不含任何原生二进制)

```sh
bash engine/build.sh -DAVSTUDIO_USE_MEDIACOMPONENT=OFF   # build.sh 会把参数转给 cmake
AVSTUDIO_BUNDLE_FFMPEG=0 cd packaging/desktop-electron && pnpm run dist
```
结果:引擎只链 `libc++`/`libSystem`(实测),spawn 用户自己的 ffmpeg;分发包里没有 FFmpeg/
MediaComponent 代码。代价:必须有 ffmpeg 在 PATH(或设 `AVSTUDIO_FFMPEG`);失去流式会话与
完整元数据(见上面的能力矩阵),播放退回逐帧 seek。`pnpm doctor` 会同时报告"引擎构建能力
(caps 命令)"与目标机器是否有 ffmpeg。

### 处方 2:接受 GPL 分发(当前选择的路线)

保留 MediaComponent + `--enable-gpl` 的 FFmpeg,**但必须去掉 `--enable-nonfree`**(fdk-aac 不可再分发)。
步骤与随包清单见 `docs/GPL-COMPLIANCE.zh.md`;门禁是 `pnpm run check:native --gate`(已内置在 `dist` 里)。

### 处方 3:换掉 MediaComponent,保留 ffmpeg

`AVSTUDIO_USE_MEDIACOMPONENT=OFF` + 让引擎的 CLI 路径指到你自己的 ffmpeg 构建
(`AVSTUDIO_FFMPEG=/path/to/ffmpeg`):立刻摆脱那份非自由构建与"路径式检出",代价是每帧一次子进程。

---

## 运行时扩展点(不是"依赖",但同样有边界)

| 扩展点 | 怎么装 | 隔离级别 |
|---|---|---|
| 能力包(drop-in) | 把 `*.mjs/cjs/js` 放进 `AVSTUDIO_CAPABILITY_DIR`(两条组合路径都由 `apps/cli/src/dropins.ts` 发现;yml 路径把它合成一层 insert 行) | 与宿主同进程 |
| 运行时插件 | 目录条目 + `plugins.load`(`AVSTUDIO_HELLO`) | 同进程 + `requires` 最小权限 |
| 沙箱插件 | 目录条目 `isolation: 'process'` | **独立子进程**,只有消息通道(崩溃/卡死受控) |
| 原生插件 | `.dylib/.so` + `plugin-load` | 引擎进程内(崩了会带走引擎,由宿主监督重启) |

---

## 环境变量与它们的归属

每个变量由**组合层的那一行**读进配置(`packages/bundle/app/cordis.patch.yml`,用
`!!js ctx.env.str/num/flag/list`),再由**拥有该资源的包**用自己的 `Config` schema 校验 ——
**前缀由 boot 身份决定**(`apps/cli/src/identity.ts`):基座默认 `MEDIABASE_`、home 目录
`~/.mediabase`;AVStudio 作为第一个消费者显式用 `AVSTUDIO_` / `~/.avstudio`。表里写的是**短名**
(行里就写短名,`ctx.env.str('TOKEN')` 解析成 `${prefix}TOKEN`);`ctx.env.raw/rawNum` 用于**环境
自己的变量**(如 `PORT`);`${prefix}ENV_PREFIX` 可整体换词表(测试/嵌入用),且**不支持两套前缀同时生效**:

| 变量 | 读它的包 | 作用 |
|---|---|---|
| `AVSTUDIO_ENGINE_BIN` / `AVSTUDIO_ENGINE_SCRATCH` / `AVSTUDIO_SAMPLES_DIRS` / `AVSTUDIO_CHECKER` | `@avstudio/media` | 引擎二进制、字节交换路径、扫描目录、原生插件 |
| `AVSTUDIO_SIDECAR` / `AVSTUDIO_PYTHON` / `AVSTUDIO_FFMPEG` | `@avstudio/python` | ④ 进程与其外部工具 |
| `PORT` / `AVSTUDIO_DIST_INDEX` / `AVSTUDIO_TOKEN` / `AVSTUDIO_READONLY` / `AVSTUDIO_ACL_ALLOW` / `AVSTUDIO_ACL_DENY` | `@mediabase/server` | 监听、静态目录、鉴权、方法级 ACL |
| `AVSTUDIO_HELLO` / `AVSTUDIO_SANDBOX_ENTRY` / `AVSTUDIO_SANDBOX_HELLO` | `@mediabase/plugins` | 插件目录条目与沙箱入口 |
| `AVSTUDIO_SANDBOX_CONFINE_REQUIRED` | `@mediabase/plugins` + `@mediabase/confine` | `1` = 限制无法完全生效时拒绝加载沙箱插件(fail closed) |
| `AVSTUDIO_PLUGIN_DATA_ROOT` | `@mediabase/plugins` | 受限插件的数据目录根(默认 `~/.avstudio`,不可写则依次回退) |
| `AVSTUDIO_CROSS_ORIGIN_ISOLATION` | `@mediabase/server` + `@mediabase/gateway` | `1` = 发 COOP/COEP/CORP,页面才能用 `SharedArrayBuffer`(共享内存环前置条件) |
| `AVSTUDIO_CAPABILITY_DIR` / `AVSTUDIO_STRICT_CAPABILITIES` | `apps/cli`(组合层) | drop-in 能力、启动门禁 |
| `AVSTUDIO_LLM_*` | `@mediabase/agent` | 模型端点(可被 `ctx.settings` 覆盖) |
| `AVSTUDIO_SETTINGS_FILE` | `@mediabase/settings` | 设置文件路径 |
| `LOG_LEVEL` | **log 行**通过 `ctx.env.choice(...)` 读 | 日志级别;未知值 → 默认 `info`(不因拼错而启动失败),能力本身不读环境 |
| `AVSTUDIO_BUNDLE_FFMPEG` / `AVSTUDIO_ALLOW_NONFREE` | 打包脚本 | 是否捆绑 ffmpeg / 是否放行不可再分发构建(仅本机自用) |

> 交叉验证:每条都能在行表里查到(`grep -n "ctx.env" packages/bundle/app/cordis.patch.yml`),
> 由 `pnpm run verify:compose` 与 `tests/compose-yml.test.ts` 的"行 = 短名 + reader"用例守住
> (漏一个/多一个/写成产品前缀都会失败);"一套词表"由 `tests/env-prefix.test.ts` 守着。
> 组合层只负责"根目录 + 装载顺序 + 启动自检 + drop-in",不认识任何具体资源路径。
