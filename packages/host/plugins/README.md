# @mediabase/plugins

Host plugin: **runtime plugin manager** (`ctx.plugins`).

- `list()` — catalog entries with current state
- `load(id)` / `unload(id)` / `reload(id)` — dynamic import + `ctx.plugin(...)`;
  unload disposes the plugin's fiber, which unregisters every service and tears
  down every effect it provided (pure cordis semantics, no bespoke cleanup)
- `probe(id)` — reports whether the entry's declared services are currently on
  `ctx` (the observable proof that load/unload worked)

Catalog entries (id → module path → provided service names → **allowed services**)
arrive as plugin config from the composition (`apps/cli`), so nothing is imported
at boot. Example target: `examples/plugins/hello.ts` (loads as `ctx.hello`).

## 两种隔离:`isolation: 'in-process' | 'process'`

| | `in-process`(默认) | `process`(沙箱) |
|---|---|---|
| 运行位置 | 宿主同一进程/isolate | **独立子进程**(Node IPC + structured clone) |
| 能拿到的 API | 受限 ctx(框架成员 + `requires` 声明的服务) | **只有消息**:`log` / `events` / `services.<声明的服务>.<方法>()` / 导出的 `api` |
| 越权调用 | 宿主侧 Proxy 拒绝(协作式) | **宿主侧检查**(插件根本不持有宿主对象,绕不过) |
| 崩溃 | 会带走宿主 | 宿主只收到 `exit`,继续服务;状态显示 `error` |
| 死循环 | 卡死宿主 | `apply()` 超时后**强杀**(可抢占),宿主照常 |
| 卸载 | 销毁 Fiber | 进程终止(cleanup 先跑),不留残余 |
| `provides` 服务 | 支持 | 不支持(沙箱插件不能 provide 宿主服务) |

沙箱插件这样写(不 import 任何宿主代码,`examples/plugins/sandboxed-demo.ts` 是范例):

```ts
export const name = 'my-plugin'
export const api = { sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0) }   // 宿主可 plugins.call
export function apply(ctx) {
  ctx.log.info('启动', { id: ctx.id })
  ctx.events.on('demo.tick', (p) => ctx.log.info('tick', { p }))          // 订阅不需要服务权限
  return ctx.services.api.list()                       // 仅限 requires 声明的服务
}
```

宿主侧:`plugins.call(id, method, args)` 调用它导出的方法;`plugins.sandboxStatus` 给出
`state / 服务调用次数 / 被拒绝次数 / 订阅的事件 / 导出方法`(UI 的插件面板也会显示)。

**诚实的边界**:这是**进程隔离**,不是权限沙箱 —— 子进程以同一用户、同样的文件系统权限运行,
`require('node:fs')` 依然可用。它限定的是:崩溃/内存/生命周期的影响范围,以及**能触达宿主的面**
(只有这一套消息)。真正的权限隔离需要容器/seccomp 一类机制,不在本仓范围内。

配置:`isolation: 'process'`(目录条目)、`restarts: n`(崩溃后重启次数,默认 0 = 保持停止并显示错误)、
`config`(结构化克隆给插件);沙箱入口由组合层注入(`${prefix}SANDBOX_ENTRY`,打包版是
`Resources/sandbox/sandbox.cjs`,仓库内是 TS 源码走 tsx)。

## 最小权限(`requires`)

每个条目可以声明 `requires: ['api', …]`。声明后:

- 模块拿到的**不是**宿主 ctx,而是它自己 fiber ctx 的受限代理:框架成员
  (`effect`/`reflect`/`events`/`get`/`plugin`/`isolate` …)始终可用,其它属性一律拒绝,
  报错直接告诉你该怎么改(`在该插件条目里加 requires: ["media"]`);
- 模块自身 `inject` 的服务必须落在 `requires` 之内,否则加载失败 —— 否则 cordis 会替它
  解析服务,声明就成了空话;
- 用 `ctx.get('name')` 探测"可选服务是否存在"仍然允许。

**这不是安全沙箱**:插件与宿主同进程、同权限,`require('node:fs')` 之类照样能拿到。
它是**最小权限 + 可审计**:越权访问会立刻失败,加载/卸载都有 `ctx.log` 审计
(`mediabase.plugins` 等日志作用域)。进程沙箱见上文 `isolation: 'process'`;OS 级限制见 `@mediabase/confine`。

未声明 `requires` 的条目保持旧的"完整 ctx"行为(向后兼容);新写的运行时插件应显式声明。
