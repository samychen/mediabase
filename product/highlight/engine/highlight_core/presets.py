"""
Content-type weight presets for multi-modal highlight scoring.

A preset is ONLY a weight vector — it never toggles a signal or forces a model
dependency. The caller still decides which signals run (face / clip / whisper);
a preset just says how much each available signal should count for a given kind
of video. "general" is the engine's historical default, so selecting it changes
nothing.

These vectors are hand-tuned STARTING POINTS, not learned parameters: they encode
the obvious priors (a talking-head interview lives on faces and speech, a music
clip lives on audio dynamics, gameplay lives on motion). Treat them as a sensible
default to override with an explicit `weights` choice, not ground truth.

SPDX-License-Identifier: Apache-2.0
"""

from typing import Dict, List, Tuple

from .config import ScoringWeights

# Field order matches ScoringWeights:
#   scene_cut, audio_rms, visual_motion, object_saliency,
#   face_saliency, clip_guidance, keyword_match
# Each vector sums to 1.0 (normalized() is idempotent on it).
PRESET_WEIGHTS: Dict[str, Tuple[float, ...]] = {
    "general": (0.18, 0.22, 0.18, 0.16, 0.10, 0.10, 0.06),
    # Fast action + crowd/commentary peaks + replay cuts; faces rarely matter.
    "sports": (0.20, 0.25, 0.25, 0.12, 0.05, 0.08, 0.05),
    # Static talking head: the speaker's face and what is said carry the moment.
    "interview": (0.08, 0.18, 0.05, 0.05, 0.30, 0.10, 0.24),
    # On-screen motion and semantic events dominate; a webcam face is incidental.
    "gameplay": (0.15, 0.18, 0.30, 0.17, 0.03, 0.12, 0.05),
    # Audio dynamics (beats, drops, crescendos) are the highlight; words are not.
    "music": (0.12, 0.45, 0.18, 0.08, 0.07, 0.07, 0.03),
}

# Concrete, selectable presets. "auto" is a resolution strategy (CLIP), not a
# weight vector, so it is deliberately absent here.
PRESET_NAMES: List[str] = list(PRESET_WEIGHTS)


def preset_weights(name: str) -> ScoringWeights:
    """Return the weight vector for a concrete preset name.

    Raises KeyError for an unknown name; callers validate membership first and
    fall back to "general" so a typo never crashes a job.
    """
    return ScoringWeights(*PRESET_WEIGHTS[name])