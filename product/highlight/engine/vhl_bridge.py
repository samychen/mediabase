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
from dataclasses import dataclass, field
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
    return HighlightConfig(**kwargs)


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


def models_report() -> Dict[str, Any]:
    """What this deployment can actually score with, and under which licence."""
    onnx_path = os.environ.get("VHL_ONNX_MODEL", "")
    return {
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
            "opencv": _has_module("cv2"),
            "numpy": _has_module("numpy"),
            "onnxruntime": _has_module("onnxruntime"),
        },
        "degraded": not _has_module("cv2"),
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
        "cwd": os.getcwd(),
    }


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


def handle(rt: Runtime, verb: str, raw: Sequence[str]) -> Optional[str]:
    if not contract.known(verb):
        raise EngineError("INVALID_PARAMS", f"未知动词: {verb}")

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
