# xmedia-kit × mediabase 集成说明（中文）

> 以 [samychen/xmedia-kit](https://github.com/samychen/xmedia-kit)（C++20 媒体 SDK，BSD-3-Clause）
> 作为 mediabase 的**原生后端**。本产品是**转码 / 编码服务**；播放只是给内部测试看画面，
> 因此走浏览器原生播放，不自造帧管线。本文说明分层、线协议、MediaMTX 接线、构建/运行/验证与边界。

---

## 一、结论与定位

**基座近零改动**：`scripts/`、`apps/` 一个文件未动，根目录只有接线
（`package.json` 的 `*:xmedia` 脚本、`.gitignore`、`pnpm-lock.yaml`）。唯一触碰基座的一处是
`packages/base/engine-client/src/index.ts`：为 `proc.stdin` 增加错误处理器，吞掉对已退出子进程
写 stdin 的 `EPIPE`/`ECONNRESET`（退出处理器已结算在途请求），否则崩溃监督测试里子进程骤死会让
整个宿主随未捕获的 `error` 事件崩溃。这是**严格安全**的健壮性补丁，不改变任何命令/协议语义。
其余新增代码全在 `product/xmedia/`。

| 层 | 职责 |
|---|---|
| `xmedia-bridge`（C++ 子进程） | 消费 xmedia-kit：`media::TranscodeJob` 编码/封装并推 RTMP；`bake.*` 派生一次性 `xmedia-bake` 子进程 |
| `xmedia-bake`（C++ 子进程，可选） | 离线 HTML→MP4 烘焙（HyperFrames 对齐）：CEF OSR + GL 元素合成 + 编码封装 |
| `@xmedia/host-engine`（TS 能力包） | 进程监督、控制面命令、viewer URL、health、events、manifest、烘焙成片拉取路由 |
| MediaMTX（第三方进程，MIT） | 接收 RTMP，向浏览器提供 WHEP(WebRTC) / HLS |
| 浏览器 `<video>` | 直连 MediaMTX 播放，**媒体字节不经过 mediabase** |

关键取舍：**Host 只做控制面，不做任何媒体字节通道**。已删除的负债包括
拉取式 MJPEG 预览（`frame` / `xmedia.frames` / objectURL / pacing 泵 / fps UI）、
以及 C++ `xmedia::Player` 引擎自检管线（`open/play/pause/stop/reset/seek/rate/volume/mute/
status/info/diagnostics/snapshot`）、JPEG 抓帧、`--scratch` 字节交换、
`--allow-hardware` 硬解开关、`GET /api/xmedia.snapshot` 数据面路由与对应测试。
**净减代码**：C++ sidecar 只剩 `TranscodeJob` 一条产品路径，TS 能力包只剩
8 个控制面方法（含 `xmedia.metrics`）、4 个 agent 工具、0 条数据面路由。
（2026-11-17 起：新增 `xmedia.bake.*` 三方法/三工具与**烘焙成片拉取路由**——
本产品唯一的数据面路由，见第 3.2 节；控制面现为 11 方法 / 7 工具。）

**基座契约完全没动**：协议版本仍是 1，stdout 仍是一问一答 tab 行，
`EngineClient` 没有新增选项、没有 fd 3、没有 `StreamFrameMeta` 变更；
`readScratch()` 仍保留在基座，但本产品不再使用。新增的 `publish.*` 是产品自有动词，
旧引擎不认识就回 `UNKNOWN_COMMAND`，宿主可照常降级。

---

## 二、架构

```
   输入源（文件 / URL / FFmpeg 设备 URI）
        │
        ▼
  xmedia-bridge (C++ 子进程)                mediabase Host
   ┌────────────────────────────┐         ┌──────────────────────────┐
   │ media::TranscodeJob        │◄────────┤ WS /rpc：publish.start /  │
   │ demux → (encode/copy) → mux│  tab 行 │ stop/pause/resume/list    │
   │ （任务池：多 jobId 并发）     │         │ + viewer URL              │
   └────────────┬───────────────┘         └──────────────────────────┘
                │ RTMP/FLV（realtime 配速）          │ 只传地址
                ▼                                    │
        MediaMTX :1935                                │
         ├─ WHEP :8889 ──────────────────────────────┼─► 浏览器 <video>（WebRTC）
         ├─ HLS  :8888 ──────────────────────────────┼─► 浏览器 <video>（Safari 回退）
         └─ v3 API :9997（仅 verify 用来确认推流到达）
```

- **控制面**：只有命令与 URL。`xmedia.publish.start` 返回任务状态 + viewers。
- **媒体面**：xmedia-kit 的 muxer 直接把 RTMP 字节发给 MediaMTX；浏览器自己连 WHEP/HLS。
  没有像素、没有码流经过 WS `/rpc`、没有 `/stream` 通道、没有每帧文件 I/O、没有 scratch 文件。
- **stdout 洁净**：xmedia-kit 日志走 stderr，由 `onStderr` 转交 `ctx.log`；
  引擎的进度/完成回调**不写 stdout**（会毁掉 FIFO 匹配），改为进 `events` 队列，
  由 `xmedia.events` 按需拉取。

---

## 三、线协议（产品自有，`@mediabase/engine-client` 不懂动词）

请求每行一条、tab 分列；响应严格一问一答、每请求一行。`ok` 成功，
`err\t<code>\t<message>` 由 `callOk()` 转成 `RpcCode.ENGINE (-32003)`。

| 命令 | 参数 | 响应 |
|---|---|---|
| `hello` | — | `hello\t1\txmedia-kit/<version>\t<sandboxed>` |
| `ping` | — | `pong` |
| `publish.start` | `jobId, input, output, format, vcodec, acodec, realtime` | `ok\t<任务 JSON>` |
| `publish.stop` | `jobId` | `ok\t<任务 JSON>` |
| `publish.status` | `jobId`（**空=空闲快照**） | `ok\t<任务 JSON>` |
| `publish.pause` | `jobId` | `ok\t<任务 JSON>`（协作式暂停，幂等） |
| `publish.resume` | `jobId` | `ok\t<任务 JSON>`（恢复，幂等） |
| `publish.list` | — | `ok\t<[任务 JSON 数组]>`（全池快照，每行带 `jobId`） |
| `bake.start` | `jobId, htmlPath, outPath, optionsJson` | `ok\t<烘焙 JSON>` |
| `bake.status` | `jobId`（**空=空闲快照**） | `ok\t<烘焙 JSON>` |
| `bake.cancel` | `jobId` | `ok\t<烘焙 JSON>` |
| `events` | — | `ok\t<事件 JSON 数组>`（drain） |
| `quit` | — | `ok` |

**任务 JSON**（`publish.*`）：
`{running, done, ok, progress, input, output, format, error, elapsedMs, sandboxed,
paused, jobId}`。`paused` 是协作式暂停标志（worker 在下一个包边界挂起，阻塞中的
网络读会先读完当前包）；暂停期间 `elapsedMs` 不再累计。`jobId` 追加在尾部，使
`publish.list` 的每行快照自描述（其余回复回显请求的 id，空闲快照回空串）。
`publish.*` 三命令的**首列都是 `jobId`**（任务池键，由宿主生成，默认 `randomUUID`）；
`publish.status` 的 `jobId` 留空时引擎回**空闲快照**（`running:false`），宿主据此在没有任何任务时也返回结构化状态，
不再抛 "无可用任务"。`hello` 的第四列 `sandboxed` 表示引擎是否**真正进入**沙箱（见 3.1 节）。
`progress` / `done` 回调来自 `TranscodeJob` 的 worker 线程，桥接用 mutex 保护快照，
主循环照常一问一答。`Cancel()` 是**协作式**的：worker 在下一个包边界停止，
所以 `publish.stop` 的立即回包可能仍是 `running:true`，随后 `publish.status` 收敛为 done。

`publish.start` 的列约定：

- 网络输出必须显式给 `format`（`flv`），否则 FFmpeg 无法从 URL 推断容器 → `INVALID_PARAMS`。
- `vcodec` / `acodec` 缺列默认 `copy`；**显式空列 = 丢掉该轨**（`-vn` / `-an`）。
- `realtime=1` 按输入时戳配速（直播必需），`0` 为离线尽快跑完。
- 文件输出被取消时 `finalize_on_cancel=true`，仍留下可播放容器。

### 3.2 bake.*（离线 HTML→MP4，HyperFrames 对齐）

`bake.start` 把一个 HyperFrames Studio 对齐契约的页面（`data-start/duration` 等属性驱动）
烘成 MP4：宿主校验旋钮后经 `bake.start` 交给 bridge，bridge **spawn 一次性 `xmedia-bake`
子进程**（macOS 上是 CEF 契约要求的 `.app` bundle），子进程管线：
CEF OSR（VirtualTime bake 时钟逐帧步进）→ 元素拆纹理（`data-*` 元素各自成为 GL 场景层）→
合成读回 → I420 → 编码封装（macOS 默认 `h264_videotoolbox`，其他平台 `libx264`——
kit 按 `avcodec_find_encoder_by_name` 查找，要的是**编码器名**而非编解码名）→
可选音频混合轨（AAC 192k）→ 分块无损拼接 → `<out>.html_elements.json` 元数据导出。

- **进度**：子进程 stderr 发 `PROGRESS\t<stage>\t<percent>`，bridge 解析进 events 队列
  （`BakeProgress` / `BakeDone`），宿主经 `xmedia.events` 排空并转发 `xmedia.bake` 事件。
- **取消**：`bake.cancel` → 子进程 SIGTERM（协作式：帧循环退出、自行删除半成品与分块文件、
  退出码 3）；8s 未退升级 SIGKILL，此时由 bridge 删除已知输出路径。
- **旋钮**（`optionsJson`，宿主 zod 校验）：`seconds / fps / width / height / codec / clock
  / chunks / data(window.update 注入) / hfSeconds(HF 秒制时序) / audio`。
  **时钟默认按页面来源选择**：本地页 `virtual_time`（VT 步进，确定性可复现）；
  **远程 URL 默认 `live`**——VirtualTime 会冻结 CEF 网络服务的定时器，远程页面
  TLS 握手永远完不成（实测 `SSL handshake failed / net_error -100` → 30s 无首帧），
  而墙钟 live 下远程页面烘焙正常（bilibili 首页 10 帧实测通过）。
- **非契约页不再黑屏（2026-11-19）**：kit 的元素合成器只绘制 `data-*` 元素 quads——
  CEF 整帧上传到**不可见** master 层供元素裁切，零元素的页面（普通网页/APP 页）
  会烘成纯黑（本产品首版实测踩中，且 ffprobe/路由断言全绿，纯黑毫无察觉）。
  现产品 CLI 在**零元素帧**时把整帧上传为可见背景层直接合成；契约页不受影响
  （元素照常走合成器）。verify 新增**首帧均值亮度断言**（>2，内置冒烟页）防回归。
- **成片路由**：唯一数据面例外——`GET /api/xmedia.bake.<jobId>`（200 + Range 206）。
  路由名即任务 ID（无路径参数可穿越）、文件**真实存在**才注册、表有界（24 条最旧淘汰）；
  发布路径仍然零字节经过 mediabase。
- **诚实降级**：未构建 `xmedia-bake`（`XMEDIA_BUILD_CEF=1`）时 `bake.start` 回
  编码错误、detail 指名 `bake binary not found`——拒绝一个不存在的能力，绝不静默 0。
- **沙箱豁免**：bridge 自身可上 seccomp/Seatbelt，但 bake 子进程**不继承**——Chromium
  多进程模型与该类沙箱互斥（CEF 有自己的渲染进程沙箱），README 特此记录这一刻意决定。

### 3.3 HF Studio 编辑器（独立 Python 进程，`@xmedia/host-studio`）

上游 kit 的 HF Studio 应用（HyperFrames 对齐创作工作台：Home 项目管理 / agent 对话 /
分镜叙事 Arc 模板 / 5 轨时间线 / 导出）以**第二个 sidecar** 接入：

- **进程**：`python3 studio/tools/hf_studio.py --serve --home --port 8120`（stdlib
  ThreadingHTTPServer，只绑 127.0.0.1）。编辑器 UI 与 REST API 由 Studio **自己提供**，
  浏览器直连——宿主只做监督与入口分发，**不代理任何 studio 字节**（与 MediaMTX 边界同构）。
- **vendored 切片 + 漂移闸门**：`scripts/sync-studio.mjs` 从 kit 检出同步 14 个文件 +
  `assets/sfx`/`templates` 到 `studio/`（副本独立运行），施加两处**机械变换**并断言锚点：
  T1 `bake_bin()` 接缝（env `XMEDIA_BAKE_BIN` → 产品 `engine/build/xmedia-bake[.app]` 探测，
  导出/分镜帧因此走产品烘焙管线）；T2 agent 提示词的机器路径参数化（上游硬编码
  `/Users/.../avbase`）。`check:xmedia-drift` = `sync-studio --check` + 协议漂移检查。
- **身份对齐**：Studio 默认项目根 `~/.xmedia/projects` 与本产品身份目录 `.xmedia` 是
  **同一个目录**（刻意：项目数据在产品 home 内）。
- **监督**：spawn/崩溃事件（`xmedia.studio`）/重启上限/秒退判定都在能力包，
  `ctx.effect` 清理；`python3` 缺失时如实报告未运行（verify 断言）。
- **agent 对话**：规则引擎开箱即用；`claude`/`codex` CLI 在 PATH 上时自动启用子进程
  模式（5 轮历史 + 每轮 undo 快照）；可选 LLM 走 `XMEDIA_LLM_ENDPOINT/_API_KEY/_MODEL`。

**为什么用 `TranscodeJob` 而不是同步 `Transcode()`**：桥接是单线程 stdin 循环，
同步调用会冻结整条命令通道，导致 `status` / `stop` 无人应答。`TranscodeJob`
自带 worker 与 cancel，正是为异步宿主准备的。

### 3.1 四项企业级补强（协议单一真源 / 沙箱 / 可观测 / 任务池）

**1) 协议单一真源（`protocol/contract.json`）**
动词与列布局只写在一处 JSON。C++ 侧由 `scripts/gen-protocol.mjs` 生成
`engine/src/xmedia_protocol.h`（动词字面量、`Framing` 枚举、`*Req` / `*Res` 列索引枚举），
TS 侧 `packages/host/engine/src/protocol.ts` 直接 `import` 同一份 JSON（`resolveJsonModule`，
`VERB.PUBLISH_START === 'publish.start'`）。`pnpm run gen:protocol` 重生成头文件；
CMake 在 `contract.json` 变化时**自动重生成**；`pnpm run verify:protocol` 校验头文件覆盖全部动词；
`verify:xmedia` 比对 `contract.json` 与头文件是否漂移。C++ 侧不再手写任何动词字符串。

