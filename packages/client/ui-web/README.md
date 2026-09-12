# @mediabase/ui-web

**壳层**(client plugin,能力无关):`apply` 只做一件事 —— 把 `<App/>` 挂到 `#root`。

`App` 渲染的内容全部来自 `ctx.ui` 面板注册表,按三个区域:

- `header` / `sidebar` / `monitor`
- 左侧为空时显示提示,引导在组合层加入能力包

壳层不认识任何能力:没有 media/python/workflow/connection 的依赖,不调预览,不画
canvas,不 fetch 数据面。`inject = ['ui']` 是它唯一的硬依赖。

**响应式**:面板列表经 `useSyncExternalStore(ctx.ui.subscribe, snapshot)` 读取。

## 扩展点

新增 UI 能力 = 在自己的包里 `ctx.ui.register(...)`,**无需改壳层**。产品示例在消费仓
(如 avstudio 的媒体控制台与工具面板)。

组合顺序:注册表 `ui` 先于向其注册的面板包,**壳层最后**。

## 测试

`tests/ui-shell.test.tsx` 断言空态、热注册、header/monitor 分区与 `order`。
