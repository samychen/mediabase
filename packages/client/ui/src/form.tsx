// @mediabase/ui / form.tsx — build a form from a JSON Schema.
//
// A capability publishes its API params as JSON Schema (see ctx.api). That is
// enough to render an input form without the capability shipping any UI: the API
// console panel uses this, and any tooling can reuse it. Only the subset the
// schema bridge (@mediabase/schema) actually emits is handled; anything richer
// degrades to a JSON textarea instead of silently dropping the field.

import { createElement } from 'react'
import type { ChangeEvent, ReactNode } from 'react'

/** The subset of JSON Schema these helpers understand (see @mediabase/schema). */
export interface JsonSchemaLike {
  type?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  items?: JsonSchemaLike
  additionalProperties?: boolean | JsonSchemaLike
  anyOf?: JsonSchemaLike[]
}

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'

/** Keys the form emits; panels translate them (see @mediabase/i18n core dictionary
 *  for `form.*`, and the API console for the call status lines). */

/** A validation failure: a translation key + params, never a pre-rendered string. */
export interface FieldError {
  key: string
  params?: Record<string, string | number>
}

export interface FormField {
  name: string
  kind: FieldKind
  required: boolean
  description?: string
  defaultValue?: unknown
  /** Allowed values for `enum` fields. */
  options?: unknown[]
}

/** One field per declared property; unknown shapes become a JSON textarea. */
export function fieldsFromSchema(schema: JsonSchemaLike | undefined): FormField[] {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  return Object.entries(properties).map(([name, prop]) => {
    const field: FormField = {
      name,
      kind: kindOf(prop),
      required: required.has(name),
    }
    if (prop.description !== undefined) field.description = prop.description
    if (prop.default !== undefined) field.defaultValue = prop.default
    if (prop.enum !== undefined) field.options = prop.enum
    return field
  })
}

function kindOf(prop: JsonSchemaLike): FieldKind {
  if (prop.enum !== undefined) return 'enum'
  // A union of consts arrives as anyOf; treat it as a choice too.
  const consts = prop.anyOf?.filter((m) => m.enum !== undefined).flatMap((m) => m.enum ?? [])
  if (consts !== undefined && consts.length > 0 && consts.length === (prop.anyOf?.length ?? 0)) return 'enum'
  switch (prop.type) {
    case 'number':
      return 'number'
    case 'integer':
      return 'integer'
    case 'boolean':
      return 'boolean'
    case 'array':
      return prop.items?.type === 'string' || prop.items?.type === undefined ? 'json' : 'json'
    case 'object':
      return 'json'
    default:
      return 'string'
  }
}

/** Initial editor values: schema defaults, so the form starts callable. */
export function initialValues(fields: readonly FormField[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    const fallback = field.defaultValue
    values[field.name] = fallback === undefined || fallback === null
      ? ''
      : typeof fallback === 'object' ? JSON.stringify(fallback) : String(fallback)
  }
  return values
}

/**
 * Turn editor strings into the JSON the RPC layer expects: numbers become
 * numbers, booleans become booleans, empty optional fields disappear (so schema
 * defaults apply on the host), and JSON fields are parsed (or reported).
 */
export function valuesFromFields(
  fields: readonly FormField[],
  values: Record<string, string>,
): { params: Record<string, unknown>; errors: FieldError[] } {
  const params: Record<string, unknown> = {}
  const errors: FieldError[] = []
  for (const field of fields) {
    const raw = values[field.name] ?? ''
    if (raw.trim() === '') continue // omit: the host schema fills defaults
    switch (field.kind) {
      case 'number':
      case 'integer': {
        const n = Number(raw)
        if (!Number.isFinite(n)) errors.push({ key: 'form.needsNumber', params: { field: field.name } })
        else params[field.name] = field.kind === 'integer' ? Math.trunc(n) : n
        break
      }
      case 'boolean':
        params[field.name] = raw === 'true'
        break
      case 'enum': {
        const match = (field.options ?? []).find((o) => String(o) === raw)
        params[field.name] = match === undefined ? raw : match
        break
      }
      case 'json':
        try {
          params[field.name] = JSON.parse(raw)
        } catch {
          errors.push({ key: 'form.badJson', params: { field: field.name } })
        }
        break
      default:
        params[field.name] = raw
    }
  }
  return { params, errors }
}

export interface SchemaFormProps {
  fields: readonly FormField[]
  values: Record<string, string>
  onChange(name: string, value: string): void
  /** Optional translator; defaults to the identity (keys shown as-is). */
  t?(key: string): string
  disabled?: boolean
}

/** Minimal, dependency-free form renderer (no form library, no styling system). */
export function SchemaForm({ fields, values, onChange, t, disabled }: SchemaFormProps): ReactNode {
  const label = (field: FormField): string => {
    const base = field.description !== undefined && field.description !== ''
      ? field.description
      : t !== undefined ? t(`field.${field.name}`) : field.name
    return field.required ? `${base} *` : base
  }

  return createElement(
    'div',
    null,
    ...fields.map((field) => {
      const value = values[field.name] ?? ''
      const common = {
        value,
        disabled: disabled === true,
        'aria-label': field.name,
        onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
          onChange(field.name, e.target.value),
      }
      const input =
        field.kind === 'boolean'
          ? createElement('select', { ...common, key: 'i' }, [
              createElement('option', { key: 'any', value: '' }, '—'),
              createElement('option', { key: 'true', value: 'true' }, 'true'),
              createElement('option', { key: 'false', value: 'false' }, 'false'),
            ])
          : field.kind === 'enum'
            ? createElement('select', { ...common, key: 'i' }, [
                createElement('option', { key: 'any', value: '' }, '—'),
                ...(field.options ?? []).map((option, i) =>
                  createElement('option', { key: `${String(option)}-${i}`, value: String(option) }, String(option))),
              ])
            : field.kind === 'json'
              ? createElement('textarea', { ...common, key: 'i', rows: 2, placeholder: 'JSON' })
              : createElement('input', {
                  ...common,
                  key: 'i',
                  type: field.kind === 'string' ? 'text' : 'number',
                  placeholder: field.name,
                })
      return createElement(
        'div',
        { key: field.name },
        createElement('label', { htmlFor: field.name }, label(field)),
        input,
      )
    }),
  )
}
