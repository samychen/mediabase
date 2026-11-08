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

只用标准库 `unittest`：为一个文件引入 pytest，等于给运行环境多加一个测试依赖。

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
