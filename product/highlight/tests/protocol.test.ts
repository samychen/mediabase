// The verb table, and the guard that keeps a verb from being invented.
//
// Reported from a session: `[-32602] highlight: 未知动词: nalyze.status`. That
// line came from the ENGINE, about a verb it implements, and could not be acted
// on — nothing in it shows the string is 13 characters where `analyze.status` is
// 14, and nothing says who refused. The host owns the contract, so it is the side
// that must answer; these pin the two halves of that: every constant maps onto a
// declared verb, and anything else is refused HERE, quoted and counted.

import { describe, expect, it } from 'vitest'
import { VERB, VERB_NAMES, isKnownVerb, unknownVerbMessage } from '../packages/host/highlight/src/protocol.ts'

describe('the verb table', () => {
  it('maps every constant onto a verb the contract declares', () => {
    for (const verb of Object.values(VERB)) expect(VERB_NAMES).toContain(verb)
    // No duplicates either: a constant pointing at another verb's string would
    // still pass the line above while making one verb unreachable.
    expect(new Set(Object.values(VERB)).size).toBe(Object.values(VERB).length)
  })

  it('knows the wire verbs and nothing else', () => {
    expect(isKnownVerb('analyze.status')).toBe(true)
    expect(isKnownVerb('quit')).toBe(true)
    // The near miss from the report, and the RPC method name that is NOT a verb:
    // the two layers name different things and a caller that confuses them gets a
    // sentence saying so instead of an engine refusal.
    expect(isKnownVerb('nalyze.status')).toBe(false)
    expect(isKnownVerb('analyze.status'.slice(1))).toBe(false)
    expect(isKnownVerb('highlight.status')).toBe(false)
    expect(isKnownVerb('')).toBe(false)
  })

  it('quotes and counts the verb it refuses', () => {
    const verb = 'analyze.status'.slice(1)
    const text = unknownVerbMessage(verb)
    // Quoted: an invisible leading character or a truncation is visible in the
    // report instead of being silently normalised away by the reader's eyes.
    expect(text).toContain(`'${verb}'`)
    expect(text).toContain(`(${verb.length} 字符)`)
    // And it must not be readable as the engine's sentence: the engine implements
    // `analyze.status`, so blaming it sends the reader to the wrong process.
    expect(text).toContain('contract')
    expect(text).toContain('宿主拒绝发送')
    expect(text).not.toContain('本引擎支持')
  })

  it('says how many verbs the contract has', () => {
    expect(unknownVerbMessage('nope')).toContain(`共 ${VERB_NAMES.length} 个`)
  })
})
