# OpenVideo on mediabase（中文）

**OpenVideo** 是在本仓基座（mediabase）上落地的第一个产品层：一个 **agent 友好的视频剪辑器**。
项目文档是纯 JSON 的 **EDL（编辑决定列表）**——人在时间线上剪，AI agent 通过同一组**受检操作**
读写同一份文档。移植自 [clawnify/OpenVideo](https://github.com/clawnify/OpenVideo)（MIT，
见 `NOTICE.md`），并按 `AGENTS.md` 的规范重构为 mediabase 的组合形态。

English: [README.md](README.md)。集成设计与决策的完整说明：[INTEGRATION.zh.md](INTEGRATION.zh.md)；
agent 对接指南：[AGENT.md](AGENT.md)；移植归属：[NOTICE.md](NOTICE.md)。

## 它是什么

- **时间线剪辑**：主轨片段按数组顺序首尾相接（顺序即数组），修剪 / 分割 / 重排 / 删除；
  文字与贴图浮在输出时间轴上；音乐垫在下面。
- **实时预览**：一个主时钟驱动 stacked `<video>`/`<img>`/DOM 叠加层（与上游同一方案——
  预览管剪辑、布局与时间，像素级渲染是导出的事）。
- **媒体库**：浏览器分块上传（走控制面，块 ≤ 512 KiB）、按宿主路径导入、
  **网络 URL 下载入库**（`assets.fetch`，http/https，入库后与普通素材完全同权：
  探测/字幕/代理/导出）、时长回填、`.vtt` 字幕稿边车（字幕跟随每次修剪/分割/重排）。
  EDL 文档也直接接受 `https://` 源（预览直通播放、客户端探测时长；导出需远端支持 CORS）。
- **用一句话要求修改**：走基座的 `agent.run`——模型只调用固定的受检操作
  （`openvideo.*` 工具），一次指令一步撤销；没配 `OPENVIDEO_LLM_KEY` 时得到带码错误，不阻塞编辑器。
- **导出 MP4/WebM**：浏览器端 canvas + MediaRecorder 实时录制（本地替代上游的托管导出服务；
  草稿级保真，见「边界」）。
- **一键换肤**：基座 `@mediabase/theme`（暗色/午夜/浅色/工作室四套设计令牌皮肤，header 下拉即换、浏览器记忆；本产品默认"工作室"——上游 OpenVideo 的暖调暗色+玫红点缀+墨色按钮风格，由名册行配置决定）。
- **Agent 就绪**：EDL 校验错误带 JSON 指针（`/main/elements/2/trimStart`），agent 的
  读 → 改 → 存循环可以自我纠错。指南见 [AGENT.md](AGENT.md)。

## 快速开始

```sh
pnpm install                 # 仓库根目录（产品与基座共享一个工作区）
pnpm run build:openvideo     # 生成名册 + 构建页面
pnpm run dev:openvideo       # 宿主 http://127.0.0.1:3090（页面由宿主服务）
```

开发时也可以分开跑：`pnpm run host:openvideo` + `pnpm --filter @openvideo/web dev`（Vite :5174，代理到 :3090）。

默认身份：`bin=openvideo` · 环境前缀 `OPENVIDEO_` · 状态目录 `~/.openvideo`
（`media/` 素材库、`projects/` 项目文档）。产品层的默认端口是 **3090**（bundle 覆盖了
`server` 行），所以基座宿主（`pnpm run host`，:3088）可以同时跑。

常用环境变量（都以 `OPENVIDEO_` 为前缀，另加环境自有的 `PORT`）：

| 变量 | 作用 |
|---|---|
| `OPENVIDEO_HOME` | 状态目录（默认 `~/.openvideo`） |
| `OPENVIDEO_MEDIA_DIR` / `OPENVIDEO_PROJECT_DIR` | 覆盖素材库 / 项目目录 |
| `OPENVIDEO_MAX_UPLOAD_BYTES` | 单次浏览器上传上限（默认 512 MB） |
| `OPENVIDEO_FFMPEG_PATH` | 代理转码用的 ffmpeg 可执行文件（默认 PATH 上的 `ffmpeg`；探测不到则代理功能带码降级，其余不受影响） |
| `OPENVIDEO_LLM_KEY` / `OPENVIDEO_LLM_BASE` / `OPENVIDEO_LLM_MODEL` | 「用一句话要求修改」的 LLM 接入（基座 agent 行读取） |
| `OPENVIDEO_STRICT_CAPABILITIES=1` | 清单对账失败即拒绝启动 |
| `OPENVIDEO_READONLY=1` | 拒绝一切 `mutates` 方法 |

## 验证

```sh
pnpm run typecheck:openvideo        # 宿主面 + 客户端面 + 测试面
pnpm run test:openvideo             # 9 个套件:EDL/操作/分割/字幕/文本布局/宿主集成/名册/i18n/store
pnpm run verify:openvideo:compose   # 组合门禁(基座层 + 产品层 + 客户端名册)
pnpm run build:openvideo            # 页面构建
pnpm run verify:openvideo           # 冒烟:启动宿主,走完整 RPC/数据面/页面链路
```

## 布局（与基座的对应关系）

```
product/openvideo/
  packages/
    edl/           @openvideo/edl        纯逻辑:EDL 文档格式 + 校验(JSON 指针)+ 受检操作集
                                         + split/captions/textLayout/transcript + 派生时间线
    host/media/    @openvideo/host-media 宿主能力 `openvideo`:媒体库/项目库(文件即数据)、
                                         16 个 api 方法、每素材一条数据面路由、17 个 agent 工具、
                                         manifest + health
    client/editor/ @openvideo/ui-editor  客户端能力:6 个面板(header 状态/项目/媒体/检查器/
                                         预览/时间线),一个 store,全部文案在 messages.ts
    bundle/app/    @openvideo/bundle-app 宿主组合层:insert `openvideo` 行 + 按 id 覆盖 `server`(端口 3090)
    bundle/ui/     @openvideo/bundle-ui  浏览器名册:基座注册表 → 编辑器 → 外壳最后(title: OpenVideo)
  apps/
    cli/           @openvideo/cli        身份 + 薄入口(模板 profile:基座 bundle → 产品 bundle)
    web/           @openvideo/web        Vite 页面(名册生成物 roster.generated.ts)
  scripts/         gen-client-roster.mjs(产品自己一份,按 HANDOFF 要求)· verify.mjs(冒烟)
  tests/           产品测试套件(vitest,独立 config)
```

规范落点（对照根 `AGENTS.md`）：

- **像素/渲染在产品层**：预览与导出都在产品的客户端包里，`@mediabase/*` 一无所知。
- **能力自注册**：方法/路由/工具/manifest/health 全部在 `@openvideo/host-media` 内注册，
  基座 server 与外壳零改动。
- **组合是数据**：新能力 = 一个包 + bundle 一行；页面 = 名册一行；`verify:compose` 与
  启动预检守着。
- **边界校验**：参数与结果都是 schema；EDL 拒绝带 JSON 指针；应用错误走 `RpcError` 码 +
  `messageKey`（客户端字典渲染）。
- **副作用挂 fiber**：上传会话清扫定时器、每素材路由的注册/注销都在 `ctx.effect`。
- **i18n**：组件零字符串；zh-CN + en 平行；宿主错误按 key 本地化（tests/i18n.test.ts 守着）。
- **数据面 ≠ 控制面**：字节走 `GET /api/openvideo.asset.<id>`；上传分块走控制面（受 1 MB 帧上限约束）。

## 边界（相对上游，故意不做/换掉的部分）

| 上游（Clawnify 托管） | 本产品 |
|---|---|
| MP4 导出在托管 edit service | 浏览器端 canvas + MediaRecorder 实时录制（草稿级；受浏览器编码器限制，Chromium 通常给 webm，新版可给 mp4）。**解码同样依赖浏览器**：HEVC/H.265 等不受支持的编码会被事前探测并在 UI 明确报错（媒体库角标 / 舞台提示 / 导出拒绝），绝不静默黑屏 |
| Google Drive 导入 | 宿主路径导入 + 浏览器上传（本地信任边界） |
| 托管转写 / 素材分析（AI 看片） | `.vtt` 字幕稿边车（人工/外部工具产出后附加）；`clean_up_clip`、`autocut` 不移植 |
| 托管 media service 的转码/HLS | **本地 ffmpeg 代理转码**（可选：按执行探测，缺 ffmpeg 带码降级）——浏览器解不了的素材一键生成 webm(VP9/Opus) 代理，预览/导出自动切换，原文件不动 |
| D1 + R2 存储 | 文件系统：`~/.openvideo/media` + `projects`（项目文档就是那份 JSON） |
| 自有 instruct LLM 循环（OpenRouter） | 基座 `agent.run` + 受检操作工具（同一组 op） |
| 数据面 Range 请求（ seeking 大文件） | 基座路由整块响应；本地小素材可用,大文件建议 `OPENVIDEO_MEDIA_DIR` 指到快盘 |
| 胶片缩略图 / 波形图 | 未移植（预览聚焦剪辑语义） |

## 许可

产品自有代码 MIT（随基座）。移植部分来自 clawnify/OpenVideo（MIT），归属与许可文本见
[NOTICE.md](NOTICE.md)。运行时**没有新增任何第三方 npm 依赖**——基座 NOTICE.md 不变。
