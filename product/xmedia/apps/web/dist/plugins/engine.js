// engine 插件 —— 引擎监督状态与最近调用结果（全局调用抽屉的镜像）。
// 引擎与宿主之间只有控制面命令；本视图只读 health，不发起任何任务。
export default {
  id: 'engine',
  title: '引擎与指标',
  area: 'sidebar',
  group: '系统',
  order: 50,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',

  mount(el) {
    el.innerHTML = `
      <header class="view-head">
        <h1>引擎与指标</h1>
        <p>子进程监督状态、任务指标与最近一次调用结果。引擎与宿主之间只有控制面命令，媒体字节从不经过本页。</p>
      </header>

      <div class="panel">
        <h2>引擎监督状态</h2>
        <pre id="state">连接中…</pre>
      </div>

      <div class="panel">
        <h2>最近一次调用结果</h2>
        <pre id="out-detail">—</pre>
      </div>`

    const refresh = async () => {
      try {
        const res = await fetch(`/api/health`)
        const health = await res.json()
        el.querySelector('#state').textContent = JSON.stringify(health.xmedia ?? { offline: true }, null, 2)
      } catch (e) {
        el.querySelector('#state').textContent = `health 不可用: ${e.message}`
      }
    }
    void refresh()
    // 面板没有 unmount 契约（视图仅隐藏保状态），定时器随页面存续——本壳刻意
    // 不为只读面板引入销毁复杂度；挂载只发生一次。
    setInterval(() => { void refresh() }, 10_000)
    void timer
  },
}
