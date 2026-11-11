#!/usr/bin/env python3
"""
vhl-bridge — the line-protocol entry point to the highlight engine.

The host (@highlight/host-engine) supervises this process through
@mediabase/engine-client: one tab-separated request line in, exactly one reply
line out, in strict request order. Long work (a full analyze pass) does NOT
block the channel: `analyze.start` returns a job snapshot immediately and the
worker thread reports progress through `analyze.status`.

Design decisions worth knowing before editing:

  * stdout is a PROTOCOL channel. Every log line, warning and traceback goes to
    stderr, because one stray print would desynchronise the FIFO reply match.
  * A refusal is `err\t<CODE>\t<message>`; the host maps CODE to an RPC error
    code, so a client can branch on "not found" vs "invalid params" instead of
    matching prose.
  * The engine is stateless across restarts by design: job records live in
    memory, and a restart loses them. The HOST owns durable state (it can
    re-submit), which is why this process never writes a job database.
  * Cancellation reaches INTO FFmpeg (see highlight_core/cancel.py), so "stop"
    means stop, not "stop after the next full pass".

Run the bridge directly for diagnostics:
    python3 engine/vhl_bridge.py --doctor

SPDX-License-Identifier: Apache-2.0
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import contract  # noqa: E402  (path set above)

from highlight_core import (  # noqa: E402
    CancelToken,
    Cancelled,
    HighlightConfig,
    HighlightPipeline,
    ScoringWeights,
)
from highlight_core.ffmpeg_engine import FFmpegEngine  # noqa: E402
# Read only for `_HAS_OPENCV` — see `opencv_usable()` for why the analyzer's own
# import flag is the only trustworthy answer here.
from highlight_core import vision_analyzer  # noqa: E402

ENGINE_NAME = "vhl-engine"
ENGINE_VERSION = "2.1.0"


# --------------------------------------------------------------------------- #
# Wire helpers
# --------------------------------------------------------------------------- #

def wire(value: Any) -> str:
    """Fold a tab/newline to a space: one column must never split one reply."""
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def line(token: str, *columns: Any) -> str:
    return "\t".join([token, *(wire(c) for c in columns)])


def jdump(value: Any) -> str:
    # Compact + no ASCII escaping: tabs inside strings become \t escapes, so a
    # JSON column is always a single physical line.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


_out_lock = threading.Lock()


def say(text: str) -> None:
    """Write one reply line and flush — a buffered reply reads as a hang."""
    with _out_lock:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"[vhl-bridge] {message}\n")
    sys.stderr.flush()


class EngineError(Exception):
    """A refusal with a stable code the host maps onto an RPC code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------- #
# Option mapping (wire camelCase -> HighlightConfig field)
# --------------------------------------------------------------------------- #

_FLOAT = "float"
_INT = "int"
_BOOL = "bool"
_STR = "str"
_STRS = "strs"
_WEIGHTS = "weights"

# The knob table comes from the CONTRACT (protocol/contract.json, through
# contract.py), not from a literal here: a host that validates a knob the engine
# does not implement is a silent lie, and two hand-maintained tables drift.
_OPTIONS: Dict[str, Tuple[str, str]] = dict(contract.OPTIONS)
_META: Dict[str, Dict[str, Any]] = dict(contract.OPTION_META)

# Keys the bridge handles itself rather than passing to HighlightConfig.
_SPECIAL = {key for key, spec in _META.items() if spec.get("special")}

# What an explicit opt-in needs, and how to fix it when it is missing.
_REQUIRES_HINT = {
    "face": ("MediaPipe 人脸检测", "pip install mediapipe"),
    "clip": ("OpenCLIP 零样本引导", "pip install open-clip-torch"),
    "whisper": ("faster-whisper 字幕", "pip install faster-whisper"),
    "onnxruntime": ("ONNX Runtime 目标检测", "pip install onnxruntime"),
}


def _build_weights(key: str, value: Any) -> ScoringWeights:
    """A composite option: the seven signal weights, validated then normalised by
    the engine at score time.

    Two refusals are deliberate. An unknown sub-key would otherwise be dropped
    silently (the user tunes a signal that does not exist). An all-zero map would
    make ScoringWeights.normalized() substitute its own defaults, i.e. accept the
    request and ignore it — the most expensive kind of bug.
    """
    fields: Dict[str, Dict[str, Any]] = (_META.get(key) or {}).get("fields") or {}
    if not isinstance(value, dict):
        raise EngineError(
            "INVALID_PARAMS",
            f"选项 {key} 需要对象(子键: {', '.join(sorted(fields))})",
        )
    unknown = [sub for sub in value if sub not in fields]
    if unknown:
        raise EngineError(
            "INVALID_PARAMS",
            f"选项 {key} 没有子键 {', '.join(sorted(unknown))}(可用: {', '.join(sorted(fields))})",
        )
    attrs: Dict[str, float] = {}
    for sub, raw in value.items():
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise EngineError("INVALID_PARAMS", f"{key}.{sub} 必须是 0~1 之间的数字")
        number = float(raw)
        if not (0.0 <= number <= 1.0):
            raise EngineError("INVALID_PARAMS", f"{key}.{sub} 必须在 0~1 之间(收到 {number})")
        attrs[str(fields[sub]["field"])] = number
    if sum(attrs.values()) <= 0:
        raise EngineError("INVALID_PARAMS", f"{key} 至少要有一个信号权重 > 0")
    return ScoringWeights(**attrs)


