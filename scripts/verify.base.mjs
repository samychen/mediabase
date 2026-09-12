// mediabase / scripts / verify.base.mjs — NEUTRAL smoke test for a running host.
//
// This one knows nothing about media, python or product verbs: it checks the
// contracts the BASE owns, so any project built on `@mediabase/*` can run it as-is:
//
//   1. the app shell is served (`GET /` returns HTML),
//   2. `/api/health` answers `{ok:true}`,
//   3. the control plane answers over WS JSON-RPC,
//   4. `server.info` reports a control-plane protocol version,
//   5. `api.list` is non-empty (capabilities registered themselves),
//   6. `capabilities.verify()` is clean (declarations match reality),
//   7. a failing method answers with a CODED error that also carries a translation key
//      (`messageKey`/`messageParams`) — the wire contract the client localizes from,
//   8. the cross-origin-isolation posture is the one the host was asked for (COOP/COEP/
//      CORP present only with MEDIABASE_CROSS_ORIGIN_ISOLATION=1; the flag is what the
//      `@mediabase/shm` ring needs in a browser),
//   9. IF the deployment mounts the plugin manager: its catalog and its refusal are
//      well-formed, and any sandboxed plugin reports the confinement it got.
//
// Run:  node scripts/verify.base.mjs                     # http://127.0.0.1:3088
//       MEDIABASE_URL=http://127.0.0.1:3099 node scripts/verify.base.mjs
//       MEDIABASE_TOKEN=… PORT=3088 node scripts/verify.base.mjs
//       MEDIABASE_EXPECT_PROTOCOL=1 node scripts/verify.base.mjs   # fail on mismatch

import { checker, connect, hostUrl, withToken } from './lib/host-rpc.mjs'

const base = hostUrl()
const checks = checker()
console.log(`[verify.base] 目标宿主: ${base}${process.env.MEDIABASE_TOKEN ? '(带 token)' : ''}\n`)

// 1) the SPA shell is served without a token (it carries no data)
try {
  const res = await fetch(`${base}/`)
  const body = await res.text()
  checks.expect('GET / 返回应用外壳', res.ok && /<html|<!doctype/i.test(body), `${res.status}, ${body.length}B`)
} catch (e) {
  checks.fail('GET / 返回应用外壳', e.message)
}

// 2) health
let health = null
try {
  const res = await fetch(withToken(`${base}/api/health`))
  health = await res.json()
  checks.expect('GET /api/health', res.ok && health?.ok === true, JSON.stringify(health).slice(0, 120))
} catch (e) {
  checks.fail('GET /api/health', e.message)
}

