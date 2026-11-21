// WHEP playback client — the standard WebRTC egress protocol MediaMTX serves at
// `${webrtcBase}/${path}/whep`. Dependency-free: one POST with a recvonly SDP
// offer, the answer comes back, the session URL rides in the `Location` header
// and is DELETEd on teardown.
//
// SINGLE SOURCE OF TRUTH:
//   - xmedia  apps/web/dist/index.html  (loaded as <script type="module">)
//
// Upstream error contract observed on MediaMTX v1.21: JSON
// `{ "error": "no stream is available on path 'cam1'" }` — surfaced verbatim so
// the caller sees WHY (usually: nobody is publishing).
//
// A video-only publisher MUST pass { audio: false }: an audio transceiver makes
// MediaMTX reject the whole WHEP session with "codecs not supported by client"
// when the stream carries no audio (measured end to end with a real SDP offer).
// Streams that may carry audio (console) use the default audio: true.

/**
 * @typedef {Object} WhepHandle
 * @property {() => void} close  Call on unmount / path switch / manual stop. Idempotent.
 */

/**
 * Start a WHEP session rendering into `video`.
 * @param {string} url WHEP endpoint, e.g. http://host:8889/my/path/whep
 * @param {HTMLVideoElement} video target element
 * @param {{ audio?: boolean }} [opts] audio: add an audio recvonly transceiver
 *   (default true). Set false when publishing video-only.
 * @returns {Promise<WhepHandle>}
 */
export async function startWhep(url, video, opts = {}) {
  const audio = opts.audio !== false
  if (typeof RTCPeerConnection === 'undefined') throw new Error('此浏览器不支持 WebRTC')
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  if (audio) pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = (event) => {
    video.srcObject = event.streams[0] ?? new MediaStream([event.track])
    video.play().catch(() => {
      /* autoplay policy: the operator can press play on the element */
    })
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offer.sdp ?? '',
    })
  } catch (e) {
    pc.close()
    throw e
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body.error === 'string') detail = body.error
    } catch {
      /* non-JSON error body: keep the HTTP status line */
    }
    pc.close()
    // Carry both `message` (for string-match callers like xmedia's /no stream/)
    // and `status`/`detail` (for typed callers like console's isWhepError).
    throw Object.assign(new Error(detail), { status: res.status, detail })
  }

  const sessionUrl = res.headers.get('location')
  const answer = await res.text()
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  } catch (e) {
    pc.close()
    throw e
  }

  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      if (sessionUrl) {
        // Best-effort teardown so MediaMTX drops the session immediately
        // instead of on the RTCPeerConnection timeout.
        const absolute = sessionUrl.startsWith('http')
          ? sessionUrl
          : new URL(sessionUrl, url).toString()
        fetch(absolute, { method: 'DELETE' }).catch(() => undefined)
      }
      pc.close()
      video.srcObject = null
    },
  }
}

/** Whether this browser can play an HLS playlist with a bare <video> (Safari /
 * iOS). Everywhere else WHEP is the only dependency-free option — which is
 * fine: it is the low-latency path anyway. */
export function nativeHlsSupported() {
  if (typeof document === 'undefined') return false
  const probe = document.createElement('video')
  return (
    probe.canPlayType('application/vnd.apple.mpegurl') !== '' ||
    probe.canPlayType('application/x-mpegURL') !== ''
  )
}
