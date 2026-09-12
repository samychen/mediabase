// @mediabase/log — leveled logging with scoped children, as the `ctx.log` service.
//
// Before this, diagnostics were `console.log` in the host plus raw engine stderr
// passthrough: no levels, no scopes, no way to collect them. A capability now
// logs through `ctx.log.child('media')`, and the composition layer decides where
// records go (stderr by default, a custom sink in tests, a file later).
//
// The factory is exported separately from the plugin so the sink/level logic is
// testable without a cordis context.

import type { Context } from '@deepseek-ai/cordis'
import { parse, z, type Schema } from '@mediabase/schema'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Leveled logger; use `.child(scope)` inside a capability. */
    log: LogService
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** One diagnostic record — structured, so a sink can filter/forward it. */
export interface LogRecord {
  time: string
  level: LogLevel
  scope: string
  msg: string
  data?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  /** Derive a logger for a subsystem; the child marker is appended to the scope. */
  child(scope: string): Logger
}

export interface LogService extends Logger {
  level(): LogLevel
  setLevel(level: LogLevel): void
}

export interface LogOptions {
  level?: LogLevel
  /** Scope prefix, e.g. `avstudio` or `engine`. */
  scope?: string
  sink?: LogSink
  /** Timestamps on/off for the default stderr sink (records always carry time). */
  timestamps?: boolean
}

export interface LogConfig extends LogOptions {}

/**
 * The DEPLOYMENT CONFIG: level/scope/timestamps are validated, because a composition
 * row states them. `sink` is NOT declared — it is a function, so a yml row can never
 * carry one and a `z.any()` field would only pretend it could. It still type-checks
 * and survives parsing, because this dialect passes unknown keys through untouched:
 * the schema constrains what a DEPLOYMENT may say, and embedding code (tests, a host
 * with its own collector) keeps the other seam.
 */
export const Config: Schema<LogConfig, LogConfig> = z.object({
  level: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')])
    .description("minimum level; default info. A row reads it from the deployment's own vocabulary: level: !!js ctx.env.choice('LOG_LEVEL', ['debug','info','warn','error']) — an unrecognized value falls back here rather than stopping the boot"),
  scope: z.string().description('scope prefix; default the app name'),
  timestamps: z.boolean().description('timestamps on the default stderr sink'),
})

export function isLogLevel(v: unknown): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error'
}

/** Default sink: one line per record on stderr (stdout stays clean for UX). */
export function stderrSink(timestamps = true): LogSink {
  return (r: LogRecord): void => {
    const head = timestamps ? `${r.time} ` : ''
    const tail = r.data !== undefined ? ` ${JSON.stringify(r.data)}` : ''
    process.stderr.write(`${head}${r.level.toUpperCase().padEnd(5)} ${r.scope ? `${r.scope} ` : ''}${r.msg}${tail}\n`)
  }
}

export function createLogger(options: LogOptions = {}): LogService {
  // The neutral default: a base package cannot know which app it serves. A composition
  // states the app's own scope on the log row (`scope: !!js ctx.appPaths.bin`).
  let level: LogLevel = options.level ?? 'info'
  const sink: LogSink = options.sink ?? stderrSink(options.timestamps ?? true)
  const root = options.scope ?? 'mediabase'

  function make(scope: string): LogService {
    const emit = (lvl: LogLevel) => (msg: string, data?: Record<string, unknown>): void => {
      if (ORDER[lvl] < ORDER[level]) return
      const record: LogRecord = { time: new Date().toISOString(), level: lvl, scope, msg }
      if (data !== undefined) record.data = data
      sink(record)
    }
    return {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      child(child): LogService {
        return make(scope === '' ? child : `${scope}.${child}`)
      },
      level: () => level,
      setLevel(next: LogLevel): void {
        level = next
      },
    }
  }

  return make(root)
}

/** Plugin name (stable identity). */
export const name = 'log'

export function apply(ctx: Context, rawConfig: LogConfig = {}): void {
  const { sink, ...declared } = rawConfig
  const config: LogConfig = { ...parse(Config, declared), ...(sink === undefined ? {} : { sink }) }
  // No environment read here ON PURPOSE: the base must not know a product's prefix, and two
  // readers of one knob is how they drift. The row states `level` from the deployment's own
  // vocabulary, and `ctx.env.choice` is what preserves "a typo falls back to info" — a knob
  // whose bad value should not stop a boot is a reader decision, not a package decision.
  const opts: LogOptions = { level: config.level ?? 'info', scope: config.scope ?? 'mediabase' }
  if (config.sink !== undefined) opts.sink = config.sink
  if (config.timestamps !== undefined) opts.timestamps = config.timestamps
  ctx.reflect.provide('log', createLogger(opts))
}
