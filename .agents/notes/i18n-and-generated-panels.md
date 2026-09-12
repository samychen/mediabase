# Note: text belongs in dictionaries, panels belong to schemas

Status: implemented

## Problem

Two kinds of duplication that both grow with every new capability:

1. UI text was hard-coded Chinese inside components, so "support English" meant
   editing every panel, and a capability could not ship its own translations
   without touching the shell.
2. Every capability needed a hand-written panel to be *usable*: media had a
   console, python had buttons, and a new capability got nothing until someone
   wrote React for it — even though `ctx.api` already knew its methods and their
   JSON Schema.

## Decisions

**1. `ctx.i18n` is the only text boundary.** Each UI package ships
`messages.ts` (`zh-CN` + `en`) and registers it in `apply` (disposer follows the
fiber); components call `useI18n(ctx)` and render `t('key')`. Consequences that
were not obvious up front:
- panel titles must be registered as `titleKey`, otherwise switching the locale
  leaves the old language in the section headers;
- a status line that *stays on screen* must store a key + params, not rendered
  text. Rendering text into state freezes the language at that moment — this bit
  the media console (`空闲`) and the capability summary, and is now called out in
  AGENTS.md;
- `form.tsx` returns validation *keys* (`form.needsNumber`), not sentences, so the
  form layer stays text-free too.

**2. The fallback chain is deliberate: active → fallback → the key.**
Not "any dictionary that happens to have the key". Mixing languages behind the
user's back is worse than an obviously missing translation, and it hides the gap.
`errorText` follows the same principle for errors: the host's prose stays in the
host's language, the client localizes by `RpcCode` and renders
`[code] localized · host detail` — the code is what the log and the bug report
share, so it is never dropped.

**3. A guard test makes "translated" a property, not a claim.**
`tests/i18n-coverage.test.ts` reads every UI source and fails on a CJK literal
outside `messages.ts` (comments and host-side diagnostics excepted). It found real
leftovers the moment it was written (validation strings, a JSON parse message, a
core dictionary living in `index.ts`) — which is exactly why it exists: the next
component someone writes would otherwise drift back.

**4. Generated panels answer "a capability with no UI".**
`@mediabase/ui` gained `fieldsFromSchema` (JSON Schema → field descriptors),
`valuesFromFields` (editor strings → RPC-ready values, omitting empties so host
defaults apply, reporting bad values instead of sending them) and `SchemaForm`
(a dependency-free renderer). The API console panel lists `api.list` and renders a
form per method, so **every registered method is callable without any
capability-owned UI**, with a raw-JSON box for shapes a form cannot express.
Unknown schema shapes degrade to a JSON textarea rather than being dropped
silently.

Rejected: a form library (a dependency for ~120 lines of value), and a
"localize the host messages" scheme (the host would need a locale, a dictionary
and a re-render path — codes are the cheaper and more honest contract).

## Evidence

- `tests/i18n.test.ts` (5): fallback chain, interpolation, subscriber counts,
  dictionary disposal with the fiber, coded-error texts (localized + host detail),
  title-key switching.
- `tests/i18n-coverage.test.ts` (2): no CJK literals outside dictionaries; every
  UI package ships both locales.
- `tests/api-console.test.tsx` (6): schema→field mapping, coercion/omission/errors,
  the panel generating a form for a real method and invoking it with typed values,
  a coded error rendered from the code, and a header language switch flipping the
  shell + panel titles + capability strings.
- `ui-composition`/`ui-shell` suites now compose the real `@mediabase/i18n`, so the
  shell's own text is resolved through the same path as production.
