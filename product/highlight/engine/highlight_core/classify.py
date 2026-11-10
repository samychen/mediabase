"""
Zero-shot content-type classification via OpenCLIP (MIT).

Samples a handful of frames spread across the video and asks CLIP which type
prompt fits best, mapping the winner to a weight preset. This is a COARSE PRIOR,
not a learned classifier: the prompts are hand-written and the decision is a
cosine-similarity argmax over averaged embeddings. It exists so `contentPreset=
auto` can pick a sensible starting recipe without the caller labelling the video.

Honest degradation: whenever OpenCV or OpenCLIP is missing, the video cannot be
sampled, or the model fails to load/run, it returns "general" with a recorded
reason instead of raising. `auto` therefore never hard-fails a job — it falls
back to the default recipe and says so in the report.

Cost note: this loads the CLIP checkpoint (ViT-B-32, ~350 MB). setup-models.sh
pre-caches it so a normal deployment loads from disk; a deployment that skipped
that step pays a one-time download. If clipGuidance is ALSO enabled the guider
loads its own copy — the two are not shared yet.

SPDX-License-Identifier: Apache-2.0
"""

from typing import Any, Dict, List, Optional, Tuple

from .cancel import Cancelled, CancelToken
from .config import HighlightConfig

# preset name -> prompts. Several phrasings per type average out wording bias.
# The keys are exactly the concrete preset names (presets.PRESET_NAMES).
TYPE_PROMPTS: Dict[str, List[str]] = {
    "sports": [
        "a sports match with athletes on a field",
        "a stadium crowd watching a game",
        "fast athletic action with a ball in play",
    ],
    "interview": [
        "a person speaking to the camera in a close-up",
        "a talk show or podcast interview",
        "a talking head discussing a topic",
    ],
    "gameplay": [
        "a video game screen with a HUD overlay",
        "gameplay footage of a virtual world",
        "an esports match of a computer game",
    ],
    "music": [
        "a musical performance on a stage",
        "a music video with a singer or band",
        "a concert with instruments and stage lighting",
    ],
    "general": [
        "generic everyday footage",
        "a home video of ordinary scenes",
    ],
}

_SAMPLE_FRAMES = 12


def classify_content(
    video_path: str,
    config: HighlightConfig,
    duration_sec: float,
    token: Optional[CancelToken] = None,
) -> Tuple[str, Dict[str, Any]]:
    """Return (preset_name, info). `info` is report-ready: scores, frame count,
    model id, and a degradation reason when it could not run."""
    base: Dict[str, Any] = {
        "method": "clip",
        "model": f"{config.clip_model_name}/{config.clip_pretrained}",
    }

    def degraded(reason: str, frames: int = 0) -> Tuple[str, Dict[str, Any]]:
        return "general", {
            **base, "degraded": True, "reason": reason,
            "scores": {}, "frames_sampled": frames,
        }

    try:
        import cv2  # type: ignore
    except ImportError:
        return degraded("opencv-unavailable")
    try:
        import open_clip  # type: ignore
        import torch  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError:
        return degraded("openclip-unavailable")

    # Sample frames evenly across the timeline. Seek by frame index; fall back
    # to the container's frame count when no duration hint is available.
    frames: List[Any] = []
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return degraded("video-open-failed")
        try:
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            total = int(duration_sec * fps) if duration_sec > 0 else 0
            if total <= 0:
                total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            if total <= 0:
                return degraded("no-frames")
            for i in range(_SAMPLE_FRAMES):
                if token is not None:
                    token.raise_if_cancelled()
                idx = int(total * (i + 0.5) / _SAMPLE_FRAMES)
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ret, frame = cap.read()
                if ret and frame is not None:
                    frames.append(cv2.resize(frame, (320, 180)))
        finally:
            cap.release()
    except Cancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - sampling must degrade, not crash
        return degraded(f"frame-sampling-failed: {type(exc).__name__}: {exc}")

    if not frames:
        return degraded("no-frames")

    try:
        model, _, preprocess = open_clip.create_model_and_transforms(
            config.clip_model_name, pretrained=config.clip_pretrained
        )
        model.eval()
        tokenizer = open_clip.get_tokenizer(config.clip_model_name)
        with torch.no_grad():
            type_feats = {}
            for name, prompts in TYPE_PROMPTS.items():
                tf = model.encode_text(tokenizer(prompts))
                tf = tf / tf.norm(dim=-1, keepdim=True)
                tf = tf.mean(dim=0)
                type_feats[name] = tf / tf.norm()
            batch = torch.stack([
                preprocess(Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)))
                for f in frames
            ])
            imf = model.encode_image(batch)
            imf = imf / imf.norm(dim=-1, keepdim=True)
            imf = imf.mean(dim=0)
            imf = imf / imf.norm()
            # Cosine [-1,1] -> [0,1] so the report reads as a confidence-like score.
            scores = {
                name: round(float((imf @ tf).item() + 1.0) / 2.0, 4)
                for name, tf in type_feats.items()
            }
    except Cancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - model load/inference must degrade
        return degraded(f"clip-failed: {type(exc).__name__}: {exc}", len(frames))

    winner = max(scores, key=lambda k: scores[k])
    return winner, {
        **base, "degraded": False, "reason": None,
        "scores": scores, "frames_sampled": len(frames), "winner": winner,
    }