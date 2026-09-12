// @mediabase/log — direct unit tests.
//
// `ctx.log` was imported by half the suite and never tested on its own: the tests used
// it as plumbing (a sink they could read), so nothing pinned the parts a capability
// actually depends on — level filtering, scope composition, the record shape a sink
// receives, the stderr line format, or the env/level resolution. A logging bug is
// invisible by nature (missing diagnostics, or noise), which is exactly why the
// contract belongs in a file of its own.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createLogger, isLogLevel, stderrSink, type LogRecord } from '../packages/base/log/src/index.ts'
import * as log from '../packages/base/log/src/index.ts'

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** Collect records from a logger (the sink the composition layer would install). */
function collect(): { records: LogRecord[]; sink: (r: LogRecord) => void } {
  const records: LogRecord[] = []
  return { records, sink: (r) => records.push(r) }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['MEDIABASE_LOG_LEVEL']
})

describe('@mediabase/log: levels', () => {
  it('accepts exactly the four levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) expect(isLogLevel(level)).toBe(true)
    for (const other of ['trace', 'WARN', '', undefined, null, 1, {}]) expect(isLogLevel(other)).toBe(false)
  })

  it('drops everything below the configured level, and nothing at or above it', () => {
    const cases: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; expected: string[] }> = [
      { level: 'debug', expected: ['debug', 'info', 'warn', 'error'] },
      { level: 'info', expected: ['info', 'warn', 'error'] },
      { level: 'warn', expected: ['warn', 'error'] },
      { level: 'error', expected: ['error'] },
    ]
    for (const c of cases) {
      const { records, sink } = collect()
      const logger = createLogger({ level: c.level, sink })
      logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e')
      expect(records.map((r) => r.level), `level=${c.level}`).toEqual(c.expected)
    }
  })

  it('changes level live, so a runtime switch needs no restart', () => {
    const { records, sink } = collect()
    const logger = createLogger({ level: 'info', sink })
    expect(logger.level()).toBe('info')
    logger.debug('noisy')
    logger.setLevel('debug')
    expect(logger.level()).toBe('debug')
    logger.debug('now visible')
    expect(records.map((r) => r.msg)).toEqual(['now visible'])
  })

  it('defaults to info', () => {
    const { records, sink } = collect()
    const logger = createLogger({ sink })
    logger.debug('hidden'); logger.info('shown')
    expect(records.map((r) => r.msg)).toEqual(['shown'])
  })
})

describe('@mediabase/log: scope', () => {
  it('composes child markers onto the root scope', () => {
    const { records, sink } = collect()
    const logger = createLogger({ level: 'debug', sink })
    logger.info('root')
    logger.child('media').info('one level')
    logger.child('media').child('play').info('two levels')
    // No app name in the base: the DEFAULT scope is neutral, and a composition states the
    // app's own (`scope: !!js ctx.appPaths.bin` → `avstudio`, `mediabase`, …).
    expect(records.map((r) => r.scope)).toEqual(['mediabase', 'mediabase.media', 'mediabase.media.play'])
  })

  it('honours a custom root scope, and an empty root produces the child name alone', () => {
    const first = collect()
    createLogger({ level: 'debug', sink: first.sink, scope: 'engine' }).child('decoder').info('x')
    expect(first.records[0]?.scope).toBe('engine.decoder')

    const second = collect()
    createLogger({ level: 'debug', sink: second.sink, scope: '' }).child('bare').info('x')
    expect(second.records[0]?.scope).toBe('bare')
  })

  it('keeps children independent of later level changes (they share the service)', () => {
    const { records, sink } = collect()
    const logger = createLogger({ level: 'warn', sink })
    const child = logger.child('a')
    child.info('dropped')
    logger.setLevel('debug')
    child.info('kept')
    expect(records.map((r) => r.msg)).toEqual(['kept'])
  })
})