**2) 进程沙箱（`--sandbox`）**
`engine/src/sandbox.h` + `sandbox.cc` 提供 `xmedia_sandbox::ApplySandbox(bool)`：
- POSIX 资源上限（CPU 600s / 地址空间 2 GiB / 单文件 2 GiB / 打开文件 1024），**任何平台生效**；
- Linux：seccomp-BPF 系统调用白名单（未知调用返回 `EPERM`）；
- macOS：Seatbelt 最小档案（deny-default + 读 / `/tmp` 与 `/var/folders` 写 / 外连网络 / 自信号）。
`sandboxed` 标志**如实反映平台沙箱是否真正生效**：Linux 上 seccomp 应用成功 → `true`；
macOS 的废弃 `sandbox_init` API 不接受内联档案（报 `profile not found`），
此时如实回 `false` 并在 stderr 说明，**绝不谎报已隔离**——POSIX 资源上限仍照常应用。
沙箱为 best-effort、非致命：应用失败只记日志、不中止启动。

**3) 可观测性（metrics）**
`packages/host/engine/src/metrics.ts` 的 `Metrics` 类在进程内计数：
`jobsStarted / jobsSucceeded / jobsFailed / activeJobs / failureReasons / recent`（最近窗口）。
完成事件**幂等入账**（`recordCompletion` 重复调用返回 `false`），避免重复统计。
控制面新增 `xmedia.metrics` API；`xmedia.engine.state` 与 health 也携带 `sandboxed` 与 `metrics` 快照。

