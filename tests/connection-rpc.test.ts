// @mediabase/connection — the control-plane client's behaviour around a socket that is
// not OPEN yet.
//
// This is a bug the real-browser suite found, and it is worth a suite of its own
// because it is invisible to every other kind of test:
//
//   A panel mounts and calls `ctx.rpc.call('api.list')` IMMEDIATELY. If the socket is
//   still CONNECTING at that instant, the old client handed the message to a `send`
//   that checked `readyState === OPEN` and dropped it — no error, no retry — so the
//   call hung until its 30s timeout and the panel stayed empty with nothing logged.
//   Same shape after a reconnect: requests already written are never answered, and
//   the caller waited out the timeout instead of hearing "connection lost".
//
// jsdom + a controllable fake WebSocket: what matters here is the SEQUENCE (queued →
// flushed, close → failed), not a real network.
//
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as connection from '../packages/client/connection/src/index.ts'
import { RpcCode } from '../packages/base/rpc/src/index.ts'

/** A WebSocket stand-in whose every step is driven by the test. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  binaryType = ''
  /** Everything the client actually wrote to the wire. */
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  /** The handshake completed: the client may flush and call. */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  reply(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
  }

  replyError(id: number, code: number, message: string): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) })
  }

  /** Requests the client sent that are still awaiting an answer. */
  pendingIds(): number[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { id?: number })
      .map((msg) => msg.id)
      .filter((id): id is number => typeof id === 'number')
  }

  /** Answer by METHOD, so a test never depends on the client's send order. */
  replyTo(method: string, result: unknown): void {
    const msg = this.sent
      .map((raw) => JSON.parse(raw) as { id?: number; method?: string })
      .find((m) => m.method === method)
    if (msg?.id === undefined) throw new Error(`no request for ${method} (sent: ${this.sent.join(' | ')})`)
    this.reply(msg.id, result)
  }

  methodsSent(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { method: string }).method)
  }
}

const settle = (ms = 0): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

beforeEach(() => {
  FakeSocket.instances = []
  // jsdom provides `location`; the WebSocket is replaced so the test drives every
  // transition (connecting → open → close) deterministically.
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket as unknown as typeof WebSocket
})

afterEach(() => {
  FakeSocket.instances = []
})

async function compose(): Promise<{ ctx: Context; socket: () => FakeSocket; rpc: { call<T>(m: string, p?: unknown): Promise<T> } }> {
  const ctx = new Context()
  ctx.plugin(connection)
  await settle(0)
  const service = ctx.get('rpc')
  if (!service) throw new Error('ctx.rpc missing')
  const socket = (): FakeSocket => {
    const found = FakeSocket.instances.at(-1)
    if (found === undefined) throw new Error('no socket was opened')
    return found
  }
  socket() // the plugin connects on apply
  return { ctx, socket, rpc: service as { call<T>(m: string, p?: unknown): Promise<T> } }
}

describe('the control-plane client while the socket is CONNECTING', () => {
  it('queues a call made before the socket opens, then sends it (no silent drop)', async () => {
    const { rpc, socket } = await compose()
    const call = rpc.call<unknown[]>('api.list')
    // The panel's mount call landed while the handshake was still in flight: it must
    // be HELD, not thrown away.
    expect(socket().sent).toEqual([])

    socket().open()
    await settle(0)
    // It reached the wire once the socket opened (the handshake follows it).
    expect(socket().methodsSent()).toContain('api.list')
    socket().replyTo('server.info', { protocol: 1, host: '127.0.0.1', port: 1, distIndex: '' })
    socket().replyTo('api.list', [{ name: 'api.list' }])
    await expect(call).resolves.toEqual([{ name: 'api.list' }])
  })

  it('keeps order: a queued call goes out before later ones', async () => {
    const { rpc, socket } = await compose()
    const first = rpc.call('a.one')
    const second = rpc.call('b.two')
    socket().open()
    await settle(0)
    // Calls the caller made while connecting are flushed in order, and the handshake
    // follows them (a panel's request must not wait behind the handshake).
    expect(socket().methodsSent()).toEqual(['a.one', 'b.two', 'server.info'])
    socket().replyTo('server.info', { protocol: 1 })
    socket().replyTo('a.one', 'one')
    socket().replyTo('b.two', 'two')
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
  })

  it('refuses (rather than queues forever) when the host is unreachable', async () => {
    const { rpc, socket } = await compose()
    // 200 queued calls is the bound; the next one must FAIL loudly instead of growing
    // an outbox in a page that will never connect.
    const queued: Array<Promise<unknown>> = []
    for (let i = 0; i < 200; i++) queued.push(rpc.call('x.y').catch(() => 'queued'))
    const failure = await rpc.call('one.too.many').then(() => null, (e: { code?: number; message: string }) => e)
    expect(failure?.code).toBe(RpcCode.UNAVAILABLE)
    expect(failure?.message).toContain('outbox')
    // The refused call never reached the wire.
    expect(socket().sent).toEqual([])
    socket().open()
    await settle(0)
  })
})

describe('the control-plane client when the connection drops', () => {
  it('fails in-flight calls instead of letting them time out', async () => {
    const { rpc, socket } = await compose()
    socket().open()
    await settle(0)
    const ids = socket().pendingIds()
    socket().reply(ids[0]!, { protocol: 1 })
    const call = rpc.call('media.status')
    await settle(0)
    const inFlight = socket().methodsSent().includes('media.status')

    // A dropped control plane means that request will never be answered: the caller
    // must hear it now (a UI can say "connection lost"), not after 30 seconds.
    socket().close()
    const failure = await call.then(() => null, (e: { code?: number; message: string }) => e)
    expect(failure?.code).toBe(RpcCode.UNAVAILABLE)
    expect(failure?.message).toContain('connection lost')
    expect(inFlight).toBe(true) // it really was on the wire when the socket died
  })

  it('queues calls made while disconnected and sends them after a reconnect', async () => {
    const { rpc, socket } = await compose()
    const first = socket()
    first.open()
    await settle(0)
    first.reply(first.pendingIds()[0]!, { protocol: 1 })
    first.close()
    await settle(0)

    // The page is reconnecting: a call placed now must survive to the next socket.
    const call = rpc.call<string>('api.list')
    await settle(1_100) // the plugin retries after 1s
    const reconnected = socket()
    expect(reconnected).not.toBe(first)
    reconnected.open()
    await settle(0)
    expect(reconnected.methodsSent()).toContain('api.list')
    reconnected.replyTo('server.info', { protocol: 1 })
    reconnected.replyTo('api.list', 'after-reconnect')
    await expect(call).resolves.toBe('after-reconnect')
  }, 15_000)
})
