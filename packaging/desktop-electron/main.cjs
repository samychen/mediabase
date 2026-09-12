// Desktop shell (Electron) — packaging/desktop-electron/main.cjs
//
// Thin shell: forks the bundled Node host (build/host.cjs produced by
// `pnpm run build:host`) with env pointing into app resources, waits for the health
// endpoint, then opens a window at http://127.0.0.1:<port>. Closing the window stops
// the host child. All real work stays in the host (see root AGENTS.md).
//
// FORK POINT: the whole product identity is the PRODUCT block below — name, config
// directory, env prefix and the resource table (env var → packaged path / dev path).
// Everything after it is generic shell logic and needs no edits.
const { app, BrowserWindow } = require('electron')
const os = require('node:os')
const { readFileSync } = require('node:fs')
const { fork } = require('node:child_process')
const { join } = require('node:path')
const { existsSync } = require('node:fs')

// ---------------------------------------------------------------- PRODUCT IDENTITY
const PRODUCT = {
  /** Window title. */
  title: 'Mediabase',
  /** Per-user config directory (default env file for a double-clicked app). */
  configDir: '.mediabase',
  /**
   * Env vocabulary this app's host uses (its boot identity's prefix). The shell only builds
   * the variable NAMES it injects from it — it never decides the vocabulary, the host does.
   */
  envPrefix: 'MEDIABASE_',
  /**
   * Resource table: env var the HOST reads → path inside the packaged app
   * (relative to Contents/Resources) and path in a repo checkout (relative to the
   * repo root). Add a row when the host grows another injected path.
   */
  resources: [
    ['DIST_INDEX', 'web/index.html', 'apps/web/dist/index.html'],
    ['HELLO', 'examples/hello.cjs', 'build/examples/hello.cjs'],
    // Sandboxed plugins spawn a CHILD process, so these must be real files on disk.
    ['SANDBOX_ENTRY', 'sandbox/sandbox.cjs', 'build/sandbox.cjs'],
    ['SANDBOX_HELLO', 'examples/sandboxed-demo.cjs', 'build/examples/sandboxed-demo.cjs'],
  ],
}

const HOST_PORT = Number(process.env.PORT ?? '3088')
const ENV_PREFIX = PRODUCT.envPrefix

function resourceEnv() {
  // Dev (pnpm start from packaging/desktop-electron): two levels up = repo root.
  // Packaged app: Contents/Resources (package.json extraResources layout).
  const root = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..')
  const host = app.isPackaged ? join(root, 'host', 'host.cjs') : join(root, 'build', 'host.cjs')
  const ext = process.platform === 'darwin' ? 'dylib' : 'so'
  const resolvePath = (template) => join(root, template.replace('{ext}', ext))

  const env = {}
  for (const [key, packaged, dev] of PRODUCT.resources) {
    env[`${ENV_PREFIX}${key}`] = resolvePath(app.isPackaged ? packaged : dev)
  }
  return { root, host, env }
}

/** The token the host was booted with, if any (env wins over the config file). */
function hostToken() {
  return process.env[`${ENV_PREFIX}TOKEN`] || userEnv()[`${ENV_PREFIX}TOKEN`] || ''
}

async function waitForHealth(port, timeoutMs) {
  const token = hostToken()
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health${query}`)
      if (r.ok) return
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`host did not come up on :${port}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

// Finder-launched apps have no shell env: allow a per-user env file at
// ~/<configDir>/env (lines like MEDIABASE_LLM_KEY=…) so the AI assistant works from
// a double-clicked app.
function userEnv() {
  try {
    const f = join(os.homedir(), PRODUCT.configDir, 'env')
    if (!existsSync(f)) return {}
    const out = {}
    for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

let hostChild = null

app.whenReady().then(async () => {
  const { root, host, env } = resourceEnv()
  if (!existsSync(host)) {
    throw new Error(`host bundle missing: ${host}\nrun: pnpm run build:host`)
  }
  console.log('[electron] host bundle:', host)
  const fromFile = userEnv()
  const childEnv = { ...process.env }
  for (const [k, v] of Object.entries(fromFile)) {
    if (!childEnv[k]) childEnv[k] = v // shell env wins over the config file
  }
  hostChild = fork(host, [], {
    env: { ...childEnv, ...env, PORT: String(HOST_PORT) },
    // fork() requires an IPC channel in stdio; order is child stdin/stdout/
    // stderr, then the IPC channel.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  hostChild.stdout.on('data', (d) => process.stdout.write(`[host] ${d}`))
  hostChild.stderr.on('data', (d) => process.stderr.write(`[host] ${d}`))
  hostChild.on('exit', (code) => {
    console.log('[electron] host exited', code)
    app.quit()
  })

  await waitForHealth(HOST_PORT, 30_000)
  console.log('[electron] host ready at http://127.0.0.1:' + HOST_PORT)

  // Headless smoke: <PREFIX>SMOKE=1 skips the window so CI/automation can
  // verify the whole host fork pipeline without opening a GUI.
  if (process.env[`${ENV_PREFIX}SMOKE`] === '1') {
    console.log('[electron] smoke ok')
    if (hostChild) hostChild.kill('SIGINT')
    app.exit(0)
    return
  }

  const win = new BrowserWindow({ width: 1280, height: 800, title: PRODUCT.title })
  // When the host enforces a token, hand it to the client through the URL: the
  // app remembers it in localStorage and then authenticates /rpc, /stream and
  // every /api fetch (see @mediabase/connection).
  const token = hostToken()
  win.loadURL(`http://127.0.0.1:${HOST_PORT}${token ? `/?token=${encodeURIComponent(token)}` : ''}`)
  win.on('closed', () => {
    if (hostChild) hostChild.kill('SIGINT')
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (hostChild) hostChild.kill('SIGINT')
  app.quit()
})
