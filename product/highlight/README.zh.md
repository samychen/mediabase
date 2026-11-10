# VHL × mediabase：视频高光引擎产品层（中文）

> 把 [samychen/video_highlight_engine](https://github.com/samychen/video_highlight_engine)
> （Python / Apache-2.0）作为 mediabase 的**第四个产品层**接进来：TS 侧只做控制面与数据面
> 路由，分析、评分、渲染全在受监督的 Python 子进程里完成。
>
> 本文记录分层、线协议、企业级约束、运行/验证方式与边界。所有数字都来自本机实测
> （macOS / x86_64 / Python 3.13 / FFmpeg 7.x，2026-11-08）。

---

## 一、结论与定位

**基座零改动**：`packages/`、`apps/`、`scripts/` 一个文件没动，根目录只加接线
（`package.json` 的 `*:highlight` 脚本、`.gitignore` 两行）。所有新增代码都在
`product/highlight/`。`@mediabase/*` 不认识「视频」「高光」任何一个词。

| 层 | 职责 |
|---|---|
| `vhl-bridge`（Python 子进程） | 探测、场景切分、音频能量、视觉显著性、字幕、多模态融合、FFmpeg 渲染 |
| `@vhl/host-highlight`（TS 能力包） | 进程监督、11 个控制面方法、5 个 agent 工具、3 条产物字节路由、health、metrics、manifest、任务日志（跨重启） |
| `@vhl/ui-highlight`（客户端插件） | 两个面板（控制 / 结果），选项目录驱动的参数面板、轮询、回放、字幕轨、信号可解释性、定位、导出 EDL |
| 浏览器 `<video>` | 从宿主字节路由拉成片，Range 直读；控制面不搬一个媒体字节 |

关键取舍：**Host 不做媒体处理**。它不理解像素，只监督一个进程、转发命令、把成片挂到一条
字节路由上。分析能力属于引擎，播放能力属于浏览器，中间没有第二套实现。

---

## 二、架构

```
  输入视频（绝对路径）
        │
        ▼
  vhl_bridge.py（受监督的 Python 子进程）          mediabase Host (:3093)
  ┌──────────────────────────────┐              ┌────────────────────────────┐
  │ highlight_core.HighlightPipeline │◄──────────┤ WS /rpc                    │
  │  probe → scenes → audio      │  tab 行一问一答 │  highlight.start/status/…  │
  │  → vision → subtitles        │              │  highlight.probe/models/…  │
  │  → scoring → render → report │─────────────►│                            │
  └───────────┬──────────────────┘  进度/阶段    └──────────┬─────────────────┘
              │ FFmpeg CLI（子进程内调用）                    │ 只返回 URL
              ▼                                             ▼
        成片 / .srt / timeline.json                GET /api/highlight.clip.<jobId>
                                                    （200 + Range 206，video/mp4）
                                                             │
                                                             ▼
                                                    浏览器 <video>
```

- **控制面**：命令、状态、进度、错误码。`highlight.start` 立即返回，长任务不占请求。
- **数据面**：一条 `api.route`，按 `jobId` 命名（路由名即任务 ID，没有可穿越的路径参数）。
- **进程边界**：模型崩溃不带走宿主；FFmpeg 以 CLI 调用，与被链接进二进制的 GPL 依赖保持距离。

---

## 三、线协议（单一真源）

`protocol/contract.json` 是唯一真源：TS 直接 `import`（`resolveJsonModule`），Python 通过
`scripts/gen-protocol.mjs` 生成 `engine/protocol_generated.py`，`verify.mjs` 断言两边都不漂移。

请求一条 tab 行，响应严格一问一答。**列索引语义**：`contract.json` 的 `request`/`response`
数组只列 payload 列，所以索引 `i` 对应线上第 `i+1` 个字段——第 0 列永远是框架词
（`hello`/`ping` 回动词本身，其余回 `ok`）。拒绝统一是 `err\t<CODE>\t<message>`。

| 动词 | 请求列 | 响应列 |
|---|---|---|
| `hello` | — | `protocol, engine, python, ffmpeg` |
| `ping` | — | `verdict` |
| `probe` | `path` | `mediaJson` |
| `analyze.start` | `jobId, input, output, optionsJson` | `jobJson` |
| `analyze.status` | `jobId`（空=最近一个） | `jobJson` |
| `analyze.cancel` | `jobId` | `jobJson` |
| `jobs.list` | — | `jobsJson` |
| `export.edl` | `jobId, path`（空=与成片同名） | `path` |
| `models.list` | — | `modelsJson` |
| `options.list` | — | `optionsJson`（选项目录：类型/默认值/范围/依赖能力/本机可用性/复合参数的子键） |
| `quit` | — | — |

**不认识的动词由谁拒绝。** 契约在宿主这一侧，引擎只是实现它。所以宿主**发之前**就用自己的
动词表拦住不在契约里的动词：`call()` 的参数类型是契约里的字面量（写错编译不过），运行时再兜
一层并报出动词与字符数——不花一次往返，也不让"本机缺陷"以引擎的口吻出现。引擎那侧的拒绝
必须**可回答**：引号包住收到的动词、给出字符数、列出本引擎支持的动词并指明动词表来自哪个文件。

```
未知动词: 'nalyze.status'(13 字符,动词表来自 contract.json);本引擎支持: analyze.cancel, analyze.start, analyze.status, …
```

旧文案 `未知动词: analyze.status` 不可回答：这个引擎**明明支持** `analyze.status`，报错却像在
说调用方拼错了；唯一有用的两条信息——"少了 1 个字符"和"是请求被截断，还是引擎的动词表旧了"
（`contract.json` vs 陈旧的 `protocol_generated.py`）——一句都没有。

**任务 JSON**：`jobId, state, stage, progress, input, output, error, createdAtMs, startedAtMs,
finishedAtMs, durationSec, fps, segments[{startSec,endSec,score,signals}], segmentCount,
srtPath, reportPath`。宿主在其上只加一个字段：`clipUrl`（数据面地址，未成功时为空串）。

**选项目录**里 `type` 有六种：`float / int / bool / str / strs / weights`。`weights` 是唯一的
复合类型（一个参数、七个信号子键），它的 `fields` 一并下发，所以渲染层不需要知道引擎有哪几个
信号。

**错误码映射**：引擎回 `err\tCODE\tmsg`，宿主转成 `@mediabase/rpc` 的码，客户端可分支处理：
`INVALID_PARAMS→-32602`、`NOT_FOUND→-32001`、`UNAVAILABLE→-32002`（解释器/脚本缺失）、
`CONFLICT→-32004`（队列满，可退避重试）、其余→`ENGINE -32003`。
所有路径参数在宿主侧先做**绝对路径**校验，相对路径直接 `-32602`。

---

## 四、控制面与可观测性

**11 个方法**：`highlight.hello`、`highlight.engine.state`、`highlight.probe`、
`highlight.start`、`highlight.status`、`highlight.cancel`、`highlight.jobs.list`、
`highlight.export.edl`、`highlight.models`、`highlight.options`、`highlight.metrics`。

`highlight.options` 是**能力发现**：返回引擎接受的全部参数、类型、默认值、上下界、枚举、
它依赖哪个模型，以及**本机是否真的具备**（`available`）。UI 的表单由它渲染，不是写死的
——引擎新增一个参数，界面自动多一个控件；缺模型时控件禁用并写明缺的是哪个依赖。

**5 个 agent 工具**（同一份参数 schema，不再各写一遍）：`probe`、`start`、`status`、
`cancel`、`export.edl`。MCP/agent 侧因此与 UI 走完全相同的入口。

**3 条数据面路由**：`GET /api/highlight.{clip|subtitle|report}.<jobId>`。

| 路由 | 内容 | 关键点 |
|---|---|---|
| `clip` | 成片 `video/mp4` | 带 `Range` 回 `206` + `Content-Range`，`Accept-Ranges: bytes` |
| `subtitle` | 字幕 `text/vtt` | 引擎落盘是 SRT（编辑器通用），**出口转 WebVTT**：Chrome 的 `<track>` 不收 SRT |
| `report` | 可解释性报告 `application/json` | 逐窗口信号序列、权重、被选片段，外加 `provenance` 指纹——分数为什么高、是谁算的，都可复查 |

路由名带任务 ID，没有路径参数可穿越；路由表**有界**（24 条，最旧淘汰）——无界路由表在长跑
进程里就是内存泄漏。注册前要求文件真实存在且落在工作目录内（`insideDir` + `realpath`，
防目录穿越与软链绕过）；成片已删除时路由干脆不注册，避免把"文件没了"变成每次 seek 的 500。

**事件**：`highlight.engine`（`phase: ready|exit`）、`highlight.job`（`phase: start|<终态>`；
重启恢复时补发 `interrupted`，让"没人监听时发生的那次崩溃"至少留下一条事件）。

**health / manifest**：`GET /api/health` 带 `highlight` 段（引擎 state + metrics）；
`capabilities.register` 声明方法、工具、路由与 `mutates`。`VHL_STRICT_CAPABILITIES=1`
时 manifest 不实即拒绝启动（verify 一直这样跑）。

**metrics**：`jobsStarted / succeeded / failed / cancelled / queueDepth / segmentsTotal /
avgElapsedMs / restoredJobs / interruptedJobs / recent[20]`，终态**幂等入账**（重复观察同一个
任务不会重复计数）。

### Prometheus 出口 `GET /api/metrics`

文本格式 0.0.4，手写（无客户端依赖），`text/plain; version=0.0.4; charset=utf-8`。
两条硬约束写在 `packages/host/highlight/src/prometheus.ts` 顶部：

1. **抓取不做任何 I/O。** 所有值都来自宿主内存里的计数器。引擎子进程卡死时，
   `/api/metrics` 仍然微秒级返回并给出 `vhl_engine_ready 0`——如果抓取要问引擎，
   一个卡住的 FFmpeg 就会把"监控缺数据"变成"监控超时"，恰好在最需要数据的时候失明。
2. **标签有界。** 任务 ID 是 UUID，做标签就是每个任务一条时间序列，最终撑死 TSDB。
   这里只有枚举（`state`）与单值构建信息（`protocol`/`engine`），逐任务细节留在
   `recent` 那个有界环里。verify 有一条断言直接正则扫描 exposition，出现 UUID 即失败。

| 指标 | 类型 | 用途 |
|---|---|---|
| `vhl_build_info{protocol,engine}` | gauge=1 | 部署漂移：混跑时一眼看出协议/引擎版本 |
| `vhl_engine_process_up` / `vhl_engine_ready` | gauge | 区分"进程在"与"能干活"（缺解释器时 1/0） |
| `vhl_engine_restarts_total` / `_fast_deaths_total` / `_handshake_failures_total` | counter | 监督策略的实际行为，不用翻日志 |
| `vhl_jobs_started_total` | counter | 准入量 |
| `vhl_jobs_terminal_total{state=…}` | counter | 一个指标三个枚举，而不是三个近同名指标 |
| `vhl_jobs_in_flight` / `vhl_queue_capacity` | gauge | 饱和预警：比值接近 1 就是 CONFLICT 前兆 |
| `vhl_segments_total` | counter | 产出量 |
| `vhl_job_duration_seconds` | histogram | 分桶 1/5/15/60/300/900s，观测吞吐 |
| `vhl_artifact_routes` | gauge | 有界路由表的占用 |
| `vhl_jobs_restored` | gauge | 启动时从任务日志恢复的行数（进程继承的历史） |
| `vhl_jobs_interrupted` | gauge | 恢复的行里，有几条是**进程死时还在跑**的——非 0 意味着丢了活，不是任务失败 |
| `vhl_models_degraded` | gauge | **只在 `models()` 跑过之后才出现**：没测过的状态不发布成 0 |

被取消的任务**不进耗时直方图**：3 秒取消说明不了引擎吞吐，只会把 p50 拉低。
`VHL_METRICS_ROUTE=0` 可关闭该路由。带 `VHL_TOKEN` 时它与其他 `/api/*` 一样需要 token
（Prometheus 侧用 `authorization: {credentials: …}` 或 `?token=`）。

两条恢复指标是 **gauge 不是 counter**：它们描述"这次启动在磁盘上看到了什么"，
而进程内 counter 在重启时被置回一个非零值，恰好破坏了 counter 唯一承诺的单调性。
同一个值导出为 0 也照常导出——和 `vhl_models_degraded` 相反：0 在这里是一次真实的测量
（"日志是空的"），而"没测过"才应该缺席。

---

## 五、企业级约束（都是实测踩出来的）

**1. 进度单调且收口到 1.0。** 引擎按阶段窗口映射总进度
（probe 0–0.03 / scenes 0.03–0.18 / audio 0.18–0.30 / vision 0.30–0.72 / subtitles
0.72–0.85 / scoring 0.85–0.88 / render 0.88–0.99 / report 0.99–1.00），
`tests/test_pipeline.py` 断言「阶段齐全 + 分数单调 + 末值恰为 1.0」。UI 只显示引擎报的
阶段名，不自造阶段。

**2. 取消是协作式的，且不留半成品。** `CancelToken` 持有所有在跑的 `Popen`，
`cancel()` 先 `SIGTERM` 再 `SIGKILL`；`assemble_highlights` 在异常分支里**先删掉输出文件**
再抛。实测：30s 的 FFmpeg 子进程在 <5s 内被杀；取消后的任务没有 `cancelled.mp4`。

**3. 崩溃监督在产品层，不在基座。** `EngineClient` 只报 `onExit`；重启上限 3 次、
间隔 500ms、**秒退 3 次即停**（二进制坏了不是"崩过一次"，否则就是日志洪水）。
`ctx.effect` 保证销毁时杀进程、清定时器。

**4. 任务状态跨进程存活，且不谎报。** 引擎的任务表在内存里，重启即忘；宿主自己的 Map 也一样。
`jobs-journal.ts` 用追加式 JSONL（`<appPaths.home>/jobs.jsonl`）在每次状态**变化**时落一行，
启动时回放。回放把"进程死时还在排队/运行"的任务改写成 `interrupted`——**绝不复述成 `running`**：
那个持有渲染的子进程已经不在了，声称在跑会让面板永远轮询、让队列深度永远 >0（进而每次 start
都被 `CONFLICT` 拒掉，且没人解释为什么）。任务日志是**提示而非真相**：引擎还在报的行永远优先。
详见第十二节。

**5. 诚实降级。** 没有 `python3` / 脚本时宿主照常启动，所有引擎调用回 `UNAVAILABLE`；
没有 OpenCV 时 `models.list` 报 `degraded: true` 并带 `degradedReason`，面板按原因显示
「降级模式：未安装 OpenCV · 视觉信号回退到 FFmpeg signalstats」/「…缺少 numpy…」/
「…OpenCV 已安装但导入失败…」，不假装能力齐全，也不把不同原因说成一种。

> 这条最早写的是「未装 OpenCV，仅 FFmpeg 信号分析」—— 一句话对着**所有**降级机器说，而它们要
> 做的修复完全不同：没装的该 `pip install`；装好了但 `libprotobuf` 挪走的（本机上一台机器就是）
> 重装同一个包没用；`brew install opencv` 而解释器里没有 numpy 的，问题根本不在 OpenCV。
> 对着这三种机器都说"未装"，等于让人去装一个已经存在的东西。而"仅 FFmpeg"也夸大了损失
> （scene/audio 本来就走 FFmpeg）。所以原因变成了**代码**（`opencv-missing` /
> `numpy-missing` / `opencv-import-failed`，见 `opencv_issue()`），措辞归 UI，未知代码
> 回退到不指名的通用句。

**6. 许可标识随能力一起返回。** `models.list` 每个模型带 `license`
（detector `Apache-2.0`、face `Apache-2.0`、clip `MIT`、whisper `MIT`）。不打包任何模型权重，
权重与 FFmpeg 构建的许可义务由部署方按自己的二进制承担。

**7. 客户端不越权。** 外壳用**自己的** ctx 渲染面板（只 inject `ui`/`i18n`），
所以面板里读 `ctx.net` 会抛 `cannot get property "net" without inject` 并整块白屏。
成片 URL 一律在 store（持有插件 ctx）里解析成绝对地址，面板只读快照。
**这条是浏览器验收抓出来的**，不是猜的。

**8. 参数契约只有一份。** 25 个可调参数的字段名、类型、上下界、枚举、依赖能力都写在
`contract.json`，Python 由 `gen-protocol.mjs` 生成，TS 直接 import。宿主在 `start` 之前
校验，拼错/越界/枚举外都在**创建任务前**返回 `INVALID_PARAMS`，并列出可用键——不是让任务
跑一秒后失败在日志里。

**9. 显式要一个没装的模型，是拒绝而不是静默 0。** 默认值允许降级（`enableWhisper` 默认开，
没装 faster-whisper 就只出画面信号），但显式 `enableClipGuidance: true` 会回
`UNAVAILABLE` 并指名缺的依赖。默认降级是能力，显式静默是撒谎——这条同时写在宿主和引擎里，
因为两边读的是同一张表。

**10. 队列有界，满就说满。** 线程池本身是无界接收的：不设上限时，一次提交 200 个任务会得到
200 个"已接受"和一个磨一小时的 worker。现在 active(queued+running) 到上限直接回
`CONFLICT -32004`（客户端可退避重试），`metrics.queueDepth` 如实暴露当前深度。

**11. 产物目录有保留窗口。** `retainJobs`（默认 20）之外的旧任务目录按 `finishedAt` 清理。
清理只针对**本进程启动过、且解析后仍在工作根内**的 `<jobId>` 目录——不会因为目录名长得像
就删别人的东西；重启前的旧目录不主动认领（"凭文件名删目录"不是产品该做的决定）。
保留窗口同时作用于任务日志：被清理的任务一并 `forget`，否则下一次启动会把它恢复成一条
指向已删产物的记录。

**12. 持久化失败不能让任务失败。** 任务日志写在身份 home 下，可能只读、可能满盘。写入失败时
回调打一行错误日志、`append` 返回 false，**任务照常跑**——持久化是记账，不能变成它所描述的
工作的依赖。同理，末行被截断（进程在 write 中途被杀）是**预期**而非异常：回放丢掉那一行并
计数，其余照常恢复。

**13. 报告要能指名道姓。** 报告原本只记录**配方**（权重、阈值、信号序列），不记录**机器**。
于是"同一素材，换台机器重跑，片段不一样"这件事没有任何解释入口——报告一个字都说不出原因。
现在任务成功时报告多一个 `provenance`：引擎/协议/解释器/FFmpeg 版本、四个模型的路径+大小+
mtime+sha256 前 16 位（**缺失也写明**，缺席比缺键更能解释一个 0）、七个信号**由哪个后端算**、
归一后的完整配方，以及一个 16 位指纹。它不是注册表也不是校验闸门：从不拒绝运行。闸门会挡在
你和新 checkpoint 之间，而"换个模型试试"正是这个产品必须保持容易的事。

**信号记的是后端，不是布尔值。** 这一条是实测逼出来的：本机 OpenCV 因 `libprotobuf` 缺失导入
失败，运动/显著性走 FFmpeg `signalstats`，同样给出 `motion 0.22 / saliency 0.98`。若写成
`visualMotion: true`，两台机器上**两个不可比的测量**会被同一个词盖住。所以报告里是
`opencv-framediff` / `ffmpeg-signalstats` / `onnx-detector` / `mediapipe` / `none` 这样的实现名。

**这条顺带抓出一个真 bug。** `find_spec('cv2')` 只回答"有没有这个模块"，对**装了但 dylib 加载
失败**的 OpenCV 照样返回 `True`——本机 Homebrew 的 opencv 就因为 `libprotobuf` 缺失而导入失败，
旧的 `models.list.degraded` 在这台机器上会谎报"没有降级"，而那正是本产品最不该撒的谎（"诚实
降级"是它存在的理由）。现在改用分析器自己**真实导入**后记下的 `_HAS_OPENCV`：那个标志不可能
与实际执行路径不一致，而且零成本——模块早就加载了。

---

## 六、Python 引擎侧

`engine/vhl_bridge.py` 是唯一的 Python 入口：stdin 逐行读、stdout 逐行答、**所有日志走
stderr**（写 stdout 会毁掉 FIFO 匹配）。`--doctor` 打印解释器/FFmpeg/模型/`environment`
（与报告里 `provenance` 同一块）后退出，便于现场排查——两台机器要对比，不必先各跑一遍分析。

- 分析核心是 `highlight_core/`（从独立引擎仓同步的副本，`engine/SYNC.json` 记录来源与文件表）。
  **不要在副本里改代码**：改上游，跑 `pnpm run sync:highlight-engine`。
- 选项表来自 `contract.json`（`contract.py` 读取），不是本文件里的一份字面量：宿主校验的键，
  引擎一定实现；引擎实现的键，宿主一定认。未知选项**报错而不是静默忽略**（拼错的参数被忽略，
  用户会以为生效了）；越界/枚举外同样拒绝；`clipPrompt` 不带 `enableClipGuidance` 也拒绝
  ——这类"看起来生效、实际是空转"的组合是最贵的 bug。
- 显式开启某个需要模型的选项而本机没装，回 `UNAVAILABLE` 并给出安装提示（见第五节第 9 条）。
- 并发：`ThreadPoolExecutor`，默认 `--workers 1`；排队上限默认 8（`--max-queue` /
  `VHL_ENGINE_MAX_QUEUE`），超出回 `CONFLICT`。单 worker 是刻意的：FFmpeg 已经吃满核，
  多任务并发只会让每个任务都变慢，且进度语义变模糊。
- 产物：`<output>`、`<output 同名>.srt`（有字幕时）、`<output stem>_timeline.json`
  （可解释性报告：权重、信号序列、被选中片段）、`export.edl` 写 CMX3600。

---

## 七、落地结构与生成物

```
product/highlight/
├─ protocol/contract.json        线协议唯一真源
├─ engine/
│  ├─ vhl_bridge.py              stdin/stdout 行协议 + 任务池 + EDL/报告
│  ├─ contract.py                contract.json → 动词表（缺失时退回生成模块）
│  ├─ protocol_generated.py      (生成) contract.json → Python 常量
│  ├─ highlight_core/            (同步) 引擎副本，禁止就地改
│  ├─ SYNC.json                  上游路径 / 提交 / 同步时间 / 文件表
│  └─ tests/test_bridge.py       桥自身的单测（stdlib unittest，无额外依赖）
├─ packages/host/highlight/      @vhl/host-highlight（能力包 + protocol.ts + prometheus.ts + jobs-journal.ts）
├─ packages/client/panel/        @vhl/ui-highlight（两个面板 + timeline.ts）
├─ packages/bundle/app/          @vhl/bundle-app（cordis.patch.yml，端口 3093）
├─ packages/bundle/ui/           @vhl/bundle-ui（client.yml 名册）
├─ apps/cli/                     BootIdentity(vhl / VHL_ / .vhl) + 薄入口
├─ apps/web/                     Vite 页面（构建产物由宿主托管）
├─ scripts/
│  ├─ gen-protocol.mjs           contract.json → protocol_generated.py（--check）
│  ├─ gen-client-roster.mjs      client.yml → roster.generated.ts（--check）
│  ├─ sync-engine.mjs            上游 → highlight_core（--check，含残留名检查）
│  ├─ verify.mjs                 端到端冒烟（真引擎 / 测试替身）
│  └─ verify-ui.mjs              真浏览器验收（CDP）
└─ tests/
   ├─ support/fake-bridge.mjs    Node 版线协议替身（含故障注入）
   ├─ support/host.ts            产品测试挂具
   ├─ host.test.ts               6 个世界 / 31 个用例（含重启）
   ├─ journal.test.ts            任务日志:回放/去重/截断/压实 / 17 个用例
   ├─ metrics.test.ts            exposition 格式 / 14 个用例
   └─ timeline.test.ts           成片内时间算术 / 4 个用例
```

**三道漂移闸门**（`pnpm run check:highlight-drift`）：协议表 ↔ `contract.json`、
客户端名册 ↔ `client.yml`、引擎副本 ↔ 上游。任何一个单向改动都会在这里红。

---

## 八、运行与环境变量

```sh
pnpm install
pnpm run build:highlight      # 生成名册 + 构建页面
pnpm run host:highlight       # http://127.0.0.1:3093
```

前置：`python3`（3.10+）与 `ffmpeg` 在 PATH 上。可选：`opencv-python`（视觉显著性）、
`onnxruntime`（检测模型）、`faster-whisper`（字幕）。缺哪个就降级，不阻塞启动。

| 变量 | 作用 | 默认 |
|---|---|---|
| `VHL_PYTHON` | 运行桥的解释器（指向 venv 以启用模型栈） | `python3` |
| `VHL_ENGINE_SCRIPT` | 桥脚本路径（打包引擎、测试替身） | `<产品根>/engine/vhl_bridge.py` |
| `VHL_PYTHON_ARGS` | 逗号分隔的解释器参数（如 `-u`） | 空 |
| `VHL_ENGINE_TIMEOUT_MS` | 单条命令超时 | `20000` |
| `VHL_ENGINE_AUTO_RESTART` / `_MAX_RESTARTS` / `_RESTART_DELAY_MS` | 崩溃监督 | 开 / 3 / 500 |
| `VHL_WORK_DIR` | 任务产物目录 | `<产品根>/work` |
| `VHL_RETAIN_JOBS` | 产物目录保留数（0=不清理）；同时是任务日志保留的记录数 | `20` |
| `VHL_JOURNAL_FILE` | 任务日志（JSONL）路径 | `<VHL_HOME>/jobs.jsonl` |
| `VHL_MAX_QUEUE` | 排队上限（含运行中）。宿主以 `--max-queue` 传给引擎，拒绝文本与指标里的容量都是这个数 | `8` |
| `VHL_METRICS_ROUTE` | 在 `/api/metrics` 提供 Prometheus 文本 | 开 |
| `VHL_STRICT_CAPABILITIES=1` | manifest 不实即拒绝启动 | 关 |
| `VHL_READONLY=1` | 拒绝一切 `mutates` 方法 | 关 |
| `VHL_HOME` / `VHL_TOKEN` / `VHL_LOG_LEVEL` / `PORT` | 数据目录 / 令牌 / 日志 / 端口 | `~/.vhl` / 无 / info / 3093 |

前端开发：`pnpm --filter @vhl/web run dev`（5174，`/rpc` 与 `/api` 代理到 3093）。

---

## 九、验证

```sh
pnpm run typecheck:highlight
pnpm run verify:highlight:compose     # 组合层（patch + 名册）
pnpm run test:highlight               # 83 个用例，不需要 Python/FFmpeg/浏览器
pnpm run test:highlight:py            # 62 个用例，桥自身（Python + stdlib unittest）
pnpm run test:highlight:all           # 上面两组
pnpm run verify:highlight:fake        # 端到端，Node 测试替身（无 Python 也能跑）
pnpm run verify:highlight:real        # 端到端，真 Python 桥 + 真 FFmpeg
pnpm run verify:highlight:ui          # 真 Chrome（CDP）+ 真引擎，截图断言
```

**CI 跑哪些**（`.github/workflows/ci.yml` 的 `quality` job）：typecheck、组合闸门、契约漂移、
66 个 TS 用例、46 个桥用例、build + 假引擎冒烟。**`real` 与 `ui` 不进 CI**：前者要有模型栈，
缺了就降级跳过——一个会跳过的闸门等于没有闸门；后者要真 Chrome。它们是本机/发布前的验收，
不是提交门禁。

`verify:highlight` 走完整面：health → strict `capabilities.verify` → `api.list`/`tools.list`
→ 协议契约（生成表与替身是否覆盖全部动词、版本=1）→ `hello`/`engine.state`/`models`
→ **选项目录**（≥20 项、类型/范围、依赖标注、可用性如实、权重子键齐全）
→ **非法选项在创建任务前被拒**（越界/类型/枚举/未知权重子键/全零权重/权重越界）
→ `probe`（真引擎还断言编码一致）→ `start/status`（进度收口、片段非空）
→ **成片可被解码且与片源同编码** → 三条数据面路由（成片 `200`/`206`、报告 JSON 含
`selected_highlights`/`timeline_series`、字幕 `text/vtt`）→ **报告指纹**（16 位格式、四个模型
身份含"缺失也写明"、七个信号各自后端、与 `models.degraded` 对 OpenCV 判断一致、与引擎自述
权重一致、不含任务级数据、同机两次 `environment` 逐字节相同而 `fingerprint` 必须不同）
→ **任务日志落盘 + 两条恢复指标
在干净 home 上为 0 且不谎报历史** → EDL（CMX3600 形态 + 事件数=片段数）
→ 取消（无半成品 + metrics）→ **队列满回 CONFLICT + `queueDepth` 可见** → 两道漂移闸门 → 页面。

重启本身（杀掉宿主、同一 home 再启动、断言 `interrupted` / `fromDisk` / 队列不被污染 /
第三次启动不重复计数）在 `tests/host.test.ts` 的第六个世界里跑：那里能用测试替身把
"死在中途"稳定复现三次，比在冒烟脚本里等真 FFmpeg 卡在合适的位置更可靠。引擎在重启
故事里只负责"忘记"，替身与真引擎在这一点的行为完全一致。

`verify:highlight:ui` 额外断言：两个面板挂载、标题不与外壳重复、**高级参数按目录渲染
（≥8 行 / ≥3 组）、被禁用的控件都标注缺失依赖**、探测回显 `320×180 · 12.00s · 25.00fps`、
点击「开始分析」后进度到 100%、**片段行显示各模态信号**、**报告链接指向
`/api/highlight.report.<jobId>`**、`<video>` 指向数据面且 **`videoWidth=320` /
`readyState=4` / 播放头推进**、「定位」把播放头放到成片内位置、导出 EDL 回显路径、
**刷新后任务列表可点回并恢复成片**、无页面异常 / 无 `console.error`。

### 本机实测（2026-11-09，macOS / x86_64 / Python 3.11.10（engine/.venv）/ FFmpeg 8.0.1，全模型栈）

本轮在装齐依赖的 venv 上跑（OpenCV / ONNX / MediaPipe / OpenCLIP / faster-whisper 全在，
`models.degraded=false`），与 2026-11-08 那次 OpenCV 导入失败的**降级路径**互为对照——两条
路径都验过，降级行为见第五节第 5/13 条。

| 检查 | 结果 |
|---|---|
| `test:highlight` | ✅ **85/85**（host 32（6 世界：正常 / 无解释器 / 崩溃监督 / 队列背压 / 保留窗口 / **重启**）+ journal 17 + metrics 14 + interpreter 7 + messages 7（含**选项标签覆盖**闸门）+ protocol 4 + timeline 4） |
| `test:highlight:py` | ✅ **70/70**（桥自身：线协议折叠、权重四类拒绝、边界/枚举、依赖缺失、EDL 时码、文件指纹、`provenance` 归一与顺序无关、坏报告不炸任务、未知动词的可回答文案、显著度后端三态、重复 OpenMP runtime 合并、**内容适配契约 8**） |
| 引擎仓 `unittest` | ✅ **26/26**，无跳过（**上游仓**，不在本树；含「取消 5s 内杀掉 30s 子进程」+ **内容适配 7** + **CLIP 分类 4**；自动分类用例在装齐依赖时**实跑 CLIP**，29s 全套） |
| `verify:highlight:fake` | ✅ **102 条断言**，0 失败 |
| `verify:highlight:real` | ✅ **123 条断言**，0 失败；真分析：`[2.80s, 12.00s]` 分数 `0.7019`，信号 `{scene 0.187, audio 1.00, motion 0.216, saliency 0.958, face/clip/keyword 0}`；默认任务 **82.4s**（Whisper base 加载 alone ~79s，Intel x86_64 纯 CPU；冒烟轮询预算因此放到 180s） |
| 成片可解码 | ✅ `10.096s / 320×180 / h264+aac`（渲染路径为 stream copy，编码与片源一致） |
| 数据面路由 | ✅ 成片 `200 video/mp4`、`Range: bytes=0-1023` → `206 bytes 0-1023/191592`；报告 `200 application/json`；字幕路由**诚实跳过**（正弦测试音无语音 → Whisper 0 cue → 不落 SRT） |
| 报告指纹 | ✅ `provenance.fingerprint 023048707fc4f408`；`environment.signals` = `{sceneCut ffmpeg-scene, audioRms ffmpeg-astats, visualMotion opencv-framediff, objectSaliency onnx-detector, faceSaliency mediapipe, clipGuidance open_clip, keywordMatch faster-whisper}`——**全模型路径**，四个模型 `present:true`，`models.degraded=false` 与之一致；两个任务 `environment` 逐字节相同、`fingerprint` 因权重不同而不同（加权任务 `9679d685dbd49e66`） |
| 内容适配 | ✅ 默认 `general` + 自适应：`signal_activity` audio=1.0 / object=0.967 / scene=0.582 / motion=0.261 / face=clip=keyword=0；`effective_weights` 把 audio 从 0.22 抬到 **0.383**、平坦的 face/clip 降到 **0.0174**、keyword 降到 **0.0105**（地板 0.1 + 归一）。`sports` 预设 `config.weights` audio/motion=**0.25**，有效权重 7 键和为 1 |
| 选项目录 | ✅ **25 项**，含 `contentPreset`/`adaptiveWeights`/`frameAccurate`/`enableClipGuidance`/`whisperModelSize` 等；越界/错类型/枚举外均在创建任务前被拒 |
| 队列背压 | ✅ 上限 1 时第二个并发任务回 `CONFLICT -32004`；`queueDepth` 从 0 → 1 |
| 保留窗口 | ✅ `retainJobs=1` 时最旧任务目录被清理，新目录保留 |
| 任务日志 / 重启 | ✅ 宿主在任务运行中被杀 → 同一 home 重启后该任务为 `interrupted`（错误文本含中断时进度）、`fromDisk: true`、`queueDepth 0`、新任务照常成功；第三次启动 `interruptedJobs 0`（同一次死亡不重复计数） |
| Prometheus 恢复指标 | ✅ 干净 home：`vhl_jobs_restored 0` / `vhl_jobs_interrupted 0`；崩溃后：`restored ≥1` / `interrupted 1`，且两条都是 gauge |
| 取消语义 | ✅ 状态 `cancelled`，`cancelled.mp4` 不存在；metrics `{jobsStarted 4, succeeded 3, cancelled 1}` |
| `verify:highlight:ui` | ✅ **37 条断言**：面板挂载 / 高级参数 **28 行 / 5 组** / `contentPreset` 渲染为下拉（6 值）/ 信号 chips / 报告链接 / `videoWidth 320` `readyState 4` / 定位 / EDL / 刷新恢复 / 无异常 |
| `typecheck:highlight` / `verify:highlight:compose` / `check:highlight-drift` | ✅ 全绿（副本 12 文件 / 协议 11 动词 / 名册 6 插件） |

---

## 十、设计决策与边界

1. **新开产品层，不并进 openvideo。** openvideo 是上游镜像 + 另一套运行时；两者的
   领域模型与生命周期都不同。四个产品共用同一套组合机制，互不引用。
2. **Python 侧车而不是 in-process。** 评分栈是 Python 生态（OpenCV / onnxruntime /
   faster-whisper）；模型崩溃不能带走宿主；引擎可以独立重启；GPL 构建的 FFmpeg 只以
   CLI 调用，不进链接期。
3. **v1 用 PATH 上的 `python3`，不内置解释器。** 打包解释器会把体积与许可责任一起放大，
   而 `hello` 握手 + `--doctor` 已经能给出可诊断的失败。
4. **单 worker。** FFmpeg 已经吃满核；并发只会让每个任务都变慢且进度失真。要横向扩展，
   多进程多实例比线程池更诚实。
5. **路由名即任务 ID。** 没有路径参数就没有穿越面；表有界，最旧淘汰。
6. **面板不碰 ctx.net。** 外壳只 inject `ui`/`i18n`，绝对 URL 在 store 里解析（见第五节第 7 条）。
7. **边界 / 未做**：任务历史是**单机追加式 JSONL**（重启可恢复、可读、可 diff，但没有跨机
   共享、没有事务、没有并发写者保护——一个 home 只能有一个宿主进程，这是它的前提）；
   多租户/配额/鉴权与分布式队列/GPU 池是**非目标**而非欠债，重新考虑的触发条件写在第十二节；
   优先级队列与长稳 soak 不做；不做逐帧精确 seek 的默认路径（默认 stream copy 会吸附到
   关键帧，需要精确请开 `frameAccurate` 重编码）；不做云端转码编排、缩略图/时间轴可视化；
   UI 只有中文/英文两套文案。要跨机或要事务，换成 PostgreSQL 是明确的下一个工程（见第十二节）。
8. **许可**：引擎与产品包 Apache-2.0；基座 MIT。捆绑/分发 FFmpeg 与模型权重的义务由部署方
   按自己的二进制承担，`models.list` 会把每个模型的许可标识随能力一起报出来。
   根 `NOTICE.md` 是**发布前置件，不是待办**：它现在 35 行，因为 `pnpm licenses list --prod`
   在本机返回空、生成脚本拒绝写空文件（脚本在保护自己，不是在偷懒）。要对外发布或交付客户前，
   在一台能正常输出许可证列表的机器上跑 `pnpm run notice` 重生成；在那之前，许可 posture 以
   本节与 `engine/README.zh.md` 为准——那两处是**手写的事实**，NOTICE 只是它们的聚合表。

---

## 十一、排错

| 现象 | 检查 |
|---|---|
| 面板显示「引擎未握手」 | `highlight.engine.state` 看 `running/pid/restarts/python/script`；`VHL_PYTHON --version` 是否可用；`python3 engine/vhl_bridge.py --doctor` 直接跑一次 |
| 调用回 `-32002` | 解释器或脚本路径不对（`VHL_PYTHON` / `VHL_ENGINE_SCRIPT`）；宿主照常启动，这是设计中的降级 |
| 任务失败 `engine.commandFailed` | 看 `job.error`；常见是输入不是绝对路径、文件不存在、或 FFmpeg 不在 PATH |
| 任务成功但没有成片 | `job.segmentCount === 0`（这段素材没有过阈值的片段）；`clipUrl` 为空，面板显示「任务成功后出现成片」 |
| 面板白屏且 console 报 `without inject` | 组件在面板里直接读了 `ctx.net`/`ctx.rpc`；改到 store 里解析 |
| 成片能下载但浏览器黑屏 | 渲染是 stream copy，成片沿用源编码；源是 MPEG-4 Part 2 之类浏览器不支持的编码时无法播放，请开 `frame_accurate` 重编码 |
| 刷新后看到 `interrupted` | 不是 bug：宿主在任务跑的时候重启过。任务不会自动续跑（续跑等于从头再算一遍并静默翻倍成本），需要就重新提交；`vhl_jobs_interrupted` 就是这个数字 |
| 刷新后什么任务都没有 | 检查 `VHL_JOURNAL_FILE` / `<VHL_HOME>/jobs.jsonl` 是否存在且可写；日志里搜「任务日志不可用」。保留窗口（`VHL_RETAIN_JOBS`）之外的记录会被一并清理 |
| `sync:highlight-engine` 报 `无 git 提交` | 上游仓还没有提交，同步照常进行，`SYNC.json` 的上游提交记为 null |
| 面板里某个参数是灰的 | 本机缺它依赖的模型（`models.list` 的 `available`）；装上对应包或不要开它。这是有意的拒绝，不是 bug |

---

## 十二、能力清单（哪些补齐了，哪些没有）

对着《企业级重新设计方案》的能力矩阵逐条核对，**产品层今天能交付什么**：

| 设计方案能力 | 引擎侧 | 产品层可达 | 说明 |
|---|---|---|---|
| 场景切分 / 音频能量 | ✅ | ✅ | `sceneThreshold`、`timeBinSec` 可调 |
| 运动显著性（OpenCV 帧差） | ✅ | ✅ | 无 OpenCV 时降级并明示 |
| 目标显著性（ONNX RT-DETR/YOLOX，类别+面积归一化） | ✅ | ✅ | `onnxModelPath` 可指模型；缺失即降级 |
| 人脸显著性（MediaPipe） | ✅ | ✅ | `enableFaceDetection`（需 mediapipe，缺则禁用） |
| 零样本语义引导（OpenCLIP） | ✅ | ✅ | `enableClipGuidance` + `clipPrompt` |
| 字幕转写（faster-whisper） | ✅ | ✅ | `enableWhisper` / `whisperModelSize` / `subtitleLanguage` |
| 翻译（Ollama） | ✅ | ✅ | `translateToLang` |
| 叙事上下文扩展 | ✅ | ✅ | `contextLeadInSec` / `contextLeadOutSec` / `contextMergeGapSec` |
| 多模态加权融合 | ✅ | ✅ | `weights` 作为**一个复合参数**（7 个子键）暴露；面板渲染成一块带归一提示的控件 |
| 内容类型适配（预设 / 自适应降权 / 自动分类） | ✅ | ✅ | `contentPreset`（5 预设 + auto）+ `adaptiveWeights`（默认开）；auto 需 CLIP，缺则拒绝选用、运行失败降级 general（第十三节） |
| 帧级精确剪辑 | ✅ | ✅ | `frameAccurate`（重编码）与 `fastStreamCopy` 二选一 |
| 异步任务 + 进度 + 取消 | ✅ | ✅ | 阶段窗口映射、协作式取消、无半成品 |
| 队列 / 背压 | ✅ | ✅ | 有界队列 + `CONFLICT` + `queueDepth` |
| 产物与可解释性 | ✅ | ✅ | 成片 / SRT（转 VTT）/ timeline.json 三条路由 + 面板信号 chips |
| 剪辑互操作（EDL） | ✅ | ✅ | CMX3600 导出，事件数=片段数已断言 |
| 许可证标识 / SBOM 可核对 | ✅ | ✅ | `models.list` 带 `license`；根 `NOTICE.md` 是**发布前置**（见下方），当前 35 行是脚本在本机取不到列表，不是内容缺失 |
| 模型/环境指纹（可复现） | — | ✅ | 报告带 `provenance`：引擎/协议/运行时版本、模型 path+大小+sha256、七个信号**各自的后端**、归一后配方、16 位指纹。**记录，不校验**（第五节第 13 条） |
| Prometheus 指标 | — | ✅ | `GET /api/metrics`：文本 0.0.4，抓取零 I/O，标签有界，含耗时直方图 |
| 任务持久化 | ❌ | ✅ | 单机追加式 JSONL（`<VHL_HOME>/jobs.jsonl`）：重启后历史仍在、在跑的任务报 `interrupted`；**不是 PostgreSQL**，不跨机、不并发写 |
| 模型注册表 / 强制版本闸门 | ❌ | — | **非目标**（1）：要解决的是"把一套模型分发给多台机器"，本项目模型来自部署方固定位置，没有分发渠道 |
| 鉴权 / 多租户 / 配额 | ❌ | — | **非目标**（2）：由部署方前置网关承担，基座已有 token/ACL，产品不重复造 |
| 分布式队列（Celery/Temporal）/ GPU 节点池 | ❌ | — | **非目标**（3）：与"单机侧车 + 按 jobId 的字节路由"直接冲突，是换架构不是加功能 |

一句话回答"能力是否补齐了"：**方案里所有"模型/推理/交付"能力都接上了**，包括逐信号权重、
Prometheus、任务持久化与报告指纹。剩下三项**不是欠债，是明确不做的非目标**——判断标准和
"什么时候该重新考虑"写在下节。把设计决策写成 ❌ 未完成，会让真正缺的那一个淹在噪声里。

### 三项非目标（以及重新考虑的触发条件）

**1. 模型注册表 / 强制版本闸门。** 报告指纹已经回答了真问题（"为什么两台机器给出不同片段"）。
注册表要解决的是另一个问题：**把一套模型资产分发给多台机器**。本项目的模型来自部署方的固定
位置（`VHL_ONNX_MODEL` + site-packages），没有分发渠道，注册表只会登记空气。强制闸门更糟：
它挡在你与一个新 checkpoint 之间，而"换个模型试试"正是这个产品必须保持容易的动作。
**触发条件**：出现第二台需要与第一台共用同一套模型资产的机器——那时先做的是分发，不是校验。

**2. 多租户 / 配额 / 鉴权。** 部署形态是一个 home、一个宿主进程、一个侧车。多租户要求共享
存储、身份贯穿每个请求、verify 全链路带上租户上下文——做了只有负债。"配额"这个需求其实已经
以另一种形式存在：`maxQueue` 就是并发上限，满了回 `CONFLICT`。
**触发条件**：同一份部署要对不同客户隔离数据或计费。

**3. 分布式队列 / GPU 节点池。** v1 的三个决策都与它冲突：宿主不管像素、侧车是单机子进程、
字节路由的 key 是 jobId 且文件必须落在本机 work 根内。分布式要换掉这三样（共享对象存储、
状态外置、跨主机取字节），前置条件恰恰是本条 1/2 和非目标之外的真缺口。
**触发条件**：单机吞吐成为真实瓶颈，且已有真实的多机需求。

### 这一轮补的四项（有断言兜着）

**逐信号权重 `weights`。** 做成一个复合参数而不是七个独立滑杆：引擎在评分时按总和归一，
七个独立控件会暗示"每个都调到 0.9 会更强"，而归一化立刻把它抵消。契约里声明 7 个子键，
宿主与引擎都拒绝：未知子键、越界、**全零**（全零会让 `ScoringWeights.normalized()` 静默
换成默认权重——接受了却没生效，是最贵的 bug）。端到端证明不是"参数被收下了"，而是
"真的进了评分"：verify 用只给 `audioRms=1`、其余全 0 的任务跑一遍，再从 timeline 报告里
读回 `config.weights = {audio_rms: 1, 其余 0}`。

**Prometheus 出口。** 见第四节。抓取只读内存、标签只有枚举、`+Inf` 桶必等于 `_count`、
未测量过的状态（`degraded`）不发布成 0。verify 断言「抓取值与 `highlight.metrics` 一致」
（两条出口不能各说一套）、「容量等于配置值」（`VHL_MAX_QUEUE=1` 时必须是 1，不是默认 8）、
「exposition 里没有 UUID」。

**任务持久化。** 四个刻意的小决定，每个都能被一条测试推翻：

1. **JSONL 而不是 PostgreSQL。** 要回答的问题只有两个（"我在跑什么""跑到哪了"），一个
   `~/.vhl/jobs.jsonl` 足够；引入数据库就要引入连接、迁移、备份与一个必须常驻的服务，
   而产品当前形态是"一个 home 一个宿主"。跨机共享或事务性写入是真实需求时再换，那时
   回放层（`replay()`）就是唯一要替换的接缝。
2. **回放把 `running` 改写成 `interrupted`，不续跑。** 续跑等于从分析第一步重来并静默
   把成本翻倍，而用户可能已经不要这个结果了——要不要重算是调用方的决定。错误文本写明
   "宿主退出 / 中断时进度 X%"，让"重新提交"是个知情选择。
3. **`interrupted` 是终态。** 不做成终态的话：面板永远轮询、`queueDepth` 永远 >0、
   队列满之后每个新任务都被 `CONFLICT` 拒掉，而没有任何一行日志解释原因。这一条有专门
   用例（重启后 `queueDepth 0` 且新任务照常成功）。
4. **同一次死亡只计一次。** 回放不是只读的：它把救回来的任务**改写一行**再写回盘，
   所以第三次启动报 `interruptedJobs 0`。否则 `vhl_jobs_interrupted` 会随 uptime 上涨，
   变成一条"看起来在监控"的曲线。

另外两条工程细节：**压实用 tmp+rename**（唯一可能丢失全部数据的操作，截断式重写中途崩溃
会留下空文件，而 rename 要么发生要么不发生）；**写失败不让任务失败**（只读 home 是部署问题，
不是任务问题）。

**报告指纹 `provenance`。** 见第五节第 13 条。四个刻意的决定：

1. **写在桥里，不写在算法副本里。** `highlight_core/` 是上游同步副本，改它会在下次
   `sync:highlight-engine` 被覆盖、并让漂移闸门变红；而且"这个部署选了哪个模型"本来就是
   部署侧的事实（模型由环境变量选），归桥管才对。
2. **权重存归一后的值。** 原始值 1/0/0… 与 2/0/0… 是同一份配方、产生完全相同的片段；
   存原始值会让两个等价运行得到不同指纹，把人送去追一个不存在的差异。
3. **`environment` 里不许有任务级数据。** 有的话每个任务都会"环境不同"，指纹就退化成
   时间戳。verify 用同一台机器上的两个任务断言 `environment` **逐字节相同**、`fingerprint`
   **必须不同**（它们的权重不同）——两条一起才证明指纹覆盖了配方而不是覆盖了噪声。
4. **取 16 个十六进制字符（64 bit），不是完整 sha256。** 它是给人看和 diff 的，不是安全
   原语；verify 断言它随配方变化，而不是一个被随手写死的常量。

顺带一条跨块自检：`provenance.recipe.weights` 必须等于引擎自己写进报告的 `config.weights`。
同一个决定被两处记录，不一致就说明有一处在撒谎，而读者无法判断是哪一处。

---

## 十三、内容适配（预设 / 自适应降权 / 自动分类）

**问题。** 一套权重不可能适配所有视频：访谈的高光在人脸与话语里，音乐的高光在音频动态里，
游戏的高光在画面运动里。用同一份 `weights` 跑所有素材，等于让体育片去拼人脸、让访谈去拼运动。
另一类失败更隐蔽：某个信号在**这段**素材上恒定（多目标帧的物体显著度饱和到 1.0、整段无人脸
的人脸信号恒为 0），它不再区分任何窗口，却仍按权重给所有窗口加同一个常数——把真正有区分度
的信号淹掉。这一轮加三个机制对症，全部**只动权重**，不替调用方决定跑哪些信号。

**1. 内容预设 `contentPreset`（启发式起点，不是学习参数）。** 五个具体预设各是一份归一权重
向量，编码的是显而易见的先验，**手调的起点而非真值**——应当用显式 `weights` 去覆盖它，而不是
把它当结论。`general` 就是引擎的历史默认，选它等于没选。

| 预设 | scene | audio | motion | object | face | clip | keyword | 先验 |
|---|---|---|---|---|---|---|---|---|
| `general` | 0.18 | 0.22 | 0.18 | 0.16 | 0.10 | 0.10 | 0.06 | 历史默认 |
| `sports` | 0.20 | 0.25 | 0.25 | 0.12 | 0.05 | 0.08 | 0.05 | 快动作 + 解说/观众峰值 + 回放切点 |
| `interview` | 0.08 | 0.18 | 0.05 | 0.05 | 0.30 | 0.10 | 0.24 | 静态 talking head：人脸与话语承载高光 |
| `gameplay` | 0.15 | 0.18 | 0.30 | 0.17 | 0.03 | 0.12 | 0.05 | 画面运动与语义事件主导，摄像头人脸是附带 |
| `music` | 0.12 | 0.45 | 0.18 | 0.08 | 0.07 | 0.07 | 0.03 | 节拍/ drop / 渐强是高光，歌词不是 |

预设**只是一份权重向量**：它从不打开/关闭某个信号，也不强制任何模型依赖。跑不跑 face / clip /
whisper 仍由调用方决定；预设只说"每个**可用**信号该占多少"。所以选 `interview` 而本机没装
MediaPipe，人脸信号照样是 0——预设不会替你装模型，也不会假装它跑了。

**2. 自适应降权 `adaptiveWeights`（默认开）。** 评分时按**这段素材**上每个信号的离散度降权：
活动度 `activity = std(信号) / max(各信号 std)`，有效权重 `raw = base × (0.1 + 0.9 × activity)`
再归一。地板 0.1 保证一个信号即便完全平坦也不会被彻底抹掉（它仍可能承载上下文），但不再能
盖过有区分度的信号。七个信号**全平坦**时退回 base（没有任何区分度可言，降权无意义）。这是纯
选择改进：设 `adaptiveWeights: false` 即可对照原始配方。报告里 `effective_weights` 是降权归一
后的值，`signal_activity` 是逐信号活动度——两者让"为什么这个窗口被选中"可复查，而不是一个黑箱。

**3. 自动分类 `contentPreset: "auto"`（显式选用，需 CLIP）。** 不想自己打标签时，让 OpenCLIP
零样本分类：沿时间轴均匀采 **12 帧**，对每类的手写 prompt 求平均文本嵌入，与平均图像嵌入算
余弦，argmax 映射到一个预设。这是**粗先验**，不是学习分类器（prompt 手写、决策是余弦 argmax）。
分数 `(cos+1)/2` 映到 [0,1] 写进报告，读起来像置信度。

- **它是显式选用，所以缺模型是拒绝而非静默。** `auto` 需要 `clip` 能力，宿主与引擎**两侧**都拦
  （契约的 `requires` 是**逐选项**而非逐取值，`auto` 这个取值的依赖只能单独写）：本机没装
  OpenCLIP 时 `contentPreset: "auto"` 回 `UNAVAILABLE` 并指名依赖（第五节第 9 条的同一条规则）。
  其余五个具体预设是纯权重向量，**不需要任何模型**。
- **一旦开跑，分类失败是诚实降级而非硬失败。** CLIP 在场但采样/推理出错（视频打不开、采不到帧、
  模型加载失败），回 `general` 并在报告写明原因（`opencv-unavailable` / `openclip-unavailable` /
  `video-open-failed` / `no-frames` / `frame-sampling-failed` / `clip-failed`），`auto` 因此绝不
  让任务硬失败。"拒绝选用一个不存在的能力"与"选用后运行时降级"是两件事，前者在边界拦，后者在报告记。
- **成本写明。** `auto` 会加载 CLIP checkpoint（ViT-B-32，~350 MB）；`setup-models.sh` 已预缓存，
  跳过那一步的部署要付一次下载。若**同时**开了 `clipGuidance`，引导器会再加载自己的一份——两者
  目前不共享，这是已知的内存翻倍点。

**优先级：显式 `weights` > 预设 > 默认。** 传了 `weights` 就标记 `weights_explicit`，预设解析整步
跳过（`config.weights` 保持显式值）；没传 `weights` 才按 `contentPreset` 取向量（`auto` 先分类，
具体名直接取，未知名退 `general`）。自适应降权与预设**正交**：它作用在解析后的配方上（无论来源
是显式还是预设），所以显式权重也会被降权——要对照原始值就关 `adaptiveWeights`。

**报告里的 `content_adaptation` 块。** 适配是**记录下来的，不是静默的**：`requested_preset`（调用方
要的）、`resolved_preset`（实际跑的）、`weights_explicit`、`adaptive_weights`、`effective_weights`
（降权归一后）、`signal_activity`（逐信号活动度）、`classification`（`auto` 时的方法/模型/分数/采样
帧数/降级原因）。`config.weights` 与 `provenance.recipe.weights` 记的是**解析后的配方**（预设或显式
值），所以指纹覆盖的是真正进评分的那份权重，而不是调用方随手填的原始值。

```jsonc
// RPC highlight.start 的 options 片段
{ "contentPreset": "interview" }                          // 纯权重，无需模型
{ "contentPreset": "auto" }                               // 需 CLIP；缺则 UNAVAILABLE
{ "contentPreset": "sports", "adaptiveWeights": false }   // 预设 + 关闭降权对照
{ "weights": { "audioRms": 1, "sceneCut": 0 } }           // 显式权重 beats 任何预设
```

**边界（先写在前面）。** 预设与分类都是**启发式**：向量手调、prompt 手写、决策是余弦 argmax，
没有在任何标注集上训练或验证过。它们把"显然该这么做"的先验固化成一个可覆盖的起点，**不是**对
视频内容的准确判断。`auto` 在测试图卡上可能给出看似自信却无意义的分数（整段都是同一类画面时
区间很窄）。要精确控制就用显式 `weights`；要评估预设好坏，拿真实素材对照 `adaptiveWeights: false`
的原始配方，看报告里的 `effective_weights` 与 `signal_activity`，而不是相信预设名。