**4) 任务池（破除 BUSY）**
旧的"一个引擎只跑一个 `TranscodeJob`、第二个回 `BUSY`"已废弃。C++ 用
`std::map<std::string, std::unique_ptr<Job>>` 以 `jobId` 为键并发跑多个 `TranscodeJob`；
`publish.start` 返回 `jobId`，`publish.status` / `publish.stop` 按 `jobId` 路由，互不干扰。
`Job*` 地址在 `std::map` 中稳定，worker 回调可安全捕获。空闲（无 `jobId`）的 `publish.status`
返回中性快照（`running:false`）而非报错。

### 3.4 转码任务监控（暂停 / 继续 / 全池快照）

在任务池之上补齐了"看得见、按得住"的监控面，三层各加一件东西：

- **kit（`TranscodeCancelToken`，协作式）**：新增 `Pause() / Resume() / IsPaused() /
  WaitWhilePaused()`。暂停与取消同构——worker 在**下一个包边界**挂起（条件变量门闩，
  `Cancel()` 会唤醒已挂起的 worker，所以"暂停中取消"不需要先恢复）；与 `Cancel()` 不同，
  暂停**不中断阻塞中的 AVIO 读**（直播输入的读会先读完当前包）。`Transcode()` 主循环在
  读包前过一次门闩，`cancel == nullptr` 的同步调用方零变化。kit 单测 +2：暂停后进度冻结、
  恢复后跑完且输出可解码；暂停中取消得到 `kCancelled`。该改动已提交并合入
  **kit 上游 main（`04d6291`，2026-11-21）**。
- **bridge（协议动词）**：`publish.pause` / `publish.resume` 幂等（未知/已完成任务直接回
  快照）；`publish.list` 一次回全池快照（每行带 `jobId`）；`PublishSnapshot` 记
  `paused_at_ms / paused_total_ms`，`elapsedMs` 扣除暂停时长（挂起期间耗时不再虚涨）。
  `PublishPaused / PublishResumed` 进 `events` 队列。
- **TS + UI**：`xmedia.publish.pause/resume`（mutates）与 `xmedia.publish.jobs`（只读）
  注册进 API 与 agent 工具表；页面新增「转码任务监控」section——新建离线转码表单
  （输入/输出/编码器，空编码器字段**不发列**：显式空列 = 丢轨）+ 全池表格
  （进度条/状态徽章/耗时，每行 暂停/继续/停止），1s 轮询 `xmedia.publish.jobs`。

`verify:xmedia` 新增两类断言：fake 引擎的 pause→list→resume 形状链，以及**真实引擎的
离线暂停端到端**（`XMEDIA_MEDIA` 存在时：file→file 启动 → progress≥1 → 暂停 →
进度冻结 → 恢复 → 跑完且输出存在）。

---

## 四、MediaMTX 与观看地址

配置文件：`product/xmedia/mediamtx.yml`（v1.21.x 键名，loopback、无鉴权、不录制）。
只开 RTMP(:1935)、WHEP(:8889)、HLS(:8888) 和 v3 API(:9997)，其余协议全关。
`paths: all_others` 是通配，任意流路径都能发布，无需改配置。

```sh
mediamtx product/xmedia/mediamtx.yml          # 需要自备二进制（brew install mediamtx 或官方 release）
pnpm run host:xmedia                          # http://127.0.0.1:3092
```

打开页面 → 填输入源 → 「开始发布」→「观看（WHEP）」（前端会自动等待首帧；
若当前没有活跃推流，且页面已填输入源，会自动重新发布）。

### 四个实测踩过的坑

**1. 三个 URL 必须指向同一个 MediaMTX path。**
MediaMTX 从 RTMP URL 的**整个** host 之后的部分取 path：
`rtmp://h:1935/live/key` 的 path 是 `live/key`，而 WHEP 要查 `/live/key/whep`。
初版 `publishBase` 带 `/live` 而 WHEP 不带，实测报
`no stream is available on path 'key'`。现在 `viewerUrls()` 自动把
`publishBase` 的路径前缀带到 WHEP/HLS，并且**默认 `publishBase` 不含 `/live`**
（`rtmp://127.0.0.1:1935`），保证三者一致。

**2. WHEP 不能带 AAC 音轨。**
MediaMTX v1.21 的 WebRTC egress 遇到 AAC 会让**整路会话**失败：
`400 {"error":"codecs not supported by client"}`（真实 SDP offer 实测）。
纯 H264 流返回 `201 Created` + SDP answer。因此
`xmedia.publish.start` 对**网络输出默认丢弃音频**（显式空 `acodec`），
对**离线文件输出默认保留两轨**（那才是转码服务的主业）。
需要音频的实时验收走 HLS（但原生 HLS 只在 Safari/iOS 可用），或显式传 `audioCodec`。
前端 WHEP 客户端也只加 video transceiver，与验证过的 offer 一致。

