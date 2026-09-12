// protocol: JSON-RPC client/server round-trips, including notifications.
import { describe, expect, it, vi } from 'vitest'
import { makeClient, makeServer, RpcCode, RpcError } from '../packages/base/rpc/src/index.ts'

async function roundTrip(methods: Record<string, (p?: unknown) => unknown | Promise<unknown>>, raw: string): Promise<string | undefined> {
  return makeServer(methods)(raw)
}

describe('rpc server', () => {
  it('answers a request with the same id and result', async () => {
    const out = await roundTrip(
      { 'media.ping': async () => true },
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'media.ping', params: {} }),
    )
    expect(JSON.parse(out!)).toEqual({ jsonrpc: '2.0', id: 7, result: true })
  })

  it('returns a method-not-found error', async () => {
    const out = await roundTrip({}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }))
    expect(JSON.parse(out!).error.code).toBe(-32601)
  })

  it('propagates handler errors as -32000', async () => {
    const out = await roundTrip(
      { boom: async () => { throw new Error('kaput') } },
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'boom' }),
    )
    expect(JSON.parse(out!).error.message).toBe('kaput')
  })

  it('carries a message key + params so a client can localize the detail', async () => {
    // The host keeps its own prose (log/CLI/bug report) AND ships a key: the
    // client renders the key when it has it, and the prose stays the fallback.
    const out = await roundTrip(
      {
        'settings.set': () => {
          throw RpcError.invalidParams('settings: 未知设置键 "nope"', undefined, {
            messageKey: 'settings.unknownKey',
            messageParams: { key: 'nope' },
          })
        },
      },
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'settings.set', params: { key: 'nope' } }),
    )
    const error = JSON.parse(out!).error
    expect(error.code).toBe(RpcCode.INVALID_PARAMS)
    expect(error.message).toBe('settings: 未知设置键 "nope"')
    expect(error.messageKey).toBe('settings.unknownKey')
    expect(error.messageParams).toEqual({ key: 'nope' })

    // ...and the client hands the same fields to the caller as an RpcError. (The
    // frame is replayed with the id THIS client asked with — ids are per client.)
    const client = makeClient(() => {})
    const pending = client.call('settings.set')
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, error }))
    await expect(pending).rejects.toMatchObject({
      code: RpcCode.INVALID_PARAMS,
      messageKey: 'settings.unknownKey',
      messageParams: { key: 'nope' },
    })
  })

  it('omits the key fields when a handler does not supply one', async () => {
    const out = await roundTrip(
      { boom: () => { throw RpcError.notFound('gone') } },
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'boom' }),
    )
    expect(JSON.parse(out!).error).toEqual({ code: RpcCode.NOT_FOUND, message: 'gone' })
  })

  it('does not respond to notifications', async () => {
    const out = await roundTrip({}, JSON.stringify({ jsonrpc: '2.0', method: 'whatever', params: {} }))
    expect(out).toBeUndefined()
  })
})

describe('rpc client', () => {
  it('resolves calls and rejects on error responses', async () => {
    const sent: string[] = []
    const client = makeClient((s) => sent.push(s))
    const p1 = client.call('media.ping')
    const p2 = client.call<string>('media.probe')
    expect(sent).toHaveLength(2)
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, result: true }))
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'no file' } }))
    await expect(p1).resolves.toBe(true)
    await expect(p2).rejects.toThrow('no file')
  })

  it('routes notifications to the handler without disturbing calls', async () => {
    const notify = vi.fn()
    const client = makeClient(() => {}, notify)
    const call = client.call('workflow.list')
    client.handle(JSON.stringify({ jsonrpc: '2.0', method: 'workflow.progress', params: { state: 'start' } }))
    expect(notify).toHaveBeenCalledWith('workflow.progress', { state: 'start' })
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }))
    await expect(call).resolves.toEqual([])
  })
})
