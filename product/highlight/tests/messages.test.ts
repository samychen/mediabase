// The panel's copy — checked where nobody looks.
//
// Two failures are invisible in a browser until a user hits them: a key present in
// zh-CN and missing in en (the UI then prints `vhl.control.degraded.numpy-missing`
// at the operator), and a degradation code with no sentence of its own (the panel
// falls back to wording that names no cause, which is the whole reason the codes
// exist). The engine's codes are the contract — `opencv_issue()` in vhl_bridge.py.

import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_MESSAGES, degradedKey, degradedText } from '../packages/client/panel/src/messages.ts'
import contract from '../protocol/contract.json'

/** Every code `opencv_issue()` can send while degraded. */
const DEGRADATION_CODES = ['opencv-missing', 'numpy-missing', 'opencv-import-failed'] as const

const copy = (locale: 'zh-CN' | 'en'): Record<string, string> =>
  HIGHLIGHT_MESSAGES[locale] as unknown as Record<string, string>

describe('panel copy', () => {
  it('both locales carry the same keys', () => {
    // Not a style rule: `t()` falls back to the ACTIVE locale, then the fallback
    // locale, then the key itself. A key only in zh-CN prints as a key on an
    // English page.
    expect(Object.keys(copy('zh-CN')).sort()).toEqual(Object.keys(copy('en')).sort())
  })

  it('every option the advanced panel renders has a label in both locales', () => {
    // The panel labels each row with `t('vhl.opt.<key>')`. A contract option added
    // without a message entry prints the RAW KEY at the operator (contentPreset /
    // adaptiveWeights did exactly this before their labels were added) — invisible
    // to the parity test above, which only checks zh-CN and en agree, not that the
    // option is covered. Mirror the panel's filter (control.tsx): the five groups,
    // minus the two quick controls and the automation-only SRT path.
    const groups = ['analysis', 'scoring', 'selection', 'text', 'output']
    const quick = new Set(['maxHighlights', 'clipDurationSec', 'srtPath'])
    const options = contract.options as Record<string, { group?: string } | string>
    for (const [key, meta] of Object.entries(options)) {
      if (typeof meta !== 'object' || meta === null) continue // `comment` is metadata
      if (!groups.includes(meta.group ?? '') || quick.has(key)) continue
      const labelKey = `vhl.opt.${key}`
      expect(copy('zh-CN')[labelKey], `zh-CN ${labelKey}`).toBeTruthy()
      expect(copy('en')[labelKey], `en ${labelKey}`).toBeTruthy()
    }
  })

  it('every degradation code has its own sentence, in both locales', () => {
    for (const code of DEGRADATION_CODES) {
      const key = degradedKey(code)
      // The specific key, not the generic one: `degradedKey` silently falling back
      // for a code it should know is exactly the regression this catches.
      expect(key, code).toBe(`vhl.control.degraded.${code}`)
      expect(copy('zh-CN')[key], `zh-CN ${key}`).toBeTruthy()
      expect(copy('en')[key], `en ${key}`).toBeTruthy()
    }
    // Every specific key also has the generic one beside it, or the fallback path
    // prints a raw key.
    expect(copy('zh-CN')['vhl.control.degraded']).toBeTruthy()
    expect(copy('en')['vhl.control.degraded']).toBeTruthy()
  })

  it('an unknown code falls back to wording that names no cause', () => {
    // A new engine code reaching an old panel must not be translated into a GUESS.
    // "not installed" on a machine that has OpenCV sends the operator to install
    // what is already there — the bug these codes were added to fix.
    expect(degradedKey('something-the-engine-added-later')).toBe('vhl.control.degraded')
    expect(degradedKey('')).toBe('vhl.control.degraded')
    for (const locale of ['zh-CN', 'en'] as const) {
      const fallback = copy(locale)['vhl.control.degraded']!
      expect(fallback).not.toMatch(/未安装|未装|not installed/)
    }
  })

  it('names the interpreter when one is reported', () => {
    // The fact is about an INTERPRETER, not the machine. A laptop with three
    // Pythons has OpenCV in one of them, so "OpenCV not installed" sends the
    // operator to install it again — into whichever interpreter is first on
    // PATH, which is not the one that reported the problem.
    for (const code of DEGRADATION_CODES) {
      const { key, params } = degradedText(code, '/usr/bin/python3')
      expect(key, code).toBe(`vhl.control.degraded.${code}.interpreter`)
      expect(params?.interpreter, code).toBe('/usr/bin/python3')
      for (const locale of ['zh-CN', 'en'] as const) {
        const sentence = copy(locale)[key]
        expect(sentence, `${locale} ${key}`).toBeTruthy()
        // The interpreter must be substitutable into the sentence, not appended
        // as a separate label: a bare path beside the message reads as a
        // footnote, and the reader's eye goes to the cause first.
        expect(sentence, `${locale} ${key}`).toContain('{interpreter}')
      }
    }
  })

  it('falls back to the cause-only sentence when no interpreter is reported', () => {
    // An older engine sends no interpreter. The code-only sentence is still
    // better than a key, but it must not gain a dangling placeholder.
    for (const code of DEGRADATION_CODES) {
      const { key, params } = degradedText(code, '')
      expect(key, code).toBe(`vhl.control.degraded.${code}`)
      expect(params, code).toBeUndefined()
    }
  })

  it('the generic fallback also has an interpreter variant', () => {
    // An unknown code with a known interpreter still names the interpreter.
    const { key, params } = degradedText('something-new', '/opt/py')
    expect(key).toBe('vhl.control.degraded.interpreter')
    expect(params?.interpreter).toBe('/opt/py')
    expect(copy('zh-CN')[key]).toBeTruthy()
    expect(copy('en')[key]).toBeTruthy()
  })
})
