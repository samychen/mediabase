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

M1 范围:

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

M2 范围:

- **录像回放**:右侧新面板按路径浏览录像窗口(天粒度分组、时刻+时长),点播放
  即上主舞台;播放走 MSE 吃 playback 服务器的 fMP4 流(浏览器直连 :9996,媒体
  字节依旧不过宿主),init 段 codec 解析内置(avc1/hvc1/mp4a),**零新依赖**
  (无 hls.js/mse.js/mp4box);
- **回放链的控制面**:新 RPC 方法 `mediamtx.playback.list` 归一化 `/list` 的
  窗口数组,并把 `/get` URL 的 origin 改写成浏览器可达地址(上游回显的是它自己
  看到的 Host);playback 未开启/不可达都是带码错误+配置提示,不是白屏。

M3 范围:

- **同步回放墙**:录像窗口可「加入同步回放」(每行一个按钮,或直接拖拽)进
  1/4/9 宫格;每个格子各自走 MSE 播放自己的窗口,所有格子共享同一条**挂钟
  时间轴** —— 面板内的 rAF 主时钟把全局时刻映射到每格自己的秒数,多路录像
  对齐同播、联动拖动。宫格的声明式状态在共享 store 里(录像面板与回放墙走
  同一条面板间接缝),60fps 的时钟刻意**不**进 store —— 一次 tick 绝不能重发
  其余七个面板赖以渲染的快照。零新依赖,媒体字节依旧浏览器 ⇄ :9996 直连。
- **跨窗口连播**:录像行的「播放」语义升级为「从此窗口连播」——该窗口与其后
  所有窗口组成播放链,主舞台在窗口边界自动续接(位置徽标 i/N),不再一段一点。
- **多服务器切换**:宿主维护一份持久化的服务器注册表(env 种子 + 配置面板
  登记),`mediamtx.servers.switch` 把**每个方法**都路由到选中的服务器,面板
  随即清空所有已成谎言的视图;agent 拿到 servers.list / servers.switch 两个
  工具(登记/移除只留作 operator RPC —— 凭据不该是模型输入)。上游认证在
  basic 之外增加静态 bearer/JWT(两者都设时 token 优先)。
- **全局配置表单**:底部抽屉按服务器原样展示整份平面配置(约 122 键),按键名
  前缀分桶;标量可编辑,复合值(对象/数组)只读展示 JSON(它们的诚实编辑器是
  mediamtx.yml)。「保存」只把**差量**经 `mediamtx.config.global.patch` 发出,
  随后回读——服务器会归一化取值、监听地址类改动立即生效,面板永远显示服务器
  的真相而不是过期草稿。

M4 范围(本里程碑):

- **同步墙串联**:格子从「单窗口」升级为同一路径连续窗口的「窗口链」(「加入
  同步回放」/拖拽 = 从该窗口起串联其后所有窗口,与主舞台同一语义)。主时钟每
  tick 在每格链内定位(第几个窗口、窗口内第几秒 —— `locateInSlot`,被测试
  钉住),跨窗口边界即把该格的 MSE 流重挂到下一窗口——对无 Range 的 `/get`
  这是唯一诚实的动作。录像 GAP 让格子暂停原地,时钟走到下一窗口自动续播。
  拖放载荷升版为 v2(schema 校验),M3 的旧标签页无法把单窗口载荷丢进 M4 的墙。
- **整链进度条**:主舞台新增第二条进度条,横跨播放链的总时长(原生进度条仍只
  管当前窗口内部)。拖过窗口边界 = 从目标窗口的第一个字节**重新取流**,缓冲
  一到就落在窗口内的目标秒上——上游没有 Range,下游就不撒谎。位置绘制搭
  video 自己的 `timeupdate`:不开 rAF、不触发重渲染。
- **JWT 过期感知**:bearer token 带 `exp` 声明时,注册表视图把它解码出来
  (`servers.list` → `expiresAt`),配置面板以徽标呈现——已过期标红、10 分钟内
  临期标黄。只解码、**不验签**:验签是流媒体服务器的职责,控制台的职责是让
  快死的 token 变成看得见的警告,而不是神秘的 401。

M5 范围(本里程碑):

- **凭据就地轮换**:`mediamtx.servers.update` 直接更新已登记服务器的地址/凭据
  (省略的字段保持、空字符串清除对应凭据);轮换快过期的 JWT 从「切走-移除-
  重登记」三步变成一次调用,活动服务器也可更新(配置面板的 ✎ 会预填表单,
  凭据留空 = 保持不变)。
- **墙的 DOM 半被钉住**:`tests/sync-panel.test.tsx` 在 jsdom 里真渲染同步墙
  与「录像→墙」接缝(真 cordis Context + i18n 插件 + 假 rpc):格子数随布局、
  入链点亮标签与 transport、jsdom 缺失的 MediaSource 以带码的 mse-unsupported
  徽标浮现(降级路径本身就是测试)、v2 拖放落地而 M3 旧载荷在元素级被拒、
  ⊞ 把「从此窗口」的链停进第一个空格。

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
# 用 bearer/JWT 代替 basic(两者都设时 token 优先):
MTXCONSOLE_SERVER_TOKEN=eyJ… pnpm run host:mtxconsole
# 更多服务器无需 env:在「全局配置」面板登记(持久化到
# ~/.mtxconsole/mtxconsole-servers.json),运行时随时切换。
```

录像回放需要 MediaMTX 侧两处配置(`mediamtx.yml`):

```yaml
pathDefaults:
  record: yes        # 或给单个路径开 record
