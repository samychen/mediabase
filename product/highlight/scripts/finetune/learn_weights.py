#!/usr/bin/env python3
"""D2 从标注学权重：高光区间标注 + 一份或多份 timeline 报告 → 学一个 7 维非负权重向量。

特征 = timeline_series 逐窗口的 7 路信号；标签 = 窗口与任一标注区间的覆盖率。
解非负最小二乘（投影梯度，7 维足够；要精确解可换 scipy.optimize.nnls），
归一到和为 1，并给出学得权重 vs 引擎默认的"区分度"对比（标注内/外平均 composite 差）。

用法: learn_weights.py --labels gt.json --report r1.json [--report r2.json ...] [--out w.json]
产物 stdout + --out 文件：camelCase weights 直接可贴进 highlight.start 的 options。
"""
import argparse
import json
from pathlib import Path

FIELDS = ["scene_cut", "audio_rms", "visual_motion", "object_saliency",
          "face_saliency", "clip_guidance", "keyword_match"]
SERIES_KEY = {"scene_cut": "scene", "audio_rms": "audio", "visual_motion": "motion",
              "object_saliency": "saliency", "face_saliency": "face",
              "clip_guidance": "clip", "keyword_match": "keyword"}
CAMEL = {"scene_cut": "sceneCut", "audio_rms": "audioRms", "visual_motion": "visualMotion",
         "object_saliency": "objectSaliency", "face_saliency": "faceSaliency",
         "clip_guidance": "clipGuidance", "keyword_match": "keywordMatch"}
ENGINE_DEFAULT = [0.18, 0.22, 0.18, 0.16, 0.10, 0.10, 0.06]


def nnls_pgd(A, y, iters=2000, lr=None):
    """非负最小二乘：投影梯度下降（w = max(0, w - lr·Aᵀ(Aw−y))），再归一。"""
    import numpy as np
    L = float(np.linalg.eigvalsh(A.T @ A).max())
    step = lr or (1.0 / max(L, 1e-9))
    w = np.zeros(A.shape[1])
    for _ in range(iters):
        w = np.maximum(0.0, w - step * (A.T @ (A @ w - y)))
    return w


def coverage_label(row_t, bin_dt, labels):
    cov = 0.0
    for lab in labels:
        inter = min(row_t + bin_dt, lab["endSec"]) - max(row_t, lab["startSec"])
        if inter > 0:
            cov = max(cov, inter / bin_dt)
    return min(1.0, cov)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True, help="ground_truth.json（highlights 数组）")
    ap.add_argument("--report", action="append", required=True)
    ap.add_argument("--out")
    args = ap.parse_args()

    import numpy as np

    labels = json.loads(Path(args.labels).read_text(encoding="utf-8"))["highlights"]
    X, y, composites_default, inside_masks = [], [], [], []
    for rp in args.report:
        rep = json.loads(Path(rp).read_text(encoding="utf-8"))
        series = rep.get("timeline_series", [])
        if len(series) < 2:
            continue
        bin_dt = series[1]["time_sec"] - series[0]["time_sec"] or 0.5
        inside = []
        for row in series:
            X.append([row[SERIES_KEY[f]] for f in FIELDS])
            t = row["time_sec"]
            y.append(coverage_label(t, bin_dt, labels))
            inside.append(coverage_label(t, bin_dt, labels) > 0.5)
            composites_default.append(row["composite"])
        inside_masks.append(inside)

    if not X:
        print("FAIL 报告里没有 timeline_series")
        return 2
    A = np.array(X, dtype=float)
    yv = np.array(y, dtype=float)

    raw = nnls_pgd(A, yv)
    s = raw.sum()
    w_norm = raw / s if s > 0 else np.array(ENGINE_DEFAULT)

    comp_learned = A @ w_norm
    comp_default = np.array(composites_default)
    ins = np.array([m for mask in inside_masks for m in mask])
    if ins.any() and not ins.all():

        def sep(v):
            return round(float(v[ins].mean() - v[~ins].mean()), 4)

        sep_learned, sep_default = sep(comp_learned), sep(comp_default)
    else:
        sep_learned = sep_default = None

    out = {
        "learned_raw": [round(float(v), 6) for v in raw],
        "weights_normalized": {f: round(float(v), 4) for f, v in zip(FIELDS, w_norm)},
        "weights_camelCase_for_options": {CAMEL[f]: round(float(v), 4)
                                          for f, v in zip(FIELDS, w_norm)},
        "separation_in_minus_out": {
            "learned": sep_learned, "engine_default": sep_default,
            "note": "同一批窗口上，学得权重的标注内/外 composite 均值差。"
                    "大于 engine_default 说明这组权重比默认更有区分度；"
                    "为负则标注或特征有问题，先别用",
        },
        "reports_used": args.report,
        "labels": labels,
        "windows": len(X),
    }
    text = json.dumps(out, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
