"""
Cooperative cancellation for long-running media stages.

Why this exists: a highlight job over a long VOD spends most of its wall time
inside OS processes (FFmpeg filter graphs, decoders). A status flag checked only
between stages would make "cancel" mean "cancel after the next full pass" —
minutes on a feature-length input. A CancelToken therefore carries BOTH a flag
and the set of live child processes, so cancelling reaches into the running
FFmpeg instead of waiting for it.

Contract:
  * Every process spawn goes through `run_cancellable`, which registers the
    child BEFORE waiting and unregisters it after — no window where a kill
    would miss a just-started process.
  * Cancellation is reported as `Cancelled`, never as a generic failure, so a
    caller can distinguish "the user withdrew this" from "the media is broken".
  * A cancelled job leaves no partial artifact behind: the assembly stage writes
    into a temp directory and only publishes on success (see ffmpeg_engine).

SPDX-License-Identifier: Apache-2.0
"""

import subprocess
import threading
from typing import List, Optional, Sequence, Set


class Cancelled(RuntimeError):
    """Raised when a job is cancelled by the caller; never a media error."""


class CancelToken:
    """
    A one-shot cancellation signal that also reaches running child processes.

    One token per job. `cancel()` is idempotent and safe to call from any
    thread (the RPC/HTTP handler does), while the worker thread is blocked in
    `wait()` on a child process.
    """

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._children: Set[subprocess.Popen] = set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        """Signal cancellation and terminate every live child process."""
        self._event.set()
        with self._lock:
            children: List[subprocess.Popen] = list(self._children)
        for proc in children:
            _terminate(proc)

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise Cancelled("job cancelled")

    def watch(self, proc: subprocess.Popen) -> None:
        """Register a child so a later `cancel()` can reach it."""
        with self._lock:
            self._children.add(proc)
        # cancel() may have run between the caller's check and this registration.
        if self._event.is_set():
            _terminate(proc)

    def unwatch(self, proc: subprocess.Popen) -> None:
        with self._lock:
            self._children.discard(proc)


def _terminate(proc: subprocess.Popen) -> None:
    """
    Stop one child: SIGTERM (so FFmpeg flushes and exits cleanly), then SIGKILL.

    Best-effort by design — the process may already be gone, and a failure here
    must never mask the Cancelled the caller is about to raise.
    """
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=2.0)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def run_cancellable(
    cmd: Sequence[str],
    token: Optional[CancelToken] = None,
    timeout: Optional[float] = None,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """
    Run one command, optionally cancellable and bounded by a timeout.

    Mirrors `subprocess.run(capture_output=True, text=True)` so call sites keep
    reading `.stdout` / `.returncode`. Differences that matter:
      * with a token, the child is killed the moment `cancel()` is called and
        the call raises `Cancelled` instead of reporting a signal exit;
      * `check=True` raises `CalledProcessError` for a genuine non-zero exit.
    """
    if token is not None:
        token.raise_if_cancelled()

    if token is None:
        return subprocess.run(
            list(cmd),
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout,
        )

    proc = subprocess.Popen(
        list(cmd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    token.watch(proc)
    try:
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate(proc)
            out, err = proc.communicate()
            raise
    finally:
        token.unwatch(proc)

    # A kill we caused is a cancellation, not a media failure: report it as such
    # so the caller never surfaces "ffmpeg exit -15" to a user who pressed stop.
    token.raise_if_cancelled()

    completed = subprocess.CompletedProcess(list(cmd), proc.returncode, out, err)
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(
            proc.returncode, list(cmd), output=out, stderr=err
        )
    return completed
