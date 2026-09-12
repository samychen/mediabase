# @mediabase/tools

Host plugin:**能力工具注册表**(`ctx.tools`)。能力包在 apply 里自注册:
`{name, description, params?, execute}`,`@avstudio/workflow` 与
`@mediabase/agent` 只认注册表——**加能力不再改核心分发代码**:

- `register(tool)` → disposer(重复名抛错;fiber 停止时全清)
- `list()` / `has(name)` / `run(name, args)`

## `params` 是 schema,不是手写 JSON Schema

`params` 是 `@mediabase/schema`(schemastery 方言)的 schema。注册表把它用两次:

1. **校验**:`run()` 在执行前校验参数,失败抛 `-32602` 并带 `path`
   (LLM 编错参数、RPC 少传字段,都不会进到能力里);
2. **生成**:`list()` 用 `toJsonSchema()` 派生出给模型用的 OpenAI 风格 JSON Schema,
   同时给出 TS 风格签名 `signature`。

一份声明两处使用 —— 以前这两件事要手写两遍,而且参数完全没人校验。

```ts
tools.register({
  name: 'media.decode',
  description: '解码某时间点一帧并显示到预览监视器',
  params: z.object({ file: z.string().required(), time: z.number().default(0) }),
  execute: (a) => media.decode({ file: a.file, time: a.time }), // a 已带类型与默认值
})
```

注册表同时把自己暴露到控制面(`tools.list` / `tools.run`)——这也是能力自注册的
一条普通路径,server 里没有任何 tools 相关代码。

当前:`@avstudio/media` 注册 media.probe/meta/decode/pluginFrame,
`@avstudio/python` 注册 python.run,`@avstudio/workflow` 注册 workflow.run;
cli 只负责组合顺序。加能力 = 装一个自注册的包。
