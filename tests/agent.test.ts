// @mediabase/agent — direct unit tests.
//
// The agent loop had exactly one test, in the host integration suite, and it is
// `it.skipIf(!FFMPEG_OK)`: it drives a MEDIA tool, so on a machine without ffmpeg the
// whole agent path is unverified. These tests talk to a scripted mock endpoint instead,
// which removes that coupling and lets the model's side of the protocol be asserted:
//
//   1. what the agent SENDS (tool surface built from the live registry, dots rewritten,
//      OpenAI message sequence, auth header, model) — the integration test can only
//      check the final answer;
//   2. how it reacts to what comes BACK: plain answer, tool calls, unknown tool,
//      unparseable arguments, a tool that throws, an endless tool loop (step cap),
//      and each HTTP failure mode (401/500/non-JSON/missing choices/refused connection);
//   3. that `ctx.settings` overrides the env config at call time, and that a tool
//      registered mid-run shows up in the next request.

import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from '../packages/base/schema/src/index.ts'
import { RpcCode, RpcError } from '../packages/base/rpc/src/index.ts'
import * as log from '../packages/base/log/src/index.ts'
import * as api from '../packages/host/api/src/index.ts'
import * as tools from '../packages/host/tools/src/index.ts'
import * as settings from '../packages/host/settings/src/index.ts'
import * as agent from '../packages/host/agent/src/index.ts'
import type { AgentService, SettingsService } from '../packages/base/protocol/src/index.ts'

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

// ---- the mock endpoint ------------------------------------------------------

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ScriptedReply {
  /** HTTP status (default 200). */
  status?: number
  /** Raw body, when the test wants something the JSON path cannot produce. */
  raw?: string
  /** A full OpenAI-style message (content and/or tool_calls). */
  message?: { role?: 'assistant'; content?: string | null; tool_calls?: ToolCall[] }
}

interface CapturedRequest {
  path: string
  authorization: string | undefined
  body: {
    model?: string
    messages?: Array<{ role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }>
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>
    tool_choice?: string
  }
}

/** A scripted `/v1/chat/completions` endpoint that records what the agent sent. */
class MockLLM {
  readonly requests: CapturedRequest[] = []
  private readonly script: ScriptedReply[] = []
  private server: http.Server | null = null
  private boundPort = 0

  /** Queue replies in order; the last one repeats once the script runs out. */
  reply(...entries: ScriptedReply[]): this {
    this.script.push(...entries)
    return this
  }

  /** Convenience: "the model answered without calling a tool". */
  answer(text: string): this {
    return this.reply({ message: { role: 'assistant', content: text } })
  }

