# @mediabase/ui-web

**壳层**(client plugin,能力无关):`apply` 只做一件事 —— 把 `<App/>` 挂到 `#root`。

`App` 渲染的内容全部来自 `ctx.ui` 面板注册表,按三个区域:

- `header`:标题行内联(如 `ui-panels` 注册的宿主连接徽标)
- `sidebar`:左列,依次渲染注册的侧栏面板(带各自 `title`)
- `monitor`:右侧监视区,依次渲染注册的面板
- 左侧为空时显示提示,引导在组合层加入能力包

壳层不认识任何能力:没有 media/python/workflow/connection 的依赖,不调 `ctx.preview`,
不画 canvas,不 fetch 数据面。`inject = ['ui']` 是它唯一的硬依赖。

**响应式**:面板列表经 `useSyncExternalStore(ctx.ui.subscribe, snapshot)` 读取,
快照按 `area:revision` 缓存。因此在 React 挂载**之后**注册的面板(运行时加载的 UI
包、`ctx.plugins` 热重载)同样立即渲染,无需刷新页面;注销后面板立刻消失。

## 扩展点

新增 UI 能力 = 在自己的包里 `ctx.ui.register({ id, title, area, order, component })`,
**无需改壳层**。示例见 `@avstudio/ui-media`(媒体控制台 + monitor 画布)与
`@avstudio/ui-panels`(连接徽标 + python/workflow/plugins/settings/agent 面板)。

组合顺序(见 `apps/web/src/main.tsx`):注册表 `ui` 先于向其注册的面板包,壳层最后。
从组合层移除所有 UI 能力包,得到的仍是一个可用的空外壳。

## 测试

`tests/ui-shell.test.tsx`(vitest + jsdom)组合一个「空壳」并断言:空态提示存在、
挂载后注册的面板出现在 DOM、注销后消失、header 面板落在 `<h1>` 内、monitor 面板落在
`.monitor` 内、`order` 生效。去掉壳层的 `subscribe` 该套用例会失败 —— 即这套断言真正
覆盖了热注册路径。

## Known Limitations and Deferred Work

- 无面板显隐/排序的运行时配置(顺序目前由注册时的 `order` 决定)。
- monitor 区无多面板编排(并排/分屏/标签页),只按 `order` 纵向排列。
- 区域只有 `header`/`sidebar`/`monitor` 三处,无更细的口袋/标签页分区(对标 DSH
  `ui-slots` 时尚未展开)。
- 标题文案与样式类名(`.app`/`.panel`/`.badge`)来自 `apps/web/index.html`,壳层未做
  主题化或 i18n。
