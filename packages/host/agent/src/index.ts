// @mediabase/agent — host plugin: LLM agent loop over the HOST TOOL REGISTRY.
// The model plans steps against whatever ctx.tools exposes — no hard-coded tool
// list here; adding a capability = registering a tool.
//
// Endpoint configured at runtime via env (composed by apps/cli short names):
//   LLM_BASE (default https://api.deepseek.com/v1) · LLM_KEY ·
//   LLM_MODEL (default deepseek-chat).
//
// The loop streams: the LLM request asks for SSE and every content delta is
// re-emitted as an `agent.delta` event (the server forwards declared events to
// connected clients), so a panel can render while the model still talks. Tool
// executions surface as `agent.progress` events. The host keeps NO
// conversation state: the caller passes prior turns as `history` and appends
// the returned `thread` — the client owns the thread, like every other piece
// of UI state.

import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentResult,
  AgentService,
  AgentStep,
  AgentTurn,
  RegistryService,
  RegistryToolView,
} from '@mediabase/protocol'
import { parse, z, type Schema } from '@mediabase/schema'
import { RpcCode, RpcError, describeRpcError } from '@mediabase/rpc'
import { wireNames } from '@mediabase/tools'
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
  /**
   * Stream the LLM response (SSE) and forward content deltas as `agent.delta`
   * events. Off for endpoints whose OpenAI-compatible /chat/completions does
   * not support `stream`.
   */
  stream?: boolean
  /**
   * Longest tool result handed back to the model, in JSON characters. A tool
   * that returns more is replaced by a {truncated:true, preview} marker — the
   * model's context, not the caller's, is what this bounds (the RPC result
   * still carries the full value).
   */
  maxToolChars?: number
  /** 本部署的环境前缀,只用于把「该设哪个变量」说对(行里交 `ctx.env.prefix`)。 */
  envPrefix?: string
}

/** The endpoint config a composition row owns; defaults are the public DeepSeek ones. */
export const Config: Schema<AgentConfig, AgentConfig> = z.object({
  baseUrl: z.string().default('https://api.deepseek.com/v1').description('OpenAI-compatible base URL'),
  apiKey: z.string().default('').description('LLM key; empty means "not configured"'),
  model: z.string().default('deepseek-chat').description('model name'),
  stream: z.boolean().default(true).description('stream the LLM response and forward agent.delta events'),
  maxToolChars: z.natural().default(24_000).description('longest tool result (JSON chars) fed back to the model'),
  envPrefix: z.string().default('MEDIABASE_').description('env prefix in force; names the variable a user must set'),
})

const STEP_CAP = 12
const REQUEST_TIMEOUT_MS = 60_000
/** Conversation turns accepted in `history` (the client may hold more; the loop needs few). */
const HISTORY_TURNS = 20

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

/** Keep the model's context bounded: a too-large tool result becomes a marker. */
function budget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return JSON.stringify({ truncated: true, totalChars: content.length, preview: content.slice(0, maxChars) })
}

