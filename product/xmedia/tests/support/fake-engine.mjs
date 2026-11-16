// A Node implementation of the xmedia bridge line protocol, used by the TS
// suites so the host can be exercised on machines that never compiled the C++
// engine. It is a TEST DOUBLE, not a second implementation to maintain: it
// speaks the SAME tab-separated FIFO contract generated from
// protocol/contract.json (see product/xmedia/scripts/gen-protocol.mjs). The
// verbs/columns here mirror the contract; if they drift, the protocol check in
// verify.mjs fails.
//
// There is no Player pipeline and no scratch byte exchange — media bytes never
// cross the host in this product. The bake verbs are simulated too: a "baked"
// job writes a small placeholder file at the output path, so the host's pull
// route has a real file to serve without any CEF.
//
// Fault injection (env):
//   FAKE_ENGINE_MODE=crash       exit(7) right after the first hello
//   FAKE_ENGINE_MODE=silent      never replies (timeout path)
//   FAKE_ENGINE_MODE=bake-fail   bake jobs complete with a failure
//   FAKE_ENGINE_MODE=bake-slow   bake jobs run 1.5 s (cancel lands mid-run)

import { writeFileSync } from 'node:fs'

const state = {
  events: [],
  // Task pool: jobId -> publish snapshot (mirrors the C++ bridge's std::map).
  jobs: new Map(),
  // Bake pool: jobId -> bake snapshot (mirrors the bridge's bakes_ map).
  bakes: new Map(),
}
// The capability appends --sandbox to the engine argv when configured; the real
// bridge engages resource caps + seccomp/Seatbelt, this double just reports it.
const SANDBOXED = process.argv.includes('--sandbox')
const say = (line) => process.stdout.write(`${line}\n`)
const json = (value) => JSON.stringify(value)

function idlePublish(jobId, input = '', output = '', format = '') {
  return {
    running: false, done: false, ok: false, progress: 0,
    input, output, format, error: '', startedMs: 0, finishedMs: 0,
    sandboxed: SANDBOXED,
  }
}

function idleBake() {
  return {
    kind: 'bake', running: false, done: false, ok: false, cancelled: false,
    progress: 0, stage: 'queued', html: '', output: '', error: '',
    exitCode: -1, startedMs: 0, finishedMs: 0,
  }
}

// A single fake process can simulate several concurrent jobs; the capability
// assigns a unique jobId per publish.start, which is exactly how the real
// engine breaks the old single-BUSY limit.
function publishStatus(jobId) {
  const p = state.jobs.get(jobId) ?? idlePublish(jobId)
  const now = p.running ? Date.now() : p.finishedMs
  return {
    running: p.running, done: p.done, ok: p.ok, progress: p.progress,
    input: p.input, output: p.output, format: p.format, error: p.error,
    elapsedMs: p.startedMs > 0 ? now - p.startedMs : 0,
    sandboxed: p.sandboxed,
  }
}

function bakeStatus(jobId) {
  const b = state.bakes.get(jobId) ?? idleBake()
  const now = b.running ? Date.now() : b.finishedMs
  return {
    kind: 'bake', running: b.running, done: b.done, ok: b.ok,
    cancelled: b.cancelled, progress: b.progress, stage: b.stage,
    html: b.html, output: b.output, error: b.error, exitCode: b.exitCode,
    elapsedMs: b.startedMs > 0 ? now - b.startedMs : 0,
  }
}

