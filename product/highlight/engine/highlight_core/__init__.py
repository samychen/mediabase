"""
Video Highlight Engine (Clean-Room Commercial Implementation)
SPDX-License-Identifier: Apache-2.0
"""

from .cancel import CancelToken, Cancelled
from .config import HighlightConfig, ScoringWeights
from .detector import Detection, OnnxDetector
from .pipeline import HighlightPipeline, PipelineResult
from .scorer import HighlightSegment, MultiModalScorer
from .vision_analyzer import FrameVisionMetrics, VisionAnalyzer

__all__ = [
    "HighlightConfig",
    "ScoringWeights",
    "HighlightPipeline",
    "PipelineResult",
    "HighlightSegment",
    "MultiModalScorer",
    "FrameVisionMetrics",
    "VisionAnalyzer",
    "OnnxDetector",
    "Detection",
    "CancelToken",
    "Cancelled",
]
__version__ = "2.1.0"
