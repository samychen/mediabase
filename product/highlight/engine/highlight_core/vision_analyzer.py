"""
Clean-Room Vision & Motion Analyzer.
- Uses OpenCV (`cv2`, Apache-2.0) and NumPy (BSD) when installed for motion analysis.
- Optional, clean-license model signals (all gracefully degrade to 0 if deps absent):
    * ONNX object detection (RT-DETR / YOLOX, Apache-2.0) via `detector.py`
      -> class-aware, area-normalized object saliency
    * MediaPipe Face Detection (BlazeFace, Apache-2.0) -> face saliency
    * OpenCLIP zero-shot text guidance (MIT) -> semantic (prompt) saliency
- Falls back to FFmpeg native `signalstats` (YDIF / SATAVG) when OpenCV/NumPy absent.

SPDX-License-Identifier: Apache-2.0
"""

from dataclasses import dataclass
import math
import re
import subprocess
from typing import Callable, List, Optional, Sequence, Tuple

from .cancel import CancelToken, run_cancellable
from .config import HighlightConfig
from .detector import OnnxDetector, saturate_score

ProgressFn = Callable[[float], None]


def _percentile(sorted_vals: Sequence[float], q: float) -> float:
    if not sorted_vals:
        return 1.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = (len(sorted_vals) - 1) * (q / 100.0)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return float(sorted_vals[lo])
    frac = pos - lo
    return float(sorted_vals[lo]) * (1.0 - frac) + float(sorted_vals[hi]) * frac


@dataclass
class FrameVisionMetrics:
    """Per-sampled-frame visual analysis metrics across all available signals."""
    timestamp_sec: float
    motion_score: float
    saliency_score: float      # object saliency (class-aware, area-normalized)
    face_score: float = 0.0    # face saliency (MediaPipe)
    clip_score: float = 0.0    # zero-shot semantic guidance (OpenCLIP)


