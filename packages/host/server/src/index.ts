// @mediabase/server — host plugin: HTTP/WS front door, now a PURE composition
// over the neutral @mediabase/gateway and the @mediabase/api registry. This file
// supplies NO method names, NO raw route, NO health payload of its own — the
// capabilities registered all of those into ctx.api, so adding a capability no
// longer edits the server at all.

import { createGateway, type StreamSink } from '@mediabase/gateway'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'
import { CONTROL_PROTOCOL_VERSION, type HostInfo } from '@mediabase/protocol'
import { attachStreamSink } from '@mediabase/api'
import type {} from '@mediabase/api'
import type {} from '@mediabase/log'

/** Plugin name (stable identity). */
export const name = 'server'

/** Services required before apply() runs. */
export const inject = ['api', 'capabilities', 'log'] as const

export interface ServerConfig {
  /** Application root: the default location of the built client and its assets. */
  root: string
  host?: string
  port?: number
  /** Absolute path to index.html inside the built client (apps/web/dist). */
  distIndex?: string
  /**
   * Optional shared secret. When set, `/api/*` and both WS endpoints require
   * `?token=`; the static shell stays public. Opt-in (TOKEN env) because it
   * is a local trust boundary, not a multi-user login.
   */
  token?: string
  /**
   * Method-level access policy (enforced in ctx.api, so it covers every client and
   * is audited). `readonly` refuses every method a capability declared `mutates`.
   */
  acl?: { readonly?: boolean; allow?: string[]; deny?: string[] }
  /**
   * Serve the COOP/COEP headers that make `SharedArrayBuffer` available (the client's
   * frame ring needs them). Opt-in: a cross-origin-isolated page refuses
   * cross-origin subresources that do not opt in.
   */
  crossOriginIsolation?: boolean
}

export const Config: Schema<ServerConfig, ServerConfig> = z.object({
  root: z.string().required().description('application root (packaged app: its resource root)'),
  host: z.string().default('127.0.0.1'),
  port: z.natural().default(3088).description('listen port; 0 lets the OS pick one'),
  distIndex: z.string().description('absolute path of the client index.html'),
  token: z.string().description('shared secret; empty/absent = no auth (local trust boundary)'),
  acl: z.object({
    readonly: z.boolean().description('refuse every method declared mutates'),
    allow: z.array(z.string()).description('allow list (prefix.* wildcards)'),
    deny: z.array(z.string()).description('deny list; wins over allow'),
  }).description('method-level access policy'),
  crossOriginIsolation: z.boolean().description('serve COOP/COEP/CORP for SharedArrayBuffer'),
})

