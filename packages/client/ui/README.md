# @mediabase/ui

Client 插件:`ctx.ui` UI 面板注册表(route-C 地基)+ 跨包面板共享的状态契约。

它**不依赖 React、也不依赖任何能力包** —— 只拥有两份东西:

1. **面板注册表**:UI 能力包调用 `ctx.ui.register({ id, title, area, order, component })`
   把面板挂进来;壳层(`ui-web`)只渲染注册结果。加一块 UI = 注册一个面板,无需改壳。
2. **共享面板状态契约**(`ctx.view`,`ViewState`):媒体文件/尺寸/时长这类「多个面板都要
   读」的状态。契约放这里,**提供者**放能力包(`ui-media` 提供值),于是 `ui-panels`
   这类外部 UI 包读 `ctx.view` 时不必依赖 `@avstudio/ui-media`。该能力包未组合时服务
   不存在,一律用 `ctx.get('view')` 读并容忍 `undefined`。

`area` 三区:`header`(标题行内联)/ `sidebar`(左列)/ `monitor`(右侧)。

```ts
const ui = ctx.get('ui')!
const off = ui.register({ id: 'my-panel', title: '我的面板', area: 'sidebar', order: 10, component: MyPanel })
// 卸载时(或交给 ctx.effect 的清理函数)调用 off()
```

## 热注册(挂载后注册也要重绘)

壳层可能比能力包更早挂载(运行时加载 UI 包、`ctx.plugins` 热重载),因此注册表提供:

- `subscribe(listener)` —— 注册/注销时通知;返回取消订阅的函数
- `revision()` —— 每次变更自增的版本号,供消费方做缓存键

`ui-web` 用 `useSyncExternalStore(subscribe, getSnapshot)` 消费这两者,`getSnapshot`
以 `area:revision` 缓存,保持快照引用稳定(否则 React 会判定无限循环)。插件 Fiber
销毁时注册表清空并**广播一次变更**,已挂载的壳层渲染回空态,而不是留着已死注册表的面板。

约束:面板 `id` 全局唯一(重复直接抛错);`list(area)` 每次返回新数组,React 之外的
消费方请自行缓存。

当前 `@avstudio/ui-media`(媒体控制台 + monitor 画布)与 `@avstudio/ui-panels`
(连接徽标 + python/工作流/插件/设置/助手面板)都用它注册面板。

## 由 JSON Schema 生成表单(`fieldsFromSchema` / `SchemaForm`)

能力把 API 参数以 JSON Schema 发布(`ctx.api`),这一层就能渲染出表单 —— 能力**不需要
写任何 UI**:

```ts
const fields = fieldsFromSchema(method.jsonSchema)   // 类型/必填/默认值/枚举
const { params, errors } = valuesFromFields(fields, values)  // 字符串 → RPC 值;空值省略
createElement(SchemaForm, { fields, values, onChange, t })
```

- 只覆盖 `@mediabase/schema` 实际会产出的子集;`object`/`array` 退化成 JSON 文本框,
  **不静默丢字段**
- 校验失败返回**键 + 参数**(`{ key: 'form.needsNumber', params: { field } }`),由面板翻译
- `ui-panels` 的「接口控制台」就是它的用户:列出 `api.list` 的每个方法、按 schema 生成表单、
  调用并显示结果/`[code]` 错误 —— 新能力不用再手写面板也能被点到
