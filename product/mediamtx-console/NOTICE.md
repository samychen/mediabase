# MediaMTX console product notices

> The base's root `NOTICE.md` covers the base's own runtime dependencies (this
> product adds none — every dependency is a workspace link or already in the
> base tree). This file covers the product layer's provenance, which is
> different in kind from the OpenVideo product's: **this product contains no
> derived third-party code at all.**

## Clean-room statement

This product layer (`product/mediamtx-console/`, scope `@mtxconsole/*`) is a
**clean-room implementation**:

- **No code was copied or adapted** from any existing MediaMTX management
  console. In particular, [MinChanSike/mediamtx-client] was analyzed at the
  level of its published README feature list only (which screens exist, what
  they show); its source code was **not** read during implementation. That
  repository carries **no LICENSE file**, which under copyright law means
  all-rights-reserved — copying from it would be unlawful, and nothing here
  does.
- The **interface knowledge** in `@mtxconsole/protocol` and
  `@mtxconsole/host-bridge` was derived exclusively from:
  1. a **running MediaMTX v1.21.1 server** (HTTP API responses captured live
     during development — the fixtures in `tests/protocol.test.ts` are those
     captures, trimmed), and
  2. MediaMTX's **published route table** (`internal/api/api.go` in
     [bluenviron/mediamtx], read for endpoint names/methods only).
- [bluenviron/mediamtx] itself is **MIT-licensed**; this product does not
  vendor or redistribute it. The console talks to a MediaMTX server the
  operator runs themselves (the test harness spawns one only when a binary is
  already present on the machine).

Writing an independent client for a documented, freely observable HTTP API is
not derivation: the API contract is the interface, and interfaces are facts,
not expression. Every line in this tree was written for this repository.

## Trademarks / naming

"MediaMTX" is the name of the third-party MIT-licensed server this console
manages; it is used nominatively (to say what the product is for). This
product is not affiliated with, endorsed by, or part of the MediaMTX project.

[MinChanSike/mediamtx-client]: https://github.com/MinChanSike/mediamtx-client
[bluenviron/mediamtx]: https://github.com/bluenviron/mediamtx
