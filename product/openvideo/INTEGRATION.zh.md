# OpenVideo × mediabase 集成说明（中文）

> 本文是本次集成的**交付说明文档**：任务是什么、按什么规范做、做成了什么形状、
> 每个设计决策为什么这样取舍、如何运行与验证、边界在哪里。
> 产品自身的快速上手见 [README.zh.md](README.zh.md)，agent 对接见 [AGENT.md](AGENT.md)，
> 移植归属见 [NOTICE.md](NOTICE.md)。

---

## 一、任务与结论

**任务**：以 [samychen/mediabase](https://github.com/samychen/mediabase) 为基座，按照项目代码
规范（根目录 `AGENTS.md` + `docs/HANDOFF.zh.md`），把
[clawnify/OpenVideo](https://github.com/clawnify/OpenVideo)（MIT 许可，"agent 友好的视频剪辑器"）
集成到项目中。功能范围经确认为**全栈**：宿主能力 + 浏览器编辑面板 + 组合与验证。

**结论**：已完成并提交（commit `5cae506`，78 个文件，约 8500 行）。产品层落在
`product/openvideo/`，是仓库内第一个按 HANDOFF 采纳清单落地的**产品层实例**：

- `@openvideo/*` 五个包 + 两个 app + 产品自己的脚本与测试，全部按基座规范成形；
- **基座零改动**：`packages/`、`scripts/`、`packaging/` 一个文件未动；根目录只增加
  工作区 glob、`*:openvideo` 脚本、gitignore 条目、CI 步骤与文档指引；
- 基座回归全绿（233/233），产品套件 71/71，端到端冒烟 `verify:openvideo` 全部通过；
- `NOTICE.md` 不变——集成**没有引入任何新的第三方运行时依赖**（React/Vite/cordis 均为
  基座已有版本，其余全是工作区内部链接）。

---

## 二、源项目分析：clawnify/OpenVideo 是什么

上游是一个部署在 Cloudflare Workers 上的 Clawnify 应用：

| 上游组成 | 内容 |
|---|---|
| `src/client/edit.tsx`（3313 行） | React 19 + Tailwind 4 的四区编辑器：媒体栏 / 主时钟预览 / 检查器 / 时间线（胶片缩略图、波形、拖拽） |
| `src/server/index.ts`（754 行，Hono） | REST API：`/api/assets`（上传、Drive 导入、转写、分析）、`/api/projects`（CRUD + autocut + instruct）、`/api/exports`；D1 数据库 + R2 对象存储 |
| `src/server/edl.ts` | **EDL（编辑决定列表）文档格式**与 zod 校验，错误带 JSON 指针 |
| `src/server/instruct.ts` | "用一句话要求修改"：模型只调用**固定的受检操作集**（trim/split/delete/move/add_text/…），不直接写文档 |
| `src/shared/*.ts` | 纯逻辑：split（分割语义）、captions（字幕时间线）、textLayout(文本折行/定位)、transcript（WebVTT 解析） |
| `agent.md` | agent 指南：读 → 改 → 存循环，校验错误带指针自我纠错 |

其核心思想与 mediabase 高度同构：**项目是纯 JSON 文档，人与 AI 通过同一组受检操作编辑它**。
上游的托管服务部分（Drive 导入、托管转写/分析、托管 MP4 导出、HLS 长视频）依赖 Clawnify
云平台，本地化集成时用"本地等价物"替换（见第六节边界表）。

## 三、遵循的基座规范（对照根 AGENTS.md 逐条落点）

| 规范 | 本集成的落点 |
|---|---|
| **唯一分层规则**：像素/编解码/渲染属于产品层，永不进基座 | 预览与导出全部在 `@openvideo/ui-editor`（产品客户端包）；`@mediabase/*` 对 OpenVideo 一无所知 |
| **一切皆插件**：`name/inject/Config/apply` | `@openvideo/host-media` 与 `@openvideo/ui-editor` 都是标准 cordis 插件 |
| **能力自注册表面**：方法/路由/工具/manifest 在能力自己包里注册 | 16 个 api 方法、每素材一条数据面路由、17 个 agent 工具、manifest、health 全部在 host-media 内注册；基座 server 与外壳零改动 |
| **边界校验用 `@mediabase/schema`** | 所有方法参数**与结果**都是 schema；EDL 拒绝带 JSON 指针；应用错误走 `RpcError` 码 + `messageKey` |
| **日志走 `ctx.log`** | `ctx.log.child('openvideo')`，无 console |
| **每个副作用挂 fiber** | 上传会话清扫定时器、每素材路由注册/注销都在 `ctx.effect` |
| **部署词表一个前缀** | 行里只写短名（`ctx.env.str('MEDIA_DIR')` → `OPENVIDEO_MEDIA_DIR`）；身份在 `apps/cli/src/identity.ts` 一处决定 |
| **组合是数据**：新能力 = 一个包 + 一行 | `@openvideo/bundle-app` 的 `cordis.patch.yml` insert 一行 + 按 id 覆盖 `server` 行（演示"覆盖须整份重写"规则）；页面 = `@openvideo/bundle-ui` 名册一行 |
| **名册生成器产品自己一份** | `scripts/gen-client-roster.mjs`（按 HANDOFF 要求，基座那份写死了基座 bundle） |
| **共享启动逻辑只从 `@mediabase/boot` 引用** | 产品 CLI 与基座 CLI 同形（约 100 行薄入口），不复制 profile-boot |
| **控制面 ≠ 数据面** | 字节走 `GET /api/openvideo.asset.<id>`；命令/上传块走 WS `/rpc` |
| **UI 字符串不落组件** | 全部文案在 `messages.ts`（zh-CN + en 平行）；`tests/i18n.test.ts` 守住键覆盖与宿主 messageKey 本地化 |
| **NEVER PUBLISH / private: true** | 所有产品包 `private: true` |
| **TypeScript 严格面**（noUncheckedIndexedAccess、exactOptionalPropertyTypes…） | 产品三个 typecheck 面（host/client/test）全绿 |
| **声明在启动时对账** | 产品测试用 `OPENVIDEO_STRICT_CAPABILITIES=1` 启动宿主——manifest 撒谎即启动失败，CI 每跑必审 |
| **注释讲非显然的契约** | 每个文件头部注释说明"为什么"，移植文件注明上游出处 |

## 四、集成后的结构

```
product/openvideo/
├─ packages/
│  ├─ edl/               @openvideo/edl        纯逻辑（无 DOM 无 Node，两面通用）
│  │   └─ src/  edl.ts(文档格式+校验) ops.ts(受检操作集) split.ts captions.ts
│  │            transcript.ts textLayout.ts timeline.ts(派生时间线) index.ts
│  ├─ host/media/        @openvideo/host-media 宿主能力 `openvideo`
│  │   └─ src/  index.ts(插件:方法/路由/工具/manifest/health)
│  │            store.ts(文件系统存储,原子写) uploads.ts(分块上传会话)
│  ├─ client/editor/     @openvideo/ui-editor  客户端能力 `openvideo-editor`
│  │   └─ src/  index.tsx(插件:6 面板+store+view 契约) store.ts(唯一可观察状态)
│  │            export.ts(canvas+MediaRecorder 导出) messages.ts(zh-CN+en)
│  │            styles.css  panels/{status,projects,media,player,timeline,inspector,text-stage}
│  ├─ bundle/app/        @openvideo/bundle-app 宿主组合层(cordis.patch.yml)
│  └─ bundle/ui/         @openvideo/bundle-ui  浏览器名册(client.yml,壳最后,title=OpenVideo)
├─ apps/
│  ├─ cli/               @openvideo/cli        身份(bin=openvideo/OPENVIDEO_/~/.openvideo)+薄入口
│  └─ web/               @openvideo/web        Vite 页面(roster.generated.ts 由脚本生成)
├─ scripts/  gen-client-roster.mjs(+d.mts) · verify.mjs(端到端冒烟)
├─ tests/    10 个套件 + support/host.ts(启动真实宿主的测试挂具)
├─ tsconfig.{host,client,test}.json · vitest.config.ts · tsconfig.json(esbuild JSX 运行时)
├─ README.md / README.zh.md · AGENT.md · NOTICE.md · 本文
```

根目录改动（全部是"接线"，不含逻辑）：

| 文件 | 改动 |
|---|---|
| `pnpm-workspace.yaml` | 增加 `product/*/packages/*`、`product/*/packages/*/*`、`product/*/apps/*` 三个 glob |
| `package.json` | 增加 8 个 `*:openvideo` 脚本（build/host/dev/typecheck/test/verify/verify:compose/gen roster）；**既有脚本一个未改** |
| `.gitignore` | `product/*/apps/web/dist/`、`.openvideo/` |
| `.github/workflows/ci.yml` | 追加 4 个产品步骤（typecheck / 组合门禁 / 测试 / 构建+冒烟） |
| `README.md` `README.zh.md` | "仓库内产品层"章节 + 命令 |
| `AGENTS.md` | Repository layout 增加 `product/` 一行 |
| `docs/HANDOFF.zh.md` | 文首增加"仓内实例"指引 |

### 运行形状（数据流）

```
浏览器页面(@openvideo/web, 由宿主静态服务或 vite dev :5174)
  │  名册: connection → i18n → ui → editor → shell(最后)
  │
  ├─ 控制面 WS /rpc ──────────────► @mediabase/server → ctx.api 注册表
  │    openvideo.* 16 个方法           └► @openvideo/host-media
  │    agent.run("用一句话要求修改")        ├─ store.ts: ~/.openvideo/{media,projects} 文件即数据
  │      └► @mediabase/agent ─► ctx.tools ─┤  (assets.json 索引 + <id>.json 项目文档 + .vtt 边车)
  │           openvideo_* 17 个受检工具     └─ uploads.ts: 分块会话(512KiB 块, 30min TTL 清扫)
  │
  └─ 数据面 GET /api/openvideo.asset.<id> ◄─ 每素材一条路由(注册表是活的,素材落地即可播)
       预览/导出从这里拉字节;导出=浏览器 canvas+MediaRecorder 实时录制
```

## 五、关键设计决策与取舍

1. **EDL 校验从 zod 移植到 schemastery，并手工补严格性**。
   基座规范"边界校验只用 `@mediabase/schema`"（schemastery 方言）。方言与 zod 有两处语义差：
   字段默认**可选**（须 `.required()` 反转）；对象**不拒绝未知键**（`.extra(false)` 不生效）。
   上游 `.strict()` 的"拒绝拼写错误"恰是 agent 自我纠错的关键，因此在 `validateEdl` 里
   实现了**未知键行走器**（每种节点一张白名单表），并按 `type` 字段**分支派发**逐元素校验——
   错误路径因此能精确到 `/main/elements/2/trimStar` 这样的 JSON 指针（union 整体校验会丢失
   这一精度）。
2. **上传走控制面分块，而不是给网关加 POST**。
   基座网关数据面是 GET-only、路由 handler 无请求参数，且 WS 帧上限 1MB——这是基座故意的设计
   （控制面≠数据面）。改基座违反"产品不 fork 基座实现"，因此浏览器上传实现为
   `upload.begin → chunk×N → end` 三个方法：块 ≤512KiB（base64 后约 700KiB，稳在帧上限内），
   块必须按序、总量不得超过声明大小，会话文件落盘（内存不驻留），30 分钟 TTL 定时清扫挂在
   `ctx.effect` 上。大文件另有 `assets.import {path}`（宿主本机路径导入，本地信任边界）。
3. **每素材一条数据面路由**。
   `ApiRoute.handler` 是无参函数（"one-shot/latest bytes"语义），无法在一条路由里区分
   "哪个素材"；而注册表是**活的**（网关按请求解析路由表），所以素材落地时注册
   `openvideo.asset.<id>`、删除时注销，天然满足"晚挂载立即可用"。代价：网关不支持 Range，
   整块响应——本地小素材无感，大文件在 README 边界表中如实标注。
4. **受检操作集一处声明，三处消费**。
   `OPS`（名称+描述+参数 schema+纯函数 `applyOp`）定义在 `@openvideo/edl`：
   宿主把它注册成 17 个 agent 工具（LLM 的 JSON Schema 由同一声明派生）、
   `projects.op` 方法用它、时间线按钮也 import 同一个 `applyOp`——按钮和一句话产生的文档
   **必然一致**，不存在第二套剪辑语义。上游的 `clean_up_clip`/autocut 依赖托管看片分析，
   不移植；补了本地组装所需的 `add_clip/add_audio/remove_audio/set_captions`。
5. **"用一句话要求修改"不重造 instruct 循环**。
   上游自建 OpenRouter 函数调用循环；基座自带 `agent.run`（LLM function-calling，只认
   `ctx.tools`）。因此该功能= 组装 prompt（项目 id + `describeEdl` 剪辑清单 + 用户指令）→
   `agent.run` → 重读项目文档采纳（一步撤销）。没配 `OPENVIDEO_LLM_KEY` 时得到带码错误
   文案（字典里有对应键），编辑器不被阻塞——与基座 agent 的行为契约一致。
6. **导出=浏览器端实时录制**。
   基座故意不带引擎，产品也不引入原生依赖；上游导出是托管服务。本地等价物是
   canvas + MediaRecorder：同一套派生时间线驱动隐藏媒体元素实时播放，逐帧绘制
   （contain/cover、文本折行与字幕布局复用 `textLayout`，与预览**同源**），音频经
   WebAudio 混入。产出 webm（新版 Chromium 可 mp4），草稿级保真——文档如实标注，
   不做过度承诺。
7. **产品 bundle 覆盖 `server` 行把默认端口移到 3090**。
   覆盖按基座规则**整份重写** config（root/distIndex/token/COI/acl 全部复述），只改端口默认——
   既是功能（基座宿主 :3088 与产品宿主可并存），也是对"patch 覆盖语义"的仓内示范。
   `distIndex` 不写：默认 `<root>/apps/web/dist/index.html` 相对产品根解析，正好命中产品页面。
8. **预览移植主时钟方案而非逐帧渲染**。
   上游注释说得很清楚："预览展示剪辑、布局与时间；像素级渲染是导出的事"。移植了其
   master-clock 语义（墙钟 + 播放中视频元素纠偏、>0.75s 才真正 seek 以免清空缓冲、
   暂停时紧跟播放头），胶片缩略图/波形（重且依赖逐帧解码）不移植。
9. **存储=文件，项目文档就是那份 JSON**。
   上游 D1 行 + R2 对象 → `~/.openvideo/media/assets.json` 索引 + `projects/<id>.json`。
   这不只是省事：EDL 的"纯 JSON、人和 agent 共读共写"哲学在本地落成了**用户可以直接打开
   的文件**。写入原子（tmp+rename），索引每次变更重读。
10. **一个 store 供所有面板**。六个面板共享一个可观察 store（防抖保存 700ms、整文档撤销栈、
    采纳宿主保存后的文档为一步撤销），面板经 `ctx.get('openvideoEditor')` 读取；同时按基座
    `@mediabase/ui` 预留的 `view` 契约（ViewState）在项目打开时 provide——未来别的监控面板
    无需认识本包即可协作。

## 六、边界：故意不移植/替换的部分

| 上游（Clawnify 托管） | 本产品 | 理由 |
|---|---|---|
| 托管 edit service 导出 MP4 | 浏览器 canvas+MediaRecorder | 基座不带引擎；不引入原生依赖 |
| Google Drive 导入 | 宿主路径导入 + 浏览器上传 | 本地信任边界；Drive 需平台凭据 |
| 托管转写/素材分析（AI 看片） | `.vtt` 字幕稿边车（人工/外部工具产出后附加） | 无本地 ASR；字幕数学全移植，逻辑有测试 |
| D1 + R2 | 文件系统 | 见决策 9 |
| 自有 instruct LLM 循环 | 基座 `agent.run` + 同一组受检工具 | 见决策 5 |
| 数据面 Range（大文件 seek） | 整块响应 | 基座网关语义；本地小素材可用 |
| 胶片缩略图/波形/hls.js | 不移植 | 预览聚焦剪辑语义 |
| React 19 / Tailwind 4 / lucide 图标 | React 18 / 纯 CSS(.ov-* 作用域) / 文本符号 | 与基座同版本同风格，零新增依赖 |

## 七、使用指南

```sh
# 仓库根目录
pnpm install                  # 产品与基座共享一个工作区/lockfile
pnpm run build:openvideo      # 生成名册 + 构建页面(product/openvideo/apps/web/dist)
pnpm run dev:openvideo        # 启动产品宿主 http://127.0.0.1:3090(页面由宿主服务)

# 开发时前后端分开(热更新):
pnpm run host:openvideo                            # 宿主 :3090
pnpm --filter @openvideo/web dev                   # Vite :5174,代理 /rpc /api 到 :3090
```

典型工作流：新建项目 → 媒体库上传/导入素材（视频时长自动探测回填）→ 点"＋"上主轨 →
时间线修剪/分割/重排 → 检查器加文字/音乐/画幅 → 播放预览 → 导出（下载或存回媒体库）。
"用一句话要求修改"需配置 LLM（下）。agent 直接对接见 [AGENT.md](AGENT.md)。

环境变量（前缀 `OPENVIDEO_`，另有环境自有的 `PORT`）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `OPENVIDEO_HOME` | 状态目录 | `~/.openvideo` |
| `OPENVIDEO_MEDIA_DIR` / `OPENVIDEO_PROJECT_DIR` | 素材库/项目目录 | `<home>/media`、`<home>/projects` |
| `OPENVIDEO_MAX_UPLOAD_BYTES` | 单次上传上限 | 512MB |
| `OPENVIDEO_LLM_KEY` / `_LLM_BASE` / `_LLM_MODEL` | "一句话修改"的 LLM（基座 agent 行读取） | 未配置→带码报错 |
| `OPENVIDEO_LOG_LEVEL` | 日志级别 | info |
| `OPENVIDEO_STRICT_CAPABILITIES=1` | manifest 对账失败即拒绝启动 | 关 |
| `OPENVIDEO_READONLY=1` | 拒绝一切 `mutates` 方法 | 关 |
| `OPENVIDEO_TOKEN` | 数据面/WS 共享令牌 | 无 |

## 八、验证清单与结果

| 命令 | 覆盖 | 结果 |
|---|---|---|
| `pnpm run typecheck` / `typecheck:openvideo` | 基座三面 + 产品三面 tsc | ✅ 全绿 |
| `pnpm run lint` | oxlint 全仓（含 product） | ✅ 0 警告 0 错误 |
| `pnpm run verify:compose` / `verify:openvideo:compose` | 组合门禁（基座 2 文件 / 基座层+产品层+名册 3 文件） | ✅ |
| `MEDIABASE_NO_BROWSER=1 pnpm test` | 基座 29 套件 | ✅ 233/233（注） |
| `pnpm run test:openvideo` | 产品 10 套件 71 用例 | ✅ 71/71 |
| `pnpm run build:web` / `build:openvideo` | 基座页面 / 产品页面构建 | ✅ |
| `node scripts/verify.base.mjs`（对 :3088 基座宿主） | 基座中性冒烟 | ✅ BASE OK |
| `pnpm run verify:openvideo` | 产品端到端：启动(strict)→health→工具表→分块上传→字节路由→路径导入→建项目→坏 EDL 指针拒绝→op→在用冲突→删除→页面 200 | ✅ 全部通过 |
| `pnpm run notice` | 基座归属文件 | ✅ 无 diff（零新增第三方运行时依赖） |
| `pnpm run doctor` | 基座环境诊断 | ✅ |

产品测试套件明细：`edl`（校验/指针/严格性/限额）、`ops`（12 个操作语义+每次操作后整文档
复检）、`split`/`captions`/`textLayout`（上游测试移植）、`host`（**真实启动**产品宿主，
`OPENVIDEO_STRICT_CAPABILITIES=1`，RPC 全链路+磁盘断言）、`roster`（生成物新鲜+壳最后）、
`i18n`（zh/en 平行+宿主 messageKey 全覆盖+组件字面量键全存在）、`editor-store`（分块数学/
防抖保存/撤销采纳/ask prompt）、`editor-ui`（jsdom 真实挂载 cordis 上下文+外壳渲染六面板）。

> 注：基座 `shm-ring.test.ts` 的"close() 唤醒等待消费者"一例在本沙箱（2 核、约 1GB 内存）
> 偶发计时波动（基线期即如此，与本次改动无关——product 不触及 `packages/`），单独重跑通过。

## 九、许可与归属

- 产品自有代码：MIT（随基座根 `LICENSE`）。
- 移植部分：clawnify/OpenVideo（MIT，Copyright (c) 2025 Clawnify）——**逐文件**归属表与
  许可全文见 [NOTICE.md](NOTICE.md)；移植源码文件头部均注明"Derived from …（MIT）"。
- 运行时零新增第三方依赖 → 基座根 `NOTICE.md`（`pnpm run notice` 生成）不变。

## 十、提交与后续建议

**提交**：`5cae506 feat(product): OpenVideo — an agent-friendly video editor on this base`
（master 本地分支，78 文件 +8495/-1；按仓库惯例署名，agent 以 `Co-authored-by: Qwen` 注记；
**尚未 push**——推送前可按需 `git commit --amend` 调整作者/信息）。
上游参考克隆保留在仓库外的 `~/openvideo-src`（未纳入版本库）。

**后续可选方向**（均已在文档中留位，不阻塞交付）：

1. Electron 桌面壳：改 `packaging/desktop-electron/main.cjs` 顶部 PRODUCT 块即可套本产品；
2. 数据面 Range 支持（大素材 seek 体验）——属基座演进，需按基座流程单独提案；
3. 胶片缩略图/波形（上游有现成实现可再移植）；
4. 本地转写（如 whisper.cpp sidecar，走 `@mediabase/engine-client` 线协议——正是基座为
   产品子进程准备的原语）；
5. CI 的产品步骤已接入 `.github/workflows/ci.yml`，push 后自动生效。