export function apply(ctx: Context, rawConfig: ServerConfig): void {
  const parsed = parse(Config, rawConfig)
  // The root-derived default is resolved HERE, in the implementation that owns it, so a
  // composition only has to state the root (or override the path outright).
  // Resolved: distIndex is decided here, so nothing below re-checks for undefined.
  const config = {
    ...parsed,
    distIndex: parsed.distIndex ?? join(parsed.root, 'apps/web/dist/index.html'),
  }
  const log = ctx.log.child(name)

  // Apply the access policy before serving: the registry is the single choke point.
  // A row may state every field and leave the environment unset, so only fields that
  // actually restrict something form the policy: `undefined` means "not stated" and an
  // empty list is not a restriction (the dialect also materialises an absent array as `[]`).
  const acl = config.acl === undefined
    ? undefined
    : Object.fromEntries(Object.entries(config.acl).filter(([, value]) =>
      value !== undefined && !(Array.isArray(value) && value.length === 0)))
  if (acl !== undefined && Object.keys(acl).length > 0) ctx.api.policy(acl)

  const gateway = createGateway({
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 3088,
    distIndex: config.distIndex,
    ...(config.token !== undefined ? { auth: { token: config.token } } : {}),
    ...(config.crossOriginIsolation === true ? { crossOriginIsolation: true } : {}),
    // Everything below is contributed by capabilities, not hard-coded here.
    // Passed as functions: the registries are live, so a capability mounted
    // after boot (drop-in module, runtime plugin load) is immediately callable.
    methods: () => ctx.api.methodMap(),
    rawRoutes: () => ctx.api.routeMap(),
    health: () => ({
      ...ctx.api.healthPayload(),
      streams: ctx.api.streams().map((s) => ({ name: s.name, subscribers: s.subscribers, dropped: s.dropped })),
    }),
    // Data-plane push: channels come from the registry, and the sink glue keeps
    // the registry's subscriber/drop accounting honest.
    streams: () => {
      const channels = ctx.api.streamMap()
      const wired: Record<string, { name: string; attach(sink: StreamSink): () => void }> = {}
      for (const channelName of Object.keys(channels)) {
        wired[channelName] = {
          name: channelName,
          attach: (sink: StreamSink) => attachStreamSink(ctx.api, channelName, sink),
        }
      }
      return wired
    },
    // The gateway answers 500 and stays up; the failure still has to reach the
    // log, or a broken capability would be invisible.
    onError: (error, where) => {
      log.warn(`请求处理失败(${where})`, { error: error instanceof Error ? error.message : String(error) })
    },
  })

  void gateway.ready()
    .then(() => {
      const auth = config.token !== undefined ? ' · 已启用 token 校验' : ''
      // Report what the registries actually hold — the base names no capability, so it
      // must not advertise one product's data-plane route in its own ready line.
      const methods = ctx.api.list().length
      const channels = Object.keys(ctx.api.streamMap()).length
      const routes = ctx.api.routes().length
      log.info(
        `宿主就绪: http://${config.host ?? '127.0.0.1'}:${gateway.port()}  ` +
          `(ws /rpc ${methods} 方法, ws /stream ${channels} 通道, /api/* ${routes} 条数据面路由)${auth}`,
      )
    })
    .catch((e) => {
      log.error('宿主监听失败', { error: e instanceof Error ? e.message : String(e) })
      void gateway.close()
    })

  // Discovery: the front door publishes where it actually listens (port 0 means
  // "any free port", so callers — tests, the desktop shell, tooling — cannot
  // guess it).
  ctx.api.register({
    name: 'server.info',
    description: '宿主门面信息/控制面握手(协议版本、监听端口、静态目录、流订阅者、访问策略)',
    params: z.object({}),
    handler: async () => {
      // The port is only real once the socket is listening (port 0 = any free
      // port), so a caller never has to guess or poll.
      await gateway.ready()
      const info: HostInfo = {
        // The handshake: a client compares this with its own CONTROL_PROTOCOL_VERSION
        // and refuses to operate on a mismatch (engine does the same with `hello`).
        protocol: CONTROL_PROTOCOL_VERSION,
        host: config.host ?? '127.0.0.1',
        port: gateway.port(),
        distIndex: config.distIndex,
        streams: gateway.streamSubscribers(),
      }
      const policy = ctx.api.currentPolicy()
      if (Object.keys(policy).length > 0) info.acl = policy
      return info
    },
  })

  ctx.capabilities.register({
    id: 'server',
    title: 'HTTP/WS 门面',
    description: '纯组合层:方法、数据面路由、health 与通知转发全部来自 ctx.api 与各能力的 manifest 声明',
    api: ['server.info'],
  })

  // ---- outbound notifications: forward events a capability DECLARED in its
  // manifest. A capability that mounts later (runtime plugin load) is picked up
  // through the subscribe hook, so no capability's event needs a server edit.
  const forward = (eventName: string): void => {
    ctx.events.on(eventName, (payload: unknown) => gateway.broadcast(eventName, payload))
  }
  const declared = new Set<string>(ctx.capabilities.list().flatMap((m) => m.events ?? []))
  for (const eventName of declared) forward(eventName)
  const disposeSub = ctx.capabilities.subscribe((manifest) => {
    for (const eventName of manifest.events ?? []) {
      if (declared.has(eventName)) continue
      declared.add(eventName)
      forward(eventName)
    }
  })

  ctx.effect(() => () => {
    disposeSub()
    void gateway.close()
  }, `${name}: http+ws`)
}
