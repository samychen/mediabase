// @vitest-environment jsdom
//
// The API console form helpers: fields come from the schema (types, required marker,
// defaults, enums), coerced values are RPC-ready, and empty optionals are omitted.
// Panel packaging lives in a product UI package; this suite only covers the base
// schema→form bridge in `@mediabase/ui`.

import { describe, expect, it } from 'vitest'
import { fieldsFromSchema, initialValues, valuesFromFields } from '../packages/client/ui/src/form.tsx'

/** A representative schema shape capabilities publish for console forms. */
const DECODE_SCHEMA = {
  type: 'object',
  properties: {
    file: { description: '媒体文件绝对路径', type: 'string' },
    time: { description: '解码时间点(秒)', default: 0, type: 'number' },
    mode: { enum: ['fast', 'slow'] },
    nested: { type: 'object' },
  },
  required: ['file'],
}

describe('JSON Schema → form fields', () => {
  it('maps types, required markers, defaults and enums', () => {
    const fields = fieldsFromSchema(DECODE_SCHEMA)
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['file', 'string', true],
      ['time', 'number', false],
      ['mode', 'enum', false],
      ['nested', 'json', false],
    ])
    expect(fields[1]?.defaultValue).toBe(0)
    expect(fields[2]?.options).toEqual(['fast', 'slow'])
    expect(initialValues(fields)).toEqual({ file: '', time: '0', mode: '', nested: '' })
  })

  it('coerces editor strings into RPC-ready values and omits empties', () => {
    const fields = fieldsFromSchema(DECODE_SCHEMA)
    const { params, errors } = valuesFromFields(fields, { file: 'a.mp4', time: '1.5', mode: 'slow', nested: '{"k":1}' })
    expect(params).toEqual({ file: 'a.mp4', time: 1.5, mode: 'slow', nested: { k: 1 } })
    expect(errors).toEqual([])

    // empty optional fields disappear so the host schema applies its defaults
    expect(valuesFromFields(fields, { file: 'a.mp4' }).params).toEqual({ file: 'a.mp4' })
    // and a bad value is reported instead of being sent
    const bad = valuesFromFields(fields, { file: 'a.mp4', time: 'soon', nested: '{oops' })
    // errors are KEYS (+ params), never pre-rendered text: the panel translates
    expect(bad.errors).toEqual([
      { key: 'form.needsNumber', params: { field: 'time' } },
      { key: 'form.badJson', params: { field: 'nested' } },
    ])
  })

  it('handles a method with no parameters', () => {
    expect(fieldsFromSchema(undefined)).toEqual([])
    expect(fieldsFromSchema({ type: 'object', properties: {} })).toEqual([])
  })
})