playback: yes        # 回放服务器(:9996);CORS 默认全开(playbackAllowOrigins ["*"])
```

改完重启 mediamtx。浏览器**直连** playback 服务器取媒体,所以它的端口要能被
你的浏览器访问到(与 WHEP/HLS 同理);控制面(`/list` 归一化)走宿主桥。

门禁:

```sh
pnpm run typecheck:mtxconsole       # 三个平面
pnpm run test:mtxconsole            # 单元 + 宿主集成(有 mediamtx 二进制时自动 LIVE)
pnpm run verify:mtxconsole          # 端到端冒烟(LIVE/DEGRADED 双模式)
pnpm run verify:mtxconsole:compose  # 组合文件门禁
```

## LIVE 实测清单(需要真机)

沙箱与 CI 都证明不了的——对着真实 MediaMTX(`MTX_BIN=… pnpm run test:mtxconsole`
会把套件切到 LIVE)与真实摄像头走一遍:

1. **HEVC 回放**:录一路 hvc1 → 主舞台与墙各播一个窗口 → devtools 里
   `addSourceBuffer` 的 MIME 应为 `hvc1.…`(codec 串按 RFC 6381 公式构造,
   但从未见过真实 HEVC 硬件);
2. **多机位同步**:两路以上录同一场景 → 入墙同播 → 秒级边界对齐应保持,
   漂移超过 0.4s 应看到吸附回位;
3. **链的跳窗**:多窗口的路径 → 从中间窗口连播 → 每个边界只有一次短缓冲,
   `i/N` 徽标递增;整链进度条跨窗拖动 = 从目标窗口第一个字节重新取流;
4. **GAP 停走**:留一段录制空档 → 对应格子暂停原地,时钟走到下一窗口自动续播;
5. **真 JWT**:配一个短 `exp` 的 token → 徽标 灰 → 黄(<10 分钟)→ 红,
   过期后调用浮现带码 401;
6. **两台真服务器**:都登记 → 切换 → 仪表盘/流/录像/墙整体换血、无旧数据残留,
   且 `~/.mtxconsole/mtxconsole-servers.json` 在宿主重启后保住注册表。

## 架构:三层,一条分层规则

```
浏览器面板(@mtxconsole/ui-console)          ← 像素/播放/表单
   │  WS JSON-RPC(控制面,命令与行,不搬字节)
宿主桥(@mtxconsole/host-bridge)             ← 凭据/跨域/归一化/工具
   │  HTTP(MediaMTX v3 API + /metrics + playback /list)
MediaMTX 服务器(第三方,MIT,操作者自备)
   ▲
   └── 浏览器直连:WHEP(:8889)/ HLS(:8888)/ 回放 fMP4(:9996)
       ← 媒体字节走这里,不过宿主
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
│   ├── host/bridge/         @mtxconsole/host-bridge 宿主能力:15 个 RPC 方法 + 6 个工具
│   ├── client/console/      @mtxconsole/ui-console  8 个面板 + WHEP 客户端 + MSE 回放/同步墙 + store
│   └── bundle/{app,ui}/     组合层(宿主 patch / 浏览器名册)
├── apps/cli/                宿主入口(身份:mtxconsole)
├── apps/web/                页面(Vite)
├── scripts/                 名册生成 + verify 冒烟
└── tests/                   protocol 单元 / host 集成(LIVE+DEGRADED+mock)/ mse / format / roster / i18n
```

## 与 OpenVideo 产品并存

两个产品互不感知,可与基座宿主同时跑:基座 :3088、OpenVideo :3090、本产品
:3091(各自 bundle 层挪默认端口),身份目录分别为 `~/.mediabase` /
`~/.openvideo` / `~/.mtxconsole`。

## 已知边界(M3)

- 链播放按窗口逐段推进——主舞台与每个墙格皆然:每跳一次重新缓冲一次
  (playback 服务器的 `/get` 不支持 Range,窗口只能从第一个字节起流);主舞台
  的原生进度条仍只跨当前窗口(跨窗口跳转用整链进度条)。拖动的诚实边界
  不变:已缓冲内即时、向前等顺序流追上、已逐出的尾部无法找回;
- 回放要求浏览器支持 MSE(现代桌面浏览器与 iOS 17.1+ 均可;更老的 Safari 会
  得到明确的"不支持"提示而非黑屏);HEVC 录像的 codec 串按标准公式构造,但未
  在真实 HEVC 设备上验证过;
- 配置表单只覆盖标量——复合键(pathDefaults、authInternalUsers 等)刻意只读
  (用 mediamtx.yml 编辑;对嵌套对象做子集补丁会静默丢掉兄弟字段);
- operator 登记的服务器凭据以明文持久化在宿主 home 下
  (`mtxconsole-servers.json` —— 与基座 settings.json 同一模式;凭据永不
  过线),env 种子的同名服务器永远优先;
- 墙在真实解码负载下的帧精度仍需真机人眼验收 —— `tests/sync-panel.test.tsx`
  (jsdom)已把 DOM 半钉到无头 DOM 能钉的极限:渲染、store 接缝、元素级 v2
  拖放契约、单格移除/清空/布局接线,以及带码的「MSE 不支持」降级(jsdom 没有
  MediaSource —— 诚实徽标本身就是断言);rAF 时钟对真实媒体的行为在 LIVE
  清单里;
- WHEP 播放依赖浏览器原生 `RTCPeerConnection`(全平台现代浏览器可用);HLS
  回退仅原生支持的浏览器(不引入 hls.js,零新依赖是本产品的硬约束);
- 上游认证:basic 或静态 bearer token(`MTXCONSOLE_SERVER_TOKEN` / 每服务器
  `token`)。token 的 `exp` 会被解码并做成徽标(已过期/临期),但没有刷新
  流程——真过期后调用以上游 401 的带码错误(`UNAVAILABLE`)浮现;轮换 token
  = `mediamtx.servers.update` 就地更新。