  /** Convenience: "the model asked for tools" (content null, as OpenAI does). */
  calls(...calls: ToolCall[]): this {
    return this.reply({ message: { role: 'assistant', content: null, tool_calls: calls } })
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      req.on('end', () => {
        let body: CapturedRequest['body'] = {}
        try {
          body = JSON.parse(raw) as CapturedRequest['body']
        } catch { /* recorded as empty; a test asserting on it will notice */ }
        this.requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body })

        const next = this.script.length > 1 ? this.script.shift()! : (this.script[0] ?? { message: { content: 'ok' } })
        if (next.raw !== undefined) {
          res.writeHead(next.status ?? 200, { 'content-type': 'application/json' })
          res.end(next.raw)
          return
        }
        if (next.status !== undefined && next.status !== 200) {
          res.writeHead(next.status, { 'content-type': 'text/plain' })
          res.end('endpoint said no')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: next.message ?? { role: 'assistant', content: 'ok' } }] }))
      })
    })
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    this.boundPort = typeof address === 'object' && address ? address.port : 0
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/v1`
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
})

// ---- composition -----------------------------------------------------------

interface Fixture {
  ctx: Context
  agent: AgentService
  settings: SettingsService
  toolCalls: Array<{ name: string; args: unknown }>
}

async function compose(baseUrl: string, opts: { apiKey?: string; model?: string } = {}): Promise<Fixture> {
  const ctx = new Context()
  const toolCalls: Array<{ name: string; args: unknown }> = []
  const file = join(mkdtempSync(join(tmpdir(), 'mediabase-agent-')), 'settings.json')
  made.push(join(file, '..'))

  ctx.plugin(log, { level: 'error', sink: () => {} })
  await settle()
  ctx.plugin(api)
  await settle()
  ctx.plugin(tools)
  await settle()
  ctx.plugin(settings, { file })
  await settle()

  // Two tools with different failure modes: the surface the model sees, and what the
  // loop does when a step succeeds and when it throws a CODED error.
  ctx.tools.register({
    name: 'media.probe',
    description: '读取媒体文件时长与分辨率',
    params: z.object({ file: z.string().required() }),
    execute: (a) => {
      toolCalls.push({ name: 'media.probe', args: a })
      return { duration: 3, width: 320, height: 240 }
    },
  })
  ctx.tools.register({
    name: 'python.run',
    description: '在独立 python 进程里执行脚本',
    params: z.object({ script: z.string().required() }),
    execute: (a) => {
      toolCalls.push({ name: 'python.run', args: a })
      throw RpcError.worker('python: 脚本执行失败(mock)')
    },
  })
  await settle()

  ctx.plugin(agent, {
    baseUrl,
    apiKey: opts.apiKey ?? 'sk-test-key',
    model: opts.model ?? 'test-model',
  })
  await settle()
  const agentService = ctx.get('agent')
  const settingsService = ctx.get('settings')
  if (!agentService || !settingsService) throw new Error('agent/settings service missing')
  return { ctx, agent: agentService, settings: settingsService, toolCalls }
}

interface Rejection { code?: number; message: string }

async function rejection(fn: () => Promise<unknown>): Promise<Rejection> {
  try {
    await fn()
  } catch (e) {
    const err = e as Rejection
    return { message: err.message, ...(typeof err.code === 'number' ? { code: err.code } : {}) }
  }
  throw new Error('expected the call to reject')
}

// ---- tests -----------------------------------------------------------------

describe('@mediabase/agent: what it sends', () => {
  it('builds the tool surface from the live registry, rewriting dots for OpenAI', async () => {
    const llm = new MockLLM().answer('done')
    await llm.start()
    const fx = await compose(llm.url)
    try {
      const result = await fx.agent.run({ prompt: '这个视频多长?' })
      expect(result).toEqual({ ok: true, answer: 'done', steps: [] })

      const sent = llm.requests[0]!
      expect(sent.path).toBe('/v1/chat/completions')
      expect(sent.authorization).toBe('Bearer sk-test-key')
      expect(sent.body.model).toBe('test-model')
      expect(sent.body.tool_choice).toBe('auto')
      // OpenAI function names cannot contain dots — the registry name is mapped, and
      // the map is what the loop uses to resolve the call back to a real tool.
      expect(sent.body.tools?.map((t) => t.function.name).sort()).toEqual(['media_probe', 'python_run'])
      const probe = sent.body.tools?.find((t) => t.function.name === 'media_probe')
      expect(probe?.function.description).toBe('读取媒体文件时长与分辨率')
      expect(probe?.function.parameters).toMatchObject({ type: 'object' })
      // The prompt is a system+user pair, in that order.
      expect(sent.body.messages?.map((m) => m.role)).toEqual(['system', 'user'])
      expect(sent.body.messages?.[1]?.content).toBe('这个视频多长?')
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  })

  it('refuses without a key, and does not touch the network', async () => {
    const llm = new MockLLM().answer('never')
    await llm.start()
    // No env key and no stored key: the failure must be immediate and local.
    const fx = await compose(llm.url, { apiKey: '' })
    try {
      const failure = await rejection(() => fx.agent.run({ prompt: 'x' }))
      expect(failure.code).toBe(RpcCode.UNAVAILABLE)
      expect(failure.message).toContain('LLM key')
      expect(llm.requests).toHaveLength(0)
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  })

  it('lets ctx.settings override the env config at call time', async () => {
    const fromEnv = new MockLLM().answer('env')
    const fromSettings = new MockLLM().answer('settings')
    await fromEnv.start()
    await fromSettings.start()
    const fx = await compose(fromEnv.url, { apiKey: 'sk-env', model: 'env-model' })
    try {
      await fx.settings.set('llm.base', fromSettings.url)
      await fx.settings.set('llm.key', 'sk-stored')
      await fx.settings.set('llm.model', 'stored-model')

      const result = await fx.agent.run({ prompt: '去哪?' })
      expect(result.answer).toBe('settings')
      // The panel-configured endpoint wins, and the env endpoint is untouched.
      expect(fromSettings.requests).toHaveLength(1)
      expect(fromSettings.requests[0]?.authorization).toBe('Bearer sk-stored')
      expect(fromSettings.requests[0]?.body.model).toBe('stored-model')
      expect(fromEnv.requests).toHaveLength(0)
    } finally {
      await fx.ctx.fiber.dispose()
      await fromEnv.stop()
      await fromSettings.stop()
    }
  })
})

describe('@mediabase/agent: what it does with the reply', () => {
  it('runs a tool call and feeds the result back in the documented shape', async () => {
    const llm = new MockLLM()
      .calls(call('c1', 'media_probe', { file: '/tmp/x.mp4' }))
      .answer('时长 3 秒')
    await llm.start()
    const fx = await compose(llm.url)
    try {
      const result = await fx.agent.run({ prompt: '探测' })
      expect(result).toMatchObject({ ok: true, answer: '时长 3 秒' })
      expect(result.steps).toEqual([{ name: 'media_probe', args: { file: '/tmp/x.mp4' }, result: { duration: 3, width: 320, height: 240 } }])
      expect(fx.toolCalls).toEqual([{ name: 'media.probe', args: { file: '/tmp/x.mp4' } }])

      // Round 2 carries assistant(tool_calls) + tool(result) — the sequence the model
      // needs to continue; getting this wrong loops forever in practice.
      const second = llm.requests[1]!
      expect(second.body.messages?.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
      expect(second.body.messages?.[2]?.tool_calls?.[0]?.id).toBe('c1')
      expect(second.body.messages?.[3]?.tool_call_id).toBe('c1')
      expect(JSON.parse(second.body.messages?.[3]?.content ?? 'null')).toEqual({ duration: 3, width: 320, height: 240 })
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  })

  it('reports a tool that throws as a coded step error and returns it to the model', async () => {
    const llm = new MockLLM()
      .calls(call('c1', 'python_run', { script: 'boom' }))
      .answer('工具失败了')
    await llm.start()
    const fx = await compose(llm.url)
    try {
      const result = await fx.agent.run({ prompt: '跑脚本' })
      expect(result.steps[0]?.error).toContain(`[${RpcCode.WORKER}]`)
      expect(result.steps[0]?.error).toContain('脚本执行失败')
      const toolMessage = llm.requests[1]?.body.messages?.at(-1)
      expect(toolMessage?.role).toBe('tool')
      expect(JSON.parse(toolMessage?.content ?? 'null')).toMatchObject({ error: expect.stringContaining('脚本执行失败') })
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  })

  it('handles an unknown tool and unparseable arguments without crashing the loop', async () => {
    const llm = new MockLLM()
      // A name the registry does not have, and a call whose arguments are not JSON.
      .calls(call('c1', 'not_a_tool', {}), call('c2', 'media_probe', '{oops'))
      .answer('继续')
    await llm.start()
    const fx = await compose(llm.url)
    try {
      const result = await fx.agent.run({ prompt: 'x' })
      expect(result.ok).toBe(true)
      expect(result.steps[0]).toMatchObject({ name: 'not_a_tool', error: expect.stringContaining('注册表无此工具') })
      // Unparseable arguments become {} and the tool still runs (the registry validates
      // them, so a missing required field is the registry's error to report).
      expect(result.steps[1]?.name).toBe('media_probe')
      expect(result.steps[1]?.args).toEqual({})
      const seen = llm.requests[1]?.body.messages ?? []
      expect(JSON.parse(seen.find((m) => m.role === 'tool')?.content ?? 'null')).toEqual({ error: 'unknown tool' })
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  })

  it('stops at the step cap instead of looping forever', async () => {
    const llm = new MockLLM().calls(call('c1', 'media_probe', { file: '/tmp/x.mp4' }))
    await llm.start()
    const fx = await compose(llm.url)
    try {
      const result = await fx.agent.run({ prompt: '无限循环', maxSteps: 2 })
      expect(result.ok).toBe(false)
      expect(result.answer).toContain('最大步骤数')
      expect(result.steps).toHaveLength(2)
      expect(llm.requests).toHaveLength(2)
      // The cap is bounded no matter what the caller asks for.
      const capped = await fx.agent.run({ prompt: '要一万步', maxSteps: 10_000 })
      expect(capped.steps.length).toBeLessThanOrEqual(12)
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  }, 30_000)

  it('sees a tool registered mid-run on the next round (the registry is live)', async () => {
    const llm = new MockLLM()
      .calls(call('c1', 'media_probe', { file: '/tmp/x.mp4' }))
      .answer('done')
    await llm.start()
    const fx = await compose(llm.url)
    try {
      // A step that adds a tool, like a capability loading a plugin during a workflow.
      fx.ctx.tools.register({
        name: 'late.tool',
        description: 'registered during the run',
        execute: () => 'late',
      })
      await fx.agent.run({ prompt: 'x' })
      const names = llm.requests[1]?.body.tools?.map((t) => t.function.name) ?? []
      expect(names).toContain('late_tool')
    } finally {
      await fx.ctx.fiber.dispose()
      await llm.stop()
    }
  })
})

describe('@mediabase/agent: HTTP failure modes are distinguished', () => {
  const cases: Array<{ label: string; reply: ScriptedReply; code: number; contains: string }> = [
    { label: '401 is a credential problem', reply: { status: 401 }, code: RpcCode.UNAUTHORIZED, contains: '401' },
    { label: '403 is a credential problem', reply: { status: 403 }, code: RpcCode.UNAUTHORIZED, contains: '403' },
    { label: '500 is an availability problem', reply: { status: 500 }, code: RpcCode.UNAVAILABLE, contains: '500' },
    { label: 'a non-JSON body is an internal problem', reply: { raw: '<html>gateway</html>' }, code: RpcCode.INTERNAL, contains: 'JSON' },
    { label: 'a body without choices is an internal problem', reply: { raw: '{}' }, code: RpcCode.INTERNAL, contains: 'choices' },
  ]

  for (const c of cases) {
    it(c.label, async () => {
      const llm = new MockLLM().reply(c.reply)
      await llm.start()
      const fx = await compose(llm.url)
      try {
        const failure = await rejection(() => fx.agent.run({ prompt: 'x' }))
        expect(failure.code).toBe(c.code)
        expect(failure.message).toContain(c.contains)
      } finally {
        await fx.ctx.fiber.dispose()
        await llm.stop()
      }
    })
  }

  it('an unreachable endpoint names the URL it tried', async () => {
    // Port 1 has nothing listening: a connection error, not an HTTP status.
    const fx = await compose('http://127.0.0.1:1/v1')
    try {
      const failure = await rejection(() => fx.agent.run({ prompt: 'x' }))
      expect(failure.code).toBe(RpcCode.UNAVAILABLE)
      expect(failure.message).toContain('http://127.0.0.1:1/v1/chat/completions')
      expect(failure.message).toMatch(/LLM_BASE|LLM_KEY/)
    } finally {
      await fx.ctx.fiber.dispose()
    }
  })
})

describe('@mediabase/agent: config vocabulary and registration', () => {
  it('declares the documented defaults, which a composition row overrides', () => {
    // The env values are CONFIG now: the bundle's row reads them
    // (`!!js ctx.env.str('MEDIABASE_LLM_BASE')`), and this schema is what a row must satisfy.
    // `undefined` is how an absent config reaches a schema (a row with no `config:` at all).
    expect(agent.Config(undefined)).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      // The prefix is not part of the request; it is how the "which variable do I set?"
      // message names the deployment's own variable (`CALC_LLM_KEY`, `AVSTUDIO_LLM_KEY`).
      envPrefix: 'MEDIABASE_',
    })
    expect(agent.Config({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' })).toEqual({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      envPrefix: 'MEDIABASE_',
    })
  })

  it('declares exactly what it registers, and unregisters with the fiber', async () => {
    const llm = new MockLLM().answer('x')
    await llm.start()
    const fx = await compose(llm.url)
    try {
      const capabilities = fx.ctx.get('capabilities')
      const own = capabilities?.verify().find((r) => r.id === 'agent')
      expect(own?.ok).toBe(true)
      expect(own?.missing).toEqual({ services: [], api: [], tools: [] })
      const registry = fx.ctx.api
      expect(registry.list().find((m) => m.name === 'agent.run')?.mutates).toBe(true)
      await fx.ctx.fiber.dispose()
      expect(registry.list().some((m) => m.name === 'agent.run')).toBe(false)
    } finally {
      await llm.stop()
    }
  })
})
