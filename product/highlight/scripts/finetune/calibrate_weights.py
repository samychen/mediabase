#!/usr/bin/env python3
"""D1 校准闭环：对同一段素材跑多组权重配方的完整 pipeline，输出对比与"区分度"指标。

区分度 = 选中片段与标注区间的平均 IoU（--labels 给 ground_truth.json 时计算）。
默认 adaptive off（对照原始配方）；--adaptive 开启看地板行为。

跑的是真引擎（HighlightPipeline），whisper/face/clip 默认关以提速；开 ONNX 检测用 --model。
产物: <out>/<variant>/ 内成片 + timeline 报告，stdout 汇总表。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from highlight_core.config import HighlightConfig, ScoringWeights  # noqa: E402
from highlight_core.pipeline import HighlightPipeline  # noqa: E402

CAMEL = {
    "sceneCut": "scene_cut", "audioRms": "audio_rms", "visualMotion": "visual_motion",
    "objectSaliency": "object_saliency", "faceSaliency": "face_saliency",
    "clipGuidance": "clip_guidance", "keywordMatch": "keyword_match",
}

# 内置变体：默认 / 音频重 / 运动重 / 均匀（全 1，检验归一幂等）
VARIANTS = {
    "default": {},
    "audio_heavy": {"audioRms": 0.6, "visualMotion": 0.25, "sceneCut": 0.15},
    "motion_heavy": {"visualMotion": 0.55, "sceneCut": 0.3, "audioRms": 0.15},
    "keyword_heavy": {"keywordMatch": 0.5, "audioRms": 0.25, "faceSaliency": 0.15, "sceneCut": 0.1},
    # CF 素材弱标注学出的向量（work/cf_learned_weights.json）——与 keyword_heavy 同口径对拍用；
    # 与标注同源，属候选比较而非留出验证
    "learned_cf": {"visualMotion": 0.5349, "audioRms": 0.3086, "objectSaliency": 0.1271, "sceneCut": 0.0294},
    "uniform": {"sceneCut": 1, "audioRms": 1, "visualMotion": 1, "objectSaliency": 1,
                "faceSaliency": 1, "clipGuidance": 1, "keywordMatch": 1},
}


def build_config(variant: dict, args) -> HighlightConfig:
    cfg = HighlightConfig()
    # 合成夹具默认关 whisper 提速；真实素材传 --whisper 打开（keyword 信号参战）
    cfg.enable_whisper = bool(args.whisper)
    if args.keywords:
        cfg.keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    cfg.enable_face_detection = False
    cfg.enable_clip_guidance = False
    cfg.enable_content_cache = False  # 变体间不共享缓存，杜绝跨配方污染
    if args.model:
        cfg.onnx_model_path = args.model
    cfg.adaptive_weights = args.adaptive
    if args.clip_sec:
        cfg.clip_duration_sec = args.clip_sec
    if args.min_gap:
        cfg.min_gap_sec = args.min_gap
    if args.lead:
        cfg.context_lead_in_sec = args.lead
        cfg.context_lead_out_sec = args.lead
    full = {v: 0.0 for v in CAMEL.values()}
    for k, val in variant.items():
        full[CAMEL[k]] = val
    cfg.weights = ScoringWeights(**full)
    # 直跑 pipeline 没有桥替我们置位：显式权重必须标记 weights_explicit，
    # 否则第 1b 步会用 contentPreset（general）改写 config.weights（桥在 RPC 路径上做这件事）
    if variant:
        cfg.weights_explicit = True
    return cfg


def iou_cov(sel, labels):
    if not labels:
        return None
    best_sum, n = 0.0, 0
    for seg in sel:
        best = 0.0
        for lab in labels:
            inter = max(0.0, min(seg["end_sec"], lab["endSec"]) - max(seg["start_sec"], lab["startSec"]))
            union = max(seg["end_sec"], lab["endSec"]) - min(seg["start_sec"], lab["startSec"])
            if union > 0:
                best = max(best, inter / union)
        best_sum += best
        n += 1
    return round(best_sum / max(1, n), 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", default=str(HERE / "work" / "calibration"))
    ap.add_argument("--labels", help="ground_truth.json（高光区间）")
    ap.add_argument("--model", help="可选 ONNX 检测模型路径")
    ap.add_argument("--whisper", action="store_true", help="开启转写（keyword 信号参战；本机建模 ~80s/变体）")
    ap.add_argument("--keywords", help="逗号分隔领域词（配合 --whisper）")
    ap.add_argument("--adaptive", action="store_true")
    ap.add_argument("--clip-sec", type=float, help="覆盖 clip_duration_sec（短素材校准时调小窗口）")
    ap.add_argument("--min-gap", type=float, help="覆盖 min_gap_sec")
    ap.add_argument("--lead", type=float, help="覆盖上下文前/后扩展秒数")
    ap.add_argument("--variants", help="逗号分隔内置变体名；缺省全部")
    args = ap.parse_args()

    names = args.variants.split(",") if args.variants else list(VARIANTS)
    unknown = [n for n in names if n not in VARIANTS]
    if unknown:
        print(f"FAIL 未知变体: {unknown}（可用: {list(VARIANTS)}）")
        return 2

    labels = None
    if args.labels:
        labels = json.loads(Path(args.labels).read_text(encoding="utf-8"))["highlights"]

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    summary = []
    for name in names:
        job = out_root / name
        job.mkdir(parents=True, exist_ok=True)
        report_path = job / "timeline.json"
        cfg = build_config(VARIANTS[name], args)
        try:
            HighlightPipeline(cfg).run(
                args.video, str(job / "clip.mp4"), report_json_path=str(report_path),
            )
        except Exception as exc:
            summary.append({"variant": name, "error": f"{type(exc).__name__}: {exc}"})
            continue
        rep = json.loads(report_path.read_text(encoding="utf-8"))
        sel = rep.get("selected_highlights", [])
        summary.append({
            "variant": name,
            "weights_in": VARIANTS[name],
            "effective_weights": rep.get("content_adaptation", {}).get("effective_weights"),
            "segments": [
                {"start": s["start_sec"], "end": s["end_sec"], "score": s["composite_score"]}
                for s in sel
            ],
            "mean_iou_vs_labels": iou_cov(sel, labels or []),
        })

    result = {
        "video": str(Path(args.video).resolve()),
        "adaptive": args.adaptive,
        "labels": labels,
        "summary": summary,
    }
    (out_root / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
