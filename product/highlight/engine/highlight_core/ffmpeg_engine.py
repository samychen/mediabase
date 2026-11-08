"""
Process-Isolated FFmpeg & FFprobe Wrapper.
Executes media probing, native filter-graph scene/audio analysis, and segment concatenation
exclusively via OS subprocesses (CLI pipe/exec boundary) to preserve LGPLv2.1 compliance.

SPDX-License-Identifier: Apache-2.0
"""

import json
import math
import pathlib
import re
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

from .cancel import CancelToken, run_cancellable
from .config import HighlightConfig

ProgressFn = Callable[[float], None]


@dataclass
class MediaMetadata:
    """Probed media stream properties."""
    duration_sec: float
    fps: float
    width: int
    height: int
    has_audio: bool
    video_codec: str
    audio_codec: Optional[str]


class FFmpegEngine:
    """Clean-room CLI wrapper around FFmpeg and FFprobe binaries."""

    _PTS_TIME_RE = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")
    _SCENE_SCORE_RE = re.compile(r"lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)")
    _RMS_LEVEL_RE = re.compile(r"lavfi\.astats\.Overall\.RMS_level=(-?[0-9]+(?:\.[0-9]+)?|-inf)")

    def __init__(self, config: HighlightConfig):
        self.config = config

    def probe(self, video_path: str, token: Optional[CancelToken] = None) -> MediaMetadata:
        """Extract stream metadata via ffprobe JSON output."""
        cmd = [
            self.config.ffprobe_bin,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(video_path),
        ]
        res = run_cancellable(
            cmd, token=token, check=True,
            timeout=self.config.subprocess_timeout_sec,
        )
        data = json.loads(res.stdout)

        streams = data.get("streams", [])
        fmt = data.get("format", {})
        duration = float(fmt.get("duration", 0.0))

        video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

        if not video_stream:
            raise ValueError(f"No video stream found in {video_path}")

        if duration <= 0.0 and "duration" in video_stream:
            duration = float(video_stream["duration"])

        fps_str = video_stream.get("avg_frame_rate", "30/1")
        if "/" in fps_str:
            num, den = fps_str.split("/", 1)
            fps = float(num) / float(den) if float(den) != 0 else 30.0
        else:
            fps = float(fps_str or 30.0)

        return MediaMetadata(
            duration_sec=duration,
            fps=fps,
            width=int(video_stream.get("width", 0)),
            height=int(video_stream.get("height", 0)),
            has_audio=audio_stream is not None,
            video_codec=video_stream.get("codec_name", "unknown"),
            audio_codec=audio_stream.get("codec_name") if audio_stream else None,
        )

    def extract_scene_scores(
        self, video_path: str, token: Optional[CancelToken] = None
    ) -> List[Tuple[float, float]]:
        """
        Use FFmpeg's native C scene change filter to compute per-frame scene transition scores
        without decoding frames into Python memory.
        Returns a list of (timestamp_sec, scene_score) tuples.
        """
        filter_expr = "select='gte(scene,0)',metadata=print:file=-"
        cmd = [
            self.config.ffmpeg_bin,
            "-hide_banner",
            "-nostats",
            "-i", str(video_path),
            "-filter:v", filter_expr,
            "-an",
            "-f", "null",
            "-",
        ]
        res = run_cancellable(
            cmd, token=token, check=True,
            timeout=self.config.subprocess_timeout_sec,
        )
        events: List[Tuple[float, float]] = []
        current_pts: Optional[float] = None

        for line in res.stdout.splitlines():
            pts_match = self._PTS_TIME_RE.search(line)
            if pts_match:
                current_pts = float(pts_match.group(1))
                continue
            score_match = self._SCENE_SCORE_RE.search(line)
            if score_match and current_pts is not None:
                score = float(score_match.group(1))
                events.append((current_pts, score))
                current_pts = None

        return events

    def extract_audio_rms_profile(
        self, video_path: str, token: Optional[CancelToken] = None
    ) -> List[Tuple[float, float]]:
        """
        Use FFmpeg's native `astats` filter to compute chunked audio RMS energy in dB
        and normalize to [0.0, 1.0].
        Returns a list of (timestamp_sec, normalized_energy) tuples.
        """
        filter_expr = (
            f"asetnsamples=n={self.config.audio_sample_chunk},"
            "astats=metadata=1:reset=1,"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"
        )
        cmd = [
            self.config.ffmpeg_bin,
            "-hide_banner",
            "-nostats",
            "-i", str(video_path),
            "-vn",
            "-filter:a", filter_expr,
            "-f", "null",
            "-",
        ]
        res = run_cancellable(
            cmd, token=token, check=False,
            timeout=self.config.subprocess_timeout_sec,
        )
        if res.returncode != 0:
            return []

        raw_points: List[Tuple[float, float]] = []
        current_pts: Optional[float] = None

        for line in res.stdout.splitlines():
            pts_match = self._PTS_TIME_RE.search(line)
            if pts_match:
                current_pts = float(pts_match.group(1))
                continue
            rms_match = self._RMS_LEVEL_RE.search(line)
            if rms_match and current_pts is not None:
                val_str = rms_match.group(1)
                if val_str == "-inf":
                    db_val = -90.0
                else:
                    try:
                        db_val = max(-90.0, min(0.0, float(val_str)))
                    except ValueError:
                        db_val = -90.0
                # Map [-70 dB, 0 dB] linearly to [0.0, 1.0]
                norm_energy = max(0.0, min(1.0, (db_val + 70.0) / 70.0))
                raw_points.append((current_pts, norm_energy))
                current_pts = None

        return raw_points

    def assemble_highlights(
        self,
        video_path: str,
        intervals: List[Tuple[float, float]],
        output_path: str,
        srt_path: Optional[str] = None,
        token: Optional[CancelToken] = None,
        progress: Optional[ProgressFn] = None,
    ) -> str:
        """
        Cut and concatenate selected highlight intervals into a single video file.
        Supports ultra-fast stream copy (`-c copy`) or compliant re-encoding.
        """
        if not intervals:
            raise ValueError("No highlight intervals provided for assembly.")

        out_file = pathlib.Path(output_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix="vh_clips_") as tmp_dir:
            tmp_path = pathlib.Path(tmp_dir)
            clip_files: List[pathlib.Path] = []

            # Segment cuts are ~90% of this stage's wall time; concatenation is
            # one fast pass. Progress is reported per finished segment so a UI
            # can show motion instead of a spinner stalled for the whole job.
            for idx, (start_sec, end_sec) in enumerate(intervals):
                if token is not None:
                    token.raise_if_cancelled()
                duration = max(0.5, end_sec - start_sec)
                clip_out = tmp_path / f"segment_{idx:03d}.mp4"

                if self.config.frame_accurate:
                    # Frame-accurate: place -ss AFTER -i (decode seek) and re-encode.
                    cmd = [
                        self.config.ffmpeg_bin,
                        "-y",
                        "-hide_banner",
                        "-loglevel", "error",
                        "-i", str(video_path),
                        "-ss", f"{start_sec:.3f}",
                        "-t", f"{duration:.3f}",
                        "-c:v", self.config.fallback_video_codec,
                        "-c:a", self.config.fallback_audio_codec,
                        str(clip_out),
                    ]
                elif self.config.fast_stream_copy:
                    cmd = [
                        self.config.ffmpeg_bin,
                        "-y",
                        "-hide_banner",
                        "-loglevel", "error",
                        "-ss", f"{start_sec:.3f}",
                        "-i", str(video_path),
                        "-t", f"{duration:.3f}",
                        "-c", "copy",
                        "-avoid_negative_ts", "make_zero",
                        str(clip_out),
                    ]
                else:
                    cmd = [
                        self.config.ffmpeg_bin,
                        "-y",
                        "-hide_banner",
                        "-loglevel", "error",
                        "-ss", f"{start_sec:.3f}",
                        "-i", str(video_path),
                        "-t", f"{duration:.3f}",
                        "-c:v", self.config.fallback_video_codec,
                        "-c:a", self.config.fallback_audio_codec,
                        str(clip_out),
                    ]

                run_cancellable(
                    cmd, token=token, check=True,
                    timeout=self.config.subprocess_timeout_sec,
                )
                clip_files.append(clip_out)
                if progress is not None and intervals:
                    # Reserve the last 10% for the concat pass.
                    progress(0.9 * (idx + 1) / len(intervals))

            concat_list_path = tmp_path / "concat_list.txt"
            with open(concat_list_path, "w", encoding="utf-8") as f:
                for clip in clip_files:
                    escaped = str(clip.resolve()).replace("'", "'\\''")
                    f.write(f"file '{escaped}'\n")

            if srt_path and self.config.embed_soft_subtitles and pathlib.Path(srt_path).exists():
                concat_cmd = [
                    self.config.ffmpeg_bin,
                    "-y",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(concat_list_path),
                    "-i", str(srt_path),
                    "-c:v", "copy",
                    "-c:a", "copy",
                    "-c:s", "mov_text",
                    "-metadata:s:s:0", f"language={self.config.subtitle_language}",
                    str(out_file),
                ]
            else:
                concat_cmd = [
                    self.config.ffmpeg_bin,
                    "-y",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", str(concat_list_path),
                    "-c", "copy",
                    str(out_file),
                ]

            try:
                run_cancellable(
                    concat_cmd, token=token, check=True,
                    timeout=self.config.subprocess_timeout_sec,
                )
            except Exception:
                # A cancelled or failed concatenation writes a truncated file at
                # the final path. Deleting it is the difference between "no
                # result" and "a result that looks finished but is broken".
                try:
                    out_file.unlink()
                except OSError:
                    pass
                raise
            if progress is not None:
                progress(1.0)

        return str(out_file.resolve())
