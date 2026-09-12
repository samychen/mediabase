# @mediabase/gateway

能力无关的 **HTTP/WS 网关**(base 包,route-B 抽取自 @mediabase/server):
- SPA 静态伺服(frontend-static 语义:越界 403、任何 miss 回退 index.html 200)
- WS `/rpc` JSON-RPC 控制面(传入你的 method map;`methods`/`rawRoutes`/`streams` 可传函数,
  每个请求现取 —— 注册表在运行时变化时不会冻结)
- WS `/stream` 数据面**推送**通道:客户端订阅一个通道,收到 `meta`(文本)+ 原始字节(二进制)

## 访问控制(可选)

设置 `auth: { token }` 后:`/api/*`(含 `/api/health`)与两个 WS 端点都要求
`?token=`(或 `Authorization: Bearer`,浏览器 WS 无法设 header 所以查询参数是主路径),
比较用 `timingSafeEqual` 常数时间。**静态 SPA 外壳保持公开** —— 它不含数据,只是页面。

这是**本机信任边界**(同机其它进程),不是登录系统:没有 TLS、没有用户模型、没有会话。
需要多用户/远程访问时必须另加一层(反向代理 + TLS + 认证)。

未带 token 的 WS 升级在握手前直接 401,客户端能明确知道原因,而不是"神秘断线"。

| | 拉取 `GET /api/<name>` | 推送 `WS /stream` |
|---|---|---|
| 适合 | 一次性/最新一帧、可缓存、易扩展 | 实时帧流,无每帧 HTTP 开销与轮询延迟 |
| 背压 | HTTP 天然按请求限速 | 慢客户端**丢帧**而不是无限排队(`streamHighWaterMark`,默认 8MiB),并回 `{type:"dropped",count}` |
| 生产者接口 | `route()` 返回当前字节 | `stream()` 的 `attach(sink)` → `sink.send(meta, body)` |

同一份字节两种取法(media 的 `preview.rgb` 同时注册拉取与推送),客户端可以按能力选择,
或在推送不可用时回退到拉取。协议刻意极小:客户端发 `{type:"subscribe",channel}`,
服务端回 `{type:"meta",channel,seq,bytes,...}` 文本帧后紧跟一个二进制帧;
不认识的通道回 `{type:"error"}`,不会断开连接。

实现注意:两个 WS 端点都跑在 `noServer` 模式 + 单一 `upgrade` 路由 —— `ws` 对路径不匹配的
升级请求会直接 400 拒绝,若各自带 `path` 建服,第二个端点会打断第一个端点的握手。
- `/api/<name>` 原始字节路由(数据面,例如 `preview.rgb`)
- `/api/health` + 事件通知广播(`broadcast(method, params)` 推给所有客户端)

`@mediabase/server` 已改成纯组合层:`methods`/`rawRoutes`/`health` 全部来自 `ctx.api`
(能力自注册),server 里没有任何业务方法名。
新应用自备这些即可复用本网关。
