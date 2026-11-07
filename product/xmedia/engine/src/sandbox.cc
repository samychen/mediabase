// sandbox.cc — see sandbox.h for the contract and platform matrix.

#include "sandbox.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <pwd.h>
#include <sys/resource.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sandbox.h>
#endif

#ifdef __linux__
#include <sys/prctl.h>
#include <vector>
#include <linux/bpf_common.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/syscall.h>
#endif

namespace xmedia_sandbox {
namespace {

// Only meaningful when started as root; the encoder never needs root.
bool DropPrivileges() {
  if (getuid() != 0) return true;
  struct passwd* pw = getpwnam("nobody");
  if (pw == nullptr) return false;
  if (setgid(pw->pw_gid) != 0) return false;
  if (setuid(pw->pw_uid) != 0) return false;
  return true;
}

// Portable POSIX caps. These bound blast radius even where seccomp/Seatbelt are
// unavailable (older kernels, unusual libc): a runaway encode cannot consume
// unbounded CPU, RAM, disk or fds.
void LimitResources() {
  rlimit cpu{600, 600};
  setrlimit(RLIMIT_CPU, &cpu);
  const rlim_t two_gib = 2UL * 1024 * 1024 * 1024;
  rlimit as{two_gib, two_gib};
  setrlimit(RLIMIT_AS, &as);
  rlimit fsize{two_gib, two_gib};
  setrlimit(RLIMIT_FSIZE, &fsize);
  rlimit nofile{1024, 1024};
  setrlimit(RLIMIT_NOFILE, &nofile);
}

#ifdef __linux__
// Syscall allowlist for the encoder. Refused syscalls return EPERM (so misuse
// fails loudly) instead of being permitted. Audit against your xmedia-kit build
// — a missing entry here surfaces as a (correctly refused) encode failure.
bool ApplySeccomp() {
  static const int allowed[] = {
      __NR_read, __NR_write, __NR_open, __NR_openat, __NR_close, __NR_lseek,
      __NR_stat, __NR_lstat, __NR_fstat, __NR_fstat64, __NR_mmap, __NR_munmap,
      __NR_brk, __NR_mprotect, __NR_madvise, __NR_futex, __NR_sched_yield,
      __NR_sched_getaffinity, __NR_clone, __NR_clone3, __NR_rt_sigprocmask,
      __NR_rt_sigaction, __NR_rt_sigreturn, __NR_sigaltstack, __NR_getpid,
      __NR_gettid, __NR_gettimeofday, __NR_clock_gettime, __NR_clock_getres,
      __NR_nanosleep, __NR_poll, __NR_ppoll, __NR_recvfrom, __NR_sendto,
      __NR_recvmsg, __NR_sendmsg, __NR_connect, __NR_socket, __NR_setsockopt,
      __NR_getsockopt, __NR_bind, __NR_listen, __NR_accept, __NR_getrandom,
      __NR_readlink, __NR_access, __NR_dup, __NR_dup3, __NR_pipe2, __NR_ioctl,
      __NR_prlimit64, __NR_getrlimit, __NR_setrlimit, __NR_arch_prctl,
      __NR_exit, __NR_exit_group, __NR_restart_syscall,
  };
  std::vector<sock_filter> f;
  f.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
  for (int nr : allowed) {
    f.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, static_cast<unsigned long>(nr), 0, 1));
    f.push_back(BPF_STMT(BPF_RET, SECCOMP_RET_ALLOW));
  }
  f.push_back(BPF_STMT(BPF_RET, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)));
  sock_fprog prog{static_cast<unsigned short>(f.size()), f.data()};
  // Fail open (log, skip) rather than abort: an unexpected filter rejection must
  // not turn a hardening step into a startup failure.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return false;
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0) != 0) {
    std::fprintf(stderr, "[xmedia-bridge] seccomp filter rejected; continuing without it\n");
    return false;
  }
  return true;
}
#endif

#ifdef __APPLE__
// macOS Seatbelt only accepts NAMED profiles through the deprecated sandbox_init
// API (no inline SBPL), so an inline profile string is rejected with
// "profile not found". We attempt it for parity but report honestly: if it does
// not engage, the engine is NOT sandboxed — only the baseline POSIX limits are.
bool ApplySeatbelt() {
  static const char kProfile[] =
      "(version 1)\n"
      "(deny default)\n"
      "(allow process-exec)\n"
      "(allow sysctl-read)\n"
      "(allow file-read*)\n"
      "(allow file-write* (regex #\"^/tmp/#\") (regex #\"^/var/folders/#\"))\n"
      "(allow network* (remote ip))\n"
      "(allow signal (target self))\n";
  if (sandbox_init(kProfile, SANDBOX_NAMED, nullptr) != 0) {
    std::fprintf(stderr,
                 "[xmedia-bridge] seatbelt rejected (inline profiles are unsupported on macOS); "
                 "continuing with POSIX limits only (sandboxed=false)\n");
    return false;
  }
  return true;
}
#endif

}  // namespace

bool ApplySandbox(bool enabled) {
  if (!enabled) return false;
  // Baseline hardening, applied UNCONDITIONALLY when a sandbox is requested:
  // a runaway encode is bounded for CPU/RAM/disk/fds, and if we were started as
  // root we drop to nobody. These are not the "sandbox" toggle — they are the
  // floor every engine process gets.
  LimitResources();
  DropPrivileges();  // best-effort; no-op unless we were root

  // The `sandboxed` flag the host reads MUST reflect reality: the platform
  // sandbox is only "on" if it actually engaged. A rejection is logged and
  // reported as false rather than turning hardening into a fatal startup error.
#ifdef __APPLE__
  return ApplySeatbelt();
#elif defined(__linux__)
  return ApplySeccomp();
#else
  std::fprintf(stderr,
               "[xmedia-bridge] no platform sandbox for this OS; POSIX limits applied (sandboxed=false)\n");
  return false;
#endif
}

}  // namespace xmedia_sandbox
