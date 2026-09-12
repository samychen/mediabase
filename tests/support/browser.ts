// tests / support / browser.ts — a REAL browser, driven over CDP, with no new
// dependency.
//
// jsdom is a DOM implementation, not a browser. It cannot answer the questions
// this suite exists for: does the built bundle actually boot, does the WS
// control plane connect from a page, does a locale switch re-render every
// panel, and is SharedArrayBuffer really gated on cross-origin isolation? The
// last one is a claim @mediabase/shm and @mediabase/gateway both make in comments —
// and no DOM shim can observe it, because it is the ENGINE that enforces it.
//
// The driver is a few dozen lines on top of Node's built-in WebSocket: launch
// headless Chrome with a debug port, attach to its page target, evaluate JS.
// No playwright/puppeteer — a browser binary already provides everything, and
// the repo keeps its dependency surface where it is.
//
// Availability is PROBED BY EXECUTION, the same rule @mediabase/confine follows:
// a browser that is missing, or that will not open a debug port, makes
// `launchBrowser()` return null with the reason, and callers skip instead of
// failing. So `pnpm test` stays green on a machine without Chrome and in CI
// images that do not ship one — while a machine that HAS one gets real coverage.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One CDP message: either a response to a `send()` or a pushed event. */
interface CdpEnvelope {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

/**
 * Remove a Chrome profile directory.
 *
 * Chrome keeps writing its cache for a moment after SIGTERM, so a plain recursive remove races
 * it and fails with `ENOTEMPTY` — measured once as a red suite on an otherwise green run.
 * Node's retry options exist for exactly this; a teardown race must not look like a product
 * failure.
 */
function removeProfile(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export interface Browser {
  /**
   * How this browser ended up drivable, when that needed a deviation from the
   * plain launch (currently: the `--no-sandbox` fallback). Empty for a normal
   * launch. Reported instead of hidden — a suite that silently dropped Chrome's
   * own sandbox would be measuring a different browser than production runs.
   */
  readonly launchNote: string
  /** Navigate the page and wait for the load event (not just the commit). */
  navigate(url: string): Promise<void>
  /**
   * Evaluate an expression in the page and return its value. THROWS when the
   * page threw — a silent undefined would hide a broken bundle.
   */
  evaluate<T = unknown>(expression: string): Promise<T>
  /** Poll `expression` until it is truthy (React renders asynchronously). */
  waitFor<T>(expression: string, timeoutMs?: number): Promise<T>
  /** Uncaught page exceptions since launch — a clean boot must have none. */
  readonly pageErrors: string[]
  close(): Promise<void>
}

export interface LaunchFailure {
  reason: string
  /** The deviation a failed attempt would have needed, when one was tried. */
  note?: string
}

/**
 * Chrome's own sandbox cannot initialize when the process is ALREADY inside a
 * seatbelt profile (a dev sandbox, a hardened runner): the browser prints
 * `sandbox initialization failed: Operation not permitted`, still announces its
 * debug port and still answers `Target.getTargets`, but no renderer can start —
 * so the CDP handshake hangs at `Page.enable`. Recognising that signature is what
 * lets the launcher retry usefully instead of reporting a timeout.
 */
const SANDBOX_SIGNATURE = /sandbox initialization failed|Failed to initialize sandbox/i

/** Extra browser flags, for a fork/CI image that needs its own (`MEDIABASE_CHROME_ARGS`). */
function extraArgs(): string[] {
  const raw = process.env['MEDIABASE_CHROME_ARGS']
  return raw === undefined || raw === '' ? [] : raw.split(' ').filter(Boolean)
}

/** Skip without even launching (`MEDIABASE_NO_BROWSER=1`), for browserless CI. */
function disabled(): LaunchFailure | null {
  return process.env['MEDIABASE_NO_BROWSER'] === '1'
    ? { reason: 'MEDIABASE_NO_BROWSER=1 (browser coverage intentionally skipped)' }
    : null
}

/**
 * Candidate browser binaries, most specific first. `MEDIABASE_CHROME` overrides:
 * a fork or a CI image with Chromium at an unusual path names it there instead
 * of editing this list (the same seam the composition layer uses for paths).
 */
function findChrome(): string | null {
  const fromEnv = process.env['MEDIABASE_CHROME']
  if (fromEnv !== undefined && fromEnv !== '') return existsSync(fromEnv) ? fromEnv : null
  const candidates: readonly string[] = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Launch headless Chrome and attach to its first page target.
 *
 * Returns null (with the reason) rather than throwing: "no browser here" is an
 * environment fact the caller turns into a skip, not a test failure.
 */
export async function launchBrowser(
  options: { startupTimeoutMs?: number; handshakeTimeoutMs?: number } = {},
): Promise<Browser | LaunchFailure> {
  const off = disabled()
  if (off !== null) return off
  const bin = findChrome()
  if (bin === null) {
    return { reason: 'no Chrome/Chromium binary found (set MEDIABASE_CHROME to name one)' }
  }
  // Sandboxed environment? Try the plain launch first (it is what production
  // resembles), then retry once WITHOUT Chrome's own sandbox and say so.
  const first = await attemptLaunch(bin, [], options)
  if (isBrowser(first)) return first
  // Two signatures of the same problem: the explicit "sandbox initialization
  // failed" line, or a handshake timeout — a browser that answers Target.getTargets
  // but never completes Page.enable has no renderer, which is what a blocked
  // sandbox produces.
  const looksSandboxBlocked = first.note !== undefined
    || SANDBOX_SIGNATURE.test(first.reason)
    || /cdp timeout/.test(first.reason)
  if (!looksSandboxBlocked) return first
  const retry = await attemptLaunch(bin, ['--no-sandbox'], options)
  if (isBrowser(retry)) {
    return {
      ...retry,
      launchNote: `--no-sandbox fallback: Chrome's own sandbox cannot initialize here (${first.reason.split('\n').at(-1) ?? first.reason})`,
    }
  }
  return {
    reason: `${first.reason} · retry with --no-sandbox also failed: ${retry.reason}`,
    note: 'the environment blocks Chrome\'s own sandbox',
  }
}

/**
 * One launch attempt. EVERY step — including the CDP handshake, which is where a
 * browser that cannot start a renderer hangs — turns a failure into a
 * `LaunchFailure` rather than an exception: availability is an environment fact a
 * caller turns into a skip, and a suite that goes red on one can never be run in
 * an unknown environment.
 */
async function attemptLaunch(
  bin: string,
  extraFlags: string[],
  options: { startupTimeoutMs?: number; handshakeTimeoutMs?: number },
): Promise<Browser | LaunchFailure> {

  const userDataDir = mkdtempSync(join(tmpdir(), 'avstudio-browser-'))
  let chrome: ChildProcess
  try {
    chrome = spawn(bin, [
      '--headless=new',
      '--disable-gpu',
      // A throwaway profile: the default one may already be running, and Chrome
      // refuses a second debug port on a profile that is in use.
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // CI containers often have a small /dev/shm, which makes Chrome tab-crash.
      '--disable-dev-shm-usage',
      // Port 0 = pick a free one and print it; nothing here assumes a port.
      '--remote-debugging-port=0',
      ...extraFlags,
      ...extraArgs(),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    removeProfile(userDataDir)
    return { reason: `spawn failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  // The debug endpoint arrives on stderr; nothing else tells us the port.
  let stderr = ''
  // Recorded while the output streams past: the sandbox signature scrolls out of a
  // "last few lines" view almost immediately (Chrome keeps logging crashpad noise
  // afterwards), so testing the tail at failure time misses it.
  let sandboxBlocked = false
  const endpoint = await new Promise<string | null>((resolve) => {
    const timeoutMs = options.startupTimeoutMs ?? 20_000
    const timer = setTimeout(() => resolve(null), timeoutMs)
    chrome.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (SANDBOX_SIGNATURE.test(stderr)) sandboxBlocked = true
      const match = stderr.match(/ws:\/\/\S+/)
      if (match !== null) { clearTimeout(timer); resolve(match[0]) }
    })
    chrome.once('exit', () => { clearTimeout(timer); resolve(null) })
  })
  if (endpoint === null) {
    kill(chrome)
    removeProfile(userDataDir)
    // The last line is the actionable one (a profile lock, a missing lib).
    const reason = stderr.split('\n').filter((l) => l.trim() !== '').at(-1) ?? 'browser exited before announcing a debug endpoint'
    return { reason }
  }

  const socket = new WebSocket(endpoint)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('cdp websocket connect failed')), { once: true })
    })
  } catch (e) {
    kill(chrome)
    removeProfile(userDataDir)
    return { reason: e instanceof Error ? e.message : String(e) }
  }

  let nextId = 0
  const pending = new Map<number, (envelope: CdpEnvelope) => void>()
  const pageErrors: string[] = []
  socket.addEventListener('message', (event) => {
    const envelope = JSON.parse(String(event.data)) as CdpEnvelope
    if (envelope.id !== undefined) {
      const slot = pending.get(envelope.id)
      if (slot !== undefined) { pending.delete(envelope.id); slot(envelope) }
      return
    }
    // An uncaught exception here means the bundle is broken; a console.error
    // does not (React logs plenty), so only exceptions are collected.
    if (envelope.method === 'Runtime.exceptionThrown') {
      const details = envelope.params?.['exceptionDetails'] as
        | { text?: string; exception?: { description?: string } }
        | undefined
      pageErrors.push(details?.exception?.description ?? details?.text ?? 'unknown page exception')
    }
  })

  const commandTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown> | undefined> => {
    const id = ++nextId
    const response = await new Promise<CdpEnvelope>((resolve, reject) => {
      pending.set(id, resolve)
      socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error(`cdp timeout: ${method}`))
      }, commandTimeoutMs)
    })
    if (response.error !== undefined) throw new Error(`cdp ${method} failed: ${response.error.message ?? 'unknown'}`)
    return response.result
  }

  /**
   * The actionable part of Chrome's stderr. Crashpad noise dominates the last
   * lines (every crash-report file it cannot write is one line), so it is filtered
   * out rather than shown in place of the reason.
   */
  const stderrTail = (lines = 3): string =>
    stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.includes('crashpad'))
      .slice(-lines)
      .join(' / ')

  const fail = (reason: string): LaunchFailure => {
    socket.close(); kill(chrome); removeProfile(userDataDir)
    // The note is the machine-readable signal the caller retries on; it is set
    // whenever the evidence was seen, whether or not the prose repeats it.
    return sandboxBlocked ? { reason, note: 'the environment blocks Chrome\'s own sandbox' } : { reason }
  }

  if (sandboxBlocked) {
    // Chrome already said its own sandbox cannot initialize, and every renderer it
    // spawns dies with it. Waiting out the CDP handshake would spend 10s to learn
    // what stderr already said, so report it now and let the caller retry.
    return fail('sandbox initialization failed (chrome: sandbox initialization failed: Operation not permitted)')
  }

  let sessionId: string
  try {
    const targets = await send('Target.getTargets')
    const infos = (targets?.['targetInfos'] ?? []) as Array<{ type: string; targetId: string }>
    const page = infos.find((t) => t.type === 'page')
    if (page === undefined) return fail('browser has no page target')
    const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const attachedSession = attached?.['sessionId'] as string | undefined
    if (attachedSession === undefined) return fail('could not attach to the page target')
    sessionId = attachedSession
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
  } catch (e) {
    // A browser that announced a debug port but cannot serve CDP is unusable, and
    // the reason must carry Chrome's own words (a missing renderer sandbox, a
    // profile lock, a missing shared library).
    const tail = stderrTail()
    return fail(`${e instanceof Error ? e.message : String(e)}${tail === '' ? '' : ` — chrome: ${tail}`}`)
  }

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      // Await a returned promise so `waitFor(fetch(...))` style probes work.
      awaitPromise: true,
    }, sessionId)
    const details = result?.['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined
    if (details !== undefined) {
      throw new Error(`page evaluation failed: ${details.exception?.description ?? details.text ?? 'unknown'}`)
    }
    const inner = result?.['result'] as { value?: unknown } | undefined
    return inner?.['value'] as T
  }

  return {
    launchNote: '',
    async navigate(url: string): Promise<void> {
      const loaded = new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const envelope = JSON.parse(String(event.data)) as CdpEnvelope
          if (envelope.method !== 'Page.loadEventFired') return
          socket.removeEventListener('message', onMessage)
          resolve()
        }
        socket.addEventListener('message', onMessage)
        // A navigation that never fires loadEventFired must not hang the suite.
        setTimeout(() => { socket.removeEventListener('message', onMessage); resolve() }, 30_000)
      })
      await send('Page.navigate', { url }, sessionId)
      await loaded
    },
    evaluate,
    async waitFor<T>(expression: string, timeoutMs = 15_000): Promise<T> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const value = await evaluate<T>(expression)
        if (value) return value
        if (Date.now() > deadline) throw new Error(`waitFor timed out: ${expression.slice(0, 120)}`)
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      }
    },
    pageErrors,
    async close(): Promise<void> {
      socket.close()
      kill(chrome)
      removeProfile(userDataDir)
    },
  }
}

/**
 * True when this is a `Browser`, false when it is the reason there is none.
 * Accepts null so an unlaunched browser (a boot that never got that far) reports
 * "not a browser" instead of forcing every caller to null-check first.
 */
export function isBrowser(value: Browser | LaunchFailure | null): value is Browser {
  return value !== null && (value as LaunchFailure).reason === undefined
}

function kill(chrome: ChildProcess): void {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return
  chrome.kill('SIGKILL')
}
