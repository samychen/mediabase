// @mediabase/settings — host plugin: persisted key->JSON settings (e.g. the LLM
// key for the AI assistant) + an in-app UI entry point. File lives under the
// boot identity's home by default (`appPaths.home/settings.json`, config.file
// overrides). Consumers read ctx.settings per use, so a change applies without
// a restart.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsService } from '@mediabase/protocol'
import { parse, z, type Schema } from '@mediabase/schema'
import { RpcCode, RpcError } from '@mediabase/rpc'
import type {} from '@mediabase/api'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side persisted settings. */
    settings: SettingsService
  }
}

/** Plugin name (stable identity). */
export const name = 'settings'

/** Services required before apply() runs. */
export const inject = ['api', 'capabilities'] as const

/**
 * Known settings keys with their schemas. `settings.set` refuses anything else:
 * a typo used to be persisted silently and then read back as "unset".
 */
const KNOWN_KEYS = {
  'llm.key': z.string().description('LLM API Key(明文存本地文件)'),
  'llm.base': z.string().description('OpenAI 兼容 base URL'),
  'llm.model': z.string().description('模型名'),
} as const

export interface SettingsConfig {
  /** JSON file path; defaults to `<appPaths.home>/settings.json`. */
  file?: string
}

/**
 * The capability's DEPLOYMENT CONFIG, validated at the boundary: a wrong type or an
 * unsupported field name stops the boot with a path instead of being discovered later as
 * a missing file. Declared against the TypeScript interface, so the schema and the type
 * cannot drift.
 */
export const Config: Schema<SettingsConfig, SettingsConfig> = z.object({
  file: z.string().description('settings JSON path; default <appPaths.home>/settings.json'),
})

export function apply(ctx: Context, rawConfig: SettingsConfig = {}): void {
  const config = parse(Config, rawConfig)
  const appHome = (ctx.get('appPaths') as { home?: string } | undefined)?.home
  const file = config.file ?? join(appHome ?? join(homedir(), '.mediabase'), 'settings.json')
  let store: Record<string, unknown> = {}
  let loaded = false

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      store = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    } catch {
      store = {}
    }
  }

  const settings: SettingsService = {
    async list(): Promise<Record<string, unknown>> {
      await ensureLoaded()
      return { ...store }
    },
    async get(key: string): Promise<unknown> {
      await ensureLoaded()
      return store[key]
    },
    async set(key: string, value: unknown): Promise<void> {
      await ensureLoaded()
      const v = value === undefined || value === '' ? undefined : value
      // Build the next state, WRITE it, and only then commit it to memory. The other
      // order mutated the store first, so a failed write left the host reporting a
      // value that was never persisted — the one outcome a settings store must not
      // produce.
      const next: Record<string, unknown> = { ...store }
      if (v === undefined) delete next[key]
      else next[key] = v
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(next, null, 2))
      } catch (e) {
        throw new Error(`settings: 无法写入 ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
      store = next
    },
  }

  ctx.reflect.provide('settings', settings)

  // ---- self-registration: control plane + manifest --------------------------
  const disposers = [
    ctx.api.register({
      name: 'settings.list',
      description: '读取全部已保存设置(key -> JSON)',
      params: z.object({}),
      handler: () => settings.list(),
    }),
    ctx.api.register({
      name: 'settings.set',
      description: `写入一个设置项;已知键:${Object.keys(KNOWN_KEYS).join(' / ')}(空值删除)`,
      mutates: true,
      params: z.object({
        key: z.string().required().description('设置键(未知键会被拒绝并列出可用键)'),
        value: z.any().description('JSON 值;空字符串或 null 删除该键'),
      }),
      handler: async (p) => {
        const schema = (KNOWN_KEYS as Record<string, (v: unknown) => unknown>)[p.key]
        if (schema === undefined) {
          throw new RpcError(RpcCode.INVALID_PARAMS, `settings: 未知设置键 "${String(p.key)}"`, undefined, {
            messageKey: 'settings.unknownKey',
            messageParams: { key: String(p.key) },
          })
        }
        const value = p.value === null ? undefined : p.value
        if (value !== undefined && value !== '') {
          try {
            schema(value)
          } catch (e) {
            throw new RpcError(RpcCode.INVALID_PARAMS, `settings.set(${p.key}): ${e instanceof Error ? e.message : String(e)}`, undefined, {
              messageKey: 'settings.invalidValue',
              messageParams: { key: p.key, detail: e instanceof Error ? e.message : String(e) },
            })
          }
        }
        await settings.set(p.key, value)
        return undefined
      },
    }),
    ctx.api.register({
      name: 'settings.keys',
      description: '列出已知设置键及其签名',
      params: z.object({}),
      handler: () => Object.entries(KNOWN_KEYS).map(([key, schema]) => ({ key, signature: schema.toString() })),
    }),
  ]

  ctx.capabilities.register({
    id: 'settings',
    title: '持久化设置',
    description: '键值设置落盘 <appPaths.home>/settings.json(明文),供 AI 助手等能力读取',
    services: ['settings'],
    api: ['settings.list', 'settings.set', 'settings.keys'],
  })

  ctx.effect(() => () => disposers.forEach((d) => d()), `${name}: api`)
}
