# mediabase

中立、可启动的媒体应用基座：`@mediabase/*` + cordis 组合 + 可选 Electron 壳。  
**不含** C++ 引擎与产品领域能力；那些由消费者（如 [avstudio](../avstudio)）叠在基座上。

默认身份：`bin=mediabase` · 环境前缀 `MEDIABASE_` · 状态目录 `~/.mediabase`。

## 快速开始（小工具）

```sh
pnpm install
pnpm run host          # http://127.0.0.1:3088
pnpm run verify:base   # 对已启动的 host 做中性冒烟
```

做一个新产品 / 小工具时，通常只改：

1. **`apps/cli/src/identity.ts`**（或你自己的薄入口）— `bin` / `envPrefix` / `homeDir` / `profileKey`
2. **`packages/bundle/app/cordis.patch.yml`** — `insert` 你的能力行（或另做产品 bundle 叠在 `@mediabase/bundle-app` 之后）
3. **`packages/bundle/ui/client.yml`** — 面板名册（壳 `@mediabase/ui-web` 必须最后）
4. **`packaging/desktop-electron/main.cjs` 的 `PRODUCT` 块** — 窗口标题、`configDir`、`envPrefix`、`resources`

共享启动逻辑在 **`@mediabase/boot`**：产品入口只传入自己的 `BootIdentity`，不要复制 `profile-boot`。

## 包一览

| 层 | 包 |
|----|-----|
| 中立基元 | `rpc` · `schema` · `log` · `protocol` · `engine-client` · `gateway` · `confine` · `shm` |
| 宿主能力 | `boot` · `api` · `server` · `tools` · `plugins` · `settings` · `agent` |
| 客户端 | `connection` · `i18n` · `ui` · `theme`（皮肤令牌+一键换肤，内置 dark/midnight/light/studio/studio-light） · `ui-web` |
| 组合 | `@mediabase/bundle-app` · `@mediabase/bundle-ui` |

## 被消费方式

- **本机开发**：与产品仓同级，产品 `pnpm-workspace.yaml` 写入 `../mediabase/packages/...`
- **CI / 可复现**：pin git tag（当前 **`v0.1.6`**），checkout 到旁路目录后再 `pnpm install`
- **不** publish 到公共 npm（`private: true`）；可用 `pnpm run build:base` + `pnpm pack`
- **照着做一遍**：`docs/WALKTHROUGH.zh.md` —— 在基座旁边新建一个计算器，计算部分有 JS / Python / C++ 三种可换后端（参考实现 12 个文件，零改动基座）
- **第一次接触本仓**：`docs/LEARNING-PATH.zh.md` —— 分阶段学习路径：每阶段给出读什么、做什么、怎么算过关
- **把工具暴露给外部 agent**：`docs/MCP.zh.md` —— MCP Streamable HTTP 端点（`POST /mcp`）、stdio 桥、Claude/Cursor 接入
- **仓内产品层实例**：`product/openvideo/`（视频剪辑）、`product/xmedia/`（C++20 转码/推流服务，已并入 MediaMTX 流服务管理）、`product/highlight/`（视频高光引擎）—— 产品叠在基座上（各自的 `@scope` + 产品 bundle + 独立身份），基座零改动；见各自 `README.zh.md`

## 仓库内产品层：OpenVideo

`product/openvideo/` 是在本基座上落地的第一个产品（agent 友好的视频剪辑器，移植自
clawnify/OpenVideo，MIT）：`@openvideo/*` scope、自己的 bundle 层与身份（`OPENVIDEO_` /
`~/.openvideo` / 端口 3090），基座包保持中立、零改动。它是 `docs/HANDOFF.zh.md`
采纳清单的**仓内实例**——消费仓可以照着它的形状叠自己的产品层。

```sh
pnpm run build:openvideo   # 名册 + 页面
pnpm run dev:openvideo     # http://127.0.0.1:3090
pnpm run test:openvideo    # 产品测试套件
pnpm run verify:openvideo  # 端到端冒烟
```

详见 `product/openvideo/README.zh.md`（设计、边界与规范落点）与 `product/openvideo/AGENT.md`（agent 指南）。