describe('@mediabase/log: the record a sink receives', () => {
  it('is structured and complete', () => {
    const { records, sink } = collect()
    const logger = createLogger({ level: 'debug', sink, scope: 'mediabase' })
    logger.warn('engine slow', { ms: 12, bin: 'engine' })

    const record = records[0]!
    expect(record.level).toBe('warn')
    expect(record.scope).toBe('mediabase')
    expect(record.msg).toBe('engine slow')
    expect(record.data).toEqual({ ms: 12, bin: 'engine' })
    // ISO-8601 so a log file sorts and parses without a locale guess.
    expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('omits `data` entirely when there is none, and passes the object through untouched', () => {
    const { records, sink } = collect()
    const logger = createLogger({ level: 'debug', sink })
    logger.info('no data')
    expect('data' in records[0]!).toBe(false)

    const payload = { nested: { deep: true } }
    logger.info('with data', payload)
    // Same reference: the sink decides what to do with it (forward, redact, drop), so the
    // logger must not copy or reshape it.
    expect(records[1]?.data).toBe(payload)
  })
})

describe('@mediabase/log: the stderr sink', () => {
  const captured = (): { lines: string[]; restore: () => void } => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk))
      return true
    })
    return { lines, restore: () => spy.mockRestore() }
  }

  const record = (over: Partial<LogRecord> = {}): LogRecord => ({
    time: '2026-09-12T00:00:00.000Z',
    level: 'info',
    scope: 'mediabase.media',
    msg: 'ready',
    ...over,
  })

  it('writes one line per record, with the level padded and the data as JSON', () => {
    const { lines, restore } = captured()
    try {
      stderrSink(true)(record({ data: { fps: 15 } }))
      expect(lines[0]).toBe('2026-09-12T00:00:00.000Z INFO  mediabase.media ready {"fps":15}\n')
    } finally {
      restore()
    }
  })

  it('can drop the timestamp, and omits the data tail when there is none', () => {
    const { lines, restore } = captured()
    try {
      const sink = stderrSink(false)
      sink(record())
      sink(record({ level: 'error', msg: 'boom' }))
      expect(lines[0]).toBe('INFO  mediabase.media ready\n')
      expect(lines[1]).toBe('ERROR mediabase.media boom\n')
    } finally {
      restore()
    }
  })

  it('writes to stderr, not stdout (stdout stays clean for the CLI/UX)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      stderrSink()(record())
      expect(err).toHaveBeenCalledTimes(1)
      expect(out).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('@mediabase/log: the plugin and its config', () => {
  it('takes the level from config, and defaults to info', async () => {
    const ctx = new Context()
    ctx.plugin(log, { level: 'error', sink: () => {} })
    await settle()
    expect(ctx.get('log')?.level()).toBe('error')
    await ctx.fiber.dispose()

    // No environment read here ON PURPOSE: a base package must not know a product's prefix.
    // The composition row reads `LOG_LEVEL` through `ctx.env.choice(...)`, which turns an
    // unrecognized value into the schema default instead of a boot failure — that reader is
    // what used to be tested here, and it is tested where it lives (tests/compose-yml.test.ts).
    const plain = new Context()
    plain.plugin(log, { sink: () => {} })
    await settle()
    expect(plain.get('log')?.level()).toBe('info')
    await plain.fiber.dispose()
  })

  it('routes records to the configured sink with the configured scope, and children derive from it', async () => {
    const records: LogRecord[] = []
    const ctx = new Context()
    ctx.plugin(log, { level: 'debug', sink: (r) => records.push(r), scope: 'engine' })
    await settle()
    const service = ctx.get('log')
    if (!service) throw new Error('ctx.log missing')
    service.child('decoder').info('frame decoded', { n: 1 })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ scope: 'engine.decoder', msg: 'frame decoded', data: { n: 1 } })
  })

  it('unregisters with the fiber (no logger outlives its plugin)', async () => {
    const ctx = new Context()
    ctx.plugin(log, { sink: () => {} })
    await settle()
    expect(ctx.get('log')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('log')).toBeUndefined()
  })
})