function dispatch(parts) {
  const [verb] = parts
  switch (verb) {
    case 'hello':
      say(`hello\t1\tfake-xmedia-kit`)
      if (process.env.FAKE_ENGINE_MODE === 'crash') setTimeout(() => process.exit(7), 10)
      return
    case 'ping': say('pong'); return
    case 'quit': say('ok'); process.exit(0); return
    // Products own their verbs: publish.* mirrors the C++ bridge's columns,
    // with jobId as the first request column (per protocol/contract.json).
    case 'publish.start': {
      const [jobId = '', input = '', output = '', format = ''] = parts.slice(1)
      if (!jobId || !input || !output) {
        say('err\tINVALID_PARAMS\tpublish.start requires <jobId> <input> <output> [format] [vcodec] [acodec] [realtime]')
        return
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(output) && !format) {
        say('err\tINVALID_PARAMS\ta network output needs an explicit format (flv for rtmp)')
        return
      }
      if (state.jobs.has(jobId)) { say('err\tBUSY\tjob already exists: ' + jobId); return }
      state.jobs.set(jobId, {
        ...idlePublish(jobId, input, output, format), running: true, progress: 5,
        startedMs: Date.now(),
      })
      state.events.push({ type: 'PublishStarted', jobId, output })
      say(`ok\t${json(publishStatus(jobId))}`)
      return
    }
    case 'publish.stop': {
      const [jobId = ''] = parts.slice(1)
      const job = state.jobs.get(jobId)
      if (job && job.running) {
        job.running = false
        job.done = true
        job.ok = false
        job.error = 'cancelled'
        job.finishedMs = Date.now()
        state.events.push({ type: 'PublishDone', jobId, ok: false, error: 'cancelled' })
      }
      say(`ok\t${json(publishStatus(jobId))}`)
      return
    }
    case 'publish.status': {
      const [jobId = ''] = parts.slice(1)
      say(`ok\t${json(publishStatus(jobId))}`)
      return
    }
    case 'events': {
      const drained = state.events
      state.events = []
      say(`ok\t${json(drained)}`)
      return
    }
    // bake.* mirrors the C++ bridge's columns (see contract.json's comment).
    // The fake "encodes" by writing a placeholder file at the output path so
    // the host's pull route serves a real file in tests.
    case 'bake.start': {
      const [jobId = '', htmlPath = '', outPath = ''] = parts.slice(1)
      if (!jobId || !htmlPath || !outPath) {
        say('err\tINVALID_PARAMS\tbake.start requires <jobId> <htmlPath> <outPath> [optionsJson]')
        return
      }
      if (state.bakes.has(jobId)) { say('err\tBUSY\tbake job already exists: ' + jobId); return }
      state.bakes.set(jobId, {
        html: htmlPath, output: outPath, running: true, done: false, ok: false,
        cancelled: false, progress: 0, stage: 'init', error: '', exitCode: -1,
        startedMs: Date.now(), finishedMs: 0,
      })
      state.events.push({ type: 'BakeStarted', jobId, output: outPath })
      say(`ok\t${json(bakeStatus(jobId))}`)
      const fail = process.env.FAKE_ENGINE_MODE === 'bake-fail'
      const slow = process.env.FAKE_ENGINE_MODE === 'bake-slow'
      const finishMs = slow ? 1500 : 140
      let progress = 0
      const tick = setInterval(() => {
        const b = state.bakes.get(jobId)
        if (!b || !b.running) { clearInterval(tick); return }
        progress = Math.min(90, progress + 20)
        b.stage = 'render'
        b.progress = progress
        state.events.push({ type: 'BakeProgress', jobId, stage: 'render', progress })
      }, slow ? 150 : 30)
      setTimeout(() => {
        clearInterval(tick)
        const b = state.bakes.get(jobId)
        if (!b || !b.running) return
        b.running = false
        b.done = true
        b.finishedMs = Date.now()
        if (fail) {
          b.ok = false
          b.error = 'fake bake failure'
          b.stage = 'failed'
          b.exitCode = 1
          state.events.push({ type: 'BakeDone', jobId, ok: false, cancelled: false, exitCode: 1, output: outPath, error: b.error })
        } else {
          b.ok = true
          b.stage = 'done'
          b.progress = 100
          b.exitCode = 0
          try { writeFileSync(outPath, Buffer.from(`fake-bake-${jobId}`)) } catch { /* route gate re-checks existence */ }
          state.events.push({ type: 'BakeDone', jobId, ok: true, cancelled: false, exitCode: 0, output: outPath })
        }
      }, finishMs)
      return
    }
    case 'bake.status': {
      const [jobId = ''] = parts.slice(1)
      say(`ok\t${json(bakeStatus(jobId))}`)
      return
    }
    case 'bake.cancel': {
      const [jobId = ''] = parts.slice(1)
      const b = state.bakes.get(jobId)
      if (b && b.running) {
        b.running = false
        b.done = true
        b.ok = false
        b.cancelled = true
        b.stage = 'cancelled'
        b.error = 'cancelled'
        b.exitCode = 3
        b.finishedMs = Date.now()
        state.events.push({ type: 'BakeDone', jobId, ok: false, cancelled: true, exitCode: 3, output: b.output })
      }
      say(`ok\t${json(bakeStatus(jobId))}`)
      return
    }
    default: say(`err\tUNKNOWN_COMMAND\t${verb}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line && process.env.FAKE_ENGINE_MODE !== 'silent') dispatch(line.split('\t'))
    nl = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
