"""
Clean-Room ONNX Object Detector with Class-Aware, Area-Normalized Saliency Scoring.
- Uses ONNX Runtime (MIT) for inference; execution providers auto-selected
  (CUDA / TensorRT / OpenVINO -> CPU) for GPU acceleration without code changes.
- Supports "yolox" and "rtdetr" ONNX output layouts (both Apache-2.0 checkpoints).
- Replaces the previous crude `np.sum(high_conf)` box-count scoring with a
  category-weighted, area-normalized saliency signal suitable for enterprise use.

SPDX-License-Identifier: Apache-2.0
"""

from dataclasses import dataclass, field
import math
from typing import Dict, List, Optional, Tuple

from .config import HighlightConfig

# COCO 80-class names (RT-DETR / YOLOX checkpoints are typically COCO-trained).
COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]


@dataclass
class Detection:
    """A single object detection with class id, confidence, and normalized box area."""
    class_id: int
    class_name: str
    score: float
    # area as a fraction of the full frame (0.0 - 1.0)
    area_fraction: float
    # absolute box in original-frame pixel coordinates
    x1: float
    y1: float
    x2: float
    y2: float


class OnnxDetector:
    """
    ONNX Runtime-backed object detector producing class-aware detections.
    Optional dependency: `onnxruntime` (MIT). Raises ImportError with guidance
    if not installed.
    """

    def __init__(self, config: HighlightConfig):
        try:
            import onnxruntime as ort  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dep
            raise ImportError(
                "onnxruntime is required for ONNX detection. "
                "Install via `pip install onnxruntime` (or onnxruntime-gpu for CUDA)."
            ) from exc

        if not config.onnx_model_path:
            raise ValueError("onnx_model_path must be set to use OnnxDetector.")

        providers = self._select_providers(ort, config.ort_providers)
        self.session = ort.InferenceSession(
            config.onnx_model_path, providers=providers
        )
        self.input_name = self.session.get_inputs()[0].name
        # Infer model input size from the session if possible, else use config.
        shape = self.session.get_inputs()[0].shape
        self.input_size = (
            int(shape[-1]) if isinstance(shape[-1], int) and shape[-1] > 0
            else config.onnx_input_size
        )
        self.config = config
        self.class_names = COCO_CLASSES
        self.format = config.onnx_model_format

    @staticmethod
    def _select_providers(ort, preferred: Optional[List[str]]) -> List[str]:
        available = ort.get_available_providers()
        if preferred:
            ordered = [p for p in preferred if p in available]
            if ordered:
                # Always keep CPU as final fallback.
                if "CPUExecutionProvider" not in ordered:
                    ordered.append("CPUExecutionProvider")
                return ordered
        # Default: prefer any hardware EP, then CPU.
        hw = [p for p in available if p != "CPUExecutionProvider"]
        return hw + ["CPUExecutionProvider"]

    def detect(self, frame_bgr) -> List[Detection]:
        """Run detection on a single BGR frame (numpy array)."""
        import numpy as np  # type: ignore

        h0, w0 = frame_bgr.shape[:2]
        resized, ratio, (dw, dh) = self._letterbox(frame_bgr, self.input_size)
        blob = resized.transpose(2, 0, 1)[None].astype("float32") / 255.0

        outputs = self.session.run(None, {self.input_name: blob})
        raw = outputs[0]
        # Squeeze batch dim.
        if raw.ndim == 3:
            raw = raw[0]

        if self.format == "rtdetr":
            dets = self._postprocess_rtdetr(raw, w0, h0)
        else:
            dets = self._postprocess_yolox(raw, ratio, dw, dh, w0, h0)
        return dets

    def _letterbox(self, frame_bgr, size: int):
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        h, w = frame_bgr.shape[:2]
        scale = min(size / w, size / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        resized = cv2.resize(frame_bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((size, size, 3), 114, dtype="uint8")
        dw, dh = (size - nw) // 2, (size - nh) // 2
        canvas[dh:dh + nh, dw:dw + nw] = resized
        return canvas, scale, (dw, dh)

    def _postprocess_yolox(self, raw, ratio, dw, dh, w0, h0) -> List[Detection]:
        import numpy as np  # type: ignore

        conf = self.config.onnx_conf_threshold
        obj_conf = raw[:, 4]
        cls_scores = raw[:, 5:]
        # YOLOX exports either raw logits or already-sigmoid class probs.
        if cls_scores.size and float(cls_scores.max()) > 1.0:
            cls_scores = 1.0 / (1.0 + np.exp(-cls_scores))
        cls_ids = np.argmax(cls_scores, axis=1)
        cls_conf = cls_scores[np.arange(len(cls_ids)), cls_ids]
        scores = obj_conf * cls_conf
        keep = scores > conf
        if not keep.any():
            return []

        boxes = raw[keep, :4]
        scores_k = scores[keep]
        cls_k = cls_ids[keep]

        # boxes are cx, cy, w, h in letterboxed-input pixels -> original frame.
        x1 = boxes[:, 0] - dw
        y1 = boxes[:, 1] - dh
        x2 = boxes[:, 2] - dw
        y2 = boxes[:, 3] - dh
        x1 /= ratio
        y1 /= ratio
        x2 /= ratio
        y2 /= ratio
        dets: List[Detection] = []
        for i in range(len(scores_k)):
            xx1, yy1, xx2, yy2 = x1[i], y1[i], x2[i], y2[i]
            if xx2 <= xx1 or yy2 <= yy1:
                continue
            area = (float(xx2) - float(xx1)) * (float(yy2) - float(yy1)) / (w0 * h0)
            dets.append(Detection(
                class_id=int(cls_k[i]),
                class_name=self.class_names[int(cls_k[i])] if int(cls_k[i]) < len(self.class_names) else str(int(cls_k[i])),
                score=float(scores_k[i]),
                area_fraction=min(1.0, max(0.0, area)),
                x1=float(xx1), y1=float(yy1), x2=float(xx2), y2=float(yy2),
            ))
        return self._nms(dets, self.config.onnx_iou_threshold)

    def _postprocess_rtdetr(self, raw, w0, h0) -> List[Detection]:
        import numpy as np  # type: ignore

        conf = self.config.onnx_conf_threshold
        # raw: [num_queries, 4 + num_classes]; boxes normalized to original size.
        boxes = raw[:, :4]
        logits = raw[:, 4:]
        probs = 1.0 / (1.0 + np.exp(-logits))
        cls_ids = np.argmax(probs, axis=1)
        cls_conf = probs[np.arange(len(cls_ids)), cls_ids]
        keep = cls_conf > conf
        if not keep.any():
            return []

        boxes_k = boxes[keep]
        scores_k = cls_conf[keep]
        cls_k = cls_ids[keep]
        cx, cy, w, h = boxes_k[:, 0], boxes_k[:, 1], boxes_k[:, 2], boxes_k[:, 3]
        x1 = (cx - w / 2)
        y1 = (cy - h / 2)
        x2 = (cx + w / 2)
        y2 = (cy + h / 2)
        dets: List[Detection] = []
        for i in range(len(scores_k)):
            xx1, yy1, xx2, yy2 = x1[i] * w0, y1[i] * h0, x2[i] * w0, y2[i] * h0
            if xx2 <= xx1 or yy2 <= yy1:
                continue
            area = (float(xx2) - float(xx1)) * (float(yy2) - float(yy1)) / (w0 * h0)
            dets.append(Detection(
                class_id=int(cls_k[i]),
                class_name=self.class_names[int(cls_k[i])] if int(cls_k[i]) < len(self.class_names) else str(int(cls_k[i])),
                score=float(scores_k[i]),
                area_fraction=min(1.0, max(0.0, area)),
                x1=float(xx1), y1=float(yy1), x2=float(xx2), y2=float(yy2),
            ))
        return self._nms(dets, self.config.onnx_iou_threshold)

    @staticmethod
    def _nms(dets: List[Detection], iou_thr: float) -> List[Detection]:
        if not dets:
            return []
        # Greedy NMS per class using absolute boxes.
        by_class: Dict[int, List[Detection]] = {}
        for d in dets:
            by_class.setdefault(d.class_id, []).append(d)

        final: List[Detection] = []
        for cls_dets in by_class.values():
            cls_dets.sort(key=lambda d: d.score, reverse=True)
            while cls_dets:
                best = cls_dets.pop(0)
                final.append(best)
                cls_dets = [d for d in cls_dets if OnnxDetector._iou(best, d) < iou_thr]
        return final

    @staticmethod
    def _iou(a: Detection, b: Detection) -> float:
        ix1 = max(a.x1, b.x1)
        iy1 = max(a.y1, b.y1)
        ix2 = min(a.x2, b.x2)
        iy2 = min(a.y2, b.y2)
        iw = max(0.0, ix2 - ix1)
        ih = max(0.0, iy2 - iy1)
        inter = iw * ih
        area_a = max(1e-6, (a.x2 - a.x1) * (a.y2 - a.y1))
        area_b = max(1e-6, (b.x2 - b.x1) * (b.y2 - b.y1))
        return inter / (area_a + area_b - inter)

    @staticmethod
    def saliency_from_detections(
        detections: List[Detection],
        class_weights: Dict[str, float],
    ) -> float:
        """
        Class-aware, area-normalized saliency for one frame.
        saliency = Σ ( class_weight * area_fraction * confidence )
        Defaults to weight 1.0 for any class not explicitly weighted.
        """
        total = 0.0
        for d in detections:
            w = class_weights.get(d.class_name, 1.0)
            total += w * d.area_fraction * d.score
        # A single large, confident, high-weight object roughly saturates the signal.
        return min(1.0, total)
