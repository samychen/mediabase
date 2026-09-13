// @mediabase/agent — host plugin: LLM agent loop over the HOST TOOL REGISTRY.
// The model plans steps against whatever ctx.tools exposes — no hard-coded tool
// list here; adding a capability = registering a tool.
//
// Endpoint configured at runtime via env (composed by apps/cli short names):
//   LLM_BASE (default https://api.deepseek.com/v1) · LLM_KEY ·
//   LLM_MODEL (default deepseek-chat).

import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentResult,
  AgentService,
  AgentStep,
  RegistryService,
  RegistryToolView,
} from '@mediabase/protocol'
import { parse, z, type Schema } from '@mediabase/schema'
import { RpcCode, RpcError, describeRpcError } from '@mediabase/rpc'
import type {} from '@mediabase/tools'
// Type-only imports keep each package compilable STANDALONE (see
// scripts/build-base.mjs): ctx.settings is declared by @mediabase/settings.
import type {} from '@mediabase/settings'
import type {} from '@mediabase/api'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** LLM agent (function calling over registered tools). */
    agent: AgentService
  }
}

/** Plugin name (stable identity). */
export const name = 'agent'

import type {} from '@mediabase/log'

/** Services required before apply() runs. */
export const inject = ['tools', 'settings', 'api', 'capabilities', 'log'] as const

export interface AgentConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** The endpoint config a composition row owns; defaults are the public DeepSeek ones. */
export const Config: Schema<AgentConfig, AgentConfig> = z.object({
  baseUrl: z.string().default('https://api.deepseek.com/v1').description('OpenAI-compatible base URL'),
  apiKey: z.string().default('').description('LLM key; empty means "not configured"'),
  model: z.string().default('deepseek-chat').description('model name'),
})

const STEP_CAP = 12
const REQUEST_TIMEOUT_MS = 60_000

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

interface ChatChoice {
  message: ChatMessage
  finish_reason?: string
}

