// @mediabase/api — host plugin: the control-plane API registry + capability manifests.
//
// Before this, adding a capability meant editing four places: the plugin, its
// service, a hand-written entry in @mediabase/server's method map, and the client.
// Now a capability registers its own methods (ctx.api), its data-plane routes,
// its health payload and a manifest (ctx.capabilities) inside its own package;
// the server only reads the registry. `tools.list/run` was the first such
// registry — this is that pattern for the whole control plane.
//
// One schema language (@mediabase/schema) guards every boundary: params are
// validated before the handler runs (INVALID_PARAMS with a path), results are
// validated after it (a capability that breaks its own contract fails loudly
// instead of shipping a malformed payload to the UI).

import type { Context } from '@deepseek-ai/cordis'
import type { Schema } from '@mediabase/schema'
import { describe as describeSchema, parse, SchemaError, toJsonSchema, z } from '@mediabase/schema'
import { RpcCode, RpcError, hasRpcCode } from '@mediabase/rpc'
// Type-only: ctx.log is declared by @mediabase/log, and the import keeps this
// package compilable STANDALONE (see scripts/build-base.mjs).
import type {} from '@mediabase/log'
import type {
  ApiMethodView,
  CapabilityManifest,
  CapabilityReport,
  StreamChannel,
  StreamChannelView,
  StreamSink,
} from '@mediabase/protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Control-plane API registry: capabilities register, server exposes. */
    api: ApiService
    /** Capability manifests: what each capability claims to contribute. */
    capabilities: CapabilitiesService
  }
}

/** A method contributed to the control plane (WS JSON-RPC `method`). */
export interface ApiMethod<S = Schema<any, any>, R = Schema<any, any>> {
  /** Dotted name, unique host-wide, e.g. `media.play`. */
  name: string
  description: string
  /**
   * True when the call CHANGES host state (playback, settings, plugin load, tool
   * execution…). The registry cannot infer this, so capabilities declare it and
   * `policy({ readonly: true })` refuses exactly those methods.
   */
  mutates?: boolean
  /** Validated before the handler runs; omitted = accepts anything. */
  params?: S
  /** Validated after the handler runs; omitted = result unchecked. */
  result?: R
  /** `params` drives the argument type: `{file: string}` from `z.object({file})`. */
  handler: (params: S extends Schema<any, infer P> ? P : Record<string, unknown>) => R extends Schema<any, infer O> ? O | Promise<O> : unknown
}

/** A data-plane byte route, served at `/api/<name>` by the gateway. */
export interface ApiRoute {
  name: string
  description?: string
  /** Same shape @mediabase/gateway serves: bytes plus optional headers. */
  handler: () => { body: Uint8Array | null; headers?: Record<string, string> }
}

export interface ApiService {
  register<S = Schema<any, any>, R = Schema<any, any>>(method: ApiMethod<S, R>): () => void
  /** Register a raw byte route (pull); the capability owns the payload format. */
  route(route: ApiRoute): () => void
  /**
   * Register a byte STREAM channel (push). The gateway hands the producer a sink
   * when a client subscribes; `attach`'s disposer runs when the last one leaves,
   * so publishing costs nothing with no viewers.
   */
  stream(channel: StreamChannel): () => void
  /** Channel map for the gateway's stream endpoint. */
  streamMap(): Record<string, StreamChannel>
  /** Introspection: channels with live subscriber/drop counters. */
  streams(): StreamChannelView[]
  /** True when a method is declared as state-changing (see ApiMethod.mutates). */
  mutates(name: string): boolean
  /**
   * Host-wide access policy, applied inside `call()` so every transport and the
   * audit log see the same rules. `allow`/`deny` accept exact names or a
   * `prefix.*` wildcard; `readonly` refuses every method declared `mutates`.
   */
  policy(policy: ApiPolicy): void
  /** The policy currently in force. */
  currentPolicy(): ApiPolicy
  /** Mutable per-channel counters (used by the transport glue). */
  streamStats(channel: string): { subscribers: number; dropped: number }
  /** Contribute a payload merged into `GET /api/health`. */
  health(contributor: () => Record<string, unknown>): () => void
  has(name: string): boolean
  list(): ApiMethodView[]
  routes(): ApiRoute[]
  /** Route map for `createGateway({ rawRoutes })`. */
  routeMap(): Record<string, () => { body: Uint8Array | null; headers?: Record<string, string> }>
  healthPayload(): Record<string, unknown>
  /** Validate + invoke one method (the same path the RPC server takes). */
  call(name: string, params?: unknown): Promise<unknown>
  /** Method map for `createGateway({ methods })`. */
  methodMap(): Record<string, (params?: unknown) => unknown | Promise<unknown>>
}