def _coerce(key: str, value: Any, kind: str) -> Any:
    if kind == _WEIGHTS:
        return _build_weights(key, value)
    try:
        if kind == _FLOAT:
            return float(value)
        if kind == _INT:
            return int(value)
        if kind == _BOOL:
            return bool(value)
        if kind == _STR:
            return str(value)
        if kind == _STRS:
            if isinstance(value, str):
                return [s for s in (part.strip() for part in value.split(",")) if s]
            if isinstance(value, (list, tuple)):
                return [str(v) for v in value]
            raise ValueError("需要字符串数组")
    except (TypeError, ValueError) as exc:
        raise EngineError("INVALID_PARAMS", f"选项 {key} 取值非法: {value!r} ({exc})") from exc
    raise EngineError("INVALID_PARAMS", f"选项 {key} 类型未知")


def _check_bounds(key: str, value: Any) -> None:
    """min/max/enum are contract data, so the host can enforce the same limits."""
    spec = _META.get(key, {})
    enum = spec.get("enum")
    if enum is not None and value not in enum:
        raise EngineError(
            "INVALID_PARAMS", f"选项 {key} 必须是 {', '.join(map(str, enum))} 之一(收到 {value!r})"
        )
    low = spec.get("min")
    high = spec.get("max")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if low is not None and value < low:
            raise EngineError("INVALID_PARAMS", f"选项 {key} 不能小于 {low}(收到 {value})")
        if high is not None and value > high:
            raise EngineError("INVALID_PARAMS", f"选项 {key} 不能大于 {high}(收到 {value})")


def _capability(report: Dict[str, Any], name: str) -> bool:
    if name == "onnxruntime":
        return bool((report.get("runtime") or {}).get("onnxruntime"))
    group = report.get(name) or {}
    return bool(group.get("available"))


def check_requirements(options: Dict[str, Any], report: Dict[str, Any]) -> None:
    """An EXPLICIT opt-in to a missing model is a refusal, not a silent zero.

    Defaults are still allowed to degrade (enable_whisper defaults to true, and a
    deployment without faster-whisper simply analyses without subtitles) — but a
    client that asked for CLIP guidance and got a zero-weight signal with no
    explanation would be lied to, which is worse than a clear error.
    """
    for key, value in options.items():
        spec = _META.get(key) or {}
        requires = spec.get("requires")
        if not requires or not value:
            continue
        if _capability(report, requires):
            continue
        label, hint = _REQUIRES_HINT.get(requires, (requires, ""))
        suffix = f";安装方式: {hint}" if hint else ""
        raise EngineError(
            "UNAVAILABLE", f"选项 {key} 需要 {label},当前环境未安装{suffix}"
        )


def build_config(options: Dict[str, Any], report: Optional[Dict[str, Any]] = None) -> HighlightConfig:
    kwargs: Dict[str, Any] = {}
    seen: Dict[str, Any] = {}
    for key, value in options.items():
        if key in _SPECIAL or key.startswith("_"):
            continue
        spec = _OPTIONS.get(key)
        if spec is None:
            raise EngineError(
                "INVALID_PARAMS",
                f"未知选项: {key}(可用: {', '.join(sorted(_OPTIONS))})",
            )
        field_name, kind = spec
        coerced = _coerce(key, value, kind)
        _check_bounds(key, coerced)
        kwargs[field_name] = coerced
        seen[key] = coerced
    if report is not None:
        check_requirements(seen, report)
    # Cross-field trap: a prompt without guidance is a no-op that looks enabled.
    if seen.get("clipPrompt") and not seen.get("enableClipGuidance"):
        raise EngineError("INVALID_PARAMS", "clipPrompt 需要同时开启 enableClipGuidance")
    # An explicit `weights` choice must beat any preset: mark it so the pipeline
    # leaves the caller's recipe untouched (resolved_preset=None in the report).
    if "weights" in seen:
        kwargs["weights_explicit"] = True
    # `auto` is the one preset value that needs a model (CLIP classifies the
    # content). The generic `requires` is per-option, so this per-value rule is
    # checked here, mirroring the host's assertRequirements. The engine would
    # degrade to general, but the contract boundary must not silently honour less
    # than was asked.
    if seen.get("contentPreset") == "auto" and report is not None and not _capability(report, "clip"):
        label, hint = _REQUIRES_HINT["clip"]
        raise EngineError(
            "UNAVAILABLE", f"contentPreset=auto 需要 {label},当前环境未安装;安装方式: {hint}"
        )
    return HighlightConfig(**kwargs)


