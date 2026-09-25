// WHEP playback — the standard WebRTC egress protocol MediaMTX serves at
// `${webrtcBase}/${path}/whep`. One POST with a recvonly SDP offer, the answer
// comes back, the session URL rides in the `Location` header and is DELETEd on
// teardown. Upstream error contract observed on v1.21: JSON
// `{ status: "error", error: "no stream is available on path 'cam1'" }` —
// surfaced verbatim so the operator sees WHY (usually: nobody is publishing).

export interface WhepHandle {
  /** Call on unmount / path switch / manual stop. Idempotent. */
  close(): void
}

export interface WhepError {
  status: number
  detail: string
}

export function isWhepError(e: unknown): e is WhepError {
  return typeof e === 'object' && e !== null && typeof (e as WhepError).status === 'number'
}

/**
 * Start a WHEP session rendering into `video`. Resolves once the answer SDP
 * is applied (frames start flowing via ontrack shortly after); rejects with a
 * WhepError for upstream refusals, or the raw error for transport failures.
 */
export async function startWhep(whepUrl: string, video: HTMLVideoElement): Promise<WhepHandle> {
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = (event) => {
    video.srcObject = event.streams[0] ?? new MediaStream([event.track])
    void video.play().catch(() => {
      /* autoplay policy: the operator can press play on the element */
    })
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  let res: Response
  try {
    res = await fetch(whepUrl, {
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
      const body = (await res.json()) as { error?: string }
      if (typeof body.error === 'string') detail = body.error
    } catch {
      /* non-JSON error body: keep the HTTP status line */
    }
    pc.close()
    throw { status: res.status, detail } satisfies WhepError
  }

  const sessionUrl = res.headers.get('location')
  const answerSdp = await res.text()
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
  } catch (e) {
    pc.close()
    throw e
  }

  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      if (sessionUrl !== null && sessionUrl !== '') {
        // Best-effort teardown so MediaMTX drops the session immediately
        // instead of on the RTCPeerConnection timeout.
        const url = sessionUrl.startsWith('http') ? sessionUrl : new URL(sessionUrl, whepUrl).toString()
        void fetch(url, { method: 'DELETE' }).catch(() => undefined)
      }
      pc.close()
      video.srcObject = null
    },
  }
}

/** Whether this browser can play an HLS playlist with a bare <video> (Safari /
 * iOS). Everywhere else WHEP is the only dependency-free option — which is
 * fine: it is the low-latency path anyway. */
export function nativeHlsSupported(): boolean {
  if (typeof document === 'undefined') return false
  const probe = document.createElement('video')
  return probe.canPlayType('application/vnd.apple.mpegurl') !== ''
    || probe.canPlayType('application/x-mpegURL') !== ''
}