export type { ApiMethodView, CapabilityManifest, CapabilityReport, StreamChannelView }

/**
 * Attach a transport sink to a registered channel, keeping the channel's
 * subscriber accounting honest. The gateway glue (server) calls this and keeps
 * the returned disposer for the subscription's lifetime.
 */
export function attachStreamSink(
  api: ApiService,
  channel: string,
  sink: StreamSink,
): () => void {
  const ch = api.streamMap()[channel]
  if (!ch) throw new RpcError(RpcCode.NOT_FOUND, `api: 未知流通道 "${channel}"`, undefined, {
    messageKey: 'api.unknownStream',
    messageParams: { channel },
  })
  const stat = api.streamStats(channel)
  stat.subscribers++
  const detach = ch.attach(sink)
  return () => {
    stat.subscribers = Math.max(0, stat.subscribers - 1)
    detach()
  }
}

export interface CapabilitiesService {
  register(manifest: CapabilityManifest): () => void
  list(): CapabilityManifest[]
  /** Cross-check every declaration against what actually registered. */
  verify(): CapabilityReport[]
  /**
   * Observe capability registration — the server uses it to forward the events
   * of a capability that mounts later (runtime plugin load), not just those
   * present at boot.
   */
  subscribe(listener: (manifest: CapabilityManifest) => void): () => void
}

const NAME_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+)+$/

/** Access policy: deny wins over allow; `readonly` refuses mutating methods. */
export interface ApiPolicy {
  readonly?: boolean
  allow?: string[]
  deny?: string[]
}

/** Exact name, or `prefix.*` for a whole namespace. */
function matches(pattern: string, methodName: string): boolean {
  if (pattern.endsWith('.*')) return methodName.startsWith(pattern.slice(0, -1))
  return pattern === methodName
}

/** Plugin name (stable identity). */
export const name = 'api'

/** Services required before apply() runs. */
export const inject = ['log'] as const

