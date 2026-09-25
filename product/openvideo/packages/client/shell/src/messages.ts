// @openvideo/ui-shell / messages.ts — the shell's own strings (zh-CN + en):
// the projects home screen and the editor chrome. Panel content strings live
// in @openvideo/ui-editor's dictionary; both merge into ctx.i18n.

export const SHELL_MESSAGES = {
  'zh-CN': {
    'ov.shell.tagline': '项目是一份纯 JSON 的 EDL 文档——你在时间线上剪,AI 通过同一组受检操作修改同一份文档。',
    'ov.shell.newProject': '新建项目',
    'ov.shell.namePlaceholder': '项目名称',
    'ov.shell.create': '新建',
    'ov.shell.emptyTitle': '还没有项目',
    'ov.shell.emptyBody': '新建一个项目,从媒体库把素材放上时间线;或者用一句话让 AI 帮你剪。',
    'ov.shell.open': '打开',
    'ov.shell.delete': '删除',
    'ov.shell.deleteConfirm': '再点一次删除「{name}」',
    'ov.shell.updated': '{date} 更新',
    'ov.shell.back': '项目',
    'ov.shell.missingEditor': '编辑器能力(@openvideo/ui-editor)未组合——名册中它必须排在壳之前。',
    'ov.shell.cover': '封面',
    'ov.shell.panelError': '面板 “{panel}” 渲染失败:{message}',
  },
  en: {
    'ov.shell.tagline': 'A project is a plain-JSON EDL document — you cut it on the timeline; an AI edits the same document through the same checked operations.',
    'ov.shell.newProject': 'New project',
    'ov.shell.namePlaceholder': 'Project name',
    'ov.shell.create': 'Create',
    'ov.shell.emptyTitle': 'No projects yet',
    'ov.shell.emptyBody': 'Create a project, put footage on the timeline from the library — or ask the AI to cut it for you in one sentence.',
    'ov.shell.open': 'Open',
    'ov.shell.delete': 'Delete',
    'ov.shell.deleteConfirm': 'Click again to delete "{name}"',
    'ov.shell.updated': 'updated {date}',
    'ov.shell.back': 'Projects',
    'ov.shell.missingEditor': 'The editor capability (@openvideo/ui-editor) is not composed — it must precede the shell in the roster.',
    'ov.shell.cover': 'cover',
    'ov.shell.panelError': 'panel “{panel}” failed to render: {message}',
  },
} as const