**3. `no stream is available on path '…'` 最常见的原因是"流已经结束"。**
MediaMTX 只在**发布者保持连接**时持有 path。文件片源在 `realtime=1` 下按输入时戳配速，
播完 `publish.status` 变成 `running:false / done:true / progress:100`，RTMP 连接随即断开，
`/v3/paths/list` 立刻变空。此时点观看（WHEP 或 HLS）都会得到
`no stream is available on path 'test'`，**与路径错配无关**（坑 1 的错长一样，要按 status 区分）。
首帧尚未到达的启动窗口也会报同一句。前端已处理：观看前检查任务状态、无活跃流时自动重新发布、
对这句错误按 400ms 重试最多 12s；观看中片源正常播完会自动重新发布并重连 WHEP。
诊断命令：

```sh
curl -s http://127.0.0.1:9997/v3/paths/list | python3 -m json.tool   # items 为空 = 没有流
curl -s http://127.0.0.1:3092/api/health | python3 -m json.tool      # xmedia.publish.running
```

需要真正不间断的画面，用屏幕采集等无限输入源；有限片源只能靠重发保持画面（中间有短暂黑屏）。

**4. WHEP 连接成功但画面全黑：stream copy 的长 GOP 没有 IDR。**
这是"201 + SDP answer 都正常，`readers` 也连上了，但 `<video>` 永远黑"的原因。
WebRTC reader 必须从一个 **IDR 关键帧**开始解码；`videoCodec=copy` 会把源片的
GOP 原样送进 MediaMTX。实测 `curve.mp4`（1080p High）前 120 帧只有 **1 个 I 帧**，
其余全是 B/P：Chrome 收到 `packets=55 / bytes=64KB`，但 `framesDecoded=0`、
`keyFrames=0`、`video.readyState=0`。对照组（FFmpeg `-g 25` 规范片源 copy 推流）
同一套 WHEP 客户端 `frames=165 / keyFrames=7 / readyState=4`，画面正常。
`answer` 的 `fmtp` 也没有 `sprop-parameter-sets`，所以不能指望带外 SPS/PPS 兜底。

修法：`xmedia.publish.start` 对**实时网络输出默认重新编码**（macOS
`h264_videotoolbox`，其他平台 `libx264`），由编码器产生规律 IDR；**离线文件输出仍用
`copy`**（没有浏览器在等关键帧）。可用 `XMEDIA_LIVE_VCODEC` 换成本机 FFmpeg 实际
支持的编码器，或在单次调用里显式传 `videoCodec`。本机 pinned FFmpeg **不含
libx264**（`video encoder: "libx264" not in this FFmpeg build`），所以 macOS 默认走
VideoToolbox。`publish.status` 会回显 `videoCodec` 便于诊断。

用同一条 `curve.mp4` 验证修法：改 `h264_videotoolbox` 后 Chrome 得到
`frames=200 / keyFrames=18 / readyState=4 / videoWidth=1920`；产品页真实浏览器
点「开始发布」→「观看」得到 `readers=1`、`outboundBytes≈25MB`、视频区域显示实际画面。
**若坚持用 `copy`，请自己保证输入是短 GOP、带 in-band SPS/PPS 的 H264。**

**远程访问**：浏览器必须能直连 MediaMTX 端口，不是宿主能连就行。
按 viewer 侧地址覆盖 `XMEDIA_PUBLISH_BASE` / `XMEDIA_WHEP_BASE` / `XMEDIA_HLS_BASE`；
跨域还需 MediaMTX 的 CORS 与（生产环境的）鉴权/TLS，这些是部署配置，不是产品代码负债。

**屏幕采集**：xmedia-kit 没有独立采集模块；把 FFmpeg 设备 URI 当 `input` 喂给
`publish.start`（macOS `avfoundation`、Linux `x11grab`、Windows `gdigrab`）。
`realtime` 对 live input 会被忽略（设备自身节拍即时钟）。设备 demuxer 兼容性需按目标机型实测。

---

## 五、落地结构

```
product/xmedia/
├─ mediamtx.yml                  本地验收用 MediaMTX 配置
├─ protocol/
│  └─ contract.json             线协议唯一真源（动词 / 列布局 / 版本）
├─ engine/
│  ├─ CMakeLists.txt            find_package / add_subdirectory；显式链接 xmedia::transcode
│  ├─ cmake/smoke.cmake         ctest：hello/ping/publish.*/events/quit
│  └─ src/
│     ├─ mediabase_bridge.cc    线协议 + TranscodeJob 发布（无 Player）+ 任务池
│     ├─ xmedia_protocol.h      (生成) contract.json → C++ 动词/列常量
│     ├─ sandbox.h / sandbox.cc 进程沙箱（POSIX rlimit + Linux seccomp / macOS Seatbelt）
├─ packages/
│  ├─ host/engine/
│  │  ├─ index.ts               @xmedia/host-engine（能力包；含 Metrics、任务池、sandbox 状态）
│  │  ├─ protocol.ts            (import) contract.json → TS 端 VERB / 列常量
│  │  └─ metrics.ts             Metrics 类（幂等计数 + 最近窗口）
│  └─ bundle/app/               @xmedia/bundle-app（cordis.patch.yml，端口 3092；
│                                组合 @xmedia/host-mtx-bridge 桥）
├─ apps/
│  ├─ cli/                      BootIdentity(XMEDIA_ / .xmedia) + 薄入口
│  └─ web/dist/                 零依赖壳 + ESM 插件：index.html（壳/loader/registry）
│                                + whep.js（共享模块镜像）+ plugins/{manifest.json, _lib.js,
│                                  live.js, monitor.js, stream.js, bake.js, studio.js, engine.js}
├─ scripts/
│  ├─ build-engine.mjs          cmake 配置/构建/ctest 转发
│  ├─ gen-protocol.mjs          contract.json → engine/src/xmedia_protocol.h
│  ├─ verify-protocol.mjs       (verify:protocol) 头文件覆盖全部动词
│  ├─ sync-whep.mjs             libs/whep/whep.js → apps/web/dist/whep.js 字节一致镜像
│  └─ verify.mjs                端到端冒烟（fake / 真实 C++ / 真实 MediaMTX）
├─ tests/
│  ├─ support/fake-engine.mjs   Node 版线协议测试替身（任务池 + sandbox 镜像契约）
│  ├─ support/host.ts           产品测试挂具
│  └─ host.test.ts              6 个世界 / 15 个用例（含沙箱 / 指标 / 任务池 / 协议契约）
└─ README.zh.md
```

