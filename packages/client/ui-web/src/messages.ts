// @mediabase/ui-web / messages.ts — the shell's own chrome strings.
//
// Registered into ctx.i18n by the plugin; kept out of App.tsx so every UI package
// has the same shape (components + a messages module) and a guard test can assert
// that no other file carries untranslated literals.

/** Chrome strings the shell owns; registered into ctx.i18n by the plugin. */
export const SHELL_MESSAGES = {
  'zh-CN': {
    'shell.subtitle': 'Cordis · 插件化面板外壳',
    'shell.empty': '未注册任何面板 — 请在组合层加入能力包(如 a panel capability)。',
    'shell.panelError': '面板 “{panel}” 渲染失败:{message}',
  },
  en: {
    'shell.subtitle': 'Cordis · plugin-based panel shell',
    'shell.empty': 'No panels registered — add a capability package to the composition (e.g. a panel capability).',
    'shell.panelError': 'panel “{panel}” failed to render: {message}',
  },
} as const
