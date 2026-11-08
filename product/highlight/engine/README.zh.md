# engine/ — 引擎侧车（Python）

本目录是产品的 Python 侧：**一个桥接脚本**（产品自有代码）加上**一份算法副本**（从引擎上游同步）。
两者边界必须分清，否则下一次升级会踩到一起。

```
engine/
├─ vhl_bridge.py          ← 产品代码：stdin/stdout 行协议、任务池、EDL、报告
├─ contract.py            ← 产品代码：读 protocol/contract.json（缺失时退回生成模块）
├─ protocol_generated.py  ← 生成物：scripts/gen-protocol.mjs 产出，不要手改
├─ highlight_core/        ← 同步副本：来自引擎上游，不要手改
└─ SYNC.json              ← 副本来源：上游路径、提交、同步时间、文件表
```

## 为什么是副本，而不是依赖

产品树要能独立分发和运行：`pnpm run host:highlight` 不该要求旁边还有一个引擎仓。
所以算法包整体复制进 `highlight_core/`，唯一的改写是把包名 `highlighter` → `highlight_core`
（相对导入原样保留）。因为只改包名，与上游的 diff 永远是可读的。

**上游仍是唯一真源。** 改算法 = 改上游 → 重新同步 → 提交副本 diff。

```sh
# 默认从 ../../video_highlight_engine/highlighter 同步
pnpm run sync:highlight-engine
# 指向任意检出位置
VHL_UPSTREAM_ENGINE=/path/to/video_highlight_engine/highlighter \
  node product/highlight/scripts/sync-engine.mjs
# CI：副本与上游不一致就红
node product/highlight/scripts/sync-engine.mjs --check
```

同步脚本做三件事：删除旧副本后整份重写、写 `SYNC.json`（含上游 `git rev-parse HEAD`）、
**扫描残留的上游包名**（`from highlighter …` 会导入一个这里不存在的模块，要在同步时报错，
而不是在第一个任务跑到一半时才 `ModuleNotFoundError`）。上游没有 git 提交时
`upstreamCommit` 记为 `null`，同步照常进行。

## 桥接脚本

`vhl_bridge.py` 是进程内唯一入口，规则很少但都很硬：

- **stdout 只写协议行**，日志一律 stderr（写 stdout 会毁掉一问一答的 FIFO 匹配）。
- 一行一条请求，恰好一行回复；`ok` / 动词开头表示成功，`err\t<CODE>\t<msg>` 表示拒绝。
- `--doctor` 打印解释器、FFmpeg、OpenCV、onnxruntime、faster-whisper 的可用性后退出，
  用于现场排查（不启动宿主也能跑）。
- 选项走 `camelCase` 白名单：未知键**拒绝**而不是忽略——拼错的参数被静默忽略，
  用户会以为它生效了。
- **不认识的动词，拒绝也要能回答**：文案引号包住收到的动词、给出字符数、列出本引擎支持的
  动词和动词表来源（`contract.json` 还是陈旧的 `protocol_generated.py`）。旧文案
  `未知动词: analyze.status` 对一台**支持** `analyze.status` 的引擎毫无意义：它像在说调用方
  拼错了，而"少了 1 个字符"和"表旧了"这两条唯一能指导修复的信息都不在里面。（宿主的
  `call()` 还有自己的闸门，见产品 README 第三节——本机缺陷不该以引擎的口吻出现。）
- 长任务在 `ThreadPoolExecutor` 里跑（默认 1 个 worker），主循环继续应答 `status`/`cancel`。

## 桥自己的测试

`highlight_core/` 有上游的 pytest；**桥没有上游，测试得自己写**。`tests/test_bridge.py`
覆盖的是那种"坏了不报错、只是结果不对"的地方：

```sh
pnpm run test:highlight:py        # 或 python3 -m unittest discover -s product/highlight/engine/tests -v
```

- **线协议折叠**：值里的制表符/换行必须变空格。漏一个，一条回复就被切成多列，后面每一列
  都错位——回复仍能解析，只是全是错的。
