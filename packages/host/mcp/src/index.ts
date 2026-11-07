// @mediabase/mcp — host plugin: expose ctx.tools as an MCP (Model Context
// Protocol) endpoint, so external agents (Claude Desktop, Cursor, any MCP
// client) drive the SAME tool surface the built-in LLM agent plans over.
//
// Transport: stateless Streamable HTTP. One POST path speaks JSON-RPC 2.0 and
// answers `application/json` directly (the spec allows a server that offers no
// server-initiated streams); GET/DELETE answer 405. No session header, nothing
// held between requests — the registry is the only state, and it is live.
//
// The mapping is deliberately thin, because the registry already holds what
// MCP needs: `tools/list` reads registry.list() (its JSON Schema IS the
// inputSchema), `tools/call` funnels through ctx.api.call('tools.run') so the
// tool executions of an external agent carry the same policy, validation and
// audit trail as a control-plane call. Names are mangled the same way the
// LLM agent mangles them (MCP, like OpenAI, forbids dots), collisions
// disambiguated by the shared @mediabase/tools helper.
//
// Token-gated by the front door like every /api/* path when ${prefix}TOKEN is
// set — an MCP URL for an external client is `http://host:3088/mcp?token=…`.

import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'
import { hasRpcCode, RpcCode } from '@mediabase/rpc'
import { wireNames } from '@mediabase/tools'
import type { RegistryService } from '@mediabase/protocol'
// Type-only imports keep the package compilable STANDALONE (see
// scripts/build-base.mjs): ctx.api is declared by @mediabase/api, ctx.log by
// @mediabase/log, ctx.appPaths by @mediabase/boot.
import type {} from '@mediabase/api'
import type { ApiEndpointResponse } from '@mediabase/api'
import type {} from '@mediabase/log'
import type {} from '@mediabase/boot'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** MCP endpoint surface (configured path + tool count) for introspection. */
    mcp?: McpInfo
  }
}

export interface McpInfo {
  /** The mounted path, e.g. `/mcp`. */
  path: string
}

/** Plugin name (stable identity). */
export const name = 'mcp'

/** Services required before apply() runs. */
export const inject = ['api', 'tools', 'capabilities', 'log'] as const

export interface McpConfig {
  /** Absolute path the endpoint answers on (POST; other methods get 405). */
  path: string
}

export const Config: Schema<McpConfig, McpConfig> = z.object({
  path: z.string().default('/mcp').description('absolute POST path of the MCP endpoint'),
})

/** Protocol versions this endpoint speaks; initialize negotiates down to the client's. */
const MCP_VERSIONS = ['2025-06-18', '2025-03-26'] as const
// A bare cordis context already defaults appPaths.bin to 'mediabase', so the
// suffix is just 'mcp': neutral → mediabase-mcp, a product (bin 'avstudio') →
// avstudio-mcp.
const SERVER_NAME = 'mcp'

// ---- JSON-RPC over MCP ------------------------------------------------------

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

// Type aliases (not interfaces) so the objects flow into Record<string, unknown>
// without an index-signature fight.
type RpcResult = {
  jsonrpc: '2.0'
  id: string | number | null
  result: Record<string, unknown>
}

type RpcFailure = {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string }
}

const rpcResult = (id: RpcRequest['id'], result: Record<string, unknown>): RpcResult => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
})
const rpcError = (id: RpcRequest['id'], code: number, message: string): RpcFailure => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

