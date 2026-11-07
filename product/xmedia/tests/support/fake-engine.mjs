// A Node implementation of the xmedia bridge line protocol, used by the TS
// suites so the host can be exercised on machines that never compiled the C++
// engine. It is a TEST DOUBLE, not a second implementation to maintain: it
// speaks the SAME tab-separated FIFO contract generated from
// protocol/contract.json (see product/xmedia/scripts/gen-protocol.mjs). The
// verbs/columns here mirror the contract; if they drift, the protocol check in
// verify.mjs fails.
//
// There is no Player pipeline and no scratch byte exchange — media bytes never
// cross the host in this product.
//
// Fault injection (env):
//   FAKE_ENGINE_MODE=crash       exit(7) right after the first hello
//   FAKE_ENGINE_MODE=silent      never replies (timeout path)

const state = {
  events: [],
  // Task pool: jobId -> publish snapshot (mirrors the C++ bridge's std::map).
  jobs: new Map(),
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
