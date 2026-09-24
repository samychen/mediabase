# C1 导读：读懂一个能力包正例（server + schema）

> 给 **C++ 工程师平行轨**（[`LEARNING-PATH.cpp.zh.md`](./LEARNING-PATH.cpp.zh.md) 阶段 C1）用。  
> 边打开源码边读；目标不是学会 TypeScript，而是能口述插件四件套，并知道边界校验长什么样。
>
> 行号以当前仓为准；若漂移，以符号名为准（`export const name`、`export function apply` 等）。

## 怎么用

1. 打开 `packages/host/server/src/index.ts`（主文件）  
2. 按下面各节对照；标 **可跳过** 的段落 C1 不必抠细节  
3. 再短扫 `packages/base/schema/src/index.ts` 的指定符号  
4. 末尾三问能答即过关（回平行轨继续 C2）

对照表见平行轨 **附录 E**。

---

## 1. 文件头与 import（`server/src/index.ts`）

**L1–5（文件头）**：一句话合同——本插件是 HTTP/WS **门面的纯组合**，**不命名任何领域能力**；方法/路由/health 全由各能力注册进 `ctx.api`。  
C++ 直觉：门面模块，不含业务动词。

**L7–14（import）**：

| 写法 | 怎么读 |
|---|---|
| `import { createGateway, … } from '@mediabase/gateway'` | 真正用到的运行时符号 |
| `import { parse, z, type Schema } from '@mediabase/schema'` | 配置边界校验（下一节还会打开 schema 包） |
| `import type { Context } from '@deepseek-ai/cordis'` | 只要类型，编译后可擦掉 |
| `import type {} from '@mediabase/api'`（及 log） | **侧效式类型注入**：给 `Context` 补上 `ctx.api` / `ctx.log` 等字段；无运行时代码。≈「只为拿到增强后的头文件」 |

C1：**不必**追进 gateway 实现。

---

## 2. 四件套（本阶段核心）

每个能力包都长这样：`name` / `inject` / `Config` / `apply`。

### `name`（约 L17）

```ts
export const name = 'server'
```

稳定插件名（组合表、日志 scope 会用到）。≈ 模块 id。

### `inject`（约 L20）

```ts
export const inject = ['api', 'capabilities', 'log'] as const
```

硬依赖：这些服务未出现时，fiber **等待**，不会在半残状态下跑 `apply`。≈ 构造前必须存在的依赖。

### `ServerConfig` + `Config`（约 L22–60）

- `interface ServerConfig`：配置形状；字段上的 JSDoc 就是人读的说明（`root` / `port` / `token` / `acl` …）。扫字段名即可。  
- `export const Config = z.object({ … })`：同一形状的 **运行时** 约束——默认值（如 `host`/`port`）、必填（`root`）、描述。

C++ 直觉：结构体声明 +「带默认与校验的装填」。部署时真正的值来自 **组合行（YAML）**，不是写死在这个文件里——所以换端口改 patch，不改这里。

### `apply`（约 L62 起）

`export function apply(ctx: Context, rawConfig: ServerConfig): void` ≈ 模块 `Init`。

**C1 必看：**

| 位置（约） | 看什么 |
|---|---|
| L63–70 | `parse(Config, rawConfig)`：校验并填默认；`distIndex` 缺省时在**实现里**用 `root` 拼出来 |
| L71 | `ctx.log.child(name)`：带 scope 的日志，别用 `console.log` |
| L185–188 | `ctx.effect(() => () => { … gateway.close() }, …)`：卸载时清理。≈ RAII / 析构登记 |

**C1 可跳过（记一句即可）：**

| 位置（约） | 一句 |
|---|---|
| L73–81 | ACL 有陈述才 `ctx.api.policy`；`undefined`/空列表不当限制 |
| L83–116 | `createGateway({ methods: () => ctx.api.methodMap(), … })`——注册表是 **活的**（函数每次取），晚挂载的能力立刻可调 |
| L118–134 | 监听成功/失败打日志 |
| L139–167 | 本插件唯一方法 `server.info` + `capabilities.register`（能力自述，启动可对账） |
| L169–183 | 按 manifest 声明的事件转发到 WS |

C2 心智模型阶段会再碰到「活注册表 / 控制面」；此处不必抠完。

---

## 3. 短扫 `@mediabase/schema`

打开 `packages/base/schema/src/index.ts`。

| 符号 | 约行 | 读什么 | C1 |
|---|---|---|---|
| 包头注释 | L1–11 | 边界统一用这一套；`parse` 给人/RPC，`toJsonSchema` 给 LLM 工具描述 | 读头 |
| `export { z }` | L13–15 | 从本包装 re-export；能力包写 `import { z, parse } from '@mediabase/schema'` | ★ |
| `Schema` / `Infer` | L17–21 | 入参类型 vs 校验后类型 | 可选 |
| `SchemaError` | L37–45 | 失败带 **`path`**，便于定位字段 | ★ |
| `parse` | L52–65 | 成功 → 填好默认的值；失败 → `SchemaError`（可带 label） | ★ |
| `toJsonSchema` 及以下 | L76+ | 工具/agent 用 | **跳过** |

和 server 的对应关系：`apply` 里第一件事就是 `parse(Config, rawConfig)`——配置错在启动边界失败，且能指出路径。C3 写能力包方法参数时是同一套 `z` +（经 api 层）校验习惯。

---

## 4. 自测三问（过关）

1. **`inject` 里某个服务一直不出现，会怎样？**  
   （fiber 等待，`apply` 不会在缺依赖时乱跑。）

2. **为什么换监听端口通常不改 `index.ts`？**  
   （端口在组合行 / patch 的 `config` 里；本文件只声明 `Config` 形状与默认。）

3. **`parse` 失败时，调用方靠什么定位坏字段？**  
   （`SchemaError.path`，以及消息里的路径信息。）

能用自己的话答完 → 回 [`LEARNING-PATH.cpp.zh.md`](./LEARNING-PATH.cpp.zh.md) 阶段 C2。
