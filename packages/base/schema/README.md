# @mediabase/schema

中立底座:**mediabase schema 方言** —— 语法用 DSH 的 `@deepseek-ai/schemastery`,
本包补上其余代码需要的那两件事。没有领域知识,不依赖 cordis。

```ts
import { z, parse, toJsonSchema, describe, SchemaError } from '@mediabase/schema'

const Params = z.object({ file: z.string().required(), time: z.number().default(0) })
parse(Params, input, 'tool 参数')  // 校验失败 → SchemaError(带 path)
toJsonSchema(Params)                       // → 给 LLM function-calling 的 JSON Schema
describe(Params)                           // → '{ file: string, time?: number }'
```

用它的地方(以前全是 `unknown` + `as` 断言):

| 边界 | 校验对象 | 失败表现 |
|---|---|---|
| `ctx.api` 方法 | 参数(handler 前)、返回值(handler 后) | `-32602` / `-32603`(契约不符) |
| `ctx.tools` | 工具参数(execute 前) | `-32602` + `path` |
| `@mediabase/settings` | 已知设置键的取值 | `-32602` + 可用键提示 |
| LLM agent | 工具参数 JSON Schema | 由 `toJsonSchema()` 生成,不手写 |

约束:`toJsonSchema` 只覆盖本方言实际用到的类型(string/number/boolean/const/
array/object/dict/union);未知类型退化为 `{}`,模型的 description 仍保留。
schemastery 会给 object/dict/array 隐式补空默认值,这些**不会**写进 JSON Schema
(判别"用户写了默认值"和"库补的空壳")。