export function apply(ctx: Context, rawConfig: AgentConfig): void {
  const config = parse(Config, rawConfig)
  const registry: RegistryService = ctx.tools
  const settings = ctx.settings
  const log = ctx.log.child(name)
  log.debug('agent 就绪', { baseUrl: config.baseUrl, model: config.model, key: config.apiKey !== '', stream: config.stream })

  interface ActiveLLM { baseUrl: string; apiKey: string; model: string }

  /** The error mapping shared by both request shapes. */
  function httpError(res: Response, detail: string): RpcError {
    const message = `agent: LLM ${res.status}: ${detail.slice(0, 300)}`
    // 401/403 are credentials; anything else is the endpoint being unavailable.
    return res.status === 401 || res.status === 403
      ? RpcError.unauthorized(message, { status: res.status }, {
        messageKey: 'agent.llmStatus',
        messageParams: { status: res.status, detail: detail.slice(0, 200) },
      })
      : RpcError.unavailable(message, { status: res.status }, {
        messageKey: 'agent.llmStatus',
        messageParams: { status: res.status, detail: detail.slice(0, 200) },
      })
  }

  /** The tool surface for one request, named through the disambiguated wire map. */
  function toolSurface(wire: Map<string, string>): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return registry.list().map((t) => ({
      type: 'function',
      function: {
        name: wire.get(t.name)!,
        description: t.description,
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }))
  }

  /** Shared tail of both request shapes: turn a body into the assistant message. */
  function parseChoices(text: string, url: string): ChatMessage {
    let data: { choices?: ChatChoice[] }
    try {
      data = JSON.parse(text) as { choices?: ChatChoice[] }
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

  /** One non-streaming request: the whole message comes back at once. */
  async function chatOnce(messages: ChatMessage[], llm: ActiveLLM, wire: Map<string, string>): Promise<ChatMessage> {
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
          // Built from the registry on every call: a tool that was registered
          // (or unregistered) after boot shows up immediately.
          tools: toolSurface(wire),
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
      throw httpError(res, body)
    }
    return parseChoices(await res.text(), url)
  }

  /**
   * One streaming request (SSE). Content deltas are re-emitted as `agent.delta`
   * events while the model talks; tool calls arrive split across chunks and are
   * assembled here — execution still waits for the complete message.
   */
  async function chatStream(messages: ChatMessage[], llm: ActiveLLM, wire: Map<string, string>, run: number): Promise<ChatMessage> {
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
          tools: toolSurface(wire),
          tool_choice: 'auto',
          stream: true,
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
      throw httpError(res, body)
    }
    if (res.body === null) {
      throw new RpcError(RpcCode.INTERNAL, 'agent: LLM 流式响应没有 body', { url }, {
        messageKey: 'agent.noMessage',
        messageParams: { url },
      })
    }
    // An endpoint (or a proxy) that ignored `stream: true` answers plain JSON:
    // parse it the non-streaming way instead of reading zero SSE frames as an
    // empty answer.
    if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
      return parseChoices(await res.text(), url)
    }

    let content = ''
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') {
          done = true
          break
        }
        let parsed: {
          choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
        }
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue // a keep-alive comment or a partial frame: skip, not fail
        }
        const delta = parsed.choices?.[0]?.delta
        if (typeof delta?.content === 'string' && delta.content !== '') {
          content += delta.content
          ctx.events.emit('agent.delta', { run, text: delta.content })
        }
        for (const tc of delta?.tool_calls ?? []) {
          const index = tc.index ?? 0
          const acc = calls.get(index) ?? { id: '', name: '', arguments: '' }
          if (typeof tc.id === 'string') acc.id = tc.id
          if (typeof tc.function?.name === 'string') acc.name = tc.function.name
          if (typeof tc.function?.arguments === 'string') acc.arguments += tc.function.arguments
          calls.set(index, acc)
        }
      }
    }

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.id !== '' || c.name !== '')
      .map(([, c]) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }))
    return {
      role: 'assistant',
      content: content === '' ? null : content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
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

  let runSeq = 0

  const agent: AgentService = {
    async run(o): Promise<AgentResult> {
      const llm = await resolveLLM()
      if (!llm.apiKey) {
        const variable = `${config.envPrefix ?? 'MEDIABASE_'}LLM_KEY`
        throw RpcError.unavailable(`agent: 未配置 LLM key(设置面板或 ${variable} 环境变量)`, undefined, {
          messageKey: 'agent.noKey',
          messageParams: { prefix: config.envPrefix ?? 'MEDIABASE_' },
        })
      }
      const run = ++runSeq
      // The CLIENT owns the conversation: prior turns come in, this run's turn
      // goes back out. The host itself keeps nothing between runs.
      const history = (o.history ?? [])
        .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
        .slice(-HISTORY_TURNS)
      const messages: ChatMessage[] = [
        { role: 'system', content: '你是本应用的助手,用提供的工具完成任务,简明回答。' },
        ...history.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
        { role: 'user', content: o.prompt },
      ]
      const steps: AgentStep[] = []
      const maxSteps = Math.max(1, Math.min(STEP_CAP, o.maxSteps ?? 6))
      ctx.events.emit('agent.progress', { run, phase: 'start' })

      let surface: RegistryToolView[] = registry.list()
      let wire = wireNames(surface)
      const byWire = new Map<string, RegistryToolView>()
      const indexTools = (): void => {
        byWire.clear()
        for (const t of surface) byWire.set(wire.get(t.name)!, t)
      }
      indexTools()

      let answer = ''
      let ok = false
      for (let round = 0; round < maxSteps; round++) {
        const reply = config.stream
          ? await chatStream(messages, llm, wire, run)
          : await chatOnce(messages, llm, wire)
        if (!reply.tool_calls || reply.tool_calls.length === 0) {
          ok = true
          answer = reply.content ?? '(模型未返回文本)'
          break
        }
        messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls })
        for (const call of reply.tool_calls) {
          const view = byWire.get(call.function.name)
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
          ctx.events.emit('agent.progress', { run, phase: 'tool-start', name: view.name })
          try {
            // Through the control plane on purpose: the same policy (readonly/ACL),
            // the same audit trail and the same param validation as any client.
            step.result = await ctx.api.call('tools.run', { name: view.name, args: parsed })
          } catch (e) {
            // Coded failure ([code] message) so the UI and the model both see why.
            step.error = describeRpcError(e)
          }
          ctx.events.emit('agent.progress', {
            run,
            phase: 'tool-done',
            name: view.name,
            ...(step.error !== undefined ? { error: step.error } : {}),
          })
          steps.push(step)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: budget(
              JSON.stringify(step.error !== undefined ? { error: step.error } : step.result),
              config.maxToolChars ?? 24_000,
            ),
          })
        }
        // Refresh in case a step registered/unregistered tools mid-run.
        surface = registry.list()
        wire = wireNames(surface)
        indexTools()
      }
      if (!ok) answer = 'agent: 达到最大步骤数仍未收敛'
      const thread: AgentTurn[] = [...history, { role: 'user', content: o.prompt }, { role: 'assistant', content: answer }]
      ctx.events.emit('agent.progress', { run, phase: 'done', ok, answer })
      return { ok, answer, steps, thread }
    },
  }

  ctx.reflect.provide('agent', agent)

  // ---- self-registration: control plane + manifest --------------------------
  const disposers = [
    ctx.api.register({
      name: 'agent.run',
      description: '让 LLM agent 用注册表中的工具完成一次任务(函数调用循环,流式经 agent.delta/agent.progress 事件可见)',
      mutates: true,
      params: z.object({
        prompt: z.string().required().description('中文任务描述'),
        maxSteps: z.number().description('最大步数(默认 6)'),
        history: z.array(z.object({
          role: z.string().description('user 或 assistant'),
          content: z.string(),
        })).description('往轮对话(客户端持有并追加,宿主无状态)'),
      }),
      handler: (p) => agent.run({
        prompt: p.prompt,
        ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
        ...(p.history !== undefined && p.history.length > 0 ? { history: p.history as AgentTurn[] } : {}),
      }),
    }),
  ]

  ctx.capabilities.register({
    id: 'agent',
    title: 'AI 助手',
    description: 'LLM function-calling 循环,只认 ctx.tools;key/base/model 来自 ctx.settings 或组合层 env',
    services: ['agent'],
    api: ['agent.run'],
    events: ['agent.delta', 'agent.progress'],
  })

  ctx.effect(() => () => disposers.forEach((d) => d()), `${name}: api`)
}
