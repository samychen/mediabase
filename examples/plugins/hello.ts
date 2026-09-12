// examples/plugins/hello.ts
//
// A dynamically loadable plugin (catalog entry of @mediabase/plugins).
// Deliberately imports nothing: it only needs the part of the cordis context it
// touches, declared structurally so the file runs under tsx with no workspace
// resolution from this directory.

/** Structural view of ctx used here (cordis Context satisfies it). */
interface MiniContext {
  reflect: {
    provide(name: string, value: unknown): unknown
  }
  effect(fn: () => unknown): unknown
}

export const name = 'hello'

export function apply(ctx: MiniContext): void {
  const state = { loads: 0 }
  state.loads += 1
  // lifecycle: keep a counter alive only while this plugin's fiber is loaded
  ctx.effect(() => () => {
    state.loads = 0
  })
  ctx.reflect.provide('hello', {
    greet: (who: string): string => `hello, ${who}! (load #${state.loads})`,
    loads: () => state.loads,
  })
}