class VisionAnalyzer:
    """
    Computes multi-signal visual scores across sampled frames.
    OpenCV + ONNX Runtime (+ optional MediaPipe / OpenCLIP) when installed,
    gracefully falling back to FFmpeg native `signalstats` in minimal environments.
    """

    # CORRECT single-escape regexes (fixes prior double-escape bug).
    _PTS_TIME_RE = re.compile(r"pts_time:([0-9]+(?:\.[0-9]+)?)")
    _YDIF_RE = re.compile(r"lavfi\.signalstats\.YDIF=([0-9]+(?:\.[0-9]+)?)")
    _SATAVG_RE = re.compile(r"lavfi\.signalstats\.SATAVG=([0-9]+(?:\.[0-9]+)?)")

    def __init__(self, config: HighlightConfig):
        self.config = config
        self.detector: Optional[OnnxDetector] = None
        self.face_analyzer = None
        self.clip_guider = None

        if _HAS_OPENCV:
            if config.onnx_model_path:
                try:
                    self.detector = OnnxDetector(config)
                except Exception as exc:  # pragma: no cover - optional
                    self.detector = None
                    import warnings
                    warnings.warn(f"ONNX detector disabled: {exc}")
            if config.enable_face_detection:
                self.face_analyzer = _MediaPipeFaceAnalyzer(config)
            if config.enable_clip_guidance and config.clip_prompt:
                self.clip_guider = _OpenClipGuider(config)

    def analyze_video(
        self,
        video_path: str,
        candidate_windows: Optional[List[Tuple[float, float]]] = None,
        token: Optional[CancelToken] = None,
        progress: Optional[ProgressFn] = None,
        duration_hint: float = 0.0,
    ) -> List[FrameVisionMetrics]:
        """Scan frames, compute normalized multi-signal scores."""
        if _HAS_OPENCV:
            raw_metrics = self._analyze_with_opencv(
                video_path, candidate_windows, token, progress, duration_hint
            )
        else:
            raw_metrics = self._analyze_with_ffmpeg_signalstats(
                video_path, candidate_windows, token, progress, duration_hint
            )

        if not raw_metrics:
            return []

        motions = sorted(m[1] for m in raw_metrics)
        saliencies = sorted(m[2] for m in raw_metrics)
        faces = sorted(m[3] for m in raw_metrics)
        clips = sorted(m[4] for m in raw_metrics)

        m_max = max(_percentile(motions, 98.0), 1e-5)
        s_max = max(_percentile(saliencies, 98.0), 1e-5)
        f_max = max(_percentile(faces, 98.0), 1e-5)
        c_max = max(_percentile(clips, 98.0), 1e-5)

        results: List[FrameVisionMetrics] = []
        for ts, m_val, s_val, f_val, c_val in raw_metrics:
            results.append(
                FrameVisionMetrics(
                    timestamp_sec=ts,
                    motion_score=min(1.0, max(0.0, m_val / m_max)),
                    saliency_score=min(1.0, max(0.0, s_val / s_max)),
                    face_score=min(1.0, max(0.0, f_val / f_max)) if f_max > 1e-5 else 0.0,
                    clip_score=min(1.0, max(0.0, c_val / c_max)) if c_max > 1e-5 else 0.0,
                )
            )
        return results

    def _analyze_with_opencv(
        self,
        video_path: str,
        candidate_windows: Optional[List[Tuple[float, float]]],
        token: Optional[CancelToken] = None,
        progress: Optional[ProgressFn] = None,
        duration_hint: float = 0.0,
    ) -> List[Tuple[float, float, float, float, float]]:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return self._analyze_with_ffmpeg_signalstats(
                video_path, candidate_windows, token, progress, duration_hint
            )

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        prev_gray = None
        frame_idx = 0
        raw_metrics: List[Tuple[float, float, float, float, float]] = []

        try:
            while True:
                if frame_idx % max(1, self.config.frame_skip) != 0:
                    if not cap.grab():
                        break
                    frame_idx += 1
                    continue

                ret, frame = cap.read()
                if not ret or frame is None:
                    break

                ts = frame_idx / fps
                frame_idx += 1

                # Cooperative cancel + progress inside the scan: this loop is the
                # longest pure-Python stage, so checking only between stages
                # would make "stop" feel broken on long inputs.
                if token is not None and frame_idx % 15 == 0:
                    token.raise_if_cancelled()
                    if progress is not None and duration_hint > 0.0:
                        progress(min(1.0, ts / duration_hint))

                if candidate_windows and not self._in_windows(ts, candidate_windows):
                    continue

                small = cv2.resize(frame, (320, 180), interpolation=cv2.INTER_AREA)
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                gray_blur = cv2.GaussianBlur(gray, (5, 5), 0)

                if prev_gray is not None:
                    diff = cv2.absdiff(gray_blur, prev_gray)
                    motion_val = float(np.mean(diff)) / 255.0
                else:
                    motion_val = 0.0
                prev_gray = gray_blur

                saliency_val, face_val, clip_val = self._score_signals(frame, small)
                raw_metrics.append((ts, motion_val, saliency_val, face_val, clip_val))
        finally:
            cap.release()

        return raw_metrics

    def _score_signals(self, frame, small) -> Tuple[float, float, float]:
        """Compute object / face / clip saliency for one frame."""
        saliency_val = 0.0
        face_val = 0.0
        clip_val = 0.0

        if self.detector is not None:
            try:
                dets = self.detector.detect(frame)
                saliency_val = OnnxDetector.saliency_from_detections(
                    dets, self.config.saliency_class_weights
                )
            except Exception:  # pragma: no cover - model runtime edge cases
                saliency_val = 0.0

        if saliency_val <= 0.0 and self.detector is None:
            # Cheap Sobel-based fallback when no ONNX model is configured.
            gx = cv2.Sobel(gray_fallback(small), cv2.CV_32F, 1, 0, ksize=3)
            gy = cv2.Sobel(gray_fallback(small), cv2.CV_32F, 0, 1, ksize=3)
            mag = cv2.magnitude(gx, gy)
            saliency_val = float(np.mean(mag)) / 255.0

        if self.face_analyzer is not None:
            face_val = self.face_analyzer.score(frame)

        if self.clip_guider is not None:
            clip_val = self.clip_guider.score(small)

        return saliency_val, face_val, clip_val

    def _analyze_with_ffmpeg_signalstats(
        self,
        video_path: str,
        candidate_windows: Optional[List[Tuple[float, float]]],
        token: Optional[CancelToken] = None,
        progress: Optional[ProgressFn] = None,
        duration_hint: float = 0.0,
    ) -> List[Tuple[float, float, float, float, float]]:
        """
        Zero-dependency fallback using FFmpeg's native `signalstats` filter.
        Face / clip signals are unavailable in this minimal path (left at 0.0).
        """
        step = max(1, self.config.frame_skip)
        filter_expr = (
            f"select='not(mod(n,{step}))',"
            "scale=160:90,"
            "signalstats,"
            "metadata=print:file=-"
        )
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
            cmd, token=token, check=False,
            timeout=self.config.subprocess_timeout_sec,
        )
        if res.returncode != 0:
            return []

        raw_metrics: List[Tuple[float, float, float, float, float]] = []
        current_pts: Optional[float] = None
        current_ydif: float = 0.0
        current_sat: float = 0.0

        for line in res.stdout.splitlines():
            pts_match = self._PTS_TIME_RE.search(line)
            if pts_match:
                if current_pts is not None:
                    if not candidate_windows or self._in_windows(current_pts, candidate_windows):
                        raw_metrics.append((current_pts, current_ydif, current_sat, 0.0, 0.0))
                current_pts = float(pts_match.group(1))
                current_ydif = 0.0
                current_sat = 0.0
                if progress is not None and duration_hint > 0.0:
                    progress(min(1.0, current_pts / duration_hint))
                continue

            ydif_match = self._YDIF_RE.search(line)
            if ydif_match:
                current_ydif = float(ydif_match.group(1)) / 255.0
                continue

            sat_match = self._SATAVG_RE.search(line)
            if sat_match:
                current_sat = float(sat_match.group(1)) / 255.0

        if current_pts is not None:
            if not candidate_windows or self._in_windows(current_pts, candidate_windows):
                raw_metrics.append((current_pts, current_ydif, current_sat, 0.0, 0.0))

        return raw_metrics

    @staticmethod
    def _in_windows(ts: float, windows: List[Tuple[float, float]]) -> bool:
        for start, end in windows:
            if start <= ts <= end:
                return True
        return False


