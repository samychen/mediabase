// The deployment vocabulary has exactly ONE prefix.
//
// The base is adopted by other products, so nothing inside it may hardcode a product name:
// the boot identity decides the prefix, `ctx.env` resolves short row names through it, and
// the two base capabilities that read the environment themselves (the plugin manager's
// sandbox entry and demo catalog) receive it through their `Config`.
//
// This suite is the invariant's end-to-end proof: swapping the prefix must move the WHOLE
// vocabulary at once, and the previous one must stop being read — "accept both" is how one of
// them silently rots, which is why the design forbids it.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootHost, expectError } from './support/host.ts'

/** A prefix that is not this application's, to prove the swap is wholesale. */
const OTHER = 'EXPT_'

describe('the deployment vocabulary', () => {
  it('moves as ONE vocabulary when the prefix is swapped, and stops reading the old one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mediabase-prefix-'))
    const host = await bootHost({
      // `MEDIABASE_ENV_PREFIX` is the identity override the boot reads before anything else.
      MEDIABASE_ENV_PREFIX: OTHER,
      // The new vocabulary, by SHORT name behind the swapped prefix…
      [`${OTHER}HOME`]: home,
      [`${OTHER}READONLY`]: '1',
      // …and the previous one, which must NOT be consulted: `0` here would disable the very
      // policy the new vocabulary asks for.
      MEDIABASE_READONLY: '0',
    })
    try {
      // The policy the ROW built from the swapped environment is the policy in force.
      const info = await host.rpc.call<{ acl?: Record<string, unknown> }>('server.info', {})
      expect(info.acl).toEqual({ readonly: true })
      const denied = await expectError(host.rpc, 'settings.set', { key: 'locale', value: 'en' })
      expect(denied.code).toBe(-32021)
      expect(denied.messageKey).toBe('error.acl.readonly')

      // The app keeps its identity (name, home) — only the vocabulary moved.
      expect(host.output()).toContain('"组合":"patch 层"')
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('keeps the app its own name when nothing overrides the prefix', async () => {
    // The default path: this repo uses `MEDIABASE_*` so every documented variable,
    // operator shell profile and CI step matches the boot identity.
    const host = await bootHost({ MEDIABASE_READONLY: '1' })
    try {
      const info = await host.rpc.call<{ acl?: Record<string, unknown> }>('server.info', {})
      expect(info.acl).toEqual({ readonly: true })
    } finally {
      await host.stop()
    }
  }, 120_000)
})