能力包注册：**14 个 `xmedia.*` 控制面方法（含 `xmedia.metrics` 与监控三动词
`publish.pause/resume/jobs`）、10 个 agent 工具、1 条数据面路由（烘焙成片拉取）、
3 类事件、health、capabilities manifest**。没有 `ws /stream` 通道。
此外经**能力级组合**（见决策 9）挂载 `@xmedia/host-mtx-bridge` 宿主桥
（已从原独立流服务台产品完整迁入本仓）：20 个 `mediamtx.*`
控制面方法 + 8 个 agent 工具 + health 键 `mediamtx`，字节不过桥。
`server` 与 `ui-web` 一行未改。

WHEP 客户端是**仓库级共享模块** `libs/whep/whep.js`（纯 ESM、零依赖、带
`whep.d.ts`）。xmedia 的 `apps/web/dist/whep.js` 是它的**字节一致镜像**（由
`pnpm run sync:whep` 生成，`verify:xmedia` 断言一致）。两方共用，不会漂移。

---

## 六、构建 C++ 引擎

前置：CMake ≥ 3.20、C++20 编译器，以及 **FFmpeg 4.4–7.x（libavcodec 58..61）**。
`FindFFmpeg.cmake` 会拒绝 FFmpeg 8（Homebrew 当前默认），报 `found libavcodec 62`。
用 `XMEDIA_FFMPEG_ROOT` 指向项目自带的 pinned 7.1.1
（本机 `/Users/samychen/Develop/avbase/tools/build`），或先跑 xmedia-kit 的 `tools/setup_ffmpeg.sh`。

```sh
# A) 已 install 的 SDK（只编译 sidecar 一个 .cc，秒级）
cmake --install <xmedia-kit 构建目录> --prefix /path/to/prefix
XMEDIA_KIT_DIR=/path/to/prefix pnpm run build:xmedia:engine

# B) 直接用源码树（会重建整个 SDK，无需 install）
XMEDIA_KIT_SOURCE_DIR=/path/to/xmedia-kit \
XMEDIA_FFMPEG_ROOT=/path/to/pinned-ffmpeg \
XMEDIA_DEPS_LIBDIR=/path/to/pinned-ffmpeg/lib \
  pnpm run build:xmedia:engine
```

产物：`product/xmedia/engine/build/xmedia-bridge`。`XMEDIA_DEPS_LIBDIR` 写入运行时 rpath。

### 6.1 烘焙工具链（可选，`XMEDIA_BUILD_CEF=1`）

`xmedia-bake`（离线 HTML→MP4）需要 kit 的两个 **opt-in 层**：CEF（二进制 distro，
kit 自动探测 `<kit>/../cef` 与 `~/Develop/vspo/cef`）与 GLFW（brew install glfw）。
只支持**源码树消费**（CEF/GLFW 目标不随 installed SDK 导出）：

```sh
XMEDIA_BUILD_CEF=1 \
XMEDIA_KIT_SOURCE_DIR=/path/to/xmedia-kit \
XMEDIA_FFMPEG_ROOT=/path/to/pinned-ffmpeg \
XMEDIA_DEPS_LIBDIR=/path/to/pinned-ffmpeg/lib \
  pnpm run build:xmedia:engine
```

产物：`engine/build/xmedia-bake.app`（macOS CEF 契约要求的 bundle，bridge 探测
自身同级目录自动发现；`XMEDIA_BAKE_BIN` 可显式覆盖）。缺 distro 时 kit 降级为
`XMEDIA_HAS_CEF=0`，bake 目标不构建、配置不报错，宿主对 `bake.start` 回**编码拒绝**
并指名原因。许可姿态：CEF 的 BSD 许可与 Chromium 组件由部署方的 distro 承担，
kit 不重分发、本产品不打包任何 CEF 二进制。

**四个必须知道的点**（都是实测后修正的）：

- 消费方 CMake 工程要 `project(... LANGUAGES C CXX)`：SDK 的 `FindFFmpeg.cmake`
  用 `try_run()` 编译 `.c` 版本探针，只启用 CXX 会配置失败。
- `xmedia::xmedia-kit` 是 in-tree ALIAS，**不在导出集合**；install 模式链接
  唯一导出的 `xmedia::player`（它携带 media/FFmpeg 依赖，不代表本产品使用 Player）。
  而 **transcode 是 opt-in target**（`media/CMakeLists` decision D11）：
  umbrella 不带它，宿主必须显式链接 `xmedia::transcode`，否则 `TranscodeJob`
  链接失败。install 模式该库只安装不导出，用 `find_library` 从 `<prefix>/lib` 解析。
- **B 方案的 include 根**：SDK target 用 `$<BUILD_INTERFACE:${CMAKE_SOURCE_DIR}>`，
  被 `add_subdirectory()` 消费时指向消费方源码目录，`render/gl/gl_export.h` 等全部找不到。
  本工程在 `add_subdirectory` 前用 `include_directories("${XMEDIA_KIT_SOURCE_DIR}")`
  从父作用域补回根路径（不改上游）。
- 顶层 SDK configure 也要 pinned `XMEDIA_FFMPEG_ROOT`，否则 Homebrew 的
  FFmpeg 8 / libavcodec 62 会被 `FindFFmpeg.cmake` 拒绝。

**IDE / 单文件检查**：`clang++ -fsyntax-only render/gl/gl_api.h` 会因相对 SDK 根引用而失败。
走 CMake 或让编辑器读取编译数据库：

