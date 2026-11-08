// The panel's copy — checked where nobody looks.
//
// Two failures are invisible in a browser until a user hits them: a key present in
// zh-CN and missing in en (the UI then prints `vhl.control.degraded.numpy-missing`
// at the operator), and a degradation code with no sentence of its own (the panel
// falls back to wording that names no cause, which is the whole reason the codes
// exist). The engine's codes are the contract — `opencv_issue()` in vhl_bridge.py.

import { describe, expect, it } from 'vitest'
import { HIGHLIGHT_MESSAGES, degradedKey } from '../packages/client/panel/src/messages.ts'

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
})