export function apply(ctx: Context, rawConfig: McpConfig): void {
  const config = parse(Config, rawConfig)
  if (!config.path.startsWith('/')) throw new Error(`mcp: 路径必须以 "/" 开头: "${config.path}"`)
  const registry: RegistryService = ctx.tools
  const log = ctx.log.child(name)

  /** Reverse of the shared wire-name map: what the client sent → the real tool. */
  const byWire = (): Map<string, string> => {
    const reverse = new Map<string, string>()
    for (const [canonical, wire] of wireNames(registry.list())) reverse.set(wire, canonical)
    return reverse
  }

  const toolList = (): Array<Record<string, unknown>> => {
    const surface = registry.list()
    const wire = wireNames(surface)
    return surface.map((t) => ({
      name: wire.get(t.name) ?? t.name,
      description: t.description,
      // The registry's derived JSON Schema IS the MCP inputSchema.
      inputSchema: t.parameters ?? { type: 'object', properties: {} },
      // Mutates is an honest declaration, not a guess: a tool that never said
      // gets no annotation instead of a wrong one.
      ...(t.mutates !== undefined ? { annotations: { readOnlyHint: !t.mutates } } : {}),
    }))
  }

  const serverInfo = (): { name: string; version: string } => {
    // The product's own bin names the server: an avstudio deployment answers
    // as avstudio-mcp without this package spelling any product. appPaths is
    // an injected context property — absent in bare unit compositions, where
    // the access itself throws rather than reading undefined.
    let bin = 'mediabase'
    try {
      bin = ctx.appPaths.bin
    } catch {
      /* not composed by boot: the neutral name stands in */
    }
    return { name: `${bin}-${SERVER_NAME}`, version: '0.1.6' }
  }

  async function handleRpc(msg: RpcRequest): Promise<{ status: number; body: Record<string, unknown> | null }> {
    // Notifications carry no id and expect no answer (HTTP 202 per the spec).
    if (msg.id === undefined || msg.id === null) return { status: 202, body: null }

    switch (msg.method) {
      case 'initialize': {
        const requested = typeof msg.params?.['protocolVersion'] === 'string' ? msg.params['protocolVersion'] : ''
        // Echo the client's version when we speak it; otherwise answer with our
        // newest and let the client decide (the spec's negotiation rule).
        const version = (MCP_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_VERSIONS[0]
        return {
          status: 200,
          body: rpcResult(msg.id, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: serverInfo(),
          }),
        }
      }
      case 'ping':
        return { status: 200, body: rpcResult(msg.id, {}) }
      case 'tools/list':
        return { status: 200, body: rpcResult(msg.id, { tools: toolList() }) }
      case 'tools/call': {
        const wire = typeof msg.params?.['name'] === 'string' ? msg.params['name'] : ''
        const args = (msg.params?.['arguments'] ?? {}) as Record<string, unknown>
        const canonical = byWire().get(wire)
        if (canonical === undefined) {
          // Unknown tool is a TOOL error, not a protocol error: the client asked
          // a well-formed question about a surface that changed under it.
          return {
            status: 200,
            body: rpcResult(msg.id, {
              content: [{ type: 'text', text: `unknown tool: ${wire}` }],
              isError: true,
            }),
          }
        }
        try {
          const result = await ctx.api.call('tools.run', { name: canonical, args })
          return {
            status: 200,
            body: rpcResult(msg.id, {
              content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
              isError: false,
            }),
          }
        } catch (e) {
          // A refusal (readonly/ACL) or a tool failure is reported INSIDE the
          // result: the client sees why in text, with the coded prefix.
          const text = hasRpcCode(e)
            ? `[${e.code}] ${e instanceof Error ? e.message : String(e)}`
            : e instanceof Error ? e.message : String(e)
          return {
            status: 200,
            body: rpcResult(msg.id, { content: [{ type: 'text', text }], isError: true }),
          }
        }
      }
      default:
        return { status: 200, body: rpcError(msg.id, RpcCode.METHOD_NOT_FOUND, `method not found: ${String(msg.method)}`) }
    }
  }

  const disposers = [
    ctx.api.endpoint({
      path: config.path,
      description: `MCP(Model Context Protocol)Streamable HTTP 端点:initialize/tools/list/tools/call,把 ctx.tools 暴露给外部 agent`,
      handler: async (req) => {
        let msg: RpcRequest
        try {
          msg = JSON.parse(new TextDecoder().decode(req.body)) as RpcRequest
        } catch {
          return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'parse error: body is not JSON')) }
        }
        if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
          return { status: 400, body: JSON.stringify(rpcError(msg.id ?? null, -32600, 'invalid request: jsonrpc "2.0" and a method are required')) }
        }
        const answered = await handleRpc(msg)
        const out: ApiEndpointResponse = answered.body === null
          ? // A notification: 202 with no body, per the spec.
            { status: answered.status, body: '' }
          : { status: answered.status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(answered.body) }
        return out
      },
    }),
  ]

  ctx.reflect.provide('mcp', { path: config.path } satisfies McpInfo)

  ctx.capabilities.register({
    id: 'mcp',
    title: 'MCP 服务',
    description: `把 ctx.tools 暴露为 MCP Streamable HTTP 端点(POST ${config.path});tool 执行走 ctx.api.call,与控制面同策略同审计`,
  })

  log.info(`MCP 端点已挂载: POST ${config.path}(当前 ${registry.list().length} 个工具)`)
  ctx.effect(() => () => disposers.forEach((d) => d()), `${name}: endpoint`)
}
