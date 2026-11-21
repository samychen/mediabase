// studio 插件 —— HF Studio 编辑器入口。Studio 是独立 Python 进程（stdlib HTTP，
// 仅绑 127.0.0.1），浏览器直连它，宿主不代理其字节；导出经烘焙管线出片。
export default {
  id: 'studio',
  title: 'HF Studio',
  area: 'sidebar',
  group: '工具',
  order: 40,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',

  mount(el, ctx) {
    const { call, show } = ctx
    const query = new URLSearchParams(location.search).has('token')
      ? `?token=${encodeURIComponent(new URLSearchParams(location.search).get('token'))}` : ''
    el.innerHTML = `
      <header class="view-head">
        <h1>HF Studio 编辑器</h1>
        <p>HyperFrames 对齐创作工作台：独立 Python 进程（stdlib HTTP 服务器，仅绑 127.0.0.1）。
          浏览器直连 Studio，<strong>宿主不代理其字节</strong>；导出经本产品的烘焙管线（xmedia-bake）。</p>
      </header>

      <div class="panel">
        <div class="row">
          <button id="studio-open" class="btn primary">打开 Studio（新标签）</button>
          <a id="studio-link" class="label" href="#" target="_blank" rel="noopener" style="display:none"></a>
        </div>
        <pre id="studio-state" style="margin-top: 10px">状态读取中…</pre>
      </div>`

    const $id = (id) => el.querySelector('#' + id)

    const refreshStudio = async () => {
      const value = await call('xmedia.studio.state')
      if (value && !value.error) {
        $id('studio-state').textContent = JSON.stringify(value, null, 2)
        if (value.running) {
          const link = $id('studio-link')
          link.href = value.url + query
          link.textContent = value.url
          link.style.display = 'inline'
        }
      } else {
        $id('studio-state').textContent = 'Studio 状态读取失败'
      }
      return value
    }

    $id('studio-open').addEventListener('click', async () => {
      const value = await call('xmedia.studio.url')
      if (value && !value.error && value.url) {
        window.open(value.url + query, '_blank', 'noopener')
        show(value)
      } else {
        show(value ?? { error: 'studio url 不可用' })
      }
    })

    void refreshStudio()
  },
}
