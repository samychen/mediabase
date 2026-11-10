"""
Multi-Modal Timeline Scoring, Narrative Context Expansion & NMS Highlight Selector.
Aligns asynchronous feature streams (FFmpeg scene cuts, audio RMS energy, vision
motion/object/face/clip saliency, and Whisper keyword hits) onto a unified temporal
grid, expands selected windows with lead-in/reaction context (avoids jarring cuts),
and extracts optimal highlight intervals.

Zero-Dependency Pure Python Engine (with optional NumPy acceleration):
Works out-of-the-box on any standard Python 3.9–3.13+ installation without requiring `numpy`.

SPDX-License-Identifier: Apache-2.0
"""

from dataclasses import dataclass
import math
from typing import Dict, List, Optional, Sequence, Tuple

from .config import HighlightConfig, ScoringWeights
from .vision_analyzer import FrameVisionMetrics


def _std(values: Sequence[float]) -> float:
    """Population standard deviation (pure Python). Used only for RELATIVE
    signal activity, so the n vs n-1 choice is immaterial."""
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    return math.sqrt(sum((v - mean) ** 2 for v in values) / n)


def _percentile(sorted_vals: Sequence[float], q: float) -> float:
    """Compute the q-th percentile (0 <= q <= 100) of a sorted numeric sequence."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = (len(sorted_vals) - 1) * (q / 100.0)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return float(sorted_vals[lo])
    frac = pos - lo
    return float(sorted_vals[lo]) * (1.0 - frac) + float(sorted_vals[hi]) * frac


def _interp_1d(num_bins: int, valid_indices: List[int], valid_values: List[float]) -> List[float]:
    """Pure-Python 1D linear interpolation across missing time bins."""
    if not valid_indices:
        return [0.0] * num_bins
    out = [0.0] * num_bins
    first_idx = valid_indices[0]
    last_idx = valid_indices[-1]

    for i in range(first_idx + 1):
        out[i] = valid_values[0]
    for i in range(last_idx, num_bins):
        out[i] = valid_values[-1]

    for k in range(len(valid_indices) - 1):
        i0, i1 = valid_indices[k], valid_indices[k + 1]
        v0, v1 = valid_values[k], valid_values[k + 1]
        span = i1 - i0
        for i in range(i0, i1 + 1):
            t = (i - i0) / span if span > 0 else 0.0
            out[i] = v0 * (1.0 - t) + v1 * t
    return out


def _mean_slice(arr: Sequence[float], start: int, end: int) -> float:
    sub = arr[start:end]
    return sum(sub) / len(sub) if sub else 0.0


@dataclass
class HighlightSegment:
    """Selected highlight clip with composite and per-modality breakdown scores."""
    start_sec: float
    end_sec: float
    composite_score: float
    modality_breakdown: Dict[str, float]


class MultiModalScorer:
    """Fuses multi-modal signals, expands narrative context, and extracts top-K clips."""

    def __init__(self, config: HighlightConfig):
        self.config = config
        # Post-call state: after score_and_select these describe the fusion that
        # ACTUALLY ran (base weights, then adaptive dampening of flat signals).
        # The pipeline reads them into the report so the recipe is auditable.
        self.effective_weights: ScoringWeights = config.weights.normalized()
        self.signal_activity: Optional[Dict[str, float]] = None

    def score_and_select(
        self,
        duration_sec: float,
        scene_events: List[Tuple[float, float]],
        audio_events: List[Tuple[float, float]],
        vision_metrics: List[FrameVisionMetrics],
        keyword_hits: List[Tuple[float, float, float]],
    ) -> Tuple[List[HighlightSegment], List[Dict[str, float]]]:
        """
        Discretize timeline into `time_bin_sec` bins, compute weighted multi-modal scores,
        apply sliding-window NMS to select top-K clips, then expand each with narrative
        lead-in/reaction context and merge adjacent clips. Returns:
          1. Chronologically ordered top-K `HighlightSegment` clips
          2. Full timeline bin array for visualization / Timeline Viewer UI
        """
        bin_dt = max(0.1, self.config.time_bin_sec)
        num_bins = max(1, int(math.ceil(duration_sec / bin_dt)))

        scene_grid = [0.0] * num_bins
        audio_grid = [0.0] * num_bins
        motion_grid = [0.0] * num_bins
        saliency_grid = [0.0] * num_bins
        face_grid = [0.0] * num_bins
        clip_grid = [0.0] * num_bins
        keyword_grid = [0.0] * num_bins

        # 1. Scene Cut Grid
        thresh = max(0.05, self.config.scene_threshold)
        for ts, score in scene_events:
            idx = min(num_bins - 1, max(0, int(ts / bin_dt)))
            norm_s = min(1.0, score / thresh)
            if norm_s > scene_grid[idx]:
                scene_grid[idx] = norm_s

        # 2. Audio RMS Grid
        audio_counts = [0] * num_bins
        for ts, energy in audio_events:
            idx = min(num_bins - 1, max(0, int(ts / bin_dt)))
            audio_grid[idx] += energy
            audio_counts[idx] += 1

        nonzero_audio_vals: List[float] = []
        for i in range(num_bins):
            if audio_counts[i] > 0:
                audio_grid[i] /= audio_counts[i]
                nonzero_audio_vals.append(audio_grid[i])

        if nonzero_audio_vals and max(nonzero_audio_vals) > 1e-5:
            sorted_a = sorted(nonzero_audio_vals)
            p5 = _percentile(sorted_a, 5.0)
            p98 = _percentile(sorted_a, 98.0)
            span = max(1e-5, p98 - p5)
            for i in range(num_bins):
                if audio_counts[i] > 0:
                    audio_grid[i] = min(1.0, max(0.0, (audio_grid[i] - p5) / span))

        # 3. Vision Motion / Object / Face / Clip Grids
        v_counts = [0] * num_bins
        for vm in vision_metrics:
            idx = min(num_bins - 1, max(0, int(vm.timestamp_sec / bin_dt)))
            motion_grid[idx] += vm.motion_score
            saliency_grid[idx] += vm.saliency_score
            face_grid[idx] += vm.face_score
            clip_grid[idx] += vm.clip_score
            v_counts[idx] += 1

        valid_v_idx: List[int] = []
        valid_motion: List[float] = []
        valid_saliency: List[float] = []
        valid_face: List[float] = []
        valid_clip: List[float] = []
        for i in range(num_bins):
            if v_counts[i] > 0:
                motion_grid[i] /= v_counts[i]
                saliency_grid[i] /= v_counts[i]
                face_grid[i] /= v_counts[i]
                clip_grid[i] /= v_counts[i]
                valid_v_idx.append(i)
                valid_motion.append(motion_grid[i])
                valid_saliency.append(saliency_grid[i])
                valid_face.append(face_grid[i])
                valid_clip.append(clip_grid[i])

        if valid_v_idx and len(valid_v_idx) < num_bins:
            motion_grid = _interp_1d(num_bins, valid_v_idx, valid_motion)
            saliency_grid = _interp_1d(num_bins, valid_v_idx, valid_saliency)
            face_grid = _interp_1d(num_bins, valid_v_idx, valid_face)
            clip_grid = _interp_1d(num_bins, valid_v_idx, valid_clip)

        # 4. Keyword Hit Grid
        for start_s, end_s, kw_score in keyword_hits:
            i_start = min(num_bins - 1, max(0, int(start_s / bin_dt)))
            i_end = min(num_bins - 1, max(i_start, int(math.ceil(end_s / bin_dt))))
            for i in range(i_start, i_end + 1):
                if kw_score > keyword_grid[i]:
                    keyword_grid[i] = kw_score

        # 5. Weighted Multi-Modal Fusion
        w = self.config.weights.normalized()
        self.signal_activity = None
        if self.config.adaptive_weights:
            grids = {
                "scene_cut": scene_grid,
                "audio_rms": audio_grid,
                "visual_motion": motion_grid,
                "object_saliency": saliency_grid,
                "face_saliency": face_grid,
                "clip_guidance": clip_grid,
                "keyword_match": keyword_grid,
            }
            w, self.signal_activity = self._adaptive_weights(w, grids)
        self.effective_weights = w
        composite_grid = [0.0] * num_bins
        timeline_series: List[Dict[str, float]] = []

        for i in range(num_bins):
            c_val = (
                w.scene_cut * scene_grid[i]
                + w.audio_rms * audio_grid[i]
                + w.visual_motion * motion_grid[i]
                + w.object_saliency * saliency_grid[i]
                + w.face_saliency * face_grid[i]
                + w.clip_guidance * clip_grid[i]
                + w.keyword_match * keyword_grid[i]
            )
            composite_grid[i] = c_val
            timeline_series.append(
                {
                    "time_sec": round(i * bin_dt, 2),
                    "composite": round(c_val, 4),
                    "scene": round(scene_grid[i], 4),
                    "audio": round(audio_grid[i], 4),
                    "motion": round(motion_grid[i], 4),
                    "saliency": round(saliency_grid[i], 4),
                    "face": round(face_grid[i], 4),
                    "clip": round(clip_grid[i], 4),
                    "keyword": round(keyword_grid[i], 4),
                }
            )

        # 6. Sliding-Window Integral + Non-Maximum Suppression (NMS)
        clip_bins = max(1, int(round(self.config.clip_duration_sec / bin_dt)))
        gap_bins = max(0, int(round(self.config.min_gap_sec / bin_dt)))

        if clip_bins >= num_bins:
            return (
                [
                    HighlightSegment(
                        start_sec=0.0,
                        end_sec=round(duration_sec, 3),
                        composite_score=round(_mean_slice(composite_grid, 0, num_bins), 4),
                        modality_breakdown=self._breakdown(
                            scene_grid, audio_grid, motion_grid, saliency_grid,
                            face_grid, clip_grid, keyword_grid, 0, num_bins,
                        ),
                    )
                ],
                timeline_series,
            )

        num_windows = num_bins - clip_bins + 1
        working_scores = [
            _mean_slice(composite_grid, idx, idx + clip_bins)
            for idx in range(num_windows)
        ]

        selected: List[HighlightSegment] = []
        for _ in range(self.config.max_highlights):
            best_idx = -1
            best_score = -1.0
            for idx, val in enumerate(working_scores):
                if val > best_score:
                    best_score = val
                    best_idx = idx

            if best_idx < 0 or best_score <= 0.0:
                break

            start_bin = best_idx
            end_bin = min(num_bins, start_bin + clip_bins)
            start_sec = round(start_bin * bin_dt, 3)
            end_sec = round(min(duration_sec, end_bin * bin_dt), 3)

            selected.append(
                HighlightSegment(
                    start_sec=start_sec,
                    end_sec=end_sec,
                    composite_score=round(best_score, 4),
                    modality_breakdown=self._breakdown(
                        scene_grid, audio_grid, motion_grid, saliency_grid,
                        face_grid, clip_grid, keyword_grid,
                        start_bin, end_bin,
                    ),
                )
            )

            suppress_start = max(0, best_idx - clip_bins - gap_bins + 1)
            suppress_end = min(num_windows, best_idx + clip_bins + gap_bins)
            for s_idx in range(suppress_start, suppress_end):
                working_scores[s_idx] = -1.0

        selected.sort(key=lambda seg: seg.start_sec)

        # 7. Narrative Context Expansion + Merge (enterprise: avoid jarring cuts)
        expanded = self._expand_context(selected, duration_sec, bin_dt)

        return expanded, timeline_series

    def _adaptive_weights(
        self,
        base: ScoringWeights,
        grids: Dict[str, List[float]],
    ) -> Tuple[ScoringWeights, Dict[str, float]]:
        """Dampen signals that barely vary on THIS video, then renormalise.

        A near-constant grid adds the same offset to every window, so it cannot
        help RANK highlights — its weight is better spent on signals that move.
        This is the direct remedy for a saturated signal (e.g. object saliency
        pinned at 1.0 on a busy frame): its std collapses, its weight shrinks,
        and the discriminative signals regain influence.

        Each weight is scaled by `floor + (1-floor) * activity`, where activity
        is the signal's std relative to the most-varying signal. The floor keeps
        a flat signal present (not deleted); renormalisation preserves sum=1.
        When EVERY grid is constant the factors are uniform and the base weights
        survive unchanged — there is nothing to prefer, so we prefer nothing.

        Returns (effective_weights, activity) where activity[name] in [0,1] is
        the relative variation, exposed for the report.
        """
        stds = {name: _std(grid) for name, grid in grids.items()}
        max_std = max(max(stds.values()), 1e-6)
        activity = {name: stds[name] / max_std for name in grids}
        floor = 0.1
        raw = {
            name: getattr(base, name) * (floor + (1.0 - floor) * activity[name])
            for name in grids
        }
        total = sum(raw.values())
        if total <= 0:
            return base, activity
        effective = ScoringWeights(**{name: raw[name] / total for name in grids})
        return effective, activity

    def _breakdown(self, sg, ag, mg, slg, fg, cg, kg, start, end) -> Dict[str, float]:
        return {
            "scene": round(_mean_slice(sg, start, end), 4),
            "audio": round(_mean_slice(ag, start, end), 4),
            "motion": round(_mean_slice(mg, start, end), 4),
            "saliency": round(_mean_slice(slg, start, end), 4),
            "face": round(_mean_slice(fg, start, end), 4),
            "clip": round(_mean_slice(cg, start, end), 4),
            "keyword": round(_mean_slice(kg, start, end), 4),
        }

    def _expand_context(
        self,
        segments: List[HighlightSegment],
        duration_sec: float,
        bin_dt: float,
    ) -> List[HighlightSegment]:
        """
        Expand each selected window by lead-in / reaction context, then merge clips
        separated by less than `context_merge_gap_sec`. Each merged clip keeps the
        composite score and modality breakdown of the strongest original segment it
        overlaps (the score is NOT recomputed over the expanded span).
        """
        lead_in = self.config.context_lead_in_sec
        lead_out = self.config.context_lead_out_sec
        merge_gap = self.config.context_merge_gap_sec

        if not segments:
            return []

        # Expand (clamped to media bounds) and convert to (start,end) tuples.
        expanded = [
            (max(0.0, s.start_sec - lead_in), min(duration_sec, s.end_sec + lead_out))
            for s in segments
        ]
        expanded.sort(key=lambda x: x[0])

        # Merge adjacent intervals within merge_gap.
        merged: List[Tuple[float, float]] = []
        for st, en in expanded:
            if merged and st <= merged[-1][1] + merge_gap:
                merged[-1] = (merged[-1][0], max(merged[-1][1], en))
            else:
                merged.append((st, en))

        # Map merged spans back to a composite score using original segment scores.
        # Preserve the strongest underlying composite for the merged clip.
        result: List[HighlightSegment] = []
        for st, en in merged:
            best = None
            for seg in segments:
                # overlap with original (pre-expansion) segment
                ov = min(seg.end_sec, en) - max(seg.start_sec, st)
                if ov > 0 and (best is None or seg.composite_score > best.composite_score):
                    best = seg
            score = best.composite_score if best else 0.0
            breakdown = best.modality_breakdown if best else {}
            result.append(
                HighlightSegment(
                    start_sec=round(st, 3),
                    end_sec=round(en, 3),
                    composite_score=score,
                    modality_breakdown=breakdown,
                )
            )
        return result
