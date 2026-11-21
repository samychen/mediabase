// monitor 插件 —— 转码任务监控：新建离线转码表单 + 全任务池快照表格。
// 数据源是 xmedia.publish.jobs（一次调用拿全池），行按钮复用任务池公共动词
// stop/pause/resume；1s 轮询一次，从不逐任务轮询。
import { shortPath } from './lib/_lib.js'

export default {
  id: 'monitor',
  title: '转码监控',
  area: 'sidebar',
  group: '媒体面',
  order: 20,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>',

  mount(el, ctx) {
    const { call, show } = ctx
    el.innerHTML = `
      <header class="view-head">
        <h1>转码任务监控</h1>
        <p>离线转码 · 并发任务池。多个任务在引擎进程内并发执行，每 1s 刷新一次全池快照。</p>
      </header>

      <div class="panel">
        <h2>新建离线转码</h2>
        <div class="row">
          <span class="label">输入</span>
          <input id="job-input" class="grow" size="40" placeholder="/path/to/source.mp4">
          <span class="label">输出</span>
          <input id="job-output" class="grow" size="40" placeholder="/path/to/out.mp4（绝对路径，容器随扩展名）">
        </div>
        <div class="row" style="margin-top: 8px">
          <span class="label">视频编码</span>
          <input id="job-vcodec" size="22" placeholder="留空 = copy；或 libx264 / h264_videotoolbox…">
          <span class="label">音频编码</span>
          <input id="job-acodec" size="22" placeholder="留空 = copy；显式空串 = 丢轨">
          <button id="job-submit" class="btn primary">新建转码</button>
        </div>
      </div>

      <div class="panel">
        <h2>任务池快照</h2>
        <table class="jobs" id="jobs-table">
          <thead>
            <tr><th>任务</th><th>输入 → 输出</th><th>进度</th><th>状态</th><th>耗时</th><th>操作</th></tr>
          </thead>
          <tbody id="jobs-body"><tr><td colspan="6">任务池快照读取中…</td></tr></tbody>
        </table>
        <p class="hint">
          「暂停/继续」是协作式的：worker 在下一个包边界挂起/恢复（阻塞中的网络读会先读完当前包），
          暂停期间耗时不再累计；「停止」为协作式取消，文件输出仍会收尾出可播放容器。
          已完成的任务保留在列表里，直到下一次新建转码触发清理。
        </p>
      </div>`

    const $id = (id) => el.querySelector('#' + id)

    const jobPhase = (job) => job.running
      ? (job.paused ? 'pause' : 'run')
      : (job.done
        ? (job.ok ? 'done' : (/cancel/i.test(job.error || '') ? 'cancel' : 'fail'))
        : 'run')
    const JOB_BADGES = { run: '运行中', pause: '已暂停', done: '已完成', cancel: '已取消', fail: '失败' }

    const fmtJob = (job) => {
      const phase = jobPhase(job)
      const badge = JOB_BADGES[phase] ?? '未知'
      const action = phase === 'pause' ? '继续' : '暂停'
      const stopBtn = (phase === 'run' || phase === 'pause')
        ? `<button class="btn" data-act="stop" data-id="${job.jobId}">停止</button>` : ''
      return `<tr>
        <td title="${job.jobId}">${job.jobId.slice(0, 8)}</td>
        <td class="path">${shortPath(job.input || '—')} → ${shortPath(job.output || '—')}</td>
        <td><div class="bar ${phase === 'pause' ? 'paused' : ''}"><i style="width:${job.progress}%"></i></div> ${job.progress}%</td>
        <td><span class="badge ${phase}">${badge}</span></td>
        <td>${(job.elapsedMs / 1000).toFixed(1)}s</td>
        <td>${stopBtn}${phase === 'run' || phase === 'pause' ? `<button class="btn" data-act="pause" data-id="${job.jobId}">${action}</button>` : ''}</td>
      </tr>`
    }

    const renderJobs = (jobs) => {
      const body = $id('jobs-body')
      if (!jobs || jobs.error) {
        body.innerHTML = `<tr><td colspan="6">任务池快照读取失败: ${JSON.stringify(jobs?.error ?? jobs)}</td></tr>`
        return
      }
      if (jobs.length === 0) {
        body.innerHTML = '<tr><td colspan="6">任务池为空 —— 填上方表单新建离线转码，或经 agent 工具/API 创建</td></tr>'
        return
      }
      body.innerHTML = jobs.map(fmtJob).join('')
    }

    const refreshJobs = async () => {
      renderJobs(await call('xmedia.publish.jobs'))
    }

    $id('jobs-table').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-act]')
      if (!btn) return
      const jobId = btn.dataset.id
      const act = btn.dataset.act
      const verb = act === 'stop' ? 'xmedia.publish.stop'
        : (btn.textContent === '继续' ? 'xmedia.publish.resume' : 'xmedia.publish.pause')
      show(await call(verb, { jobId }))
      void refreshJobs()
    })

    $id('job-submit').addEventListener('click', async () => {
      const input = $id('job-input').value.trim()
      const output = $id('job-output').value.trim()
      if (!input || !output) { show({ error: '离线转码需要输入与输出绝对路径' }); return }
      // Empty codec fields must stay ABSENT: an explicit empty column on the wire
      // means "drop this stream" (-vn/-an), not "copy".
      const params = { input, output, realtime: false }
      if ($id('job-vcodec').value.trim()) params.videoCodec = $id('job-vcodec').value.trim()
      if ($id('job-acodec').value.trim()) params.audioCodec = $id('job-acodec').value.trim()
      const result = await call('xmedia.publish.start', params)
      show(result)
      if (result && !result.error) void refreshJobs()
    })

    void refreshJobs()
    setInterval(() => { void refreshJobs() }, 1000)
  },
}
