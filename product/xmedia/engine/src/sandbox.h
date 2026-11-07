// sandbox.h — optional process hardening for the xmedia-bridge.
//
// The bridge decodes UNTRUSTED media. A crash there is isolated (separate
// process), but a memory-safety bug is still a code-execution surface, so when
// invoked with --sandbox we drop privileges and cap the syscall / resource
// surface before the SDK starts worker threads.
//
// The *shape* is portable; the *strength* is platform-dependent:
//   * POSIX (all): RLIMIT caps (CPU / address space / file size / fds) + a
//     best-effort privilege drop to "nobody" when started as root.
//   * Linux: a seccomp-BPF allowlist on top of the above.
//   * macOS: a Seatbelt profile on top of the above (deprecated but functional).
//
// ApplySandbox() is non-fatal by design on the parts it cannot guarantee: a
// desktop run is never root, so the drop is a no-op there, and a rejected
// seccomp filter is logged and skipped rather than aborting the process.

#pragma once

namespace xmedia_sandbox {

// Engage the sandbox if `enabled`. Returns true when any hardening was applied.
// Call once, early, before the media SDK spins up worker threads.
bool ApplySandbox(bool enabled);

}  // namespace xmedia_sandbox
