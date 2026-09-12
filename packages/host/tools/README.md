# @mediabase/tools

Host plugin:**能力工具注册表**(`ctx.tools`)。能力包在 apply 里自注册:
`{name, description, params?, execute}`;产品侧的 recipe runner 与
`@mediabase/agent` 只认注册表——**加能力不再改核心分发代码**:

- `register(tool)` → disposer(重复名抛错;fiber 停止时全清)
- `list()` / `has(name)` / `run(name, args)`

## `params` 是 schema,不是手写 JSON Schema

`params` 是 `@mediabase/schema`(schemastery 方言)的 schema。注册表把它用两次:

1. **校验**:`run()` 在执行前校验参数,失败抛 `-32602` 并带 `path`;
2. **生成**:`list()` 用 `toJsonSchema()` 派生出给模型用的 OpenAI 风格 JSON Schema,
   同时给出 TS 风格签名 `signature`。

```ts
tools.register({
  name: 'demo.echo',
  description: '示例工具',
  params: z.object({ text: z.string().required() }),
  execute: (a) => ({ text: a.text }),
})
```

注册表同时把自己暴露到控制面(`tools.list` / `tools.run`)。本仓基座组合默认不挂
领域工具;产品能力在消费仓自注册后即可被 agent/workflow 发现。
