"""
Configuration & Hyperparameters for the Video Highlight Engine.
SPDX-License-Identifier: Apache-2.0
"""

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class ScoringWeights:
    """Weights for multi-modal feature fusion (automatically normalized at runtime)."""
    scene_cut: float = 0.18
    audio_rms: float = 0.22
    visual_motion: float = 0.18
    object_saliency: float = 0.16
    face_saliency: float = 0.10
    clip_guidance: float = 0.10
    keyword_match: float = 0.06

    def normalized(self) -> "ScoringWeights":
        total = (
            self.scene_cut
            + self.audio_rms
            + self.visual_motion
            + self.object_saliency
            + self.face_saliency
            + self.clip_guidance
            + self.keyword_match
        )
        if total <= 0:
            return ScoringWeights(0.16, 0.16, 0.16, 0.16, 0.12, 0.12, 0.12)
        return ScoringWeights(
            scene_cut=self.scene_cut / total,
            audio_rms=self.audio_rms / total,
            visual_motion=self.visual_motion / total,
            object_saliency=self.object_saliency / total,
            face_saliency=self.face_saliency / total,
            clip_guidance=self.clip_guidance / total,
            keyword_match=self.keyword_match / total,
        )


@dataclass
class HighlightConfig:
    """Global configuration for video analysis, scoring, and synthesis."""
    # External Binary Paths (process isolation for LGPL compliance)
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"

    # Robustness
    subprocess_timeout_sec: float = 600.0

    # Timeline & Resolution
    time_bin_sec: float = 0.5
    clip_duration_sec: float = 6.0
    max_highlights: int = 5
    min_gap_sec: float = 1.5

    # Narrative Context Expansion (avoids jarring 1s cuts; mirrors Sliver)
    context_lead_in_sec: float = 1.2
    context_lead_out_sec: float = 1.2
    context_merge_gap_sec: float = 0.75

    # Stage 1: Coarse FFmpeg Filter Parameters
    scene_threshold: float = 0.25
    audio_sample_chunk: int = 22050

    # Stage 2: Fine Vision & Motion Analysis Parameters
    frame_skip: int = 5
    onnx_model_path: Optional[str] = None
    onnx_model_format: str = "yolox"  # "yolox" | "rtdetr"
    onnx_input_size: int = 640
    onnx_conf_threshold: float = 0.35
    onnx_iou_threshold: float = 0.45
    # Per-class saliency weights (class_name -> weight); empty = uniform 1.0
    saliency_class_weights: dict = field(default_factory=dict)
    # ONNX Runtime execution providers; auto-falls back to CPU if unavailable
    ort_providers: Optional[List[str]] = None
    enable_face_detection: bool = False  # MediaPipe Face Detection (Apache-2.0)
    enable_clip_guidance: bool = False   # OpenCLIP zero-shot text guidance (MIT)
    clip_prompt: str = ""                # e.g. "a goal celebration, a person speaking"
    clip_model_name: str = "ViT-B-32"     # OpenCLIP model id
    clip_pretrained: str = "laion2b_s34b_b79k"

    # Stage 3: Subtitle & Local LLM Translation Parameters
    enable_whisper: bool = True
    whisper_model_size: str = "base"
    whisper_device: str = "auto"
    subtitle_language: str = "zho"  # emitted soft-subtitle track language code
    keywords: List[str] = field(default_factory=list)
    ollama_url: str = "http://127.0.0.1:11434/api/generate"
    ollama_model: str = "qwen2.5:7b"
    translate_to_lang: Optional[str] = None

    # Stage 4: Rendering & Export Parameters
    # Use stream copy (-c copy) by default to avoid GPL encoder dependencies (x264/x265)
    fast_stream_copy: bool = True
    # Frame-accurate mode re-encodes each cut with -ss placed AFTER -i (decode seek)
    frame_accurate: bool = False
    fallback_video_codec: str = "libopenh264"
    fallback_audio_codec: str = "aac"
    embed_soft_subtitles: bool = True

    # Caching
    enable_content_cache: bool = True
    cache_dir: str = ".vhe_cache"

    # Multi-modal Weights
    weights: ScoringWeights = field(default_factory=ScoringWeights)