export function apply(ctx: Context): void {
  const log = ctx.log.child(name)
  const methods = new Map<string, ApiMethod>()
  const routes = new Map<string, ApiRoute>()
  const streams = new Map<string, StreamChannel>()
  // Live accounting per channel: how many sinks are attached and how many frames
  // the transport had to drop under backpressure.
  const streamStats = new Map<string, { subscribers: number; dropped: number }>()
  const healthFns: Array<() => Record<string, unknown>> = []
  const manifests = new Map<string, CapabilityManifest>()
  const manifestListeners = new Set<(m: CapabilityManifest) => void>()
  let activePolicy: ApiPolicy = {}

  /**
   * Why a call is refused, or null when it is allowed. Carries BOTH the prose (for
   * the log and a CLI) and a message key, so a client can explain the refusal in
   * the user's language instead of quoting the host's.
   */
  function policyRefusal(methodName: string): { reason: string; key: string } | null {
    const { allow, deny, readonly } = activePolicy
    if (deny?.some((pattern) => matches(pattern, methodName)) === true) {
      return { reason: 'deny 列表拒绝', key: 'error.acl.denied' }
    }
    if (allow !== undefined && allow.length > 0 && !allow.some((pattern) => matches(pattern, methodName))) {
      return { reason: '不在 allow 列表内', key: 'error.acl.notAllowed' }
    }
    if (readonly === true && methods.get(methodName)?.mutates === true) {
      return { reason: '只读模式拒绝改状态的方法', key: 'error.acl.readonly' }
    }
    return null
  }

  const api: ApiService = {
    register<S = Schema<any, any>, R = Schema<any, any>>(method: ApiMethod<S, R>): () => void {
      if (!NAME_RE.test(method.name)) {
        throw new Error(`api: 方法名必须形如 "capability.action": "${method.name}"`)
      }
      if (methods.has(method.name)) throw new Error(`api: 方法名重复 "${method.name}"`)
      // The map holds the erased (default-generic) form; the handler keeps its
      // closure over the typed params, only the registry's view is widened.
      methods.set(method.name, method as ApiMethod)
      return () => {
        methods.delete(method.name)
      }
    },
    route(route: ApiRoute): () => void {
      if (routes.has(route.name)) throw new Error(`api: 路由名重复 "${route.name}"`)
      routes.set(route.name, route)
      return () => {
        routes.delete(route.name)
      }
    },
    health(contributor: () => Record<string, unknown>): () => void {
      healthFns.push(contributor)
      return () => {
        const i = healthFns.indexOf(contributor)
        if (i >= 0) healthFns.splice(i, 1)
      }
    },
    stream(channel: StreamChannel): () => void {
      if (!NAME_RE.test(`x.${channel.name}`)) throw new Error(`api: 通道名非法 "${channel.name}"`)
      if (streams.has(channel.name)) throw new Error(`api: 通道名重复 "${channel.name}"`)
      streams.set(channel.name, channel)
      streamStats.set(channel.name, { subscribers: 0, dropped: 0 })
      return () => {
        streams.delete(channel.name)
        streamStats.delete(channel.name)
      }
    },
    streamMap(): Record<string, StreamChannel> {
      return Object.fromEntries(streams)
    },
    streamStats(channel: string): { subscribers: number; dropped: number } {
      return streamStats.get(channel) ?? { subscribers: 0, dropped: 0 }
    },
    mutates: (methodName: string): boolean => methods.get(methodName)?.mutates === true,
    policy(next: ApiPolicy): void {
      activePolicy = { ...next }
    },
    currentPolicy(): ApiPolicy {
      return { ...activePolicy }
    },
    streams(): StreamChannelView[] {
      return [...streams.values()].map((c) => {
        const stat = streamStats.get(c.name) ?? { subscribers: 0, dropped: 0 }
        const view: StreamChannelView = { name: c.name, subscribers: stat.subscribers, dropped: stat.dropped }
        if (c.description !== undefined) view.description = c.description
        return view
      })
    },
    has: (n) => methods.has(n),
    list(): ApiMethodView[] {
      return [...methods.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => {
          const view: ApiMethodView = {
            name: m.name,
            description: m.description,
            signature: m.params ? describeSchema(m.params) : '()',
          }
          if (m.mutates === true) view.mutates = true
          if (m.params) view.jsonSchema = toJsonSchema(m.params)
          return view
        })
    },
    routes: () => [...routes.values()],
    routeMap(): Record<string, () => { body: Uint8Array | null; headers?: Record<string, string> }> {
      const map: Record<string, () => { body: Uint8Array | null; headers?: Record<string, string> }> = {}
      for (const [routeName, route] of routes) map[routeName] = route.handler
      return map
    },
    healthPayload(): Record<string, unknown> {
      const out: Record<string, unknown> = {}
      for (const fn of healthFns) {
        try {
          Object.assign(out, fn())
        } catch {
          /* a broken health contributor must not break the health endpoint */
        }
      }
      return out
    },
    async call(methodName: string, params?: unknown): Promise<unknown> {
      // Every control-plane call funnels through here: one place to audit.
      const started = Date.now()
      const method = methods.get(methodName)
      if (!method) {
        log.warn(`未知方法: ${methodName}`)
        throw new RpcError(RpcCode.METHOD_NOT_FOUND, `method not found: ${methodName}`, undefined, {
          messageKey: 'api.methodNotFound',
          messageParams: { method: methodName },
        })
      }
      // Access policy lives HERE, not in the transport: one place to audit, and it
      // holds for every client (WS, future transports, in-host callers).
      const refusal = policyRefusal(methodName)
      if (refusal !== null) {
        log.warn(`拒绝调用 ${methodName}(${refusal.reason})`)
        throw RpcError.forbidden(`${methodName}: ${refusal.reason}`, { method: methodName, policy: activePolicy }, {
          messageKey: refusal.key,
          messageParams: { method: methodName },
        })
      }
      let input: unknown = params ?? {}
      if (method.params) {
        try {
          input = parse(method.params, input, `${methodName} 参数`)
        } catch (e) {
          throw new RpcError(RpcCode.INVALID_PARAMS, e instanceof Error ? e.message : String(e), {
            path: e instanceof SchemaError ? e.path : undefined,
          }, {
            messageKey: 'api.invalidParams',
            messageParams: { method: methodName, detail: e instanceof Error ? e.message : String(e) },
          })
        }
      }
      let result: unknown
      try {
        result = await method.handler(input as Record<string, unknown>)
      } catch (e) {
        log.warn(`${methodName} 失败`, {
          ms: Date.now() - started,
          code: hasRpcCode(e) ? e.code : RpcCode.INTERNAL,
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
      log.debug(`${methodName} ok`, { ms: Date.now() - started })
      if (method.result) {
        try {
          return parse(method.result, result, `${methodName} 返回`)
        } catch (e) {
          throw new RpcError(
            RpcCode.INTERNAL,
            `能力契约不符:${e instanceof Error ? e.message : String(e)}`,
            { path: e instanceof SchemaError ? e.path : undefined },
            {
              messageKey: 'api.resultContract',
              messageParams: { method: methodName, detail: e instanceof Error ? e.message : String(e) },
            },
          )
        }
      }
      return result
    },
    methodMap(): Record<string, (params?: unknown) => unknown | Promise<unknown>> {
      const map: Record<string, (params?: unknown) => unknown | Promise<unknown>> = {}
      for (const methodName of methods.keys()) {
        map[methodName] = (params?: unknown) => api.call(methodName, params)
      }
      return map
    },
  }

  const capabilities: CapabilitiesService = {
    register(manifest: CapabilityManifest): () => void {
      if (manifests.has(manifest.id)) throw new Error(`capabilities: 能力 id 重复 "${manifest.id}"`)
      manifests.set(manifest.id, manifest)
      for (const listener of [...manifestListeners]) listener(manifest)
      return () => {
        manifests.delete(manifest.id)
      }
    },
    list: () => [...manifests.values()],
    verify(): CapabilityReport[] {
      const toolsRegistry = ctx.reflect.get('tools') as { has?: (n: string) => boolean } | undefined
      return [...manifests.values()].map((m) => {
        const missing = { services: [] as string[], api: [] as string[], tools: [] as string[] }
        for (const s of m.services ?? []) {
          if (ctx.reflect.get(s) === undefined) missing.services.push(s)
        }
        for (const a of m.api ?? []) {
          if (!methods.has(a)) missing.api.push(a)
        }
        for (const t of m.tools ?? []) {
          if (typeof toolsRegistry?.has !== 'function' || !toolsRegistry.has(t)) missing.tools.push(t)
        }
        const ok = missing.services.length + missing.api.length + missing.tools.length === 0
        return { id: m.id, title: m.title, ok, missing }
      })
    },
    subscribe(listener: (m: CapabilityManifest) => void): () => void {
      manifestListeners.add(listener)
      return () => {
        manifestListeners.delete(listener)
      }
    },
  }

  ctx.reflect.provide('api', api)
  ctx.reflect.provide('capabilities', capabilities)

  // The registry introspects itself through its own mechanism — the same path a
  // capability takes, not a special case in the server.
  ctx.api.register({
    name: 'api.streams',
    description: '列出数据面流通道(订阅者数量与丢帧计数)',
    params: z.object({}),
    handler: () => api.streams(),
  })
  ctx.api.register({
    name: 'api.list',
    description: '列出控制面已注册的全部方法(含参数签名与 JSON Schema)',
    handler: () => api.list(),
  })
  ctx.api.register({
    name: 'capabilities.list',
    description: '列出已注册的能力清单(声明提供了什么)',
    handler: () => capabilities.list(),
  })
  ctx.api.register({
    name: 'capabilities.verify',
    description: '校验每个能力的声明与其实际注册是否一致',
    handler: () => capabilities.verify(),
  })

  ctx.effect(() => () => {
    methods.clear()
    routes.clear()
    streams.clear()
    streamStats.clear()
    healthFns.length = 0
    manifests.clear()
    manifestListeners.clear()
  }, `${name}: registry`)
}
