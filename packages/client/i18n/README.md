# @mediabase/i18n

Client 插件:`ctx.i18n` —— UI 文案的唯一边界。

- **每个 UI 包自带字典**:`messages.ts` 导出 `{ 'zh-CN': {...}, en: {...} }`,apply 时
  `ctx.i18n.addMessages(locale, messages)` 注册(disposer 随 fiber 回收)
- **语言探测**:`?lang=` → localStorage → `navigator.language` → 回退 `en`
- **回退链**:当前语言 → 回退语言 → **键名本身**(刻意不"随便找个有这条的语言":悄悄混语
  比显眼的缺翻译更糟)
- **切换即重绘**:`subscribe`/`revision` + `useI18n(ctx)`(`useSyncExternalStore`),
  面板标题用 `titleKey` 注册,所以标题也跟着切
- **错误按码本地化**:宿主消息保持宿主语言,客户端按 `RpcCode` 映射文案,
  渲染成 `[code] 本地化文案 · 宿主原文` —— 绝不翻译宿主的散文

```ts
const { t, locale } = useI18n(ctx)
return <button>{t('panels.run')}</button>          // 组件里没有硬编码文案
ctx.i18n.setLocale('en')                            // 立刻重绘所有订阅面板
```

**约定**:组件文件里不出现文案(只有 `messages.ts` 出现);`tests/i18n-coverage.test.ts`
用正则守住这条 —— 新写的组件再塞中文字面量会直接红。
状态行要存**键 + 参数**(不是渲染后的字符串),否则切换语言会留下旧语言的残影
(`ui-media` 控制台与 `ui-panels` 能力清单是范例)。
