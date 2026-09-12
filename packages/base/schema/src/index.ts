// @mediabase/schema — avstudio's schema dialect (neutral base, no domain, no cordis).
//
// One schema language for every boundary that used to take `unknown` + an `as`
// assertion: plugin Config, RPC/api method params, tool arguments, settings
// values. The dialect is DSH's `@deepseek-ai/schemastery`; this package adds the
// two things the rest of the codebase needs around it:
//
//   parse()        validate at the boundary and fail with a path-carrying error
//   toJsonSchema() bridge to the JSON-Schema subset the LLM function-calling API
//                  requires (so a tool declares params ONCE, validated here and
//                  described to the model there)

import z from '@deepseek-ai/schemastery'

export { z }

/** A schema: `In` is what callers may pass, `Out` is what validation returns. */
export type Schema<In = unknown, Out = In> = Schemastery<In, Out>

/** Value type produced by a schema (schemastery's TypeT). */
export type Infer<S> = Schemastery.TypeT<S>

/** JSON Schema subset — enough for OpenAI-compatible function declarations. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  additionalProperties?: boolean | JsonSchema
  anyOf?: JsonSchema[]
}

/** Validation failure with the offending path, so callers can report precisely. */
export class SchemaError extends Error {
  readonly path: (string | number)[]

  constructor(message: string, path: (string | number)[] = []) {
    super(message)
    this.name = 'SchemaError'
    this.path = path
  }
}

/**
 * Validate `data` against `schema`, returning the normalized value (defaults
 * filled). `label` prefixes the error message with the boundary being validated
 * (e.g. "media.play 参数"), which is what a user sees in the UI error line.
 */
export function parse<T>(schema: Schema<any, T>, data: unknown, label?: string): T {
  try {
    return schema(data) as T
  } catch (e) {
    const err = e as { message?: string; options?: { path?: (string | number)[] } }
    const path = Array.isArray(err.options?.path) ? err.options.path : []
    const where = path.length > 0 ? ` @ ${path.map(String).join('.')}` : ''
    const prefix = label !== undefined && label !== '' ? `${label}: ` : ''
    const raw = typeof err.message === 'string' ? err.message : String(e)
    // schemastery already prefixes the path ("$.file expected string"); keep the
    // message readable instead of printing the same path twice.
    throw new SchemaError(`${prefix}${raw}${where}`, path)
  }
}

function isEmptyRecord(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0
}

/** Human/TS-readable signature of a schema (schemastery's own toString). */
export function describe(schema: Schema<any, any>): string {
  return schema.toString()
}

/**
 * Convert a schema to the JSON-Schema subset used by function-calling tool
 * declarations. Only the types avstudio declares are handled; anything unknown
 * degrades to a bare `{}` (the model still sees the description).
 */
export function toJsonSchema(schema: Schema<any, any>): JsonSchema {
  const meta = schema.meta as { description?: string; default?: unknown; required?: boolean }
  const out: JsonSchema = {}
  const nodeType = (schema as unknown as { type: string }).type
  // schemastery gives objects/dicts/arrays an implicit empty-container default;
  // it says nothing about the caller's intent, so it does not reach the model.
  const implicit = meta.default === undefined
    || ((nodeType === 'object' || nodeType === 'dict') && isEmptyRecord(meta.default))
    || (nodeType === 'array' && Array.isArray(meta.default) && meta.default.length === 0)
  if (meta.description !== undefined) out.description = meta.description
  if (meta.default !== undefined && !implicit) out.default = meta.default
  const node = schema as unknown as {
    type: string
    value?: unknown
    list?: Schema<unknown, unknown>[]
    inner?: Schema<unknown, unknown>
    dict?: Record<string, Schema<unknown, unknown>>
  }
  switch (node.type) {
    case 'string':
      out.type = 'string'
      break
    case 'number':
      out.type = 'number'
      break
    case 'boolean':
      out.type = 'boolean'
      break
    case 'const':
      // A single const is an enum of one; a const-only union (see below) folds
      // into a proper enum.
      out.enum = [node.value]
      break
    case 'array':
      out.type = 'array'
      out.items = node.inner ? toJsonSchema(node.inner) : {}
      break
    case 'object': {
      out.type = 'object'
      out.properties = {}
      const required: string[] = []
      for (const [key, prop] of Object.entries(node.dict ?? {})) {
        out.properties[key] = toJsonSchema(prop)
        if ((prop.meta as { required?: boolean }).required === true) required.push(key)
      }
      if (required.length > 0) out.required = required
      break
    }
    case 'dict':
      out.type = 'object'
      out.additionalProperties = node.inner ? toJsonSchema(node.inner) : true
      break
    case 'union': {
      const members = node.list ?? []
      const enumValues: unknown[] = []
      for (const m of members) {
        if ((m as unknown as { type: string }).type === 'const') enumValues.push((m as unknown as { value: unknown }).value)
      }
      if (enumValues.length === members.length && members.length > 0) out.enum = enumValues
      else out.anyOf = members.map((m) => toJsonSchema(m))
      break
    }
    default:
      break
  }
  return out
}