## 仓库内产品层：xmedia

`product/xmedia/` 是第二个仓内产品，也是**第一个原生后端**（转码 / 编码服务，推 RTMP）：
消费 [xmedia-kit](https://github.com/samychen/xmedia-kit)（C++20 媒体 SDK，BSD-3-Clause）
作为受监督子进程；流服务管理（MediaMTX 桥 + 推流状态 / MSE 播放器 / 同步回放 / 配置 / 多服务器）
已完全并入本产品，宿主桥只管命令与行、媒体字节不过桥。身份 `XMEDIA_` / `~/.xmedia` / 端口
3092，基座零改动（唯一触碰是一处严格安全的 `EPIPE` 健壮性补丁，见其 README 第一节）。
协议同样单源：`contract.json` → C++ 头文件，由 `verify:protocol` 校验覆盖全部动词。

```sh
pnpm run build:xmedia:engine   # 构建 C++ 引擎（需要工具链；有预置件则跳过）
pnpm run host:xmedia           # http://127.0.0.1:3092
pnpm run test:xmedia           # 产品测试套件（15 个用例，无需 C++ 工具链）
pnpm run verify:xmedia         # 端到端冒烟（fake engine）
```

详见 `product/xmedia/README.zh.md`。

## 仓库内产品层：Highlight（VHL）

`product/highlight/` 是第三个仓内产品：把
[video_highlight_engine](https://github.com/samychen/video_highlight_engine)（Python /
Apache-2.0）作为受监督侧车接进来，做场景切分、音频能量、视觉显著性、人脸、零样本语义引导、
Whisper 字幕、多模态加权融合与 FFmpeg 渲染。身份 `VHL_` / `~/.vhl` / 端口 3093，基座零改动。

宿主**不碰像素**：它只监督一个进程、转发命令、把成片挂到一条按 `jobId` 命名的字节路由上
（`Range` 直读），分析在引擎、播放在浏览器。`protocol/contract.json` 是线协议唯一真源
（TS 直接 import，Python 由脚本生成），23 个参数与逐信号权重由引擎自报目录、UI 动态渲染。
任务历史落在 `<VHL_HOME>/jobs.jsonl`：重启后仍在，进程死时仍在跑的任务如实报 `interrupted`。

```sh
pnpm run build:highlight       # 名册 + 页面
pnpm run dev:highlight         # http://127.0.0.1:3093
pnpm run test:highlight        # 83 个用例，不需要 Python/FFmpeg/浏览器
pnpm run test:highlight:py     # 62 个用例，桥自身（Python，stdlib unittest）
pnpm run verify:highlight:all  # 端到端（替身 + 真引擎，220 条断言）
```

详见 `product/highlight/README.zh.md`（分层、线协议、企业级约束、能力矩阵与未交付边界）。


## 常用命令

```sh
pnpm run build:base      # 各 @mediabase/* → dist
pnpm run build:host      # 封闭运行时
pnpm run build:web       # 基座 roster 静态页
pnpm run verify:compose  # 组合门禁
pnpm test                # MEDIABASE_NO_BROWSER=1 可跳过浏览器
pnpm run package         # Electron（无引擎资源）

# 产品层（product/openvideo）
pnpm run dev:openvideo       # 产品宿主 + 页面（:3090）
pnpm run test:openvideo      # 产品测试套件
pnpm run verify:openvideo    # 产品端到端冒烟

# 第二个产品（product/xmedia，原生 C++ 后端 + MediaMTX 流服务）
pnpm run host:xmedia         # 转码服务宿主 + 页面（:3092）
pnpm run verify:xmedia       # 端到端冒烟（fake engine）

# 第四个产品（product/highlight，Python 引擎侧车）
pnpm run dev:highlight       # 高光引擎宿主 + 面板（:3093）
pnpm run verify:highlight:all  # 端到端冒烟（替身 + 真引擎）
```

浏览器相关缝：`MEDIABASE_NO_BROWSER` · `MEDIABASE_CHROME_ARGS` · `MEDIABASE_CHROME`。

## 许可

自有代码 MIT。不要把 GPL 引擎二进制打进本仓的默认分发物。
