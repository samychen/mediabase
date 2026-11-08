"""
Subtitle Generation, Timeline Remapping & Local LLM Translation Engine.
- Integrates with `faster-whisper` (MIT License) when available, or ingests existing SRTs.
- Remaps subtitle timestamps accurately across concatenated highlight cuts.
- Connects to local Ollama API (`http://127.0.0.1:11434`) for 100% offline translation.

SPDX-License-Identifier: Apache-2.0
"""

from dataclasses import dataclass
import json
import pathlib
import re
from typing import List, Optional, Tuple
import urllib.error
import urllib.request

from .config import HighlightConfig


@dataclass
class SubtitleSegment:
    """Single subtitle cue with start/end timestamps in seconds."""
    start_sec: float
    end_sec: float
    text: str


class SubtitleEngine:
    """Manages speech-to-text transcription, keyword matching, SRT remapping, and Ollama translation."""

    _SRT_TIME_RE = re.compile(
        r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
    )

    def __init__(self, config: HighlightConfig):
        self.config = config

    def transcribe_or_load(
        self, video_path: str, external_srt_path: Optional[str] = None
    ) -> List[SubtitleSegment]:
        """
        Load subtitles from an external SRT file if provided, or run `faster-whisper` (MIT)
        locally if installed and enabled.
        """
        if external_srt_path and pathlib.Path(external_srt_path).exists():
            return self.parse_srt(external_srt_path)

        if not self.config.enable_whisper:
            return []

        try:
            # Before CTranslate2 loads its own OpenMP runtime: if torch already
            # initialised a different copy in this process, the second one
            # aborts the interpreter mid-analysis. See openmp_guard.py.
            from .openmp_guard import repair_duplicate_openmp

            repair_duplicate_openmp()

            from faster_whisper import WhisperModel  # type: ignore

            device = self.config.whisper_device
            if device == "auto":
                device = "cpu"
            model = WhisperModel(
                self.config.whisper_model_size,
                device=device,
                compute_type="int8",
            )
            segments_iter, _ = model.transcribe(video_path, beam_size=5)
            return [
                SubtitleSegment(
                    start_sec=float(seg.start),
                    end_sec=float(seg.end),
                    text=seg.text.strip(),
                )
                for seg in segments_iter
                if seg.text.strip()
            ]
        except ImportError:
            # faster-whisper is optional in lightweight deployments
            return []
        except Exception:
            return []

    def score_keyword_hits(
        self, segments: List[SubtitleSegment]
    ) -> List[Tuple[float, float, float]]:
        """
        Evaluate subtitle segments against configured target keywords.
        Returns a list of (start_sec, end_sec, keyword_score) in [0.0, 1.0].
        """
        if not segments or not self.config.keywords:
            return []

        lowered_kw = [k.lower().strip() for k in self.config.keywords if k.strip()]
        if not lowered_kw:
            return []

        scored: List[Tuple[float, float, float]] = []
        for seg in segments:
            text_low = seg.text.lower()
            hits = sum(1 for kw in lowered_kw if kw in text_low)
            if hits > 0:
                score = min(1.0, hits / max(1.0, len(lowered_kw) * 0.5))
                scored.append((seg.start_sec, seg.end_sec, score))
        return scored

    def remap_subtitles_for_highlights(
        self,
        segments: List[SubtitleSegment],
        highlight_intervals: List[Tuple[float, float]],
    ) -> List[SubtitleSegment]:
        """
        Remap original video subtitle timestamps so they align accurately with the
        concatenated highlight reel timeline.
        """
        remapped: List[SubtitleSegment] = []
        accumulated_offset = 0.0

        for clip_start, clip_end in highlight_intervals:
            clip_duration = max(0.0, clip_end - clip_start)
            for seg in segments:
                # Check overlap between subtitle segment and highlight clip
                overlap_start = max(clip_start, seg.start_sec)
                overlap_end = min(clip_end, seg.end_sec)
                if overlap_end > overlap_start + 0.15:
                    new_start = accumulated_offset + (overlap_start - clip_start)
                    new_end = accumulated_offset + (overlap_end - clip_start)
                    remapped.append(
                        SubtitleSegment(
                            start_sec=new_start,
                            end_sec=new_end,
                            text=seg.text,
                        )
                    )
            accumulated_offset += clip_duration

        return remapped

    def translate_via_ollama(
        self, segments: List[SubtitleSegment], target_lang: Optional[str] = None
    ) -> List[SubtitleSegment]:
        """
        Translate subtitle segments locally via Ollama HTTP API without sending data
        to any external cloud service. Gracefully returns original segments if Ollama is offline.
        """
        lang = target_lang or self.config.translate_to_lang
        if not lang or not segments:
            return segments

        translated: List[SubtitleSegment] = []
        for seg in segments:
            prompt = (
                f"Translate the following video subtitle into {lang}. "
                f"Output ONLY the translated text without quotes or explanations:\n{seg.text}"
            )
            payload = json.dumps(
                {
                    "model": self.config.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                }
            ).encode("utf-8")

            req = urllib.request.Request(
                self.config.ollama_url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=5.0) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                    trans_text = body.get("response", "").strip() or seg.text
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
                # Fallback to original text if local Ollama server is not running
                trans_text = seg.text

            translated.append(
                SubtitleSegment(
                    start_sec=seg.start_sec,
                    end_sec=seg.end_sec,
                    text=trans_text,
                )
            )
        return translated

    @classmethod
    def parse_srt(cls, srt_path: str) -> List[SubtitleSegment]:
        """Parse a standard SubRip (.srt) file into SubtitleSegment objects."""
        content = pathlib.Path(srt_path).read_text(encoding="utf-8", errors="replace")
        blocks = re.split(r"\n\s*\n", content.strip())
        segments: List[SubtitleSegment] = []

        for block in blocks:
            lines = [line.strip() for line in block.strip().splitlines() if line.strip()]
            if len(lines) < 2:
                continue
            time_line_idx = 0
            for idx, line in enumerate(lines):
                if "-->" in line:
                    time_line_idx = idx
                    break
            match = cls._SRT_TIME_RE.search(lines[time_line_idx])
            if not match:
                continue
            start_sec = cls._hms_to_sec(*match.groups()[:4])
            end_sec = cls._hms_to_sec(*match.groups()[4:8])
            text = " ".join(lines[time_line_idx + 1 :])
            if text:
                segments.append(SubtitleSegment(start_sec=start_sec, end_sec=end_sec, text=text))

        return segments

    @classmethod
    def write_srt(cls, segments: List[SubtitleSegment], output_path: str) -> str:
        """Write SubtitleSegment objects to a standard SubRip (.srt) file."""
        out = pathlib.Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        lines: List[str] = []
        for idx, seg in enumerate(segments, start=1):
            start_str = cls._sec_to_srt_time(seg.start_sec)
            end_str = cls._sec_to_srt_time(seg.end_sec)
            lines.append(f"{idx}\n{start_str} --> {end_str}\n{seg.text}\n")
        out.write_text("\n".join(lines), encoding="utf-8")
        return str(out.resolve())

    @staticmethod
    def _hms_to_sec(h: str, m: str, s: str, ms: str) -> float:
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0

    @staticmethod
    def _sec_to_srt_time(seconds: float) -> str:
        seconds = max(0.0, seconds)
        total_ms = int(round(seconds * 1000))
        ms = total_ms % 1000
        total_sec = total_ms // 1000
        s = total_sec % 60
        total_min = total_sec // 60
        m = total_min % 60
        h = total_min // 60
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
