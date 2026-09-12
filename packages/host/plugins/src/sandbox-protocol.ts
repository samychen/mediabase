// @mediabase/plugins / sandbox-protocol.ts — the wire contract between the host and a
// SANDBOXED plugin process.
//
// A sandboxed plugin never sees a host object. The only things that cross this
// boundary are structured-cloneable messages: service method calls (declared
// services only, enforced host-side), log records, events, and API replies. That
// is what makes the isolation meaningful — the child cannot reach the host's ctx,
// its services, or another plugin's memory, no matter what it does.
//
// Message shapes are shared with the child entry (`sandbox/entry.ts`), which
// imports them type-only so the compiled sandbox bundle has no runtime deps.

/** Methods a sandboxed plugin may expose to the host (`plugins.call`). */
export interface SandboxApiDescriptor {
  methods: Array<{ name: string; description?: string }>
}

export type SandboxHostMessage =
  /** Host → child: start, with the module path and what may be consumed. */
  | { t: 'init'; module: string; requires: readonly string[]; config?: unknown; instanceId: string }
  /** Host → child: settle a service call. */
  | { t: 'result'; id: number; value?: unknown; error?: SerializedError }
  /** Host → child: an event the plugin subscribed to (by name). */
  | { t: 'event'; name: string; payload: unknown }
  /** Host → child: run cleanups and exit. */
  | { t: 'dispose' }

export type SandboxChildMessage =
  /** Child → host: module imported and apply() finished. */
  | { t: 'ready'; api?: SandboxApiDescriptor }
  /** Child → host: apply() threw (or the module could not be imported). */
  | { t: 'error'; message: string; stack?: string }
  /** Child → host: call a method on a DECLARED service. */
  | { t: 'call'; id: number; service: string; method: string; args: unknown[] }
  /** Child → host: log through ctx.log. */
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }
  /** Child → host: emit on the host event bus. */
  | { t: 'emit'; name: string; payload: unknown }
  /** Child → host: subscribe (so the host only forwards what is wanted). */
  | { t: 'subscribe'; name: string }
  /** Child → host: answer an `invoke`. */
  | { t: 'invoke-result'; id: number; value?: unknown; error?: SerializedError }
  /** Child → host: cleanups finished; safe to exit. */
  | { t: 'disposed' }

/**
 * Errors cross the boundary as plain data (no Error objects over IPC).
 *
 * `code` travels so the host can report the failure the plugin meant (NOT_FOUND vs
 * INTERNAL); `messageKey`/`messageParams` travel so a localized message survives the
 * boundary too. Both are optional: a plugin that throws a plain Error has neither, and
 * the host falls back to the prose — which is exactly the honest outcome.
 */
export interface SerializedError {
  message: string
  code?: number
  messageKey?: string
  messageParams?: Record<string, string | number>
  stack?: string
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    const coded = e as { code?: unknown; messageKey?: unknown; messageParams?: unknown }
    const out: SerializedError = { message: e.message }
    if (typeof coded.code === 'number') out.code = coded.code
    if (typeof coded.messageKey === 'string') out.messageKey = coded.messageKey
    if (coded.messageParams !== undefined && typeof coded.messageParams === 'object' && coded.messageParams !== null) {
      out.messageParams = coded.messageParams as Record<string, string | number>
    }
    if (e.stack !== undefined) out.stack = e.stack
    return out
  }
  return { message: String(e) }
}

/** The subset of the host IPC channel both sides need (easier to fake in tests). */
export interface IpcEndpoint {
  send(message: SandboxHostMessage | SandboxChildMessage): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'disconnect' | 'error', listener: () => void): void
}
