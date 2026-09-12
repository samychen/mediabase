# Note: a sandboxed runtime plugin is a child process, and that is the honest kind

Status: implemented

## What the in-process check could and could not do

`requires` (access-control round) hands a plugin a Proxy over its fiber context:
framework members plus declared services, everything else refused with a message
naming the fix. That is **least privilege for a cooperative plugin** — and it is
worth keeping (it is cheap, keeps stack traces readable, and works for a plugin the
user itself wrote). It cannot be more than that: the plugin lives in the host's
isolate, so an infinite loop in `apply()` hangs the host forever, a crash takes the
host down, and nothing stops code from reaching around a check it can see.

## Decisions

**1. Child process, not `worker_threads`.** A worker shares the process, so
`process.abort()` or a native crash still kills the host. A child gives real
containment, can be `kill`ed, and needs no new transport beyond Node IPC (with
`serialization: 'advanced'` so Buffers/Uint8Array survive service calls).

**2. The channel is messages, and nothing else.** A sandboxed plugin gets `log`,
`events` (subscribe/emit), `services.<declared>.<method>()` and an exported `api`
the host reaches via `plugins.call`. It never receives a host object, which is what
makes the enforcement real: `requires` is checked **on the host side** in
`dispatchCall`, so the plugin cannot skip it — it has no other door.

**3. `apply()` is bounded, and that is the point.** A deadline (default 10s) plus
`SIGTERM`→`SIGKILL` means a plugin stuck in an infinite loop is preempted and the
host keeps serving. This property is impossible in-process and is the strongest
argument for the whole feature; the test spins forever and asserts the host is
responsive afterwards.

**4. A crashed sandbox is reported as crashed, not as loaded.** The child's own
state wins in `plugins.list`/`plugins.probe` (`reportedState`), because the first
implementation kept saying "loaded" while the process was gone — the kind of lie a
plugin panel must never tell. `restarts` (default 0) is opt-in.

**5. Two entries, because deployments differ.** A packaged app spawns
`build/sandbox.cjs` (plain CJS, no tsx); a checkout can run the TS source through
tsx. `sandboxEntryFor` (called by the capability's `apply` when the row states no entry)
prefers the bundle when it exists, `AVSTUDIO_SANDBOX_ENTRY`
overrides, and the tests run the WHOLE suite against both entries.

**What this is not:** an OS permission sandbox. The child runs as the same user with
the same filesystem access; `require('node:fs')` still works. It bounds blast radius
(crash, memory, CPU, lifecycle) and the API surface — the README, AGENTS.md and the
panel all say exactly that instead of implying confinement.

## Bugs this round found (both by running real children)

- The **bundled** entry died instantly: `export const entryUrl = fileURLToPath(import.meta.url)`
  is a leftover from the ESM build, and `import.meta` does not exist in CJS — the same
  trap the host bundle hit earlier. Removed, and the test matrix now runs the bundle
  path so it cannot regress silently. The first version of the test helper *looked*
  like it preferred the bundle but actually picked the TS source (an inverted check),
  which is exactly why it passed while the host failed.
- The i18n coverage guard (from the i18n round) caught the sandbox status line I had
  just added to the plugins panel as a literal — the guard doing its job on new code
  within minutes of it being written.

## Evidence

- `tests/plugin-sandbox.test.ts` (10 = 5 scenarios × 2 entries): log/event/service
  channels and `plugins.call`; undeclared service refused host-side and never
  reaching the service; crash (uncaught timer throw + `process.exit(7)`) leaving the
  host alive with `state: 'error'`; infinite-loop `apply()` preempted in <6s with the
  host responsive; a throwing service surfacing as an error across the boundary.
- Real host E2E: `plugins.list` shows the sandboxed entry, `plugins.load` → `ready`
  with `api: [sum, describe]` and subscription to `media.play.tick`,
  `plugins.call sum [1,2,3,4]` → 10, unknown method → error, unload runs the plugin's
  cleanup and leaves **no orphan child** (`pgrep` empty).
- `examples/plugins/sandboxed-demo.ts` + `build/sandbox.cjs` are shipped
  (`extraResources`, `AVSTUDIO_SANDBOX_ENTRY`/`AVSTUDIO_SANDBOX_HELLO`), so the
  packaged app can load a sandboxed plugin without a shell.
