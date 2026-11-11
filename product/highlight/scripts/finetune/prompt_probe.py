#!/usr/bin/env python3
"""B1 prompt 探针：对一段视频评测多条 clipPrompt 的区分度，选 prompt 用。

对均匀采样的帧计算每条 prompt 的逐帧余弦（与引擎 _OpenClipGuider 同一算式），
输出 mean/std/p95 与 top-3 帧时间戳。std 大 = 该 prompt 在这段素材上有区分度；
mean 高 = 整段贴合。选 prompt 的标准：std 大且 top 帧确实落在你想要的高光上。

可选 --auto-check：顺带跑引擎 classify_content（auto 分类路径），验证 TYPE_PROMPTS 工作。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

import cv2  # noqa: E402

SAMPLE_FRAMES = 12


def sample_frames(video: str, n: int = SAMPLE_FRAMES):
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"FAIL 无法打开视频: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    frames = []
    for i in range(n):
        idx = int(total * (i + 0.5) / n)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret and frame is not None:
            frames.append((round(idx / fps, 2), cv2.resize(frame, (320, 180))))
    cap.release()
    return frames


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--prompt", action="append", required=True, help="可重复，多条对比")
    ap.add_argument("--model", default="ViT-B-32")
    ap.add_argument("--pretrained", default="laion2b_s34b_b79k")
    ap.add_argument("--auto-check", action="store_true", help="顺带跑引擎 auto 分类")
    args = ap.parse_args()

    import numpy as np
    import torch
    import open_clip
    from PIL import Image

    frames = sample_frames(args.video)
    if not frames:
        print("FAIL 采不到帧")
        return 2

    model, _, preprocess = open_clip.create_model_and_transforms(
        args.model, pretrained=args.pretrained
    )
    model.eval()
    tokenizer = open_clip.get_tokenizer(args.model)
    with torch.no_grad():
        batch = torch.stack([
            preprocess(Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)))
            for _, f in frames
        ])
        imf = model.encode_image(batch)
        imf = imf / imf.norm(dim=-1, keepdim=True)

        results = []
        for prompt in args.prompt:
            tf = model.encode_text(tokenizer([prompt]))
            tf = tf / tf.norm(dim=-1, keepdim=True)
            cos = (imf @ tf.T).squeeze(1).numpy()  # [-1,1]
            order = np.argsort(cos)[::-1]
            results.append({
                "prompt": prompt,
                "mean": round(float(cos.mean()), 4),
                "std": round(float(cos.std()), 4),
                "p95": round(float(np.percentile(cos, 95)), 4),
                "top_frames": [
                    {"ts": frames[i][0], "cos": round(float(cos[i]), 4)}
                    for i in order[:3]
                ],
            })

    out = {"video": str(Path(args.video).resolve()), "model": f"{args.model}/{args.pretrained}",
           "frames_sampled": len(frames), "prompts": results,
           "note": "合成素材上的分数本身无意义，机制验证看跑通；std 大=prompt 在该素材有区分度"}

    if args.auto_check:
        from highlight_core.classify import classify_content
        from highlight_core.config import HighlightConfig
        cfg = HighlightConfig()
        name, info = classify_content(args.video, cfg, 0.0)
        out["auto_check"] = {"resolved_preset": name, **info}

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