- **权重的四类拒绝**：未知子键、`true`（Python 里 `isinstance(True, int)` 为真）、越界、全零。
- **`--doctor` 之外的 `provenance`**：指纹 16 位、与 recipe 的键序无关、权重按归一后的值入账、
  坏报告只记日志不让任务失败。
- **两个 API 面必须一致**：`models.degraded` 与 `provenance.environment.signals.visualMotion`
  对 OpenCV 的判断不能各说一套（`find_spec('cv2')` 对装了但加载失败的 OpenCV 返回 True，
  就踩过这个坑）。
- **降级要带原因**：`degradedReason` 是 `opencv-missing` / `numpy-missing` /
  `opencv-import-failed`（可用时为 `''`），与 `degraded` 同生同灭。三种原因的修复不同——
  没装、缺 numpy、装了但导入失败——混成一句"未装 OpenCV"会把后两种人送去装一个已经存在的
  东西（`numpy-missing` 尤其隐蔽：分析器把 `import cv2` 与 `import numpy` 写在同一个 `try`
  里，缺 numpy 会落进同一个标志）。（`find_spec` 在这里是对的问题，正好用来区分这几者；
  `opencv_usable()` 里它才是错的问题。）
- **未知动词的文案可回答**：引号 + 字符数 + 支持的动词 + 动词表来源；并钉住"截断的动词不在
  支持列表里、完整的那个在"——这样下一次同样的报告能自己说明是哪一类问题。

只用标准库 `unittest`：为一个文件引入 pytest，等于给运行环境多加一个测试依赖。

## 可选模型环境

**不装也能跑。** 缺哪个就退到哪个：没有 OpenCV 时视觉四项交给 FFmpeg `signalstats`，
没有 checkpoint 时物体显著度退到 Sobel 边缘，`models.list` 的 `degraded` /
`degradedReason` 与 `provenance.environment.signals` 逐项写清实际跑的是哪条路径。
装齐是为了让那四项真正出力，不是为了让引擎能启动。

```sh
sh product/highlight/scripts/setup-models.sh
```

### 为什么是独立的 venv，而不是 `pip install` 到系统 Python

三个理由是硬的，不是洁癖：

- **版本天花板存在。** torch 的 macOS x86_64 wheel 停在 **2.2.2**（2.3+ 只发 arm64），
  MediaPipe 停在 3.12。所以要用 **Python 3.11** —— 比"最新"更旧，但这是全套都有的版本。
- **它不该污染宿主解释器。** 宿主壳（WorkBuddy 自带 Python、系统 `python3`）还有别的用途，
  装进一份共享 site-packages，下一个项目的 numpy 版本就成了本次安装的附带损伤。
- **可归还。** 删掉 `engine/.venv/` 就回到"只有 FFmpeg"的状态，没有残留。

### 两个环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `VHL_PYTHON` | 宿主启动桥用的解释器 | PATH 上的 `python3` |
| `VHL_ONNX_MODEL` | 检测 checkpoint（也可由任务选项 `onnxModelPath` 覆盖） | 空 = 无检测模型 |

`VHL_ONNX_MODEL` 是**部署默认**，`onnxModelPath` 是**任务级选择**。两者都读：任务指定了就用任务的，
因为分析用的是那个，报告若只看环境变量就会描述一台没跑过模型的机器。

### 实测版本组合（macOS 15 / Intel x86_64）

| 组件 | 版本 | 为什么钉这一个 |
|---|---|---|
| numpy | 1.26.4 | MediaPipe 0.10.9 与 torch 2.2.x 的 Intel wheel 都按 1.x 编译 |
| opencv-python-headless | 4.10.0.84 | 无 GUI 依赖 |
| onnxruntime | 1.23.2 | macOS x86_64 上带 `CoreMLExecutionProvider`；YOLOX-s 的 277 个节点它接走 276 个 |
| protobuf | 4.25.8 | MediaPipe 的 `_pb2` 是 4.x 运行时生成的；5+ 导入即失败 |
| mediapipe | 0.10.9 | 最后一个有 macOS x86_64 wheel 的版本 |
| torch / torchvision | 2.2.2 / 0.17.2 | 最后一个有 macOS x86_64 wheel 的版本 |
| open-clip-torch | 3.3.0 | — |
| faster-whisper / ctranslate2 | 1.2.1 / 4.8.5 | — |

