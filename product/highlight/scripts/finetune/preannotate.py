#!/usr/bin/env python3
"""A2 预标注：用引擎自己的 OnnxDetector 对视频抽帧批量出框，产出 COCO json
供 CVAT / Label Studio 导入，人工只做修正（A2 人工成本压缩杠杆 1）。

要点：用引擎同一套 letterbox/解码/NMS 路径推理，预标注的框与部署后的行为天然一致。
产物: <out>/frames/*.jpg + <out>/coco.json + stdout 摘要（类别分布）。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1] / "engine"  # scripts/finetune → scripts → highlight
sys.path.insert(0, str(ENGINE))

import cv2  # noqa: E402

from highlight_core.config import HighlightConfig  # noqa: E402
from highlight_core.detector import COCO_CLASSES, OnnxDetector  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--model", required=True, help="ONNX 检测模型路径")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frame-step", type=int, default=15, help="每 N 帧取一帧")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--iou", type=float, default=0.45)
    args = ap.parse_args()

    out = Path(args.out)
    frames_dir = out / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    cfg = HighlightConfig()
    cfg.onnx_model_path = args.model
    cfg.onnx_conf_threshold = args.conf
    cfg.onnx_iou_threshold = args.iou
    det = OnnxDetector(cfg)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"FAIL 无法打开视频: {args.video}")
        return 2
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0

    images, annotations = [], []
    class_counts: dict = {}
    ann_id = 0
    img_id = 0
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret or frame is None:
            break
        if idx % max(1, args.frame_step) != 0:
            idx += 1
            continue
        h0, w0 = frame.shape[:2]
        img_id += 1
        file_name = f"frame_{idx:06d}.jpg"
        cv2.imwrite(str(frames_dir / file_name), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        images.append({
            "id": img_id,
            "file_name": file_name,
            "width": w0,
            "height": h0,
            "ts_sec": round(idx / fps, 3),
        })
        try:
            dets = det.detect(frame)
        except Exception as exc:  # 单帧推理失败不炸批量
            print(f"WARN frame {idx}: {type(exc).__name__}: {exc}", file=sys.stderr)
            dets = []
        for d in dets:
            ann_id += 1
            class_counts[d.class_name] = class_counts.get(d.class_name, 0) + 1
            annotations.append({
                "id": ann_id,
                "image_id": img_id,
                # 预标注保留 score 供人工排序复核；COCO GT 校验器会忽略未知字段
                "category_id": d.class_id + 1,
                "bbox": [round(d.x1, 1), round(d.y1, 1),
                         round(d.x2 - d.x1, 1), round(d.y2 - d.y1, 1)],
                "area": round((d.x2 - d.x1) * (d.y2 - d.y1), 1),
                "iscrowd": 0,
                "score": round(d.score, 4),
            })
        idx += 1
    cap.release()

    coco = {
        "info": {
            "generator": "vhl preannotate (engine OnnxDetector)",
            "model": str(Path(args.model).resolve()),
            "frame_step": args.frame_step,
            "conf": args.conf,
            "iou": args.iou,
        },
        "categories": [
            {"id": i + 1, "name": name} for i, name in enumerate(COCO_CLASSES)
        ],
        "images": images,
        "annotations": annotations,
    }
    coco_path = out / "coco.json"
    coco_path.write_text(json.dumps(coco, ensure_ascii=False), encoding="utf-8")

    summary = {
        "frames": len(images),
        "detections": len(annotations),
        "class_distribution": class_counts,
        "coco": str(coco_path),
        "frames_dir": str(frames_dir),
        "note": "合成图案素材上 0 检出属预期（yolox 训练于真实照片）；机制验证看脚本跑通+json 合法，"
                "真实素材上的预标注质量拿领域帧评估",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
