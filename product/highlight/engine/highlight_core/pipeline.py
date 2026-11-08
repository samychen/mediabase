"""
End-to-End Video Highlight Analysis & Synthesis Orchestrator.
Coordinates FFmpeg native filtering, OpenCV vision scoring, Whisper/SRT subtitles,
Ollama local translation, and final highlight video compilation.

SPDX-License-Identifier: Apache-2.0
"""

from dataclasses import asdict, dataclass
import json
import pathlib
from typing import Any, Callable, Dict, List, Optional, Tuple

from .cancel import CancelToken
from .config import HighlightConfig
from .ffmpeg_engine import FFmpegEngine, MediaMetadata
from .scorer import HighlightSegment, MultiModalScorer
from .subtitle_engine import SubtitleEngine
from .vision_analyzer import VisionAnalyzer

# (stage name, overall completion 0.0-1.0). A UI renders the name and the
# number; an agent reads the same pair. Stages are the honest granularity —
# per-frame progress inside a stage is mapped into that stage's window.
ProgressFn = Callable[[str, float], None]

# Where each stage sits on the overall 0-1 scale. The numbers are wall-clock
# estimates for a typical 1080p VOD, not arbitrary: the vision scan dominates,
# transcription is second, rendering is short because segments are few.
_STAGE_WINDOWS: Dict[str, Tuple[float, float]] = {
    "probe": (0.00, 0.03),
    "scenes": (0.03, 0.18),
    "audio": (0.18, 0.30),
    "vision": (0.30, 0.72),
    "subtitles": (0.72, 0.85),
    "scoring": (0.85, 0.88),
    "render": (0.88, 0.99),
    "report": (0.99, 1.00),
}


@dataclass
class PipelineResult:
    """Structured result emitted by the highlight pipeline."""
    input_video: str
    output_video: str
    output_srt: Optional[str]
    timeline_report_json: str
    metadata: MediaMetadata
    highlights: List[HighlightSegment]


class HighlightPipeline:
    """Main orchestrator for commercial-compliant video highlight generation."""

    def __init__(self, config: Optional[HighlightConfig] = None):
        self.config = config or HighlightConfig()
        self.ffmpeg = FFmpegEngine(self.config)
        self.vision = VisionAnalyzer(self.config)
        self.subtitles = SubtitleEngine(self.config)
        self.scorer = MultiModalScorer(self.config)

    def run(
        self,
        video_path: str,
        output_video_path: str,
        external_srt_path: Optional[str] = None,
        report_json_path: Optional[str] = None,
        progress: Optional[ProgressFn] = None,
        token: Optional[CancelToken] = None,
    ) -> PipelineResult:
        """
        Execute the full multi-modal highlight extraction and rendering pipeline.

        `token` makes the run cancellable from ANOTHER thread (an API handler, a
        UI stop button): it reaches into the running FFmpeg, and a cancelled run
        raises `Cancelled` instead of returning a half-rendered artifact.

        `progress(stage, fraction)` fires on stage boundaries AND inside the two
        long stages (vision scan, render), so a client shows motion rather than
        a spinner that sits at 0% for minutes.
        """
        cancel = token or CancelToken()

        def emit(stage: str, within: float) -> None:
            if progress is None:
                return
            lo, hi = _STAGE_WINDOWS[stage]
            progress(stage, lo + (hi - lo) * max(0.0, min(1.0, within)))

        in_path = str(pathlib.Path(video_path).resolve())
        out_path = str(pathlib.Path(output_video_path).resolve())

        # 0. Cancellation fence: a job cancelled while queued must not start work.
        cancel.raise_if_cancelled()
        emit("probe", 0.0)

        # 1. Probe Input Video
        meta = self.ffmpeg.probe(in_path, token=cancel)
        emit("probe", 1.0)

        # 2. Coarse Stage: Native FFmpeg Scene Cut & Audio RMS Extraction
        emit("scenes", 0.0)
        scene_events = self.ffmpeg.extract_scene_scores(in_path, token=cancel)
        emit("scenes", 1.0)

        emit("audio", 0.0)
        audio_events = (
            self.ffmpeg.extract_audio_rms_profile(in_path, token=cancel)
            if meta.has_audio
            else []
        )
        emit("audio", 1.0)

        # 3. Fine Stage: OpenCV Motion & Saliency/ONNX Object Analysis
        emit("vision", 0.0)
        vision_metrics = self.vision.analyze_video(
            in_path,
            token=cancel,
            progress=lambda fraction: emit("vision", fraction),
            duration_hint=meta.duration_sec,
        )
        emit("vision", 1.0)

        # 4. Subtitle Transcription / Parsing & Keyword Scoring
        emit("subtitles", 0.0)
        raw_subs = self.subtitles.transcribe_or_load(in_path, external_srt_path)
        keyword_hits = self.subtitles.score_keyword_hits(raw_subs)
        emit("subtitles", 1.0)

        # 5. Multi-Modal Scoring & Non-Maximum Suppression (NMS)
        emit("scoring", 0.0)
        highlights, timeline_series = self.scorer.score_and_select(
            duration_sec=meta.duration_sec,
            scene_events=scene_events,
            audio_events=audio_events,
            vision_metrics=vision_metrics,
            keyword_hits=keyword_hits,
        )
        emit("scoring", 1.0)

        intervals = [(h.start_sec, h.end_sec) for h in highlights]

        # 6. Remap & Optionally Translate Subtitles via Local Ollama
        emit("render", 0.0)
        output_srt: Optional[str] = None
        if raw_subs and intervals:
            remapped_subs = self.subtitles.remap_subtitles_for_highlights(
                raw_subs, intervals
            )
            if self.config.translate_to_lang:
                remapped_subs = self.subtitles.translate_via_ollama(
                    remapped_subs, self.config.translate_to_lang
                )
            if remapped_subs:
                srt_target = str(pathlib.Path(out_path).with_suffix(".srt"))
                output_srt = self.subtitles.write_srt(remapped_subs, srt_target)

        # 7. Assemble Highlight Video via FFmpeg Concat Demuxer
        final_video = self.ffmpeg.assemble_highlights(
            video_path=in_path,
            intervals=intervals,
            output_path=out_path,
            srt_path=output_srt,
            token=cancel,
            progress=lambda fraction: emit("render", fraction),
        )

        # 8. Export Timeline & Explainability Report JSON
        emit("report", 0.0)
        if not report_json_path:
            report_json_path = str(
                pathlib.Path(out_path).with_name(
                    f"{pathlib.Path(out_path).stem}_timeline.json"
                )
            )
        report_payload: Dict[str, Any] = {
            "input_video": in_path,
            "output_video": final_video,
            "output_srt": output_srt,
            "metadata": asdict(meta),
            "config": {
                "clip_duration_sec": self.config.clip_duration_sec,
                "max_highlights": self.config.max_highlights,
                "scene_threshold": self.config.scene_threshold,
                "frame_skip": self.config.frame_skip,
                "fast_stream_copy": self.config.fast_stream_copy,
                "weights": asdict(self.config.weights.normalized()),
            },
            "selected_highlights": [asdict(h) for h in highlights],
            "timeline_series": timeline_series,
        }
        pathlib.Path(report_json_path).write_text(
            json.dumps(report_payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        emit("report", 1.0)

        return PipelineResult(
            input_video=in_path,
            output_video=final_video,
            output_srt=output_srt,
            timeline_report_json=str(pathlib.Path(report_json_path).resolve()),
            metadata=meta,
            highlights=highlights,
        )
