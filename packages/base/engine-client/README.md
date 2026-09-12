# @mediabase/engine-client

能力无关的**引擎子进程传输层**(base 包)。它只知道线协议的机械部分:

- FIFO 请求/响应匹配:`call(parts)`(tab 分隔行,严格一问一答)
- 拒绝与失败都带码:`callOk()` 非 `ok` → `ENGINE`;子进程退出/发送失败/超时 → `UNAVAILABLE`
- scratch 文件字节交换:`readScratch()`(路径由组合层注入)
- stderr 收口:`onStderr`(交给 `ctx.log`,不污染宿主 stdout)
- **协议握手**:`hello()` + `ENGINE_PROTOCOL_VERSION` + `assertProtocol()`
- **崩溃后可重启**:`running` / `restart()` / `onExit(info)`,dispose 之后不再重启

**领域媒体动词(probe/decode/session/…)不在这个包里** —— 列布局与命令词由拥有引擎
二进制的**产品能力**(如消费仓的 `@avstudio/media`)定义。

## 为什么 `hello` 属于传输层

`hello` 不是业务动词,而是线协议自身的握手:子进程宣告协议版本,宿主用
`assertProtocol()` 拒绝不认识的版本。**破坏列/字段语义时必须同时升两端版本号** ——
否则错配会表现成诡异的解析错误,而不是一句"协议不匹配"。

```ts
const client = new EngineClient(bin, { onStderr, onExit, scratchFile })
await client.call(['probe', file])   // 原样取回 tab 分隔列(动词由产品定义)
const info = await client.hello()
assertProtocol(info)                 // 不匹配 → CONFLICT(带两侧版本号)
```

## 崩溃语义(`onExit` 在这里,策略不在这里)

子进程退出时,所有在途调用立即以 `UNAVAILABLE` 拒绝,随后 `onExit(info)` 交给上层
决定:重启几次、退避多久 —— 这些是**产品策略**,不属于中立底座。

`restart()` 会替换子进程;被替换的旧子进程的 exit 事件会被忽略。`dispose()` 之后的
exit 不算崩溃,也不再重启。

测试:`tests/engine-supervision.test.ts` 用可编排的假引擎脚本覆盖握手、拒绝码、超时、
退出与重启。真实原生引擎的覆盖在消费仓。
