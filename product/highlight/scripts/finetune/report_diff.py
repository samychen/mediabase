#!/usr/bin/env python3
"""对比多份 timeline 报告：effective_weights / signal_activity / 选中片段 / 与标注的重合率。

用法: report_diff.py --labels ground_truth.json report1.json report2.json ...
labels 可省略；给了就额外计算每个变体的窗口覆盖率（precision 口径：选中片段与标注区间的
IoU 最大值）。
"""
import argparse
import json
from pathlib import Path

SIG_KEYS = ["scene", "audio", "motion", "saliency", "face", "clip", "keyword"]


def coverage(selected, labels):
    """每个选中片段与标注区间的最大 IoU；无标注返回 None。"""
    if not labels:
        return None
    out = []
    for seg in selected:
        s0, s1 = seg["start_sec"], seg["end_sec"]
        best = 0.0
        for lab in labels:
            l0, l1 = lab["startSec"], lab["endSec"]
            inter = max(0.0, min(s1, l1) - max(s0, l0))
            union = max(s1, l1) - min(s0, l0)
            if union > 0:
                best = max(best, inter / union)
        out.append(round(best, 3))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("reports", nargs="+", help="timeline report json 路径")
    ap.add_argument("--labels")
    args = ap.parse_args()

    labels = None
    if args.labels:
        labels = json.loads(Path(args.labels).read_text(encoding="utf-8"))["highlights"]

    for rep_path in args.reports:
        rep = json.loads(Path(rep_path).read_text(encoding="utf-8"))
        ca = rep.get("content_adaptation", {})
        sel = rep.get("selected_highlights", [])
        series = rep.get("timeline_series", [])
        print(f"== {Path(rep_path).name}")
        print(f"  effective_weights: {json.dumps(ca.get('effective_weights'))}")
        print(f"  signal_activity:   {json.dumps(ca.get('signal_activity'))}")
        print(f"  片段({len(sel)}): "
              + "; ".join(f"[{s['start_sec']:.1f}-{s['end_sec']:.1f}] {s['composite_score']}"
                          for s in sel))
        cov = coverage(sel, labels or [])
        if cov is not None:
            print(f"  与标注 IoU: {cov}  平均 {sum(cov) / len(cov):.3f}" if cov else "  与标注 IoU: -")
        if series:
            import statistics as st
            means = {k: round(st.mean(row[k] for row in series), 4) for k in SIG_KEYS}
            stds = {k: round(st.pstdev([row[k] for row in series]), 4) for k in SIG_KEYS}
            print(f"  信号均值: {means}")
            print(f"  信号std:  {stds}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