def gray_fallback(small):
    """Convert a small BGR frame to grayscale (helper for Sobel fallback)."""
    return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)


class _MediaPipeFaceAnalyzer:
    """Optional face saliency via MediaPipe Face Detection (Apache-2.0)."""

    def __init__(self, config: HighlightConfig):
        import mediapipe as mp  # type: ignore

        self.mp_face = mp.solutions.face_detection
        self.detector = self.mp_face.FaceDetection(
            model_selection=1, min_detection_confidence=0.5
        )

    def score(self, frame) -> float:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.detector.process(rgb)
        if not results.detections:
            return 0.0
        total = 0.0
        for det in results.detections:
            rel = det.location_data.relative_bounding_box
            score = det.score[0] if det.score else 0.5
            area = max(0.0, rel.width) * max(0.0, rel.height)
            total += area * float(score)
        return saturate_score(total)


class _OpenClipGuider:
    """Optional zero-shot semantic guidance via OpenCLIP (MIT)."""

    def __init__(self, config: HighlightConfig):
        import open_clip  # type: ignore
        import torch  # type: ignore

        self.torch = torch
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            config.clip_model_name, pretrained=config.clip_pretrained
        )
        self.model.eval()
        self.tokenizer = open_clip.get_tokenizer(config.clip_model_name)
        with torch.no_grad():
            text = self.tokenizer([config.clip_prompt])
            self.text_features = self.model.encode_text(text)
            self.text_features /= self.text_features.norm(dim=-1, keepdim=True)

    def score(self, small) -> float:
        from PIL import Image  # type: ignore

        torch = self.torch
        image = Image.fromarray(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
        img_t = self.preprocess(image).unsqueeze(0)
        with torch.no_grad():
            image_features = self.model.encode_image(img_t)
            image_features /= image_features.norm(dim=-1, keepdim=True)
            similarity = (image_features @ self.text_features.T).item()
        # Map cosine similarity [-1, 1] -> [0, 1].
        return max(0.0, min(1.0, (similarity + 1.0) / 2.0))


try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    _HAS_OPENCV = True
except ImportError:
    cv2 = None  # type: ignore
    np = None  # type: ignore
    _HAS_OPENCV = False