```sh
cmake -S /path/to/xmedia-kit -B /path/to/xmedia-kit/build/clangd \
  -DXMEDIA_FFMPEG_ROOT=/path/to/pinned-ffmpeg \
  -DXMEDIA_ENABLE_FFMPEG=ON -DXMEDIA_ENABLE_SDL2=OFF \
  -DXMEDIA_BUILD_TESTS=OFF -DXMEDIA_BUILD_EXAMPLES=OFF \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

---

## 七、运行与环境变量

```sh
pnpm install
pnpm run build:xmedia:engine
mediamtx product/xmedia/mediamtx.yml       # 另一个终端
pnpm run host:xmedia                       # http://127.0.0.1:3092
```

无需为引擎路径设任何变量：组合层默认用
`<产品根>/engine/build/xmedia-bridge`（`ctx.appPaths.root`，不依赖 PATH/cwd）。
`XMEDIA_ENGINE_BIN` 可覆盖（测试替身、另一份产物）。

| 变量 | 作用 | 默认 |
|---|---|---|
| `XMEDIA_ENGINE_BIN` | sidecar 可执行/解释器 | `<产品根>/engine/build/xmedia-bridge` |
| `XMEDIA_ENGINE_ARGS` | 逗号分隔的额外 argv | 空 |
| `XMEDIA_ENGINE_TIMEOUT_MS` | 单命令超时 | 30000 |
| `XMEDIA_ENGINE_AUTO_RESTART` / `_MAX_RESTARTS` / `_RESTART_DELAY_MS` | 崩溃监督 | 开 / 3 / 500 |
| `XMEDIA_PUBLISH_BASE` | MediaMTX RTMP 基址 | `rtmp://127.0.0.1:1935` |
| `XMEDIA_WHEP_BASE` | WHEP 基址（浏览器可达） | `http://127.0.0.1:8889` |
| `XMEDIA_HLS_BASE` | HLS 基址（浏览器可达） | `http://127.0.0.1:8888` |
| `XMEDIA_PUBLISH_PATH` | 默认流路径 | `xmedia` |
| `XMEDIA_LIVE_VCODEC` | 实时网络输出的视频编码器（覆盖平台默认） | macOS `h264_videotoolbox` / 其他 `libx264` |
| `XMEDIA_BAKE_BIN` | 烘焙 CLI 可执行（空 = bridge 探测自身同级 `.app`/平铺二进制） | 空 |
| `XMEDIA_BAKE_ROUTE` | 烘焙成片经 `/api/xmedia.bake.<jobId>` 拉取路由对外提供 | 开 |
| `XMEDIA_BUILD_CEF=1` | （仅构建期）同时构建 `xmedia-bake`：需要 kit 的 CEF distro + GLFW | 关 |
| `XMEDIA_STUDIO_PYTHON` / `XMEDIA_STUDIO_SCRIPT` | Studio 服务器解释器 / 入口脚本 | `python3` / `<产品根>/studio/tools/hf_studio.py` |
| `XMEDIA_STUDIO_PORT` | Studio loopback 端口（浏览器直连，宿主不代理） | 8120 |
| `XMEDIA_BAKE_BIN` | 烘焙 CLI（Studio 导出/分镜帧经此接缝调用） | 空 = bake_bin() 探测 |
| `XMEDIA_STUDIO_AUTO_START` / `_AUTO_RESTART` / `_MAX_RESTARTS` / `_RESTART_DELAY_MS` | Studio 监督策略 | 开 / 开 / 3 / 500 |
| `XMEDIA_KIT_ROOT` | （agent 对话提示词用）kit 源码根，默认为同步副本根 | 空 |
| `XMEDIA_MTX_SERVER_URL` | MediaMTX v3 API 基址（桥接能力；未起时 `mediamtx.*` 如实报错） | `http://127.0.0.1:9997` |
| `XMEDIA_MTX_USERNAME` / `XMEDIA_MTX_PASSWORD` / `XMEDIA_MTX_SERVER_TOKEN` | MediaMTX API 鉴权（auth* 开启时才需要；token 优先于 basic） | 空 |
| `XMEDIA_MTX_SERVER_NAME` / `XMEDIA_MTX_SERVERS_FILE` / `XMEDIA_MTX_TIMEOUT_MS` | 桥的多服务器注册表与超时；serversFile 默认 `<home>/xmedia-mtx-servers.json` | `default` / 空 / 8000 |
| `XMEDIA_STRICT_CAPABILITIES=1` | manifest 不实即拒绝启动 | 关 |
| `XMEDIA_READONLY=1` | 拒绝一切 `mutates` 方法 | 关 |
| `XMEDIA_ENGINE_SANDBOX=1` | 启动引擎时加 `--sandbox`（POSIX 资源上限；Linux seccomp / macOS Seatbelt best-effort） | 关 |
| `XMEDIA_TOKEN` / `XMEDIA_LOG_LEVEL` / `PORT` | 令牌 / 日志 / 端口 | 无 / info / 3092 |

---

## 八、验证

```sh
pnpm run typecheck:xmedia
pnpm run verify:xmedia:compose
pnpm run gen:protocol                     # contract.json → engine/src/xmedia_protocol.h
pnpm run verify:protocol                  # 头文件覆盖全部动词、版本一致
pnpm run test:xmedia                      # 15 个用例，无需 C++ 工具链
pnpm run verify:xmedia                    # fake engine 端到端

# 真实 C++ 引擎 + 真实 MediaMTX 全链路（需先启动 mediamtx）
XMEDIA_ENGINE_BIN=$PWD/product/xmedia/engine/build/xmedia-bridge \
XMEDIA_MEDIA=/path/to/clip.mp4 \
XMEDIA_PUBLISH_OUTPUT=rtmp://127.0.0.1:1935/verify \
XMEDIA_MTX_API=http://127.0.0.1:9997 \
  pnpm run verify:xmedia

# （可选，仅 Linux 真实引擎）确认 --sandbox 真正生效
XMEDIA_TEST_SANDBOX=1 XMEDIA_ENGINE_BIN=$PWD/product/xmedia/engine/build/xmedia-bridge \
  pnpm run verify:xmedia
```

`verify:xmedia` 覆盖：health → strict `capabilities.verify` → `api.list` / `tools.list` /
`api.streams`（断言 **`xmedia.frames` 与整条引擎自检面已不存在**）→ 协议契约检查（头文件覆盖全部动词、版本=1）
→ `hello` → viewer URL → `publish.start/status/stop`（含空闲 `status` 与 `jobId` 路由）
→ **监控动词链**（fake：`publish.pause` → `publish.list` 全池快照 → `publish.resume`）→
**真实引擎离线暂停端到端**（`XMEDIA_MEDIA` 存在时：file→file → 暂停 → 进度冻结 → 恢复 → 跑完）
→ `xmedia.metrics` 结构化指标 → **bake 全链**（fake 引擎跑通；真实引擎烘真实页面后
ffprobe 解码断言；无工具链时断言诚实拒绝）→ （有 MediaMTX 时）v3 API 确认 `path.ready` 与轨列表、
**默认无 AAC**、**WHEP 真实 SDP 握手返回 201 + answer** → `events` → 监督状态（含 `sandboxed`）
→ 页面含 `<video>`、不含帧订阅与自检区块、含转码任务监控区。

### 本机实测（2026-11-07，macOS / x86_64）