def _apply_whisper_model_path(
    config: HighlightConfig, options: Dict[str, Any], report: Optional[Dict[str, Any]]
) -> None:
    """Special option `whisperModelPath`: local CTranslate2 dir wins over the hub size.

    The generic `requires` check never sees special options (build_config skips
    them), so the capability gate is repeated here — same rule as §5.9: an
    explicit opt-in for a missing model is a rejection, not a silent default.
    faster-whisper's first argument is size_or_path, so a local directory is a
    legal value; it must override the contract-enum'd hub name, not merge with it.
    """
    path = str(options.get("whisperModelPath") or "")
    if not path:
        return
    if report is not None and not _capability(report, "whisper"):
        label, hint = _REQUIRES_HINT["whisper"]
        raise EngineError(
            "UNAVAILABLE", f"whisperModelPath 需要 {label},当前环境未安装;安装方式: {hint}"
        )
    if not pathlib.Path(path).exists():
        raise EngineError("NOT_FOUND", f"转写模型目录不存在: {path}")
    config.whisper_model_size = path


def options_catalog(report: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """What a client may set, its limits, and whether this deployment can honour it."""
    rows: List[Dict[str, Any]] = []
    for key, spec in _META.items():
        requires = spec.get("requires") or ""
        eligible = True if not requires else (_capability(report or {}, requires) if report else True)
        rows.append({
            "key": key,
            "type": spec.get("type", "str"),
            "default": spec.get("default"),
            "min": spec.get("min"),
            "max": spec.get("max"),
            "enum": spec.get("enum"),
            "requires": requires,
            "group": spec.get("group", "analysis"),
            "available": eligible,
            "fields": spec.get("fields"),
        })
    rows.sort(key=lambda row: (str(row["group"]), str(row["key"])))
    return rows


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #

@dataclass
class Job:
    job_id: str
    input: str
    output: str
    config: HighlightConfig
    srt_path: str
    token: CancelToken
    state: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    error: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    segments: List[Dict[str, Any]] = field(default_factory=list)
    output_srt: str = ""
    report_path: str = ""
    duration_sec: float = 0.0
    fps: float = 25.0

    def snapshot(self) -> Dict[str, Any]:
        """Stable wire shape: camelCase, no internals (no token, no config object)."""
        return {
            "jobId": self.job_id,
            "state": self.state,
            "stage": self.stage,
            "progress": round(self.progress, 4),
            "input": self.input,
            "output": self.output,
            "error": self.error,
            "createdAtMs": int(self.created_at * 1000),
            "startedAtMs": None if self.started_at is None else int(self.started_at * 1000),
            "finishedAtMs": None if self.finished_at is None else int(self.finished_at * 1000),
            "durationSec": round(self.duration_sec, 3),
            "fps": round(self.fps, 3),
            "segments": self.segments,
            "segmentCount": len(self.segments),
            "srtPath": self.output_srt,
            "reportPath": self.report_path,
        }


def _segment(highlight: Any) -> Dict[str, Any]:
    return {
        "startSec": round(float(highlight.start_sec), 3),
        "endSec": round(float(highlight.end_sec), 3),
        "score": round(float(highlight.composite_score), 4),
        "signals": {
            str(k): round(float(v), 4)
            for k, v in dict(highlight.modality_breakdown).items()
        },
    }


class Runtime:
    """Job registry + worker pool. One instance per process."""

    def __init__(self, workers: int, ffmpeg_bin: str = "ffmpeg", max_queue: int = 8) -> None:
        self._lock = threading.Lock()
        self._jobs: Dict[str, Job] = {}
        self._order: List[str] = []
        self._pool = ThreadPoolExecutor(max_workers=max(1, workers))
        self._closed = False
        self._ffmpeg_bin = ffmpeg_bin
        # Backpressure. A thread pool accepts an unbounded queue, so without this
        # a client that submits 200 jobs gets 200 "accepted" answers and one
        # worker grinding for an hour. Rejecting the overflow immediately is the
        # honest answer, and it is what lets a caller retry with backoff.
        self._max_queue = max(1, max_queue)

    def queue_depth(self) -> int:
        with self._lock:
            return sum(1 for job in self._jobs.values() if job.state in ("queued", "running"))

    # -- lifecycle ---------------------------------------------------------- #

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
        for job in jobs:
            job.token.cancel()
        self._pool.shutdown(wait=False, cancel_futures=True)

    # -- commands ----------------------------------------------------------- #

    def start(self, job_id: str, input_path: str, output_path: str,
              options: Dict[str, Any]) -> Job:
        if not input_path:
            raise EngineError("INVALID_PARAMS", "analyze.start 需要 input 路径")
        if not output_path:
            raise EngineError("INVALID_PARAMS", "analyze.start 需要 output 路径")
        src = pathlib.Path(input_path)
        if not src.exists():
            raise EngineError("NOT_FOUND", f"输入文件不存在: {input_path}")
        if not src.is_file():
            raise EngineError("INVALID_PARAMS", f"输入不是文件: {input_path}")

        # Validate options BEFORE accepting the job: a bad knob must fail the
        # call, not become a background job that fails a second later.
        report = models_report()
        config = build_config(options, report)
        srt_path = str(options.get("srtPath") or "")
        if srt_path and not pathlib.Path(srt_path).exists():
            raise EngineError("NOT_FOUND", f"字幕文件不存在: {srt_path}")
        _apply_whisper_model_path(config, options, report)

        out = pathlib.Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        job = Job(
            job_id=job_id or uuid.uuid4().hex,
            input=str(src.resolve()),
            output=str(out.resolve()),
            config=config,
            srt_path=srt_path,
            token=CancelToken(),
        )
        with self._lock:
            if self._closed:
                raise EngineError("UNAVAILABLE", "引擎正在关闭")
            if job.job_id in self._jobs:
                raise EngineError("INVALID_PARAMS", f"任务已存在: {job.job_id}")
            active = sum(1 for j in self._jobs.values() if j.state in ("queued", "running"))
            if active >= self._max_queue:
                raise EngineError(
                    "CONFLICT",
                    f"队列已满({active}/{self._max_queue});请等待现有任务结束或先取消",
                )
            self._jobs[job.job_id] = job
            self._order.append(job.job_id)
        self._pool.submit(self._run, job)
        return job

    def status(self, job_id: str) -> Job:
        return self._find(job_id)

    def cancel(self, job_id: str) -> Job:
        job = self._find(job_id)
        job.token.cancel()
        if job.state in ("queued", "running"):
            job.stage = "cancelling"
        return job

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [self._jobs[jid].snapshot() for jid in self._order]

    def _find(self, job_id: str) -> Job:
        with self._lock:
            if not job_id and self._order:
                job_id = self._order[-1]
            job = self._jobs.get(job_id)
        if job is None:
            raise EngineError("NOT_FOUND", f"未知任务: {job_id or '(空)'}")
        return job

    # -- worker ------------------------------------------------------------- #

    def _run(self, job: Job) -> None:
        with self._lock:
            job.state = "running"
            job.stage = "probe"
            job.started_at = time.time()

        def on_progress(stage: str, fraction: float) -> None:
            # Snapshot reads and writes of two scalars are atomic enough in
            # CPython, but the explicit clamp keeps the wire contract honest.
            job.stage = stage
            job.progress = min(1.0, max(0.0, float(fraction)))

        try:
            pipeline = HighlightPipeline(job.config)
            result = pipeline.run(
                video_path=job.input,
                output_video_path=job.output,
                external_srt_path=job.srt_path or None,
                progress=on_progress,
                token=job.token,
            )
            job.segments = [_segment(h) for h in result.highlights]
            job.output_srt = result.output_srt or ""
            job.report_path = result.timeline_report_json
            # Stamp before declaring success: a client that reads the report the
            # moment the job turns `succeeded` must already find the fingerprint,
            # otherwise "the artifact is complete" would be a race.
            attach_provenance(job.report_path, job.config)
            job.duration_sec = float(result.metadata.duration_sec)
            job.fps = float(result.metadata.fps or 25.0)
            job.state = "succeeded"
            job.stage = "done"
            job.progress = 1.0
        except Cancelled:
            job.state = "cancelled"
            job.stage = "cancelled"
            job.error = "任务已取消"
            log(f"job {job.job_id} cancelled")
        except Exception as exc:  # noqa: BLE001 - every failure must be reported
            job.state = "failed"
            job.stage = "failed"
            job.error = f"{type(exc).__name__}: {exc}"
            log(f"job {job.job_id} failed: {job.error}\n{traceback.format_exc()}")
        finally:
            job.finished_at = time.time()


# --------------------------------------------------------------------------- #
# Diagnostics
# --------------------------------------------------------------------------- #

_ffmpeg_version_cache: Optional[str] = None


def ffmpeg_version() -> str:
    global _ffmpeg_version_cache
    if _ffmpeg_version_cache is not None:
        return _ffmpeg_version_cache
    binary = os.environ.get("VHL_FFMPEG_BIN", "ffmpeg")
    try:
        res = subprocess.run(
            [binary, "-version"], capture_output=True, text=True, timeout=5.0
        )
        first = (res.stdout or "").splitlines()
        _ffmpeg_version_cache = first[0].strip() if first else ""
    except Exception:
        _ffmpeg_version_cache = ""
    return _ffmpeg_version_cache


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def opencv_usable() -> bool:
    """Whether the vision stage will actually run — not whether cv2 exists.

    `importlib.util.find_spec('cv2')` answers "is there a module named cv2", and
    it says YES for a wheel whose native library fails to dlopen: a Homebrew
    opencv whose libprotobuf moved does exactly that, and the import dies with
    `Library not loaded`. Anything that reports capability from find_spec will
    therefore claim "motion + saliency available" on a machine that silently runs
    the FFmpeg-only path — the one lie this product cannot afford, because honest
    degradation is the whole reason `degraded` exists.

    The analyzer imports cv2 for real at import time and records the outcome, so
    its flag cannot disagree with the run. Reading it costs nothing: the module is
    already loaded by the time this process answers anything.
    """
    return bool(getattr(vision_analyzer, "_HAS_OPENCV", False))


def opencv_issue() -> str:
    """Why the vision stage will not run — as a CODE the UI translates.

    `degraded` on its own conflates machines that need different fixes, and each
    wrong name sends the operator to install something they already have:

      * `opencv-missing`  — no module named cv2 (`pip install opencv-python-headless`);
      * `numpy-missing`   — cv2 is there but numpy is not. The analyzer imports cv2
        AND numpy in ONE `try`, so this lands in the same flag as a broken OpenCV —
        "reinstall OpenCV" would be the same wrong advice, one level down. Real on a
        macOS box with `brew install opencv` and no pip numpy;
      * `opencv-import-failed` — both are installed and the import still dies (a keg
        whose libprotobuf moved, a wheel that cannot dlopen).

    `find_spec` is the right question HERE, unlike in `opencv_usable()`: "does a
    module with this name exist" is exactly the difference between absent and
    unimportable. Empty when OpenCV is usable, so `degraded` and this field cannot
    disagree.
    """
    if opencv_usable():
        return ""
    if not _has_module("cv2"):
        return "opencv-missing"
    if not _has_module("numpy"):
        return "numpy-missing"
    return "opencv-import-failed"


def models_report(onnx_model_path: str = "") -> Dict[str, Any]:
    """What this deployment can actually score with, and under which licence.

    `onnx_model_path` is the per-job choice; `VHL_ONNX_MODEL` is the deployment
    default. Reading only the env var meant a job that named its own checkpoint was
    reported as having no detector at all.
    """
    onnx_path = onnx_model_path or os.environ.get("VHL_ONNX_MODEL", "")
    cv2 = opencv_usable()
    return {
        # Which interpreter produced this report. Without it, "opencv-missing"
        # reads as a claim about the MACHINE ("OpenCV is not installed"), when it
        # is a claim about this interpreter only — and the two need different
        # fixes. On a machine with several Pythons, OpenCV is usually installed
        # in one of them, so the operator is told to install it again.
        "interpreter": {
            "executable": sys.executable,
            "version": sys.version.split()[0],
        },
        "detector": {
            "kind": "onnx",
            "path": onnx_path,
            "present": bool(onnx_path) and pathlib.Path(onnx_path).exists(),
            "license": "Apache-2.0 (RT-DETR / YOLOX checkpoints; verify each file)",
        },
        "face": {
            "available": _has_module("mediapipe"),
            "license": "Apache-2.0 (MediaPipe Face Detection / BlazeFace)",
        },
        "clip": {
            "available": _has_module("open_clip"),
            "license": "MIT (OpenCLIP weights)",
        },
        "whisper": {
            "available": _has_module("faster_whisper"),
            "license": "MIT (faster-whisper / CTranslate2)",
        },
        "runtime": {
            "opencv": cv2,
            "numpy": _has_module("numpy"),
            "onnxruntime": _has_module("onnxruntime"),
        },
        "degraded": not cv2,
        # Why, not just whether — each cause is a different fix.
        "degradedReason": opencv_issue(),
    }


def doctor() -> Dict[str, Any]:
    return {
        "engine": ENGINE_VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "ffmpeg": ffmpeg_version(),
        "ffmpegPath": shutil.which(os.environ.get("VHL_FFMPEG_BIN", "ffmpeg")) or "",
        "protocol": contract.describe(),
        "models": models_report(),
        "environment": environment(),
        "cwd": os.getcwd(),
    }


# --------------------------------------------------------------------------- #
# Provenance — who computed these numbers
# --------------------------------------------------------------------------- #
#
# The engine's own report payload records the RECIPE (weights, thresholds) but
# nothing about the MACHINERY — and the machinery is where a disagreement comes
# from: a different ONNX checkpoint, a different OpenCV build (frame differencing moved
# between minor versions), a missing model that silently dropped one of the seven
# signals to zero. Same input, same parameters, different clip — the report as it
# stood could not name a cause, so the only available explanation was "the tool is
# inconsistent".
#
# It is NOT a registry and NOT a validation gate. Nothing here rejects a run,
# compares against a whitelist, or fails a job: recording is the whole job. A gate
# would stand between the operator and the new checkpoint they are trying to
# evaluate, which is the one thing this product must keep easy. So the recipe
# travels WITH the artifact, and two reports can be diffed after the fact.
#
# Canonicalisation matters because the fingerprint claims "these two runs are the
# same run". Every value in `environment` is therefore a string, an int or a bool,
# and mtime is an ISO string rather than float epoch seconds: a float's JSON form
# is not portable across languages and its human form is unreadable. `recipe`
# keeps the engine's own floats untouched — those are the engine's numbers, not
# ours to round for the comfort of a hash.

_ENV_CACHE: Optional[Dict[str, Any]] = None
# Which checkpoint path the cache describes. A job may name its own model (the
# contract's `onnxModelPath`), so the cache is only reusable for the same path.
_ENV_CACHE_PATH: str = ""
# Keyed by (path, size, mtime): re-reading a 90MB checkpoint on every job to
# produce the same 16 hex chars would be a real cost for no new information.
_DIGEST_CACHE: Dict[Tuple[str, int, int], str] = {}


def _dist_version(*names: str) -> str:
    """Installed version of the first matching distribution, '' when absent.

    Distribution names, not import names: `cv2` ships as `opencv-python` (or
    `-headless` / `-contrib`), and `import cv2` would pay a full OpenCV import
    just to read a string.
    """
    try:
        from importlib import metadata
    except Exception:  # pragma: no cover - stdlib always has it on 3.8+
        return ""
    for name in names:
        try:
            return metadata.version(name)
        except Exception:
            continue
    return ""


def _opencv_version() -> str:
    """The OpenCV that will run, or the version installed on disk when there is one.

    Best effort by design: a broken wheel still reports its version ("4.12.0, will
    not import" is a diagnosis), while a Homebrew keg with a dead dylib has no
    wheel metadata at all and yields "". When both fail, `signals.visualMotion`
    is the fact that matters — it names the code path that actually ran.
    """
    if opencv_usable():
        version = getattr(getattr(vision_analyzer, "cv2", None), "__version__", "")
        if version:
            return str(version)
    return _dist_version(
        "opencv-python", "opencv-python-headless", "opencv-contrib-python"
    )


def _file_identity(model_id: str, path: str) -> Dict[str, Any]:
    """Identity of a checkpoint file: what it is, how big, and a content digest."""
    entry: Dict[str, Any] = {"id": model_id, "kind": "file", "path": path, "present": False}
    try:
        stat = os.stat(path)
    except OSError:
        # Absence is a fact worth recording, not an omission: "the detector was
        # not there" explains a score of 0 far better than a missing key.
        return entry
    entry["present"] = True
    entry["bytes"] = int(stat.st_size)
    entry["mtime"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime))
    key = (path, int(stat.st_size), int(stat.st_mtime))
    digest = _DIGEST_CACHE.get(key)
    if digest is None:
        try:
            hasher = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    hasher.update(chunk)
            digest = hasher.hexdigest()[:16]
        except OSError:
            digest = ""
        _DIGEST_CACHE[key] = digest
    entry["sha256_16"] = digest
    return entry


