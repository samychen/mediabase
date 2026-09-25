# MediaMTX Console(产品层)

在 mediabase 基座上落地的**第二个产品**:一个 agent 友好的
[MediaMTX](https://github.com/bluenviron/mediamtx)(MIT)流媒体服务器管理台。
`@mtxconsole/*` scope、自己的 bundle 层与身份(`MTXCONSOLE_` / `~/.mtxconsole`
/ 端口 3091),基座包保持中立、零改动。

> **净室实现**:本产品不含任何第三方派生代码。接口知识全部来自对真实
> MediaMTX v1.21 服务器的实测与它公开的路由表;参考项目
> MinChanSike/mediamtx-client(无 LICENSE)只在 README 功能清单层面被分析,
> 源码未被阅读。详见 [NOTICE.md](./NOTICE.md)。

## 这是什么

MediaMTX 把摄像头/推流收进来,用 RTSP/RTMP/SRT/HLS/WebRTC 发出去。它自带一个
功能齐全的 HTTP API,但没有官方管理界面。本产品就是那个界面——并且是**给
agent 用的界面**:每个面板动作背后都是一个带 schema 校验的 RPC 方法,同一批
方法又以工具形式注册给基座 agent("把 3 号摄像头加到服务器上"是一句话的事)。

M1 范围(本里程碑):

- **仪表盘**:服务器版本/启动时间、全部监听端口(从服务器配置推导)、指标摘要
  (就绪/待流路径数、观看者、每路径进出字节——解析 Prometheus `/metrics`);
- **流路径**:归一化列表(在线态/源/观看者/轨道/码率/录制开关),添加拉流源
  (rtsp:// 摄像头即填即上)、改配置、删除;
- **预览播放**:WHEP(WebRTC)低延迟播放,浏览器直连 MediaMTX(媒体字节不过
  宿主);HLS 仅在原生支持的浏览器(Safari/iOS)作为回退,零新运行时依赖;
- **会话**:八种协议(rtsp/rtsps/rtmp/rtmps/hls/webrtc/srt/moq)的观看/推流
  会话归一化成一张表,可踢;
- **带码降级**:服务器不可达时每个调用都返回 `UNAVAILABLE + messageKey`,
  面板显示"不可达"而不是一片空白。

## 快速开始

```sh
# 1) 起一个 MediaMTX(自备;或用发行版二进制)
mediamtx   # 默认 API 在 127.0.0.1:9997

# 2) 起本产品宿主(另一个终端)
pnpm run build:mtxconsole   # 名册 + 页面
pnpm run dev:mtxconsole     # http://127.0.0.1:3091

# 指向别的服务器 / 带认证:
MTXCONSOLE_SERVER_URL=http://192.168.1.10:9997 \
MTXCONSOLE_USERNAME=admin MTXCONSOLE_PASSWORD=… \
pnpm run host:mtxconsole
```

门禁:

```sh
pnpm run typecheck:mtxconsole       # 三个平面
pnpm run test:mtxconsole            # 单元 + 宿主集成(有 mediamtx 二进制时自动 LIVE)
pnpm run verify:mtxconsole          # 端到端冒烟(LIVE/DEGRADED 双模式)
pnpm run verify:mtxconsole:compose  # 组合文件门禁
```

## 架构:三层,一条分层规则

```
浏览器面板(@mtxconsole/ui-console)          ← 像素/播放/表单
   │  WS JSON-RPC(控制面,命令与行,不搬字节)
宿主桥(@mtxconsole/host-bridge)             ← 凭据/跨域/归一化/工具
   │  HTTP(MediaMTX v3 API + /metrics)
MediaMTX 服务器(第三方,MIT,操作者自备)
   ▲
   └── 浏览器直连:WHEP(:8889)/ HLS(:8888)  ← 媒体字节走这里,不过宿主
```

- `@mtxconsole/protocol`(双面纯逻辑):归一化 wire 形状 + 上游形状适配器
  (`toPathRow`/`toSessionRow`)、Prometheus 解析、端点推导、错误分类。上游
  字段改名只会砸到**一个**适配器函数,不会波及面板。
- **为什么要有宿主桥**(浏览器明明可以直连 API):凭据留在宿主、跨域一次解决、
  面板与 agent 消费同一套归一化词汇(八种会话形状 → 一行一种)。控制面只有
  命令与行——媒体字节从不穿过宿主,这是基座的分层规则。
- **组合是数据**:`packages/bundle/app/cordis.patch.yml`(宿主层:插桥 + 端口
  3091)与 `packages/bundle/ui/client.yml`(浏览器名册:注册表 → 面板 → 基座
  外壳收尾,标题即配置)。本产品不需要自定义外壳——基座 `@mediabase/ui-web`
  已渲染 header/sidebar/monitor/bottom 四个区域。

## agent 表面

注册进基座工具注册表(`tools.run` 直通,模型经 `agent.run` 用同一批):

| 工具 | 干什么 |
|---|---|
| `mediamtx.info` | 服务器版本/启动时间 |
| `mediamtx.endpoints` | 观众端连接地址(WHEP/HLS/RTSP/…) |
| `mediamtx.paths.list` | 归一化路径列表(在线态/源/观看者) |
| `mediamtx.path.add` | **把摄像头放上服务器**:给 `source` 即拉流,不给即等推流 |
| `mediamtx.path.delete` | 下线路径 |
| `mediamtx.sessions.kick` | 踢会话 |

详见 [AGENT.md](./AGENT.md)。

## 目录

```
product/mediamtx-console/
├── packages/
│   ├── protocol/            @mtxconsole/protocol   双面纯逻辑:schemas/适配器/解析
│   ├── host/bridge/         @mtxconsole/host-bridge 宿主能力:14 个 RPC 方法 + 6 个工具
│   ├── client/console/      @mtxconsole/ui-console  5 个面板 + WHEP 客户端 + store
│   └── bundle/{app,ui}/     组合层(宿主 patch / 浏览器名册)
├── apps/cli/                宿主入口(身份:mtxconsole)
├── apps/web/                页面(Vite)
├── scripts/                 名册生成 + verify 冒烟
└── tests/                   protocol 单元 / host 集成(LIVE+DEGRADED)/ roster / i18n
```

## 与 OpenVideo 产品并存

两个产品互不感知,可与基座宿主同时跑:基座 :3088、OpenVideo :3090、本产品
:3091(各自 bundle 层挪默认端口),身份目录分别为 `~/.mediabase` /
`~/.openvideo` / `~/.mtxconsole`。

## 已知边界(M1)

- 录像回放面板未做(桥已备 `mediamtx.recordings.*` 方法与 playback 端点推导,
  M2 接 UI);
- 全局配置只提供只读审阅 + 子集补丁方法,未做表单 UI;
- WHEP 播放依赖浏览器原生 `RTCPeerConnection`(全平台现代浏览器可用);HLS
  回退仅原生支持的浏览器(不引入 hls.js,零新依赖是本产品的硬约束);
- MediaMTX 认证仅实现 basic-auth(API 侧);JWT 等上游新认证方式未接。
