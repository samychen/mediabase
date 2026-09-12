# @mediabase/ui

Client 插件:`ctx.ui` UI 面板注册表 + 跨包面板共享的状态契约。

它**不依赖 React、也不依赖任何产品能力包** —— 只拥有两份东西:

1. **面板注册表**:UI 能力包调用 `ctx.ui.register({ id, title, area, order, component })`
   把面板挂进来;壳层(`ui-web`)只渲染注册结果。加一块 UI = 注册一个面板,无需改壳。
2. **共享面板状态契约**(`ctx.view`,`ViewState`):多面板都要读的共享状态。契约放这里,
   **提供者**放产品/示例能力包;外部 UI 包读 `ctx.view` 时用 `ctx.get('view')` 并容忍
   `undefined`。

`area` 三区:`header`(标题行内联)/ `sidebar`(左列)/ `monitor`(右侧)。

```ts
const ui = ctx.get('ui')!
const off = ui.register({ id: 'my-panel', title: '我的面板', area: 'sidebar', order: 10, component: MyPanel })
```

## 热注册

- `subscribe(listener)` / `revision()` — `ui-web` 用 `useSyncExternalStore` 消费。
  挂载之后注册的面板同样立即渲染。

约束:面板 `id` 全局唯一;`list(area)` 每次返回新数组。

本仓基座 roster 默认几乎是空壳;产品在消费仓注册自己的面板(例如 avstudio 的
`ui-media` / `ui-panels`)。

## 由 JSON Schema 生成表单(`fieldsFromSchema` / `SchemaForm`)

能力把 API 参数以 JSON Schema 发布(`ctx.api`),这一层就能渲染出表单 —— 能力不需要
手写面板即可被「接口控制台」一类面板调用。