两条安装期的坑，脚本里已处理：MediaPipe 的元数据写着 `protobuf<4`，而它实际需要的是 **4.x**
—— 所以 `--no-deps` 装它、单独钉 protobuf；pip 24 在 macOS 上卸载 protobuf ≥5 时会先把目录
改名成 `~upb` 再对目录调 `rm`，报 `EISDIR`，得手动清掉再装。

### 这份环境的实际表现（本机实测）

| 指标 | 值 |
|---|---|
| YOLOX-s 单帧推理 | 150–230 ms（CoreML，Intel Iris Plus 集成显卡） |
| 6 秒 / 12fps 片段端到端 | 4.8 s |
| Whisper base 加载 | 34 s（含下载 141 MB） |
| `bus.jpg` 检测 | 1 bus 0.93 + 8 person 0.63–0.90 |

**已知限制，先写在前面：**

- **单目标显著度会饱和。** `saliency = Σ(类别权重 × 框面积占比 × 置信度)` 对多目标求和后
  很容易越过 1.0 被截断 —— 上面那张图检出 9 个目标后 `saliency` 每帧恒为 1.0，这一项
  因此失去区分度（权重 0.16 变成给所有帧加一个常数）。单目标场景下这是设计意图
  （一个大而清晰的目标就该接近饱和），多目标场景下需要换聚合方式。
- **NMS 用的是 IoU 0.45**，图上同一辆公交车的两个候选框 IoU 只有 0.417，两个都留了下来。
  阈值是配置项 `onnxIouThreshold`。
- **这台机器没有 GPU**，`torch.backends.mps.is_available()` 为 false。ONNX 走 CoreML，
  torch 侧（OpenCLIP）是纯 CPU。

## 依赖与许可

| 组件 | 用途 | 许可 | 是否随产品分发 |
|---|---|---|---|
| 引擎核心（本目录副本） | 分析 / 评分 / 渲染编排 | Apache-2.0 | 是（源码） |
| FFmpeg | 探测、切分、拼接、字幕封装 | 由**部署方**的构建决定（LGPL 或 GPL） | 否 |
| OpenCV | 视觉显著性 / 光流 | Apache-2.0 | 否（可选） |
| onnxruntime | 可选检测模型推理 | MIT | 否（可选） |
| faster-whisper | 可选字幕转写 | MIT | 否（可选） |
| 检测 / 人脸 / CLIP 权重 | 可选模型能力 | 各自上游（见 `highlight.models` 的 `license` 字段） | 否 |

要点：

- **FFmpeg 只以 CLI 被调用**，不链接进任何二进制。所以 `libx264` 之类 GPL 组件的义务
  落在部署方自己的 FFmpeg 构建上，产品不替它承担、也不假装没有。
- **不打包模型权重。** 缺哪个就降级（`models.list` 的 `degraded` 与各分支的 `available`
  如实反映），而不是给一个"看起来能用"的假实现。
- 每个模型的许可标识随 `highlight.models` 一起返回，客户端/合规检查可以直接读。

## 常见问题

| 现象 | 原因 |
|---|---|
| `ModuleNotFoundError: highlighter` | 有人在副本里手写了上游包名；跑同步脚本，它会扫出残留 |
| `--doctor` 说没有 `cv2` | 没装 OpenCV：视觉信号退化为 0，其余照常，`degraded: true` |
| 任务卡在 `vision` 很久 | OpenCV 路径逐帧读；调大 `frameSkip` 或改走 `ffmpeg` signalstats 路径 |
| `libopenh264` 找不到 | `frame_accurate` 路径默认用 `libopenh264` 重编码；本机没有就换 `fallback_video_codec` |
| 成片浏览器黑屏 | 默认 stream copy 沿用源编码；源编码浏览器不支持时请开 `frame_accurate` |
