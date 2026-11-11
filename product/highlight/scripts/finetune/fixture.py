#!/usr/bin/env python3
"""生成结构化测试素材：高光位置由构造已知，供 D 方向（校准/学权重）做机制验证。

结构（20s，320×180@25fps）：
  [0-3)  静止灰屏 + 微弱正弦音
  [3-7)  testsrc2 运动 + 响亮正弦音      ← 高光 1
  [7-10) 静止 + 微弱
  [10-14) testsrc2 运动 + 响亮           ← 高光 2
  [14-20) 静止 + 微弱

拼接边界天然产生场景切点（与高光边界重合），audio/motion 是主要区分信号，
scene 是切点处的伴随信号——这正是学习/校准想要的"有真实 confounder"的玩具数据。
产物: <out>/fixture.mp4 + <out>/ground_truth.json
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path


def build_segment(path: Path, moving: bool, loud: bool, seconds: float, ffmpeg: str) -> None:
    vol = "1.0" if loud else "0.04"
    if moving:
        vsrc = f"testsrc2=size=320x180:rate=25:duration={seconds}"
    else:
        vsrc = f"color=c=gray:size=320x180:rate=25:duration={seconds}"
    asrc = f"sine=frequency=440:sample_rate=44100:duration={seconds}"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", vsrc,
        "-f", "lavfi", "-i", asrc,
        "-filter_complex", f"[1:a]volume={vol}[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "64k",
        "-t", str(seconds),
        str(path),
    ]
    subprocess.run(cmd, check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent
    ap.add_argument("--out", default=str(here / "work" / "fixture"))
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="时长缩放（>1 让默认 6s 滑窗/上下文扩展不再黏成整块）")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    s = args.scale
    plan = [
        (3.0 * s, False, False),
        (4.0 * s, True, True),
        (3.0 * s, False, False),
        (4.0 * s, True, True),
        (6.0 * s, False, False),
    ]

    segments = []
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        t = 0.0
        highlights = []
        for idx, (sec, moving, loud) in enumerate(plan):
            seg = Path(tmp) / f"seg_{idx}.mp4"
            build_segment(seg, moving, loud, sec, args.ffmpeg)
            segments.append(seg)
            if loud:
                highlights.append({"startSec": round(t, 3), "endSec": round(t + sec, 3)})
            t += sec

        concat_list = out / "concat.txt"
        concat_list.write_text(
            "".join(f"file '{seg.resolve()}'\n" for seg in segments), encoding="utf-8"
        )
        video = out / "fixture.mp4"
        subprocess.run(
            [args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-f", "concat", "-safe", "0", "-i", str(concat_list),
             "-c", "copy", str(video)],
            check=True,
        )

    truth = {
        "video": str(video.resolve()),
        "duration_sec": t,
        "highlights": highlights,
        "design": "motion+loud sine inside highlights; static gray + quiet outside; "
                  "concat boundaries produce scene cuts coinciding with highlight edges",
    }
    (out / "ground_truth.json").write_text(
        json.dumps(truth, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(truth, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