def _module_identity(model_id: str, module: str, dists: Sequence[str]) -> Dict[str, Any]:
    """Identity of a model that ships inside a Python distribution."""
    present = _has_module(module)
    return {
        "id": model_id,
        "kind": "module",
        "module": module,
        "present": present,
        "version": _dist_version(*dists) if present else "",
    }


def environment(onnx_model_path: str = "") -> Dict[str, Any]:
    """The machinery: versions, checkpoints, and which signals can run here.

    Two sources of truth for the checkpoint, deliberately ordered: the job's own
    `onnxModelPath` first, then the deployment's `VHL_ONNX_MODEL`. The analysis
    already used the job's path, so a report that consulted only the env var would
    describe a machine that ran Sobel while the numbers beside it came from YOLOX.
    """
    global _ENV_CACHE, _ENV_CACHE_PATH
    detector_path = onnx_model_path or os.environ.get("VHL_ONNX_MODEL", "")
    if _ENV_CACHE is not None and _ENV_CACHE_PATH == detector_path:
        return _ENV_CACHE
    _ENV_CACHE_PATH = detector_path

    models: List[Dict[str, Any]] = []
    if detector_path:
        models.append(_file_identity("detector", detector_path))
    else:
        models.append({"id": "detector", "kind": "file", "path": "", "present": False})
    models.append(_module_identity("face", "mediapipe", ("mediapipe",)))
    models.append(_module_identity("clip", "open_clip", ("open_clip_torch", "open-clip-torch")))
    models.append(_module_identity("whisper", "faster_whisper", ("faster-whisper",)))
    detector_present = any(m.get("id") == "detector" and m.get("present") for m in models)

    cv2 = opencv_usable()
    _ENV_CACHE = {
        "engine": {"name": ENGINE_NAME, "version": ENGINE_VERSION},
        "protocol": int(contract.PROTOCOL_VERSION),
        "python": sys.version.split()[0],
        "ffmpeg": ffmpeg_version(),
        "runtime": {
            "opencv": _opencv_version(),
            "numpy": _dist_version("numpy"),
            "onnxruntime": _dist_version("onnxruntime", "onnxruntime-silicon"),
        },
        "models": models,
        # Which IMPLEMENTATION each signal runs on — not whether it "exists".
        # Two machines can both produce a motion score and still measure
        # different things: OpenCV frame differencing and FFmpeg's `signalstats` YDIF
        # both land in [0,1] and are not comparable. A boolean would hide exactly
        # the difference this block was added to expose, so the value is the
        # backend. `none` is the one value that means "this signal is 0 here".
        #
        # Truth grades differ, deliberately: motion/saliency come from the
        # analyzer's real import (it is what picks the code path), while
        # face/clip/whisper are lazy imports probed at spec level — theirs is an
        # upper bound ("importable"), not "loaded this run". Importing torch here
        # to tighten that would cost seconds of start-up and hundreds of MB to
        # gain one string, so the bound is documented instead.
        "signals": {
            "sceneCut": "ffmpeg-scene",
            "audioRms": "ffmpeg-astats",
            "visualMotion": "opencv-framediff" if cv2 else "ffmpeg-signalstats",
            # Three paths, not two. With OpenCV but no checkpoint the analyzer
            # scores edge magnitude (Sobel) — a real per-frame vision measurement,
            # not a file-level statistic. Reporting it as `ffmpeg-signalstats` made
            # "installed OpenCV, no model" and "no OpenCV at all" identical in the
            # report, and those two have different fixes.
            "objectSaliency": (
                "onnx-detector" if (cv2 and detector_present)
                else "opencv-sobel" if cv2
                else "ffmpeg-signalstats"
            ),
            "faceSaliency": "mediapipe" if (cv2 and _has_module("mediapipe")) else "none",
            "clipGuidance": "open_clip" if (cv2 and _has_module("open_clip")) else "none",
            "keywordMatch": "faster-whisper" if _has_module("faster_whisper") else "none",
        },
    }
    return _ENV_CACHE


