// Every operator-facing string, both locales. Panels never hold UI copy.

export type MessageKey =
  | 'console.ready'
  | 'panel.status.title'
  | 'panel.dashboard.title'
  | 'panel.streams.title'
  | 'panel.player.title'
  | 'panel.sessions.title'
  | 'panel.recordings.title'
  | 'panel.sync.title'
  | 'panel.config.title'
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
  | 'player.mseUnsupported'
  | 'player.stop'
  | 'player.chainScrub'
  | 'recordings.pick'
  | 'recordings.noPaths'
  | 'recordings.empty'
  | 'recordings.playChain'
  | 'config.servers'
  | 'config.serverAdd'
  | 'config.serverAdded'
  | 'config.serverRemoved'
  | 'config.serverSwitched'
  | 'config.srvName'
  | 'config.srvUrl'
  | 'config.srvUser'
  | 'config.srvPass'
  | 'config.srvToken'
  | 'config.serverActive'
  | 'config.serverUpdate'
  | 'config.serverUpdated'
  | 'config.srvEdit'
  | 'config.srvEditCancel'
  | 'config.srvKeep'
  | 'config.tokenExpired'
  | 'config.tokenExpiring'
  | 'config.save'
  | 'config.reset'
  | 'config.saved'
  | 'config.dirty'
  | 'config.danger'
  | 'config.readonly'
  | 'sync.addToSync'
  | 'sync.empty'
  | 'sync.dropHint'
  | 'sync.play'
  | 'sync.pause'
  | 'sync.clear'
  | 'sync.layout'
  | 'sync.layout.1'
  | 'sync.layout.4'
  | 'sync.layout.9'
  | 'sync.removeSlot'
  | 'sync.seekHint'
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
  | 'mediamtx.playbackDisabled'
  | 'mediamtx.playbackUnreachable'
  | 'mediamtx.serverExists'
  | 'mediamtx.serverUnknown'
  | 'mediamtx.serverActive'
  | 'mediamtx.serverBadUrl'
  | 'mediamtx.serverBadName'

const zhCN: Record<MessageKey, string> = {
  'console.ready': 'MediaMTX 控制台就绪',
  'panel.status.title': 'MediaMTX 服务器',
  'panel.dashboard.title': '仪表盘',
  'panel.streams.title': '流路径',
  'panel.player.title': '预览播放',
  'panel.sessions.title': '会话',
  'panel.recordings.title': '录像回放',
  'panel.sync.title': '同步回放',
  'panel.config.title': '全局配置',
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
  'player.mseUnsupported': '此浏览器不支持 MediaSource(MSE),无法回放录像。',
  'player.stop': '停止',
  'player.chainScrub': '整链进度;跨窗口跳转将从目标窗口的第一个字节重新取流(/get 无 Range)',
  'recordings.pick': '选择路径…',
  'recordings.noPaths': '还没有录像 —— 给路径开启「录制」,推流之后这里会出现可回放的窗口。',
  'recordings.empty': '该路径暂无可回放窗口。',
  'recordings.playChain': '从此窗口连播(自动接续其后的窗口)',
  'config.servers': '服务器',
  'config.serverAdd': '登记',
  'config.serverAdded': '已登记 {name}',
  'config.serverRemoved': '已移除 {name}',
  'config.serverSwitched': '已切换到 {name}',
  'config.srvName': '名称',
  'config.srvUrl': 'API 地址',
  'config.srvUser': '用户名(basic)',
  'config.srvPass': '密码',
  'config.srvToken': 'Bearer/JWT(优先)',
  'config.serverActive': '活动',
  'config.serverUpdate': '更新',
  'config.serverUpdated': '已更新 {name}',
  'config.srvEdit': '编辑(轮换凭据/改地址)',
  'config.srvEditCancel': '取消编辑',
  'config.srvKeep': '留空 = 保持不变',
  'config.tokenExpired': 'token 已过期({time})',
  'config.tokenExpiring': 'token {time} 过期',
  'config.save': '保存改动',
  'config.reset': '放弃改动',
  'config.saved': '已保存 {n} 个键,并回读了服务器的归一化结果。',
  'config.dirty': '{n} 处改动',
  'config.danger': '改动立即生效(监听地址尤甚,保存后对应服务会重启);「保存」只发送你改过的键。复合值(对象/数组)只读,请改 mediamtx.yml。',
  'config.readonly': '复合值只读 —— 用 mediamtx.yml 编辑',
  'sync.addToSync': '加入同步回放(从此窗口串联)',
  'sync.empty': '还没有画面 —— 点录像窗口行的「加入同步回放」,或把窗口拖进下面的格子;多路录像会在同一条时间轴上对齐播放。',
  'sync.dropHint': '拖入录像窗口',
  'sync.play': '播放',
  'sync.pause': '暂停',
  'sync.clear': '清空',
  'sync.layout': '布局',
  'sync.layout.1': '单画面',
  'sync.layout.4': '四宫格',
  'sync.layout.9': '九宫格',
  'sync.removeSlot': '移出该格',
  'sync.seekHint': '拖动仅在已缓冲范围内即时生效;向后跳过缓冲只能等流追上(playback 服务的 /get 不支持 Range)。',
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
  'mediamtx.playbackDisabled': '该 MediaMTX 未开启回放服务(mediamtx.yml 加 playback: yes)',
  'mediamtx.playbackUnreachable': '回放服务不可达({url})',
  'mediamtx.serverExists': '服务器 {name} 已登记',
  'mediamtx.serverUnknown': '没有名为 {name} 的服务器',
  'mediamtx.serverActive': '{name} 是当前活动服务器 —— 先切换到别的服务器再移除',
  'mediamtx.serverBadUrl': '不是合法的 http(s) 地址:{url}',
  'mediamtx.serverBadName': '服务器名称不能为空白',
}

