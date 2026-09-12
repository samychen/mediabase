# Note: the UI panel registry is reactive, and owns the shared panel-state contract

Status: implemented (2026-xx)

## Decision 1 — `ctx.ui` notifies, the shell subscribes

**Problem.** The shell mounted once and read `ctx.ui.list(area)` during render. A
panel registered *after* mount (a UI package loaded at runtime through
`ctx.plugins`, a reload) never appeared until a page refresh.

**Options considered.**
1. Keep registration-time-only rendering and require every UI package to be
   composed before the shell. Simple, but it quietly makes "everything is a
   plugin" false for UI: composition order would decide what is visible, and the
   runtime plugin manager could never ship UI.
2. Expose a subscription. `subscribe(listener)` + `revision()`, consumed by the
   shell with `useSyncExternalStore`.

**Chosen:** option 2. It is the same shape every external store uses, it keeps
`@mediabase/ui` React-free (the hook lives in the shell, not the registry), and it
costs one counter. `list()` still returns a fresh array, so the shell caches a
snapshot keyed by `area:revision` — `getSnapshot` must be referentially stable or
React re-renders forever.

**Also decided:** fiber dispose clears the registry *and* announces the change,
so a mounted shell re-renders to the empty state instead of keeping panels from a
dead registry. The alternative (silent clear) leaves a stale UI that no consumer
can notice.

Evidence: `tests/ui-registry.test.ts` (revision/notify semantics) and
`tests/ui-shell.test.tsx` (late registration renders; neutering `subscribe` makes
those cases fail — verified by temporarily stubbing it).

## Decision 2 — the shared panel state contract lives in `@mediabase/ui`

`ViewState`/`ctx.view` (current file, size, duration) is read by panels in
several packages. When the contract lived in the *providing* capability package
(`@avstudio/ui-media`), every other UI package had to depend on that capability
just to type `ctx.get('view')` — capability coupling through types, which is
exactly what route B/C tries to remove. `ui-panels` no longer depends on
`@avstudio/ui-media`.

The contract sits with the registry because the registry is the shared UI seam;
`ui` still never provides the value. Runtime honesty is preserved the cordis way:
read with `ctx.get('view')` and tolerate `undefined`, since the providing
capability may not be composed.

## Decision 3 — the connection badge is a panel, not shell chrome

The shell used to subscribe to `connection.status` and render `宿主已连接 / 离线`,
which made `@mediabase/connection` a shell dependency. Chrome that *reports a
capability* belongs to a capability: `ui-panels` registers it into a new `header`
area and the shell renders title text only. `ui-web` now depends on nothing but
`ui`, cordis and React — "the shell knows no capability" is checkable, not just
claimed.

Evidence: `tests/ui-composition.test.tsx` composes the real `ui-media` +
`ui-panels` packages against the real shell and asserts panels land in the right
areas (header badge inside `<h1>`, media canvas in `.monitor`) and disappear when
the capability fiber is disposed.
