#!/usr/bin/env python3
"""A2 抽帧：从视频按固定帧间隔采样导出 jpg，供标注工具（CVAT/Label Studio）导入。"""
import argparse
import json
import subprocess
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True, help="帧输出目录")
    ap.add_argument("--step", type=int, default=50, help="每 N 帧取一帧（默认 50）")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pattern = str(out / "frame_%05d.jpg")
    vf = f"select=not(mod(n\\,{args.step})),showinfo"
    cmd = [
        args.ffmpeg, "-hide_banner", "-nostats", "-i", args.video,
        "-filter:v", vf, "-vsync", "vfr", "-q:v", "2", pattern,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    frames = sorted(out.glob("frame_*.jpg"))
    meta = {
        "video": str(Path(args.video).resolve()),
        "frame_step": args.step,
        "frames": len(frames),
        "out": str(out.resolve()),
    }
    (out / "extract_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(meta, ensure_ascii=False))
    if proc.returncode != 0 or not frames:
        print(proc.stderr[-2000:])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
