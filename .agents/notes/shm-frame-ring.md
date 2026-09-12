# Note: three data-plane shapes, and what "zero copy" can honestly mean

Status: implemented

## Problem

The data plane had two shapes (pull `GET /api/<name>`, push `WS /stream`) and the
status said "zero-copy (shared memory / GPU texture) still missing". Before building
anything, the phrase had to be made checkable, because in a browser it is regularly
claimed for things that are not zero copy:

- A page **cannot** be handed a `SharedArrayBuffer` from another process over a
  WebSocket. Whatever the host does, the bytes must arrive as an HTTP/WS payload at
  least once.
- `putImageData` copies to the GPU. Painting a `Uint8Array` in a canvas is not a
  zero-copy path, whoever writes the marketing.

So the honest target is narrower and still valuable: **everything AFTER the bytes
land**. A monitor at 60 fps allocates a multi-megabyte buffer per frame and copies it
across threads; a shared ring removes exactly that.

## Decisions

**1. `@mediabase/shm`: a ring, not a queue.** A viewer that cannot keep up must LOSE
frames — the same policy the WS transport already followed, now structural: the
producer overwrites the oldest slot and counts the drop. `stats()` reports
`published / pending / dropped / closed / slots / slotBytes / bytes` in one object, so
a UI and a health probe show the same numbers instead of each maintaining a counter.

**2. Zero copy is a test assertion, not a promise.** `acquire()` returns a `subarray`
view of the ring's buffer, and the tests assert `frame.bytes.buffer === ring.buffer` —
and that writing through the view changes what the other side reads. That is the
property; everything else about the ring (wrap-around, seq monotonicity, drop
accounting, handle validation, a real `worker_threads` consumer) is tested in
`tests/shm-ring.test.ts` (9 cases).

**3. The handle IS the buffer.** `toTransferable()` / `attachRing()` pass the
`SharedArrayBuffer` itself, so handing the ring to a worker or another thread copies
nothing (unlike a `postMessage` of a normal buffer). `attach()` validates the shape it
is given — a wrong `slots`/`slotBytes` would silently read someone else's bytes.

**4. The client half is a sink, not a new protocol.** `openRingStream(channel, { url,
slots, slotBytes })` subscribes through the existing `openStream` and publishes each
frame into the ring; the ring can be created by the caller and shared with a worker
first. No protocol bump: the WS envelope is unchanged.

**5. The browser prerequisite is served, not assumed.** `SharedArrayBuffer` needs a
cross-origin-isolated document, so `gateway.crossOriginIsolation` adds
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
+ `Cross-Origin-Resource-Policy: same-origin` on every response. It is **off by
default** with the reason stated in the option's doc: a cross-origin-isolated page
refuses cross-origin subresources that do not opt in, so enabling it for a deployment
that embeds anything external would break that deployment.

**6. What is NOT zero copy, said out loud.** The engine→host hop still goes through the
engine's stdout pipe; making that one zero-copy needs an mmap in the host, i.e. a native
Node addon, which is the opposite of this repo's stance (the engine is the only native
build). The status document says so instead of listing the hop as done.

## Consequences

- `tests/shm-transport.test.ts` (4 cases) covers the seam: pushed frames arrive as
  views, a slow reader sheds frames with accounting from both ends, the COOP/COEP
  headers appear only when asked, and a worker reads the same memory.
- `tests/host.integration.test.ts` adds one case against the REAL pipeline
  (engine → host → gateway → ring): a 64×24 test pattern arrives as a 4608-byte view of
  the ring, not as a fresh buffer.
- The media monitor still consumes frames the per-frame way: switching it to the ring is
  a small product-side change, and the user's instruction was to finish the base first.
  The transport is therefore available and proven, but not yet load-bearing — stated
  plainly rather than implied by "zero copy implemented".
- In-browser verification is now DONE, by a later change: `tests/browser.e2e.test.ts`
  drives real headless Chrome over CDP (no new dependency) and measures both postures
  with the engine that enforces them — isolation off ⇒ `typeof SharedArrayBuffer ===
  'undefined'` and `crossOriginIsolated === false`; isolation on ⇒ COOP/COEP/CORP
  present, `new SharedArrayBuffer(8)` allocatable, and a page-side ring readable back.
  The same suite proves the bundle boots, the page's own WebSocket connects, a locale
  switch redraws panels already on screen, and the generated form round-trips
  `server.info`.
- That suite needed one fix of its own, worth remembering: it claimed "no browser ⇒
  skip, never red", but only the FIRST half of its probe (find binary → debug port →
  socket) returned a reason; the CDP handshake threw, so this machine's environment fact
  (Chrome's own sandbox cannot initialize inside another seatbelt profile:
  `sandbox initialization failed: Operation not permitted`) turned the suite RED. Now
  every step converts a failure into a reason, the launcher retries once with
  `--no-sandbox` and DISCLOSES that deviation, and `AVSTUDIO_NO_BROWSER=1` /
  `AVSTUDIO_CHROME_ARGS` are the cheap seams for a browserless CI or a sandboxed dev
  machine. A probe is only honest if ALL of it is a probe.