/** OpenAI function names must match ^[a-zA-Z0-9_-]+$ — no dots. */
function fnName(canonical: string): string {
  return canonical.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function apply(ctx: Context, rawConfig: AgentConfig): void {
  const config = parse(Config, rawConfig)
  const registry: RegistryService = ctx.tools
  const settings = ctx.settings
  const log = ctx.log.child(name)
  log.debug('agent 就绪', { baseUrl: config.baseUrl, model: config.model, key: config.apiKey !== '' })

  interface ActiveLLM { baseUrl: string; apiKey: string; model: string }

  async function chat(messages: ChatMessage[], llm: ActiveLLM): Promise<ChatMessage> {
    const base = llm.baseUrl.replace(/\/+$/, '')
    const url = `${base}/chat/completions`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages,
          // Build the tool surface from the registry on every call: a tool that
          // was registered (or unregistered) after boot shows up immediately.
          tools: registry.list().map((t) => ({
            type: 'function',
            function: {
              name: fnName(t.name),
              description: t.description,
              parameters: t.parameters ?? { type: 'object', properties: {} },
            },
          })),
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      throw RpcError.unavailable(
        `agent: 无法连接 ${url};请检查 LLM_BASE/KEY(${e instanceof Error ? e.message : String(e)})`,
        { url },
        {
          messageKey: 'agent.unreachable',
          messageParams: { url, detail: e instanceof Error ? e.message : String(e) },
        },
      )
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const message = `agent: LLM ${res.status}: ${body.slice(0, 300)}`
      // 401/403 are credentials; anything else is the endpoint being unavailable.
      const detail = body.slice(0, 200)
      throw res.status === 401 || res.status === 403
        ? RpcError.unauthorized(message, { status: res.status }, {
          messageKey: 'agent.llmStatus',
          messageParams: { status: res.status, detail },
        })
        : RpcError.unavailable(message, { status: res.status }, {
          messageKey: 'agent.llmStatus',
          messageParams: { status: res.status, detail },
        })
    }
    let data: { choices?: ChatChoice[] }
    try {
      data = (await res.json()) as { choices?: ChatChoice[] }
    } catch (e) {
      throw new RpcError(RpcCode.INTERNAL, 'agent: LLM 响应不是合法 JSON', { url }, {
        cause: e,
        messageKey: 'agent.badJson',
        messageParams: { url },
      })
    }
    const msg = data.choices?.[0]?.message
    if (!msg) {
      throw new RpcError(RpcCode.INTERNAL, 'agent: LLM 响应缺少 choices[0].message', { url }, {
        messageKey: 'agent.noMessage',
        messageParams: { url },
      })
    }
    return msg
  }

  async function resolveLLM(): Promise<ActiveLLM> {
    const [storedKey, storedBase, storedModel] = await Promise.all([
      settings.get('llm.key'), settings.get('llm.base'), settings.get('llm.model'),
    ])
    const s = (v: unknown): string => (typeof v === 'string' ? v : '')
    return {
      apiKey: s(storedKey) || config.apiKey,
      baseUrl: s(storedBase) || config.baseUrl,
      model: s(storedModel) || config.model,
    }
  }

  const agent: AgentService = {
    async run(o): Promise<AgentResult> {
      const llm = await resolveLLM()
      if (!llm.apiKey) {
        throw RpcError.unavailable('agent: 未配置 LLM key(设置面板或 LLM_KEY 环境变量)', undefined, {
          messageKey: 'agent.noKey',
        })
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: '你是本应用的助手,用提供的工具完成任务,简明回答。' },
        { role: 'user', content: o.prompt },
      ]
      const steps: AgentStep[] = []
      const maxSteps = Math.max(1, Math.min(STEP_CAP, o.maxSteps ?? 6))

      let surface: RegistryToolView[] = registry.list()
      const byFn = new Map<string, RegistryToolView>()
      const indexTools = (): void => {
        byFn.clear()
        for (const t of surface) byFn.set(fnName(t.name), t)
      }
      indexTools()

      for (let round = 0; round < maxSteps; round++) {
        const reply = await chat(messages, llm)
        if (!reply.tool_calls || reply.tool_calls.length === 0) {
          return { ok: true, answer: reply.content ?? '(模型未返回文本)', steps }
        }
        messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls })
        for (const call of reply.tool_calls) {
          const view = byFn.get(call.function.name)
          if (!view) {
            steps.push({ name: call.function.name, error: `agent: 注册表无此工具 "${call.function.name}"` })
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'unknown tool' }) })
            continue
          }
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
          } catch {
            parsed = {}
          }
          const step: AgentStep = { name: call.function.name, args: parsed }
          try {
            const result = await registry.run(view.name, parsed)
            step.result = result
          } catch (e) {
            // Coded failure ([code] message) so the UI and the model both see why.
            step.error = describeRpcError(e)
          }
          steps.push(step)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(step.error !== undefined ? { error: step.error } : step.result),
          })
        }
        // Refresh in case a step registered/unregistered tools mid-run.
        surface = registry.list()
        indexTools()
      }
      return { ok: false, answer: 'agent: 达到最大步骤数仍未收敛', steps }
    },
  }

  ctx.reflect.provide('agent', agent)

  // ---- self-registration: control plane + manifest --------------------------
  const disposers = [
    ctx.api.register({
      name: 'agent.run',
      description: '让 LLM agent 用注册表中的工具完成一次任务(函数调用循环)',
      mutates: true,
      params: z.object({
        prompt: z.string().required().description('中文任务描述'),
        maxSteps: z.number().description('最大步数(默认 6)'),
      }),
      handler: (p) => agent.run({ prompt: p.prompt, ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}) }),
    }),
  ]

  ctx.capabilities.register({
    id: 'agent',
    title: 'AI 助手',
    description: 'LLM function-calling 循环,只认 ctx.tools;key/base/model 来自 ctx.settings 或组合层 env',
    services: ['agent'],
    api: ['agent.run'],
  })

  ctx.effect(() => () => disposers.forEach((d) => d()), `${name}: api`)
}
