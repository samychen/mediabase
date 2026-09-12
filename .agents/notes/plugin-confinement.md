# Note: a claimed boundary must be enforced — plugin process confinement

Status: implemented

## Problem

Process isolation was described honestly but thinly: "this is process isolation,
not a permission sandbox — the child still runs as the same user with filesystem
access". True, and useless against the case that matters: a runtime plugin is
untrusted code by definition, and `require('fs')` inside the child was never
subject to any policy.

The naive fix — "use the OS sandbox" — died on contact with reality. On this
machine (macOS 26.4) `/usr/bin/sandbox-exec` exists and **cannot be applied at
all**: even `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` returns
`sandbox_apply: Operation not permitted` (nested sandbox / hardened kernel; a
Seatbelt profile can only be applied by a process the parent profile allows to).
A design that assumes the OS mechanism works would have shipped a boundary that
silently does not exist — the exact failure mode this framework keeps refusing.

## Decisions

**1. Two layers, because they cover different things.** `@mediabase/confine` plans:

- `node-permission` — Node's own `--permission` model: filesystem limited to the
  declared roots, and child processes / worker threads / native addons **denied**.
  Portable, and verified by running it (probe: `node --permission -e ''`).
- `seatbelt` / `bubblewrap` — the OS layer, which is the only way to express what
  Node cannot: **network denial** (there is no `--allow-net`), plus syscall and
  namespace confinement independent of the runtime.

**2. Availability is probed by EXECUTION, and the reason is the report.** `which
sandbox-exec` would have said "available" on this machine. `probeMechanisms()`
runs each mechanism and keeps its own stderr, so the plan reads
`未生效=seatbelt: sandbox_apply: Operation not permitted`. A requested denial that
cannot be enforced goes into `unavailable` and is **left out of `enforced`**;
`confinement.required: true` turns that into a refused load (`UNAVAILABLE`, with
`messageKey` so a UI can explain it) instead of a quietly less-confined child.

**3. Two measured facts shaped the implementation.**

- **Node compares paths literally, without symlink resolution.** `--allow-fs-read=/tmp/x`
  does not admit `/private/tmp/x`; the failure surfaces as "the child cannot read
  its own entry file". `resolveRoots()` therefore emits BOTH spellings of every
  root (deduped), which is the only version that survives a real filesystem.
- **`tsx` needs worker threads** (it installs its ESM hooks through a worker), and
  denying workers is part of the policy. So the sandbox entry prefers a worker-free
  path: the bundled `build/sandbox.cjs` → `node entry.ts` (Node's own type
  stripping) → `tsx` last, and only then is the give-up REPORTED
  (`allowWorker` → `unavailable`), never silently applied.

**4. The child reports on itself.** `examples/plugins/sandboxed-demo` exposes
`probeConfinement`, so the answer comes from inside the boundary. Measured on the
real host (`pnpm run host` + `plugins.call`):

```
probe : confinement="层=node-permission · 文件系统=读写(仅声明目录) · 子进程=禁止 · 网络=未限制 ·
                         未生效=seatbelt: sandbox_apply: Operation not permitted", confined=true
child : DENIED  read-outside    ERR_ACCESS_DENIED
        ALLOWED read-app        ok
        ALLOWED write-data-dir   ok
        DENIED  write-outside   ERR_ACCESS_DENIED
        DENIED  spawn           ERR_ACCESS_DENIED
        DENIED  worker          ERR_ACCESS_DENIED
        ALLOWED network         socket allowed (nothing listening on port 1)
```

Note the last row: network is **not** confined here, and both the status string and
the child's own report say so instead of implying a boundary.

**5. A confined child needs one writable place, and the host must find it.** The
first real run failed with `EPERM ... mkdir '/Users/chensi/.avstudio/plugin-data/...'`
(the per-user dir is not creatable under this session's file sandbox). Failing to
load a plugin because a *convenience* directory is missing is the wrong failure
mode, so `dataDirFor()` tries the actual operation (`mkdirSync` of the final dir,
not "is the parent writable" — a parent that exists proves nothing) down a chain
(explicit `dataRoot` → `~/.avstudio` → `<app root>/.avstudio` → temp), uses the
first that works, and logs the fallback with the reason.

**6. A declaration that cannot take effect is an error.** `confinement` on an
`in-process` entry throws `INVALID_PARAMS`: silently ignoring it would leave an
operator believing a boundary exists.

## Consequences

- The suite is `tests/plugin-confinement.test.ts` (11 cases): pure planner tests
  (both path forms, permission flags without the escape hatches, the Seatbelt
  profile as reviewable text, bubblewrap args, and the honesty rules with injected
  probes) plus real child processes proving denial, the writable data dir, the
  fail-closed refusal, and the shipped example working under the policy.
- The plugin-sandbox suite (10 cases) still passes: confinement is per entry, and
  an entry that declares no policy keeps the previous behaviour.
- What remains unverified ON THIS MACHINE is the OS layer's enforcement (Seatbelt
  refuses to apply here): the profile text and the wrapper argv are unit-tested,
  and the availability path is exercised for real, but "network actually denied"
  cannot be demonstrated here. That limitation is stated in the docs and in the
  status the GUI shows — not papered over.
