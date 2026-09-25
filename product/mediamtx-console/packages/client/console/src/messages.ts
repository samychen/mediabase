// Every operator-facing string, both locales. Panels never hold UI copy.

export type MessageKey =
  | 'console.ready'
  | 'panel.status.title'
  | 'panel.dashboard.title'
  | 'panel.streams.title'
  | 'panel.player.title'
  | 'panel.sessions.title'
  | 'server.unreachable'
  | 'server.version'
  | 'server.started'
  | 'server.listeners'
  | 'metrics.ready'
  | 'metrics.notReady'
  | 'metrics.readers'
  | 'metrics.traffic'
  | 'stream.state.ready'
  | 'stream.state.idle'
  | 'stream.play'
  | 'stream.delete'
  | 'stream.deleted'
  | 'stream.add'
  | 'stream.add.hint'
  | 'stream.name'
  | 'stream.source'
  | 'stream.sourcePlaceholder'
  | 'stream.record'
  | 'stream.added'
  | 'stream.empty'
  | 'stream.tracks'
  | 'stream.viewers'
  | 'player.none'
  | 'player.mode.whep'
  | 'player.mode.hls'
  | 'player.connecting'
  | 'player.live'
  | 'player.stopped'
  | 'player.hlsUnsupported'
  | 'player.stop'
  | 'sessions.empty'
  | 'sessions.kick'
  | 'sessions.kicked'
  | 'common.close'
  | 'common.refresh'
  | 'common.loading'
  | 'common.error'
  | 'mediamtx.unreachable'
  | 'mediamtx.upstream'
  | 'mediamtx.noMetrics'
  | 'mediamtx.notKickable'

const zhCN: Record<MessageKey, string> = {
  'console.ready': 'MediaMTX 控制台就绪',
  'panel.status.title': 'MediaMTX 服务器',
  'panel.dashboard.title': '仪表盘',
  'panel.streams.title': '流路径',
  'panel.player.title': '预览播放',
  'panel.sessions.title': '会话',
  'server.unreachable': 'MediaMTX 不可达',
  'server.version': '版本',
  'server.started': '启动于',
  'server.listeners': '监听端口',
  'metrics.ready': '就绪流',
  'metrics.notReady': '待流',
  'metrics.readers': '观看者',
  'metrics.traffic': '流量',
  'stream.state.ready': '在线',
  'stream.state.idle': '待流',
  'stream.play': '播放',
  'stream.delete': '删除',
  'stream.deleted': '已删除 {name}',
  'stream.add': '添加路径',
  'stream.add.hint': '填 source 即拉流(如 rtsp:// 摄像头);留空则等待推流。',
  'stream.name': '路径名',
  'stream.source': '拉流源',
  'stream.sourcePlaceholder': 'rtsp://user:pass@host:554/stream(可留空)',
  'stream.record': '录制',
  'stream.added': '已添加 {name}',
  'stream.empty': '没有流路径 —— 添加一个摄像头源试试。',
  'stream.tracks': '轨道',
  'stream.viewers': '观看',
  'player.none': '在左侧选择一个流路径开始预览。',
  'player.mode.whep': 'WebRTC(WHEP,低延迟)',
  'player.mode.hls': 'HLS(兼容回退)',
  'player.connecting': '连接中…',
  'player.live': '播放中',
  'player.stopped': '已停止',
  'player.hlsUnsupported': '此浏览器不支持原生 HLS,请用 WebRTC 模式。',
  'player.stop': '停止',
  'sessions.empty': '当前没有会话。',
  'sessions.kick': '踢出',
  'sessions.kicked': '已踢出 {id}',
  'common.close': '关闭',
  'common.refresh': '刷新',
  'common.loading': '加载中…',
  'common.error': '出错了:{detail}',
  'mediamtx.unreachable': 'MediaMTX 不可达({url})',
  'mediamtx.upstream': 'MediaMTX 拒绝(HTTP {status}):{detail}',
  'mediamtx.noMetrics': '该 MediaMTX 未开启 metrics',
  'mediamtx.notKickable': '{kind} 会话不支持踢出',
}

const en: Record<MessageKey, string> = {
  'console.ready': 'MediaMTX console ready',
  'panel.status.title': 'MediaMTX server',
  'panel.dashboard.title': 'Dashboard',
  'panel.streams.title': 'Streams',
  'panel.player.title': 'Preview player',
  'panel.sessions.title': 'Sessions',
  'server.unreachable': 'MediaMTX unreachable',
  'server.version': 'Version',
  'server.started': 'Started',
  'server.listeners': 'Listeners',
  'metrics.ready': 'Ready streams',
  'metrics.notReady': 'Idle streams',
  'metrics.readers': 'Viewers',
  'metrics.traffic': 'Traffic',
  'stream.state.ready': 'Live',
  'stream.state.idle': 'Idle',
  'stream.play': 'Play',
  'stream.delete': 'Delete',
  'stream.deleted': 'Deleted {name}',
  'stream.add': 'Add path',
  'stream.add.hint': 'Set a source to pull (e.g. an rtsp:// camera); leave empty to wait for a publisher.',
  'stream.name': 'Path name',
  'stream.source': 'Source',
  'stream.sourcePlaceholder': 'rtsp://user:pass@host:554/stream (optional)',
  'stream.record': 'Record',
  'stream.added': 'Added {name}',
  'stream.empty': 'No stream paths — add a camera source to get going.',
  'stream.tracks': 'Tracks',
  'stream.viewers': 'Viewers',
  'player.none': 'Pick a stream on the left to preview it.',
  'player.mode.whep': 'WebRTC (WHEP, low latency)',
  'player.mode.hls': 'HLS (compatibility fallback)',
  'player.connecting': 'Connecting…',
  'player.live': 'Playing',
  'player.stopped': 'Stopped',
  'player.hlsUnsupported': 'This browser cannot play HLS natively — use WebRTC mode.',
  'player.stop': 'Stop',
  'sessions.empty': 'No sessions right now.',
  'sessions.kick': 'Kick',
  'sessions.kicked': 'Kicked {id}',
  'common.close': 'Close',
  'common.refresh': 'Refresh',
  'common.loading': 'Loading…',
  'common.error': 'Something went wrong: {detail}',
  'mediamtx.unreachable': 'MediaMTX unreachable ({url})',
  'mediamtx.upstream': 'MediaMTX refused (HTTP {status}): {detail}',
  'mediamtx.noMetrics': 'Metrics are disabled on this MediaMTX server',
  'mediamtx.notKickable': '{kind} sessions cannot be kicked',
}

export const messages: Record<'zh-CN' | 'en', Record<MessageKey, string>> = { 'zh-CN': zhCN, en }
