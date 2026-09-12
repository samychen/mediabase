// @mediabase/tools — host plugin: capability tool registry (route-B).
//
// Provides ctx.tools: capability packages register tools here once —
// { name, description, params?, execute } — and generic consumers
// (product workflow runners, @mediabase/agent) only know the registry: adding a
// capability no longer requires editing core dispatch code.
//
// `params` is an @mediabase/schema (schemastery) schema, not a hand-written JSON
// Schema blob. The registry uses it twice: to VALIDATE arguments before execute
// (a malformed LLM tool call or a typo'd RPC call fails with a path instead of
// reaching the capability) and to DERIVE the OpenAI-style JSON Schema the agent
// sends to the model. One declaration, both uses.

import type { Context } from '@deepseek-ai/cordis'
import type { RegistryService, RegistryTool, RegistryToolView } from '@mediabase/protocol'
import { describe as describeSchema, parse, SchemaError, toJsonSchema, z } from '@mediabase/schema'
import { RpcCode, RpcError } from '@mediabase/rpc'
import type {} from '@mediabase/api'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Tool registry: capabilities register, generic cores consume. */
    tools: RegistryService
  }
}

/** Plugin name (stable identity). */
export const name = 'tools'

/** Services required before apply() runs. */
export const inject = ['api', 'capabilities'] as const

export function apply(ctx: Context): void {
  const tools = new Map<string, RegistryTool>()

  const registry: RegistryService = {
    register(tool: RegistryTool): () => void {
      if (tools.has(tool.name)) {
        throw new Error(`registry: 工具名重复 "${tool.name}"`)
      }
      tools.set(tool.name, tool)
      return () => {
        tools.delete(tool.name)
      }
    },
    list(): RegistryToolView[] {
      return [...tools.values()].map((t) => {
        const view: RegistryToolView = { name: t.name, description: t.description }
        if (t.params !== undefined) {
          view.parameters = toJsonSchema(t.params) as Record<string, unknown>
          view.signature = describeSchema(t.params)
        }
        return view
      })
    },
    async run(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      const tool = tools.get(toolName)
      if (!tool) {
        throw new RpcError(RpcCode.NOT_FOUND, `registry: 未知工具 "${toolName}"`, undefined, {
          messageKey: 'tools.unknownTool',
          messageParams: { tool: toolName },
        })
      }
      let input: Record<string, unknown> = args ?? {}
      if (tool.params) {
        try {
          input = parse(tool.params, input, `${toolName} 参数`) as Record<string, unknown>
        } catch (e) {
          throw new RpcError(RpcCode.INVALID_PARAMS, e instanceof Error ? e.message : String(e), {
            path: e instanceof SchemaError ? e.path : undefined,
          }, {
            messageKey: 'tools.invalidArgs',
            messageParams: { tool: toolName, detail: e instanceof Error ? e.message : String(e) },
          })
        }
      }
      return tool.execute(input)
    },
    has(toolName: string): boolean {
      return tools.has(toolName)
    },
  }

  ctx.reflect.provide('tools', registry)

  // The registry exposes itself over the control plane — the same
  // self-registration path every capability takes (the server names nothing).
  const disposers = [
    ctx.api.register({
      name: 'tools.list',
      description: '列出已注册工具(参数 JSON Schema 供 LLM 使用)',
      params: z.object({}),
      handler: () => registry.list(),
    }),
    ctx.api.register({
      name: 'tools.run',
      description: '按名字执行一个已注册工具(参数先经 schema 校验)',
      mutates: true,
      params: z.object({
        name: z.string().required().description('工具名,见 tools.list'),
        args: z.dict(z.any()).default({}).description('工具参数'),
      }),
      handler: (p) => registry.run(p.name, p.args),
    }),
  ]

  ctx.capabilities.register({
    id: 'tools',
    title: '工具注册表',
    description: '能力自注册工具;workflow/agent/控制面只认注册表,不认具体能力',
    services: ['tools'],
    api: ['tools.list', 'tools.run'],
  })

  // Any registered tool dies with this fiber (stop/unload cleans the map).
  ctx.effect(() => () => {
    disposers.forEach((d) => d())
    tools.clear()
  }, `${name}: tools`)
}
