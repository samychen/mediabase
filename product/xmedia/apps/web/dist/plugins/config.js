// config 插件 —— 流服务配置：多服务器注册表 + 全局配置编辑器。
// （完整管理台能力；纯逻辑在 lib/conf.js。）
//
// Global config: MediaMTX's /v3/config/global/get is a FLAT dict of ~122 keys
// rendered ALL (bucketed by key prefix, scalars editable, composite read-only
// JSON). Save sends ONLY the diff via mediamtx.config.global.patch and
// re-reads, because the server normalizes values and listener changes apply
// immediately — the panel must show the server's truth, not the draft.
// Servers: a registry (serversFile) with switch/add/update/remove; blank
// credential fields KEEP existing ones; bearer expiry is decoded client-side
// (never verified — that is the server's job).

import { configDiff, groupConfig, seedDraft } from './lib/conf.js'
import { fmtClock, fmtDay } from './lib/_lib.js'

const TOKEN_SOON_MS = 10 * 60 * 1000

export default {
  id: 'mtxconfig',
  title: '流服务配置',
  area: 'sidebar',
  group: '工具',
  order: 45,
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',

  mount(el, ctx) {
    const { call, show } = ctx
    el.innerHTML = `
      <header class="view-head">
        <h1>流服务配置</h1>
        <p>多服务器注册表（serversFile）与 MediaMTX 全局配置的上游真相：全部键都渲染
          （按前缀分组），标量可编辑，复合值只读——保存只发送 diff 并立即重读。
          <strong>危险区</strong>：global patch 会立即影响所有 listener。</p>
      </header>

      <div class="panel">
        <h2>服务器注册表</h2>
        <div class="row" style="margin-bottom: 8px">
          <select id="cf-active" style="font: inherit; padding: 6px 8px; border: 1px solid var(--xm-border); border-radius: 8px; background: #fff; flex: 1 1 320px"></select>
        </div>
        <table class="jobs" id="cf-servers"><tbody></tbody></table>
        <div class="row" style="margin-top: 10px">
          <input id="cf-srv-name" size="10" placeholder="名称 (office)">
          <input id="cf-srv-url" class="grow" size="30" placeholder="http://192.168.1.10:9997" style="font-family: var(--xm-mono)">
          <input id="cf-srv-user" size="12" placeholder="用户（留空=保留）">
          <input id="cf-srv-pass" size="12" type="password" placeholder="密码（留空=保留）" autocomplete="new-password">
          <input id="cf-srv-token" size="14" type="password" placeholder="Bearer（留空=保留）" autocomplete="off">
          <button id="cf-srv-submit" class="btn primary">注册</button>
          <button id="cf-srv-cancel" class="btn" style="display:none">取消编辑</button>
        </div>
        <p class="hint" id="cf-srv-msg"></p>
      </div>

      <div class="panel">
        <h2>全局配置（MediaMTX 上游真相）</h2>
        <div class="row" style="margin-bottom: 8px">
          <button id="cf-refresh" class="btn">重读</button>
          <button id="cf-save" class="btn primary" disabled>保存 diff</button>
          <button id="cf-reset" class="btn" disabled>还原草稿</button>
          <span id="cf-dirty" class="badge pause" style="display:none"></span>
        </div>
        <p class="hint" id="cf-msg" style="color: var(--xm-muted)"></p>
        <div id="cf-groups" style="margin-top: 8px"></div>
      </div>`

    const $id = (id) => el.querySelector('#' + id)
    const msg = (e) => (e instanceof Error ? e.message : String(e))
    const note = (text, isError) => {
      const node = $id('cf-srv-msg')
      node.textContent = text
      node.style.color = isError ? 'var(--xm-danger)' : ''
    }

    // ---- 全局配置编辑器 -----------------------------------------------------------
    let cfg = null          // 上游真相（flat dict）
    let draft = {}          // 标量草稿
    let cfgSaving = false
    let cfgLoading = false

    const numText = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')

    const renderGroups = () => {
      const wrap = $id('cf-groups')
      if (cfg === null) { wrap.innerHTML = '<p class="hint">尚未加载</p>'; return }
      const dirty = configDiff(cfg, draft)
      const dirtyCount = Object.keys(dirty).length
      $id('cf-save').disabled = dirtyCount === 0 || cfgSaving
      $id('cf-reset').disabled = dirtyCount === 0
      const dirtyEl = $id('cf-dirty')
      dirtyEl.style.display = dirtyCount > 0 ? '' : 'none'
      dirtyEl.textContent = `待保存 ${dirtyCount} 项`
      const groups = groupConfig(cfg)
      wrap.innerHTML = ''
      for (const g of groups) {
        const details = document.createElement('details')
        details.style.cssText = 'border: 1px solid var(--xm-border); border-radius: 8px; padding: 6px 10px; margin-bottom: 6px'
        const fields = g.fields.map((f) => {
          const keyHtml = `<span class="label" title="${f.key}" style="font-family: var(--xm-mono)">${f.key}</span>`
          if (f.kind === 'complex') {
            return `<div class="row" style="align-items:flex-start"><div style="flex:0 0 260px">${keyHtml}</div>
              <pre style="flex:1" title="复合值只读——它的编辑器是 mediamtx.yml">${JSON.stringify(f.value, null, 1)}</pre></div>`
          }
          if (f.kind === 'bool') {
            return `<div class="row"><div style="flex:0 0 260px">${keyHtml}</div>
              <input type="checkbox" data-cf-key="${f.key}" data-cf-kind="bool" ${draft[f.key] === true ? 'checked' : ''}></div>`
          }
          if (f.kind === 'number') {
            return `<div class="row"><div style="flex:0 0 260px">${keyHtml}</div>
              <input type="number" step="any" data-cf-key="${f.key}" data-cf-kind="number" value="${numText(draft[f.key])}" style="max-width: 200px"></div>`
          }
          return `<div class="row"><div style="flex:0 0 260px">${keyHtml}</div>
            <input type="text" data-cf-key="${f.key}" data-cf-kind="string" value="${typeof draft[f.key] === 'string' ? draft[f.key] : ''}" style="flex:1 1 320px"></div>`
        }).join('')
        details.innerHTML = `<summary class="label" style="cursor:pointer">${g.group} · ${g.fields.length}</summary>
          <div style="padding: 8px 0">${fields}</div>`
        wrap.appendChild(details)
      }
    }

    $id('cf-groups').addEventListener('change', (event) => {
      const input = event.target.closest('input[data-cf-key]')
      if (input === null || cfg === null) return
      const key = input.dataset.cfKey
      if (input.dataset.cfKind === 'bool') draft[key] = input.checked
      else if (input.dataset.cfKind === 'number') draft[key] = input.value === '' ? Number.NaN : Number(input.value)
      else draft[key] = input.value
      renderGroups()
    })

    const loadConfig = async () => {
      cfgLoading = true
      $id('cf-refresh').disabled = true
      const value = await call('mediamtx.config.global.get')
      cfgLoading = false
      $id('cf-refresh').disabled = false
      if (value && value.error) {
        cfg = null
        $id('cf-msg').textContent = `全局配置不可达: ${value.error.message ?? JSON.stringify(value.error)}`
        renderGroups()
        return
      }
      cfg = value.config ?? {}
      draft = seedDraft(cfg)
      $id('cf-msg').textContent = `已加载 ${Object.keys(cfg).length} 个键 —— 显示上游全部，保存只发送 diff`
      renderGroups()
    }

    $id('cf-save').addEventListener('click', async () => {
      if (cfg === null || cfgSaving) return
      const dirty = configDiff(cfg, draft)
      const n = Object.keys(dirty).length
      if (n === 0) return
      cfgSaving = true
      $id('cf-save').disabled = true
      const res = await call('mediamtx.config.global.patch', { values: dirty })
      cfgSaving = false
      if (res && res.error) {
        $id('cf-msg').textContent = `保存失败: ${res.error.message ?? JSON.stringify(res.error)}`
        $id('cf-msg').style.color = 'var(--xm-danger)'
        return
      }
      $id('cf-msg').style.color = ''
      await loadConfig()  // 保存后立即重读：服务端会归一化值，面板必须显示上游真相
    })
    $id('cf-reset').addEventListener('click', () => {
      if (cfg !== null) draft = seedDraft(cfg)
      renderGroups()
    })
    $id('cf-refresh').addEventListener('click', () => { void loadConfig() })

    // ---- 服务器注册表 ---------------------------------------------------------------
    let servers = []
    let activeServer = null
    let editing = null
    const SRV_FIELDS = ['name', 'url', 'user', 'pass', 'token']

    const srvForm = () => ({
      name: $id('cf-srv-name').value.trim(),
      url: $id('cf-srv-url').value.trim(),
      username: $id('cf-srv-user').value.trim(),
      password: $id('cf-srv-pass').value,
      token: $id('cf-srv-token').value.trim(),
    })
    const resetSrvForm = () => {
      for (const f of SRV_FIELDS) $id(`cf-srv-${f}`).value = ''
      $id('cf-srv-name').disabled = false
      editing = null
      $id('cf-srv-submit').textContent = '注册'
      $id('cf-srv-submit').classList.add('primary')
      $id('cf-srv-cancel').style.display = 'none'
    }

    const tokenBadge = (expiresAt) => {
      const ms = expiresAt * 1000
      const iso = new Date(ms).toISOString()
      const time = `${fmtDay(iso)} ${fmtClock(iso)}`
      if (ms < Date.now()) return { state: 'fail', text: `已过期 ${time}` }
      if (ms - Date.now() < TOKEN_SOON_MS) return { state: 'pause', text: `即将过期 ${time}` }
      return { state: 'cancel', text: `有效期至 ${time}` }
    }

    const renderServers = () => {
      const sel = $id('cf-active')
      sel.innerHTML = servers.map((s) =>
        `<option value="${s.name}" ${s.name === activeServer ? 'selected' : ''}>${s.name} · ${s.url}</option>`).join('')
      const tbody = $id('cf-servers').querySelector('tbody')
      tbody.innerHTML = servers.map((s) => {
        const exp = s.expiresAt !== null ? (() => {
          const b = tokenBadge(s.expiresAt)
          return `<span class="badge ${b.state}">${b.text}</span>`
        })() : s.auth
        return `<tr>
          <td class="path">${s.name}${s.name === activeServer ? ' · 当前' : ''}</td>
          <td class="path">${s.url}</td>
          <td>${exp}</td>
          <td>
            <button class="btn" data-edit="${s.name}" data-url="${s.url}">编辑</button>
            <button class="btn" data-remove="${s.name}" ${s.name === activeServer ? 'disabled' : ''}>删除</button>
          </td>
        </tr>`
      }).join('')
    }

    const loadServers = async () => {
      const value = await call('mediamtx.servers.list')
      if (value && value.error) { note(`注册表不可读: ${value.error.message ?? ''}`, true); return }
      servers = value.servers ?? []
      activeServer = value.active ?? null
      renderServers()
    }

    $id('cf-active').addEventListener('change', async (e) => {
      const name = e.target.value
      if (name === '' || name === activeServer) return
      const res = await call('mediamtx.servers.switch', { name })
      if (res && res.error) { note(`切换失败: ${res.error.message ?? ''}`, true); return }
      activeServer = name
      note(`已切换到 ${name}`, false)
      renderServers()
    })

    $id('cf-srv-submit').addEventListener('click', async () => {
      const form = srvForm()
      if (form.name === '' || form.url === '') { note('名称与 URL 必填', true); return }
      // 凭据空字段 KEEP：payload 省略它们；显式空串才会清空（编辑态也不发空串）。
      const payload = { name: form.name, url: form.url }
      if (form.username !== '') { payload.username = form.username; payload.password = form.password }
      if (form.token !== '') payload.token = form.token
      const res = await call(editing === null ? 'mediamtx.servers.add' : 'mediamtx.servers.update', payload)
      if (res && res.error) { note(`${editing === null ? '注册' : '更新'}失败: ${res.error.message ?? ''}`, true); return }
      note(`${editing === null ? '已注册' : '已更新'} ${form.name}`, false)
      resetSrvForm()
      void loadServers()
    })
    $id('cf-srv-cancel').addEventListener('click', resetSrvForm)
    $id('cf-servers').addEventListener('click', (event) => {
      const editBtn = event.target.closest('button[data-edit]')
      if (editBtn !== null) {
        editing = editBtn.dataset.edit
        $id('cf-srv-name').value = editing
        $id('cf-srv-name').disabled = true
        $id('cf-srv-url').value = editBtn.dataset.url
        $id('cf-srv-submit').textContent = '更新'
        $id('cf-srv-submit').classList.remove('primary')
        $id('cf-srv-cancel').style.display = ''
        note(`正在编辑 ${editing} —— 凭据留空即保留`, false)
        return
      }
      const removeBtn = event.target.closest('button[data-remove]')
      if (removeBtn !== null) {
        void call('mediamtx.servers.remove', { name: removeBtn.dataset.remove })
          .then((res) => {
            if (res && res.error) { note(`删除失败: ${res.error.message ?? ''}`, true); return }
            note(`已删除 ${removeBtn.dataset.remove}`, false)
            void loadServers()
          })
      }
    })

    void loadConfig()
    void loadServers()
  },
}
