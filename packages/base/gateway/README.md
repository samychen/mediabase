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
- `/api/<name>` 原始字节路由(数据面,例如 `preview.rgb`)**支持 Range**
- `/api/health` + 事件通知广播(`broadcast(method, params)` 推给所有客户端)

## 字节范围(Range)

路由生产者**可选**接收客户端请求的字窗口 `{start, end}`(闭区间,来自 `Range: bytes=`),
并在回包里带上 `totalSize`(完整资源长度)——带上它就是声明"这段字节可以被切片":

```ts
rawRoutes: {
  'asset.42': (range) => {
    const size = statSync(file).size
    if (!range) return { body: readWhole(file), totalSize: size }   // 200 整块
    const start = range.start                                        // 已按 size 夹取
    const end = Math.min(range.end, start + CHUNK - 1, size - 1)     // 生产者自行封顶
    return { body: readWindow(file, start, end), totalSize: size }   // 206
  },
}
```

- 声明了 `totalSize` → 网关回 `Accept-Ranges: bytes`;窗口可满足时回 `206` +
  `Content-Range: bytes start-end/total`;窗口起点越界回 `416` + `bytes */total`。
  响应里的窗口由**实际交回的字节**推导(所以生产者可以少给,分块下发),不是照抄请求。
- 生产者忽略窗口(仍返回整块 + `totalSize`)时,网关自己切片 —— 不会重发客户端已有的字节。
- **不声明** `totalSize` → 走原来的 200 整块路径,不参与 Range。一次性/易变负载
  (最新一帧、每次请求都变的快照)就属于这类:"最新一帧的第 100~200 字节"没有意义。
- 多段区间、`bytes=-500` 后缀区间、非 `bytes` 单位、畸形 spec:一律降级为 200 整块
  (RFC 9110 §14.2 允许服务端忽略 Range),不会报错。
- 开放式尾部(`bytes=500-`)会夹到资源末尾。**建议生产者自己封顶**:否则 `bytes=0-`
  就等于"把整个文件读进内存",多大的素材都不会压垮 RSS 的前提是这里封了顶。

`ctx.api.route()` 的 `handler` 签名同步放宽(接收 `ApiByteRange`),两边结构一致由
`@mediabase/server` 的赋值处做类型校验 —— 一侧改动另一侧会编译报错。
- `/api/health` + 事件通知广播(`broadcast(method, params)` 推给所有客户端)

`@mediabase/server` 已改成纯组合层:`methods`/`rawRoutes`/`health` 全部来自 `ctx.api`
(能力自注册),server 里没有任何业务方法名。
新应用自备这些即可复用本网关。
