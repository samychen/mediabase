// The panel formatters. Date cases build their expectations from a LOCAL
// Date round-tripped through toISOString, so they pass in any timezone.

import { describe, expect, it } from 'vitest'
import { fmtClock, fmtDay, fmtDur } from '../packages/client/console/src/format.ts'

const local = new Date(2026, 8, 26, 4, 49, 51) // 2026-09-26 04:49:51 local
const iso = local.toISOString()

describe('fmtDay / fmtClock', () => {
  it('render the local day and clock time of an RFC3339 timestamp', () => {
    expect(fmtDay(iso)).toBe('2026-09-26')
    expect(fmtClock(iso)).toBe('04:49:51')
  })

  it('pass unparseable timestamps through instead of showing NaN', () => {
    expect(fmtDay('garbage')).toBe('garbage')
    expect(fmtClock('')).toBe('')
  })
})

describe('fmtDur', () => {
  it('scales seconds → m:ss → h:mm:ss', () => {
    expect(fmtDur(9.978)).toBe('10s')
    expect(fmtDur(59.4)).toBe('59s')
    expect(fmtDur(60)).toBe('1:00')
    expect(fmtDur(303)).toBe('5:03')
    expect(fmtDur(3723)).toBe('1:02:03')
  })

  it('refuses nonsense', () => {
    expect(fmtDur(Number.NaN)).toBe('—')
    expect(fmtDur(-5)).toBe('—')
  })
})
