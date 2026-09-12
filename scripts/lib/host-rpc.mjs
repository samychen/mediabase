// scripts/lib/host-rpc.mjs — tiny JSON-RPC/HTTP client for the verification scripts.
//
// Shared by the neutral smoke test (`verify.base.mjs`) so it speaks the same way to a
// running host. No dependencies: Node's built-in WebSocket + fetch.

/** Where the host is: MEDIABASE_URL, else http://HOST:PORT (PORT, default 3088). */
export function hostUrl(env = process.env) {
  if (env.MEDIABASE_URL) return env.MEDIABASE_URL.replace(/\/+$/, '')
  const host = env.MEDIABASE_HOST ?? '127.0.0.1'
  const port = env.PORT ?? env.MEDIABASE_PORT ?? '3088'
  return `http://${host}:${port}`
}

/** Add the shared token when the host enforces one (`MEDIABASE_TOKEN`). */
export function withToken(url, env = process.env) {
  const token = env.MEDIABASE_TOKEN
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/** Minimal JSON-RPC client over the control-plane WebSocket. */
export function connect(baseUrl, env = process.env) {
  const wsUrl = withToken(`${baseUrl.replace(/^http/, 'ws')}/rpc`, env)
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()

  ws.addEventListener('message', (e) => {
    const res = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
    const slot = pending.get(res.id)
    if (!slot) return
    pending.delete(res.id)
    if (res.error) {
      // Carry the WHOLE wire error, like the real client (@mediabase/rpc): `code` picks the
      // bucket, `messageKey`/`messageParams` make it translatable, `data` is the
      // structured detail. Copying only `code` made a verification script report less
      // than a browser sees — the same mistake tests/support/host.ts had.
      slot.reject(Object.assign(new Error(res.error.message), res.error))
    } else slot.resolve(res.result)
  })

  return {
    ws,
    open: () => new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error(`无法连接 ${wsUrl}`)), { once: true })
      setTimeout(() => reject(new Error(`连接 ${wsUrl} 超时`)), 10_000)
    }),
    /** One JSON-RPC call; rejects with the wire error (code preserved). */
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
        setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(`rpc timeout: ${method}`))
        }, 20_000)
      })
    },
    close: () => ws.close(),
  }
}

/** Print a labelled check and remember whether it failed. */
export function checker() {
  const failures = []
  return {
    ok(label, detail) {
      console.log(`✓ ${label}${detail === undefined ? '' : `  ${detail}`}`)
    },
    fail(label, detail) {
      failures.push(label)
      console.error(`✗ ${label}${detail === undefined ? '' : `  ${detail}`}`)
    },
    /** Assert a value: truthy/false decides between ✓ and ✗. */
    expect(label, condition, detail) {
      if (condition) this.ok(label, detail)
      else this.fail(label, detail)
      return condition
    },
    summary(title) {
      if (failures.length > 0) {
        console.error(`\n${failures.length} 项检查未通过:${failures.join(' / ')}`)
        return 1
      }
      console.log(`\n${title}`)
      return 0
    },
  }
}
