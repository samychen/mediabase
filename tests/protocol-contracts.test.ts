// @mediabase/protocol — direct contract tests.
//
// The neutral vocabulary was only covered indirectly (through host integration).
// What matters about it is not behaviour but the SHAPE other people depend on:
//
//   1. it is the ONE place the control-plane version lives;
//   2. importing it costs nothing Node-specific, so a capability may import one
//      package on both planes (the browser bundle must not pull a Node builtin in
//      through a type-only concern);
//   3. coded errors are a shared vocabulary: `@mediabase/protocol` and `@mediabase/rpc`
//      must hand out the SAME objects, or a client branching on `code` breaks;
//   4. the neutral names stay neutral (no product concept in the base vocabulary).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as base from '../packages/base/protocol/src/index.ts'
import * as rpc from '../packages/base/rpc/src/index.ts'
import { ROOT } from './support/host.ts'

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

describe('@mediabase/protocol: control-plane version', () => {
  it('is a positive integer defined in exactly one place', () => {
    expect(Number.isInteger(base.CONTROL_PROTOCOL_VERSION)).toBe(true)
    expect(base.CONTROL_PROTOCOL_VERSION).toBeGreaterThan(0)
    const source = read('packages/base/protocol/src/index.ts')
    expect(source).toMatch(/CONTROL_PROTOCOL_VERSION\s*=/)
  })
})

describe('@mediabase/protocol: one vocabulary for coded errors', () => {
  it('hands out the same rpc objects as @mediabase/rpc (identity, not a copy)', () => {
    expect(base.RpcCode).toBe(rpc.RpcCode)
    expect(base.RpcError).toBe(rpc.RpcError)
    expect(base.makeServer).toBe(rpc.makeServer)
    expect(base.makeClient).toBe(rpc.makeClient)
    expect(base.describeRpcError).toBe(rpc.describeRpcError)
  })

  it('keeps every code unique and inside its documented block', () => {
    const entries = Object.entries(rpc.RpcCode)
    const values = entries.map(([, code]) => code)
    expect(new Set(values).size).toBe(values.length)
    for (const [name, code] of entries) {
      // Transport errors are JSON-RPC standard; the application surface (acl,
      // engine, worker, not-found) is -320xx so a client can branch on it.
      expect(code, `${name} must be negative`).toBeLessThan(0)
      expect(code, `${name} is outside both blocks`).toBeGreaterThanOrEqual(-32700)
    }
  })

  it('makes each factory carry the code it names (what a client branches on)', () => {
    expect(rpc.RpcError.notFound('x').code).toBe(rpc.RpcCode.NOT_FOUND)
    expect(rpc.RpcError.invalidParams('x').code).toBe(rpc.RpcCode.INVALID_PARAMS)
    expect(rpc.RpcError.unavailable('x').code).toBe(rpc.RpcCode.UNAVAILABLE)
    expect(rpc.RpcError.unauthorized('x').code).toBe(rpc.RpcCode.UNAUTHORIZED)
    expect(rpc.RpcError.worker('x').code).toBe(rpc.RpcCode.WORKER)
    expect(rpc.RpcError.forbidden('x').code).toBe(rpc.RpcCode.FORBIDDEN)

    // The rendering a user sees keeps the code visible, so prose alone never has
    // to be matched to explain a failure.
    expect(rpc.describeRpcError(rpc.RpcError.forbidden('nope'))).toBe(`[${rpc.RpcCode.FORBIDDEN}] nope`)
  })
})

describe('@mediabase/protocol: importable on both planes', () => {
  it('imports no Node builtin and reaches no schema runtime', () => {
    const source = read('packages/base/protocol/src/index.ts')
    // Type-only imports are erased; a value import would drag the schema engine
    // (and any Node dependency it has) into the browser bundle.
    expect(source).not.toMatch(/from\s+['"]node:/)
    expect(source).toMatch(/import type \{[^}]*\} from '@mediabase\/schema'/)

    const runtimeExports = Object.keys(base).sort()
    expect(runtimeExports).toEqual([
      'CONTROL_PROTOCOL_VERSION',
      'RpcCode',
      'RpcError',
      'describeRpcError',
      'hasRpcCode',
      'makeClient',
      'makeServer',
    ].sort())
  })
})

describe('@mediabase/protocol: the vocabulary stays neutral', () => {
  /** Product concepts that must not leak into the base protocol identifiers. */
  const PRODUCT_WORDS = ['preview', 'audio', 'video', 'codec', 'ffmpeg', 'decode', 'python']

  it('names no product concept in an exported identifier', () => {
    const offenders: string[] = []
    for (const line of read('packages/base/protocol/src/index.ts').split('\n')) {
      const trimmed = line.trim()
      if (!/^export\b/.test(trimmed)) continue
      // Judge the IDENTIFIERS, not the specifier they come from: a re-export names another
      // package (`export * from '@mediabase/rpc'`), and a scope is not a product concept.
      const identifiers = trimmed.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
      const lower = identifiers.toLowerCase()
      for (const word of PRODUCT_WORDS) {
        if (lower.includes(word)) offenders.push(`"${word}" in: ${trimmed.slice(0, 90)}`)
      }
    }
    expect(offenders, `product vocabulary in the neutral protocol:\n${offenders.join('\n')}`).toEqual([])
  })
})