def provenance(recipe: Optional[Dict[str, Any]] = None,
               onnx_model_path: str = "") -> Dict[str, Any]:
    """Environment + recipe, plus one short digest to compare two reports by."""
    body: Dict[str, Any] = {
        "environment": environment(onnx_model_path),
        "recipe": recipe or {},
    }
    canonical = json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    # Digest the pair, not the environment: "same numbers or not" is a question
    # about the whole recipe, and a reader should not have to compare two blocks
    # field by field to answer it. Truncated to 16 hex chars — this is a
    # fingerprint for humans and diffs, not a security primitive.
    body["fingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
    return body


def attach_provenance(report_path: str, config: HighlightConfig) -> None:
    """Stamp an existing timeline report in place. Never fails the job.

    The pipeline owns the report's shape and is a synced copy of the upstream
    engine — adding a field there would be overwritten on the next sync, so the
    bridge augments the file after the fact. Provenance is deployment-scoped
    (env vars choose the models), which is exactly why it belongs here.
    """
    if not report_path:
        return
    target = pathlib.Path(report_path)
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return
        recipe = asdict(config)
        # Normalised, not raw: weights of 0.5/0.5 and 1.0/1.0 are the same scoring
        # recipe, so a fingerprint that told them apart would send someone hunting
        # for a difference that does not exist. These are exactly the numbers the
        # engine writes into its own `config.weights`, which makes the two blocks
        # cross-checkable instead of merely parallel.
        recipe["weights"] = asdict(config.weights.normalized())
        payload["provenance"] = provenance(recipe, getattr(config, "onnx_model_path", "") or "")
        # tmp + rename: the report route serves this file to a browser that may
        # be reading it right now. A reader must see the old file or the new one,
        # never half of either.
        staged = target.with_name(target.name + ".staged")
        staged.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(staged, target)
    except Exception as exc:  # noqa: BLE001 - bookkeeping must not fail the job
        # The render is already on disk and correct; a missing stamp is a smaller
        # problem than a failed job, and it is visible in the log.
        log(f"provenance 未写入 {report_path}: {type(exc).__name__}: {exc}")



# --------------------------------------------------------------------------- #
# EDL export (the interop seam with an editor such as OpenVideo)
# --------------------------------------------------------------------------- #

def _timecode(seconds: float, fps: float) -> str:
    rate = fps if fps > 0 else 25.0
    total_frames = int(round(max(0.0, seconds) * rate))
    frames_per_hour = int(round(rate * 3600))
    hours, rest = divmod(total_frames, frames_per_hour)
    minutes, rest = divmod(rest, int(round(rate * 60)))
    secs, frames = divmod(rest, int(round(rate)))
    return f"{hours:02d}:{minutes:02d}:{secs:02d}:{frames:02d}"


def render_edl(job: Job) -> str:
    """CMX3600: source in/out in the input's timebase, record in/out cumulative."""
    lines = [
        "TITLE: VHL HIGHLIGHTS",
        "FCM: NON-DROP FRAME",
        f"* SOURCE: {job.input}",
        f"* ENGINE: {ENGINE_NAME} {ENGINE_VERSION}",
        "",
    ]
    record = 0.0
    for index, seg in enumerate(job.segments, start=1):
        start = float(seg["startSec"])
        end = float(seg["endSec"])
        duration = max(0.0, end - start)
        lines.append(
            f"{index:03d}  AX       V     C        "
            f"{_timecode(start, job.fps)} {_timecode(end, job.fps)} "
            f"{_timecode(record, job.fps)} {_timecode(record + duration, job.fps)}"
        )
        record += duration
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Verb dispatch
# --------------------------------------------------------------------------- #

def _args(verb: str, raw: Sequence[str]) -> List[str]:
    """Pad short argument lists, reject long ones (a long one means a split column)."""
    expected = len(contract.request_columns(verb))
    if len(raw) > expected:
        raise EngineError(
            "INVALID_PARAMS",
            f"{verb} 需要 {expected} 个参数,收到 {len(raw)}(列里不能含制表符)",
        )
    return list(raw) + [""] * (expected - len(raw))


def _unknown_verb(verb: str) -> "EngineError":
    """A verb this engine's table does not have — say what arrived and what is here.

    Quoted and counted on purpose. The interesting failure is a verb that is
    *almost* right: a line mangled on its way in (`nalyze.status`), or a host that
    added a verb the engine's table predates. `未知动词: analyze.status` cannot be
    acted on — this machine supports exactly that verb and the message reads like
    a typo in the caller's code. With the quote, the character count and the list
    of what this process DOES accept, both causes are visible in one line, and
    `SOURCE` names the table that answered (contract.json vs a stale
    protocol_generated.py).
    """
    return EngineError(
        "INVALID_PARAMS",
        f"未知动词: '{verb}'({len(verb)} 字符,动词表来自 {contract.SOURCE});"
        f"本引擎支持: {', '.join(sorted(contract.VERBS))}",
    )


def handle(rt: Runtime, verb: str, raw: Sequence[str]) -> Optional[str]:
    if not contract.known(verb):
        raise _unknown_verb(verb)

    if verb == "hello":
        return line(
            "hello",
            contract.PROTOCOL_VERSION,
            f"{ENGINE_NAME}/{ENGINE_VERSION}",
            sys.version.split()[0],
            ffmpeg_version(),
        )

    if verb == "ping":
        return line("ping", "pong")

    if verb == "probe":
        (path,) = _args(verb, raw)
        if not path:
            raise EngineError("INVALID_PARAMS", "probe 需要文件路径")
        if not pathlib.Path(path).exists():
            raise EngineError("NOT_FOUND", f"文件不存在: {path}")
        try:
            meta = FFmpegEngine(HighlightConfig(enable_whisper=False)).probe(path)
        except Exception as exc:  # noqa: BLE001
            raise EngineError("FAILED", f"探测失败: {exc}") from exc
        return line("ok", jdump({
            "path": str(pathlib.Path(path).resolve()),
            "durationSec": round(meta.duration_sec, 3),
            "fps": round(meta.fps, 3),
            "width": meta.width,
            "height": meta.height,
            "hasAudio": meta.has_audio,
            "videoCodec": meta.video_codec,
            "audioCodec": meta.audio_codec or "",
        }))

    if verb == "analyze.start":
        job_id, input_path, output_path, options_json = _args(verb, raw)
        if not options_json.strip():
            options: Dict[str, Any] = {}
        else:
            try:
                parsed = json.loads(options_json)
            except json.JSONDecodeError as exc:
                raise EngineError("INVALID_PARAMS", f"optionsJson 不是合法 JSON: {exc}") from exc
            if not isinstance(parsed, dict):
                raise EngineError("INVALID_PARAMS", "optionsJson 必须是对象")
            options = parsed
        job = rt.start(job_id, input_path, output_path, options)
        return line("ok", jdump(job.snapshot()))

    if verb == "analyze.status":
        (job_id,) = _args(verb, raw)
        return line("ok", jdump(rt.status(job_id).snapshot()))

    if verb == "analyze.cancel":
        (job_id,) = _args(verb, raw)
        return line("ok", jdump(rt.cancel(job_id).snapshot()))

    if verb == "jobs.list":
        _args(verb, raw)
        return line("ok", jdump(rt.list_jobs()))

    if verb == "export.edl":
        job_id, path = _args(verb, raw)
        job = rt.status(job_id)
        if job.state != "succeeded" or not job.segments:
            raise EngineError(
                "INVALID_PARAMS",
                f"任务 {job.job_id} 尚无可导出片段(state={job.state})",
            )
        target = pathlib.Path(path) if path else pathlib.Path(job.output).with_suffix(".edl")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_edl(job), encoding="utf-8")
        return line("ok", str(target.resolve()))

    if verb == "models.list":
        _args(verb, raw)
        return line("ok", jdump(models_report()))

    if verb == "options.list":
        _args(verb, raw)
        return line("ok", jdump(options_catalog(models_report())))

    if verb == "quit":
        _args(verb, raw)
        return line("ok")

    raise EngineError("INVALID_PARAMS", f"未实现的动词: {verb}")


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="vhl-bridge",
        description="Line-protocol bridge to the video highlight engine",
    )
    parser.add_argument("--doctor", action="store_true", help="打印环境能力后退出")
    parser.add_argument(
        "--workers",
        type=int,
        default=int(os.environ.get("VHL_ENGINE_WORKERS", "1")),
        help="并发分析任务数(默认 1:分析是 CPU/GPU 密集的)",
    )
    parser.add_argument(
        "--max-queue",
        type=int,
        default=int(os.environ.get("VHL_ENGINE_MAX_QUEUE", "8")),
        help="排队上限(含运行中);超出直接回 CONFLICT,不无限堆积",
    )
    args = parser.parse_args(argv)

    if args.doctor:
        info = doctor()
        info["limits"] = {"workers": max(1, args.workers), "maxQueue": max(1, args.max_queue)}
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    runtime = Runtime(args.workers, os.environ.get("VHL_FFMPEG_BIN", "ffmpeg"), args.max_queue)
    log(
        f"ready: {ENGINE_NAME}/{ENGINE_VERSION} protocol={contract.PROTOCOL_VERSION} "
        f"workers={max(1, args.workers)} ffmpeg={ffmpeg_version() or 'MISSING'}"
    )
    try:
        for raw_line in sys.stdin:
            text = raw_line.rstrip("\n")
            if not text.strip():
                continue
            parts = text.split("\t")
            verb = parts[0]
            try:
                reply = handle(runtime, verb, parts[1:])
            except EngineError as exc:
                reply = line("err", exc.code, exc.message)
            except Exception as exc:  # noqa: BLE001 - never let one verb kill the channel
                log(f"unhandled error on {verb}: {exc}\n{traceback.format_exc()}")
                reply = line("err", "FAILED", f"{type(exc).__name__}: {exc}")
            if reply is not None:
                say(reply)
            if verb == "quit":
                break
    except KeyboardInterrupt:
        pass
    finally:
        runtime.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
