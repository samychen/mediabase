# @mediabase/log

中立底座:**分级日志 + 子作用域**,以 `ctx.log` 服务提供。此前诊断是散落的
`console.log` 加引擎 stderr 原样透传 —— 无级别、无作用域、无法收集。

```ts
const log = ctx.log.child('media')      // 作用域:avstudio.media
log.info('播放开始', { file, fps })      // data 作为结构化字段输出
log.debug(line)                          // 引擎/python stderr 走这里
```

- 级别:`debug < info < warn < error`,由 config 或 `AVSTUDIO_LOG_LEVEL` 决定(默认 info)
- 输出:默认 stderr(单行、带 ISO 时间),`sink` 可换成收集器/文件(测试就是这么断言记录的)
- `setLevel()` 支持运行时调整;`createLogger()` 是纯工厂,不依赖 cordis,可单测

记录结构 `{time, level, scope, msg, data?}`;`child(scope)` 追加作用域后缀。
