# Note: two data-plane shapes — pull for bytes, push for frames

Status: implemented

## Problem

The data plane was one thing: `GET /api/preview.rgb`, produced by a raw route the
gateway called synchronously. That is fine for "latest frame" but it is
fundamentally a poll: the browser asked 15 times a second, each ask costing an
HTTP round trip, and the host had no idea whether anyone was watching (so it
encoded and served frames to nobody), and no way to shed load when a viewer could
not keep up.

## Decisions

**1. Keep pull, add push — they answer different questions.** A route stays the
right shape for one-shot/latest bytes (cacheable, trivially scalable, works from
`curl`); a stream is the right shape for a frame flow. Both are registered by the
capability against the SAME registry (`ctx.api.route` / `ctx.api.stream`), and
media registers `preview.rgb` twice so a client can choose or fall back.

**2. The producer never sees the transport.** `ctx.api.stream({ name, attach })`
hands the producer a `StreamSink` (`send(meta, body)`, `subscribers()`,
`dropped()`); whether those bytes go to one WS client, ten, or a future shared
memory ring is the gateway's business. `attach`'s disposer runs when the last
subscriber leaves, and `publishFrame` returns immediately with zero sinks — so an
idle monitor costs nothing (verified: `media.testpattern` still works with no
viewer, and no frame is encoded... the decode itself is the work, but no copy/
serialize/publish path runs).

**3. Backpressure is DROPPING, and it is reported.** A live viewer that cannot
keep up must lose frames, not build an unbounded queue (memory growth + ever
increasing latency = the classic live-stream failure). The gateway checks
`bufferedAmount` against a high-water mark (default 8 MiB), drops the frame, and
tells the client `{type:"dropped",count}` so the UI can say so honestly. The sink
returns `false` for a dropped frame so a producer could adapt (e.g. lower quality)
later.

**4. The protocol is small enough to speak by hand.** Text control frames
(`subscribe`, `meta`, `dropped`, `error`) + one binary payload per `meta`. No
framing library, no header parsing on the hot path, and a client that only knows
the envelope can still consume any channel.

Rejected: putting frames on the JSON-RPC socket (mixes control and data, and
base64/JSON per frame is absurd); a "stream" abstraction in the capability
(duplicating transport logic per capability); unbounded queueing (see 3).

**5. `noServer` + one upgrade router.** Writing the client test exposed that
`ws` aborts (HTTP 400) any upgrade whose path a *path-scoped* server does not own —
so a second `WebSocketServer({ server, path: '/stream' })` silently broke the
first endpoint's handshakes. Both servers now run `noServer` and a single
`upgrade` listener routes `/rpc` and `/stream` by pathname, destroying anything
else. Symptom worth remembering: the client hangs at `connecting` forever because
the handshake was refused, not because the protocol is wrong.

**6. `server.info` publishes the bound port.** Port 0 means "any free port", and
the gateway only knows the real one after `listening`; the method awaits
`gateway.ready()` and returns host/port/distIndex/stream subscribers. Tests,
tooling and the desktop shell stop guessing (the stream tests found the port-0
race immediately).

## Evidence

- `tests/data-plane-stream.test.ts` (6): channel registry + counters, meta+binary
  delivery with `seq`, attach/detach around subscribers, backpressure shedding
  reported via `onDropped`, unknown channel refused without dropping the socket,
  client status transitions and no-retry-after-close.
- `tests/host.integration.test.ts` (+1): on a real host, subscribe to
  `preview.rgb`, decode a frame over RPC, assert the pushed frame's meta and byte
  count, then assert the pull route still works, `server.info.streams` and
  `api.streams` report 1 subscriber, and closing the handle drops it to 0.
- `scripts/verify.mjs`: E2E check 7 pushes `160x120` = 57600 bytes over `/stream`.
