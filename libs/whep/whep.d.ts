// Type declarations for the shared, dependency-free WHEP client (whep.js).
// Kept here so the TS console can import the runtime from libs/ without
// enabling allowJs in the whole workspace.

export interface WhepHandle {
  /** Call on unmount / path switch / manual stop. Idempotent. */
  close(): void
}

export interface StartWhepOpts {
  /** Add an audio recvonly transceiver (default true). Set false for video-only publishers. */
  audio?: boolean
}

/**
 * Start a WHEP session rendering into `video`. Resolves once the answer SDP is
 * applied; rejects with an Error carrying `{ status, detail }` for upstream
 * refusals, or the raw error for transport failures.
 */
export function startWhep(
  url: string,
  video: HTMLVideoElement,
  opts?: StartWhepOpts,
): Promise<WhepHandle>

/** Whether this browser can play an HLS playlist with a bare <video>. */
export function nativeHlsSupported(): boolean
