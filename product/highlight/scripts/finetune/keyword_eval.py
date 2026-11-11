#!/usr/bin/env python3
"""C1 关键词召回评测：给定视频 + 领域词表，转写并统计命中，评估 whisper/关键词方向是否值得训。

whisperModelSize 接受官方尺寸名（base/small/…）或本地 CTranslate2 目录（fine-tune 产物），
传 --model 即可对拍 base vs fine-tune 的领域词召回（C2 验收）。
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1] / "engine"
sys.path.insert(0, str(ENGINE))

from highlight_core.config import HighlightConfig  # noqa: E402
from highlight_core.subtitle_engine import SubtitleEngine  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--keywords", required=True, help="逗号分隔领域词")
    ap.add_argument("--model", default="base", help="官方尺寸名或本地 CTranslate2 目录")
    ap.add_argument("--out")
    args = ap.parse_args()

    kws = [k.strip() for k in args.keywords.split(",") if k.strip()]
    cfg = HighlightConfig()
    cfg.enable_whisper = True
    cfg.whisper_model_size = args.model
    cfg.keywords = kws

    se = SubtitleEngine(cfg)
    segments = se.transcribe_or_load(args.video)
    scored = se.score_keyword_hits(segments)

    transcript = [
        {"start": round(s.start_sec, 2), "end": round(s.end_sec, 2), "text": s.text}
        for s in segments
    ]
    result = {
        "video": str(Path(args.video).resolve()),
        "model": args.model,
        "keywords": kws,
        "cues": len(segments),
        "hit_segments": len(scored),
        "hits": [
            {"start": round(a, 2), "end": round(b, 2), "score": round(c, 3)}
            for a, b, c in scored
        ],
        "transcript": transcript,
        "note": "正弦测试音无语音 → 0 cue 属预期（机制验证）；真实素材上用 cue 数/命中数对拍"
                "base vs fine-tune（C2 验收）",
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