const en: Record<MessageKey, string> = {
  'console.ready': 'MediaMTX console ready',
  'panel.status.title': 'MediaMTX server',
  'panel.dashboard.title': 'Dashboard',
  'panel.streams.title': 'Streams',
  'panel.player.title': 'Preview player',
  'panel.sessions.title': 'Sessions',
  'panel.recordings.title': 'Recordings',
  'panel.sync.title': 'Sync playback',
  'panel.config.title': 'Global config',
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
  'player.mseUnsupported': 'This browser lacks MediaSource (MSE) — recording playback unavailable.',
  'player.stop': 'Stop',
  'player.chainScrub': 'Whole-chain progress; a cross-window jump re-streams from the target window’s first byte (/get has no Range)',
  'recordings.pick': 'Select a path…',
  'recordings.noPaths': 'No recordings yet — enable Record on a path, publish to it, and playable windows will show up here.',
  'recordings.empty': 'No playable windows for this path yet.',
  'recordings.playChain': 'Play from here (chains the following windows)',
  'config.servers': 'Servers',
  'config.serverAdd': 'Register',
  'config.serverAdded': 'Registered {name}',
  'config.serverRemoved': 'Removed {name}',
  'config.serverSwitched': 'Switched to {name}',
  'config.srvName': 'Name',
  'config.srvUrl': 'API base URL',
  'config.srvUser': 'Username (basic)',
  'config.srvPass': 'Password',
  'config.srvToken': 'Bearer/JWT (wins)',
  'config.serverActive': 'active',
  'config.serverUpdate': 'Update',
  'config.serverUpdated': 'Updated {name}',
  'config.srvEdit': 'Edit (rotate credentials / change URL)',
  'config.srvEditCancel': 'Cancel edit',
  'config.srvKeep': 'blank = keep',
  'config.tokenExpired': 'token EXPIRED ({time})',
  'config.tokenExpiring': 'token expires {time}',
  'config.save': 'Save changes',
  'config.reset': 'Discard changes',
  'config.saved': 'Saved {n} key(s) and re-read the server’s normalized truth.',
  'config.dirty': '{n} pending',
  'config.danger': 'Changes apply immediately (listener addresses especially — saving restarts that listener); Save sends only the keys you changed. Composite values (objects/arrays) are read-only here; edit them in mediamtx.yml.',
  'config.readonly': 'Composite value — read-only; edit via mediamtx.yml',
  'sync.addToSync': 'Add to sync wall (chains from here)',
  'sync.empty': 'Nothing on the wall yet — click “Add to sync playback” on a recording window, or drag one into the grid; several windows then play side by side on ONE shared timeline.',
  'sync.dropHint': 'Drop a recording window',
  'sync.play': 'Play',
  'sync.pause': 'Pause',
  'sync.clear': 'Clear',
  'sync.layout': 'Layout',
  'sync.layout.1': 'Single',
  'sync.layout.4': 'Quad',
  'sync.layout.9': 'Nine',
  'sync.removeSlot': 'Remove from grid',
  'sync.seekHint': 'Scrubbing is instant only inside the buffered range; forward seeks wait for the stream to catch up (the playback server’s /get has no Range support).',
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
  'mediamtx.playbackDisabled': 'The playback server is disabled on this MediaMTX (set playback: yes in mediamtx.yml)',
  'mediamtx.playbackUnreachable': 'Playback server unreachable ({url})',
  'mediamtx.serverExists': 'Server {name} is already registered',
  'mediamtx.serverUnknown': 'No server named {name}',
  'mediamtx.serverActive': '{name} is the ACTIVE server — switch away before removing it',
  'mediamtx.serverBadUrl': 'Not an absolute http(s) URL: {url}',
  'mediamtx.serverBadName': 'Server name must not be blank',
}

export const messages: Record<'zh-CN' | 'en', Record<MessageKey, string>> = { 'zh-CN': zhCN, en }