| 检查 | 结果 |
|---|---|
| `cmake --build` + `ctest` | ✅ 链接 `xmedia::transcode`；`sandbox.cc` / 生成的 `xmedia_protocol.h` 编译通过；线协议冒烟通过 |
| `gen:protocol` / `verify:protocol` | ✅ `contract.json` → `xmedia_protocol.h`（10 动词）；头文件覆盖全部动词、版本=1 |
| **真实烘焙端到端（2026-11-17，XMEDIA_BUILD_CEF=1）** | ✅ `xmedia-bake.app` 组装；真引擎烘真实页面 9.7s（CEF OSR VT 时钟 + h264_videotoolbox 10 帧）→ 成片路由 `200` + `Range 206` → ffprobe 解码断言通过 |
| 真实引擎无烘焙工具链 | ✅ `bake.start` 编码拒绝，detail 指名 `bake binary not found`（诚实降级断言进 verify） |
| 真实 RTMP 推流 → MediaMTX | ✅ `path ready`，`source.type=rtmpConn`，`tracks=["H264"]`，`inboundBytes≈180 KB` |
| **WHEP 真实 SDP 握手** | ✅ `201 Created` + `Location` + 完整 SDP answer |
| WHEP 路径一致性（曾踩坑） | ✅ 同路径返回 201；错路径返回 `no stream is available` |
| AAC 约束 | ✅ 带 AAC → 400；丢音频 → 201，已固化进 verify 断言 |
| **真实 Chrome 像素渲染（headless + CDP）** | ✅ 规范片源 copy：`frames=165 / keyFrames=7 / readyState=4`；`curve.mp4` copy：`frames=0`（黑屏）；改 `h264_videotoolbox`：`frames=200 / keyFrames=18 / 1920×1080` |
| **产品页端到端浏览器验收** | ✅ 点「开始发布」→「观看」，`WHEP 播放中`、`readyState=4`、`currentTime=8.75`、`readers=1`、`outboundBytes≈25MB`、截图有实际画面 |
| 真实 C++ 引擎 `--sandbox` | ✅ Linux seccomp 应用 → `sandboxed:true`；macOS Seatbelt 内联不支持 → 如实 `false`（POSIX 资源上限仍生效），stderr 说明 |
| 任务池（多 `jobId` 并发） | ✅ 两个 `publish.start` 拿到不同 `jobId`，按 `jobId` 路由互不干扰，停止一个不影响另一个 |
| `xmedia.metrics` | ✅ 幂等计数；`jobsStarted/Succeeded/Failed/activeJobs/failureReasons/recent` 结构化返回 |
| `typecheck:xmedia` / `verify:xmedia:compose` | ✅ 全绿 |
| `test:xmedia` | ✅ 19/19（7 世界：正常 / **烘焙控制面** / 无引擎 / 崩溃监督 / 只读 / 沙箱 / 协议契约；含"任务池并发 / 指标幂等 / 空闲 status / 沙箱状态 / 成片路由 200+206 / 取消不留半成品 / 失败注入"） |
| `verify:xmedia` fake + 真实 C++ 各一遍 | ✅ 全部检查通过（含"自检面已移除 / 协议契约一致"逐项断言） |

### 转码任务监控（2026-11-21，本机 arm64，kit `26e96c8` + 协作式 Pause 补丁）

| 检查 | 结果 |
|---|---|
| kit `TranscodeJobTest`（含 `PauseParksThenResumeCompletes` / `CancelWhilePausedReportsCancelled`） | ✅ 16/16；套件内 1 个与本改动无关的环境性失败（`AudioEncoderTest.EveryAvailableEncoderInitializes`：pinned FFmpeg 缺 19 个第三方音频编码器） |
| 真实引擎离线暂停端到端（`XMEDIA_MEDIA`=60s 片源，libx264 重编码） | ✅ progress=9% 时暂停 → `paused:true`、进度与 `elapsedMs` 冻结（107ms 两次采样一致）→ 恢复 → `ok:true` 收口、`elapsedMs` 1854ms（暂停窗口被扣除）、输出文件存在 |
| 真实引擎 `verify:xmedia` 全链 | ✅ XMEDIA OK（含协议 13 动词、监控动词链 fake 断言、诚实拒绝、Studio、页面标记） |
| 浏览器验收（fake 引擎，监控页） | ✅ 新建 2 个并发任务 → 表格两行"运行中" → 暂停 A（黄色"已暂停"徽章、B 不受扰）→ 继续 → 停止（"已取消"徽章）→ 空表单被前端校验拦截；暂停期间耗时不再累计 |
| 顺带修复 | ✅ 真实引擎 `publish.*` 的 `elapsedMs` 恒为 0 的既有 bug（PublishSnapshot 一直没写 `started_ms`，fake 引擎掩盖了它） |

降级语义：引擎二进制不存在时宿主照常启动，调用返回带码
`UNAVAILABLE (-32002)` / `engine.notRunning`。先调 `xmedia.engine.state` 看
`running / pid / restarts / binary`，常见原因是没跑 `build:xmedia:engine` 或路径写错。

> 基座全量 `pnpm test` 在本沙箱有若干与本次改动无关的环境失败（裸 `pnpm`、
> Node 缺 `--permission`、`shm-ring` 计时波动），产品层未触及 `packages/`。

---

## 九、设计决策与边界

1. **不改上游、不进基座**。sidecar 是独立 CMake 工程，通过 SDK 官方的
   `find_package(xmedia-kit)` / `add_subdirectory` 消费；`@mediabase/*` 对 xmedia 一无所知。
   `publish.*` 是产品动词，协议版本 1 不变。
   **消费版本**：kit `main@26e96c8`（2026-11-18 pull，含 HF 对齐烘焙重构、GPU 合成修复、
   Studio 应用）——重建后 bake/bridge 无需产品侧改动即兼容，真机烘焙端到端复验通过。
   2026-11-21 本机 kit 检出更新至 `main@04d6291`（含协作式 Pause/Resume），
   产品引擎已重建并复验（离线暂停端到端 ✅）。
2. **播放交给浏览器**。音频、A/V 同步、seek、硬解、色彩管理、字幕由 `<video>` 与
   MediaMTX 提供，Host 不实现任何帧传输、背压或 pacing；C++ 侧连 Player 都不实例化。
   这是"用最小复杂度换可靠性"。
3. **控制面/媒体面彻底分离**。Host 只发命令、只返回 URL；`ctx.api.route` 有且仅有
   **烘焙成片拉取路由**（`xmedia.bake.<jobId>`，文件存在才注册、表有界）——发布路径仍
   零字节经过 mediabase，也不使用 `EngineClient.readScratch()`。
4. **能力自注册 + 边界校验**。方法、工具、health、manifest 全在 `apply()` 注册；
   参数用 `@mediabase/schema`，引擎 JSON 列显式解析成带码 `ENGINE` 错误。
5. **监督策略留在产品层**。`EngineClient` 只报 `onExit`；重启/退避/秒退判定在能力包，
   `ctx.effect` 保证销毁时杀子进程、清定时器。
6. **零依赖壳 + ESM 插件**。页面是一个**壳**（布局/主题/调用抽屉/插件 loader）
   + `plugins/` 下的原生 ESM 插件，无打包器。**插件契约刻意对齐基座 `UiPanel`**
   （`packages/client/ui` 的 `{id,title,area,order,component}` → 本壳
   `{id,title,area,order,icon,mount(el,ctx)}`），registry 与基座同为响应式——
   `window.xmediaCtx.ui.register()` 运行时注册即上侧栏（对齐基座
   `window.mediabaseCtx` 惯例）。新功能 = `plugins/` 加一个 `.js` +
   `manifest.json` 一行，不改壳。**升级路径**：当插件需要 i18n/theme/跨产品
   复用时迁基座 web shell（`client.yml` roster），契约一一对应，迁移是机械
   翻译。`live.js` 经 `import … from '../whep.js'` 加载 WHEP 客户端——该
   `whep.js` 是仓库级共享模块 `libs/whep/whep.js` 的字节一致镜像，无 hls.js / mse.js。
   HLS 仅作原生支持浏览器的回退。
