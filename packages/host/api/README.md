# @mediabase/api

Host plugin:**控制面注册表 + 能力清单**。这是"新能力不必改 server"的那一层。

## `ctx.api`

能力在自己的包里注册控制面方法、数据面路由与 health 片段:

```ts
ctx.api.register({
  name: 'media.play',
  description: '开始连续解码播放',
  params: z.object({ file: z.string().required(), speed: z.number().default(1) }),
  result: z.object({ duration: z.number(), fps: z.number(), w: z.number(), h: z.number() }),
  handler: (p) => media.play(p),          // p 已校验并填好默认值
})
ctx.api.route({ name: 'preview.rgb', handler: () => ({ body: preview.rgba, headers: {...} }) })
// 数据面推送(订阅者出现时才 attach;没人看就不做任何编码)
ctx.api.stream({ name: 'preview.rgb', attach: (sink) => { sinks.add(sink); return () => sinks.delete(sink) } })
ctx.api.health(() => ({ preview: media.getPreview() }))
```

- `methodMap()` / `routeMap()` / `streamMap()` / `healthPayload()` → 交给 `@mediabase/gateway`;
  `@mediabase/server` 里因此没有任何能力名
- 参数在 handler 前校验(`-32602` + `path`),返回值在 handler 后校验
  (能力违反自己的契约 → `-32603`,而不是把畸形数据发给 UI)
- 重复方法名、非法名(必须是 `capability.action`)直接抛错
- 自己也是注册者:`api.list` / `api.streams` / `capabilities.list` / `capabilities.verify`
- **`mutates: true`**:能力声明"这个方法会改状态"(播放/写入/加载/执行),注册表推断不出来,
  所以由能力写明;`api.list` 会带上这个标记,UI 可以据此禁用按钮
- **访问策略**:`ctx.api.policy({ readonly, allow, deny })`(`allow`/`deny` 支持精确名与
  `prefix.*`,deny 优先)。策略在 `call()` 里生效,因此对任何传输都成立、且与审计日志同一处;
  拒绝返回 `RpcCode.FORBIDDEN`(-32021)并把策略放进 `data`
- `/api/health` 里也能看到策略(`server.info` 的 `acl`)
- `api.streams` 给出每个通道的订阅者数与丢帧计数(`/api/health` 也带一份),便于判断是否真有人在看

## `ctx.capabilities`(manifest)

每个能力声明自己提供了什么(`services` / `api` / `tools` / `events`),
`verify()` 拿声明与实际注册对账 —— 漏注册会**在启动日志里显形**,而不是等用户点到。

```ts
ctx.capabilities.register({ id: 'media', title: '媒体引擎(C++)', description: '…',
  services: ['media','preview'], api: ['media.play', …], tools: ['media.probe', …],
  events: ['media.play.tick'] })
```

`events` 还有实际作用:`@mediabase/server` 只把**声明过的**宿主事件转发给客户端;
运行时加载的能力经 `capabilities.subscribe()` 也能补上转发,server 同样不需要改。

客户端可在「能力清单」面板看到这些(`ui-panels`),`api.list` 还给出每个方法的
TS 签名与 JSON Schema。