// 3) control plane + 4) handshake + 5) registry + 6) declarations
const rpc = connect(base)
try {
  await rpc.open()
  checks.ok('WS /rpc 已连接')

  const info = await rpc.call('server.info', {})
  const protocol = info?.protocol
  checks.expect('server.info 报告控制面协议版本', typeof protocol === 'number', `protocol=${String(protocol)}`)
  const expected = process.env.MEDIABASE_EXPECT_PROTOCOL
  if (expected !== undefined) {
    checks.expect('控制面协议版本符合预期', String(protocol) === String(expected), `期望 ${expected},实际 ${String(protocol)}`)
  }

  const methods = await rpc.call('api.list', {})
  checks.expect(
    'api.list 非空(能力已自注册)',
    Array.isArray(methods) && methods.length > 0,
    `${Array.isArray(methods) ? methods.length : 0} 个方法`,
  )

  // 7) the error contract: a coded error AND a key a client can translate
  const refusal = await rpc.call('__no_such_method__', {}).then(
    () => null,
    (e) => e,
  )
  checks.expect(
    '未知方法返回带码 + 带 key 的错误',
    refusal !== null && typeof refusal.code === 'number' && typeof refusal.messageKey === 'string',
    refusal === null
      ? '意外成功'
      : `code=${refusal.code} key=${String(refusal.messageKey)} params=${JSON.stringify(refusal.messageParams ?? null)}`,
  )

  const reports = await rpc.call('capabilities.verify', {})
  const broken = Array.isArray(reports) ? reports.filter((r) => !r.ok) : [{ id: '(无返回)' }]
  checks.expect(
    'capabilities.verify() 全部一致',
    broken.length === 0,
    broken.length === 0
      ? `${reports.length} 个能力声明与注册一致`
      : `不符:${broken.map((r) => r.id).join(', ')}`,
  )
  // 9) the plugin manager, when this deployment mounts it (it is a base capability, but a
  //    fork may compose it out) — the catalog shape, the refusal, and the confinement
  //    report a sandboxed plugin must publish.
  if (Array.isArray(methods) && methods.some((m) => m.name === 'plugins.list')) {
    const catalog = await rpc.call('plugins.list', {})
    const shaped = Array.isArray(catalog) && catalog.every((p) => typeof p?.id === 'string' && typeof p?.state === 'string')
    checks.expect('plugins.list 返回目录条目(id/state)', shaped, `${Array.isArray(catalog) ? catalog.length : 0} 个插件`)

    const unknown = await rpc.call('plugins.probe', { id: '__no_such_plugin__' }).then(() => null, (e) => e)
    checks.expect(
      'plugins.probe 未知 id 返回带码 + 带 key 的错误',
      unknown !== null && typeof unknown.code === 'number' && typeof unknown.messageKey === 'string',
      unknown === null ? '意外成功' : `code=${unknown.code} key=${String(unknown.messageKey)}`,
    )

    const confined = []
    for (const entry of Array.isArray(catalog) ? catalog : []) {
      const probe = await rpc.call('plugins.probe', { id: entry.id }).catch(() => null)
      if (probe !== null && probe.confinement !== undefined && probe.confinement !== null) {
        confined.push({ id: entry.id, confinement: probe.confinement, confined: probe.confined })
      }
    }
    if (confined.length === 0) {
      // Not a silent pass: say what was not measured, so a green run cannot be read as
      // "the boundary was verified".
      checks.ok('sandboxed plugin 的限制报告  不适用(当前没有已加载的隔离子进程插件)')
    } else {
      const bad = confined.filter((c) => typeof c.confinement !== 'string' || c.confinement.trim() === '' || typeof c.confined !== 'boolean')
      checks.expect(
        'sandboxed plugin 报告了实际生效的限制',
        bad.length === 0,
        confined.map((c) => `${c.id}: ${c.confined ? '受限' : '未受限'} · ${String(c.confinement).slice(0, 60)}`).join(' | '),
      )
    }
  } else {
    checks.ok('plugins 能力检查  不适用(该组合未挂载插件管理器)')
  }
} catch (e) {
  checks.fail('控制面检查', e.message)
} finally {
  rpc.close()
}

// 8) the isolation posture (checked over HTTP, outside the RPC block)
const wantsIsolation = process.env.MEDIABASE_CROSS_ORIGIN_ISOLATION === '1'
for (const path of ['/', '/api/health']) {
  try {
    const res = await fetch(withToken(`${base}${path}`))
    const coop = res.headers.get('cross-origin-opener-policy')
    const coep = res.headers.get('cross-origin-embedder-policy')
    const corp = res.headers.get('cross-origin-resource-policy')
    if (wantsIsolation) {
      checks.expect(
        `${path} 带跨源隔离头(MEDIABASE_CROSS_ORIGIN_ISOLATION=1)`,
        coop === 'same-origin' && coep === 'require-corp' && corp === 'same-origin',
        `COOP=${String(coop)} COEP=${String(coep)} CORP=${String(corp)}`,
      )
    } else {
      checks.expect(
        `${path} 默认不带跨源隔离头`,
        coop === null && coep === null,
        `COOP=${String(coop)} COEP=${String(coep)}`,
      )
    }
  } catch (e) {
    checks.fail(`${path} 隔离头检查`, e.message)
  }
}

process.exit(checks.summary('BASE OK — 外壳 + 健康检查 + 控制面 + 注册表 + 能力声明 + 错误契约 + 隔离姿态全部通过。'))