7. **边界 / 未做**：浏览器端像素渲染已用 headless Chrome + CDP 做过**一次性**真实验收
   （`readyState=4`、`videoWidth=1920`、`readers=1`、截图有画面），但**没有纳入 CI**——
   自动化回归仍只到 WHEP `201 + SDP answer` 与 MediaMTX v3 API；实时预览无音频（见第四节）；
   任务池已破除单 `BUSY` 限制（多个 `TranscodeJob` 以 `jobId` 并发），但仍**不**做多租户隔离、
   配额、长稳 soak、崩溃后播放位置重建；macOS 的 Seatbelt 因废弃 API 不支持内联档案而不生效
   （如实回 `false`，仅 POSIX 资源上限兜底），真正的进程沙箱以 Linux seccomp 为准；
   烘焙子进程**不继承** bridge 沙箱（Chromium 多进程模型与 seccomp/Seatbelt 互斥，CEF 自带
   渲染进程沙箱）——刻意豁免，见 3.2 节。HF Studio 编辑器已作为**第二个 sidecar** 接入
   （3.3 节）：vendored 切片 + 两处机械变换 + 漂移闸门；上游 `xmedia_mcp.py` MCP 门面
   与 `tools/web` 的 Vite 源树不在移植范围（前者与基座 agent/tools 重复，后者是构建期
   源码，产品消费其单文件构建产物 `studio_ui.html`）。
   这些是"内部验收工具"不需要的复杂度，不做。
8. **许可**：xmedia-kit BSD-3-Clause（`media/filters/legacy/` 内算法保留 LGPL-2.1），
   MediaMTX MIT；捆绑 FFmpeg 的链接与分发义务由**产品仓**承担。基座 MIT、不含原生二进制。
9. **MediaMTX 能力已完整并入本产品，不再是独立产品**。原独立流服务台产品的能力包
   与 UI 已全部迁入 xmedia：宿主桥 `@xmedia/host-mtx-bridge`（凭据留宿主侧、CORS 一次
   解决、归一词表、纯控制面无数据路由）由 bundle 的一行 cordis row 挂载，`mediamtx.*`
   方法与工具随宿主就绪。UI 侧四个零依赖 ESM 插件覆盖完整管理台——`stream.js`（推流状态：
   paths/sessions/recordings/playback/metrics + 路径增删 + 踢会话）、`player.js`（录像回放：
   单条 MSE 录制链 + 全链 scrubber，实时观看归 `live.js`）、`sync.js`（≥2 路多窗墙钟对齐回放）、
   `config.js`（全局配置编辑器 + 多服务器注册表）。三个"看"的视图职责互斥：
   `live.js` 实时 WHEP/HLS、`player.js` 单路录像、`sync.js` 多路录像对齐。
   `server` 与 `ui-web` 一行未改；`serversFile` 默认落在本产品 home
   （`.xmedia`），不与其他产品共享注册表。

---

## 十、排错

| 现象 | 检查 |
|---|---|
| `bake.start` 报 `bake binary not found` | 未构建烘焙工具链：`XMEDIA_BUILD_CEF=1 XMEDIA_KIT_SOURCE_DIR=… pnpm run build:xmedia:engine`（需要 CEF distro 与 GLFW）；或用 `XMEDIA_BAKE_BIN` 指向已有产物。烘焙旗标有粘性（换 SDK 源重建自动沿用），`XMEDIA_BUILD_CEF=0` 显式关闭 |
| **烘焙远程 URL 失败 `no first frame in 30s`** | 机器必须**网络可达**该页面（本机实测 `hyperframes.heygen.com` 直连 exit 7 被阻断）。且注意：烘焙输入应是**契约页面**（`data-start/duration` 驱动）；远程 APP 页面（如 Studio 编辑器本体）只会被当作普通网页烘焙其界面。推荐把页面/工程落到本地后走 `file://`。失败时 `bake.status` 的 `error` 现在携带子进程的具体死因 |
| 烘焙失败报 `video encoder: "h264" not in this FFmpeg build` | 用了编解码名当编码器名。宿主默认已按平台注入（macOS `h264_videotoolbox` / 其他 `libx264`）；直跑 CLI 或显式传参时请给**编码器名**（kit 按 `avcodec_find_encoder_by_name` 查找） |
| `bake.status` 停在 failed、`error` 为 `no first frame in 30s` | CEF 冷启动超预算或页面无法加载：先用浏览器/`curl` 确认页面可达；`file://` 页面的**脚本子资源必须内联**（OSR 对相对 file:// 脚本渲染黑屏）；第二次烘焙通常显著变快（CEF 暖缓存） |
| 烘焙产物黑屏/上下颠倒 | 先跑 `data:text` 之外的真实页面样本；上下颠倒说明读回翻转被改动（引擎按"画面方向与浏览器一致"处理行序） |
| 开始发布后立刻失败 | `publish.status` 的 `error`：网络输出缺 `format` 会报 `INVALID_PARAMS`；`SourceOpenFailed` 通常是 MediaMTX 没起来或端口不通 |
| `no stream is available on path '…'` | **先看 `/v3/paths/list`**：`items` 为空说明推流已结束或还没开始（第四节坑 3），重新「开始发布」即可；`/api/health` 里 `running:false / done:true` 可确认片源播完。只有推流中仍报错才是 path 不一致（坑 1）或未等首帧。前端已自动重发与重试 |
| WHEP 连接失败 | 先确认 `mediamtx.yml` 已启动、`webrtc: true`；HLS 回退同样需要活跃流，流结束点 HLS 也无效 |
| `codecs not supported by client` | 流里带了 AAC；用默认的丢音频策略，或显式传 `audioCodec: ''` |
| **信令 201、`readers` 有值，但画面全黑** | 十有八九是 `videoCodec=copy` 遇到长 GOP 片源（第四节坑 4）。看 `publish.status` 的 `videoCodec`；浏览器 `getStats()` 会显示 `packetsReceived>0` 但 `framesDecoded=0 / keyFramesDecoded=0`。改用默认重编码或 `XMEDIA_LIVE_VCODEC`；确认片源有规律 IDR。`ffprobe -show_frames -show_entries frame=key_frame,pict_type` 可数 I 帧 |
| 页面能看到地址但没画面 | 等 1–2 秒让首个关键帧到达 MediaMTX；查 v3 API `/v3/paths/list` 的 `ready` 与 `tracks`；若 `ready` 为真仍黑，按上一条查关键帧 |
| 编码器初始化失败 `video encoder init failed` | 本机 FFmpeg 不含 `libx264`。macOS 用默认 `h264_videotoolbox`，或按目标 FFmpeg build 设 `XMEDIA_LIVE_VCODEC`（如 `h264_vaapi`、`h264_nvenc`） |
| `publish.stop` 后仍显示运行中 | 协作式取消，worker 在下一个包边界退出；轮询 `publish.status` 会收敛 |
| `publish.pause` 后 `status` 仍 `paused:false` | 同为协作式：暂停请求已受理，worker 在下一个包边界才真正挂起；阻塞中的网络读会先读完当前包。轮询会收敛为 `paused:true` |
| 暂停中的任务 `elapsedMs` 不涨 | 预期行为：暂停时长被扣除，耗时只计实际编码时间 |
| 远程浏览器打不开 | WHEP/HLS 基址必须是**浏览器**可达的地址，并放行 8888/8889 端口与 CORS |
