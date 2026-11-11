#!/bin/sh
# 环境核验：fine-tune 工具链的本地依赖是否齐全（不启动宿主）。
# 退出码 0 = 本地可跑的部分全部具备；缺失项逐条打印。
ENGINE="$(cd "$(dirname "$0")/../../engine" && pwd)"
PY="$ENGINE/.venv/bin/python"
FAIL=0

say() { printf '%s\n' "$*"; }
need() { if [ -e "$2" ]; then say "PASS $1: $2"; else say "FAIL $1: $2 缺失"; FAIL=1; fi; }

need "venv python" "$PY"
need "yolox_s.onnx" "$ENGINE/models/yolox_s.onnx"
command -v ffmpeg >/dev/null 2>&1 && say "PASS ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)" || { say "FAIL ffmpeg 不在 PATH"; FAIL=1; }

[ -x "$PY" ] && ENGINE="$ENGINE" "$PY" - <<'EOF'
import importlib, os, sys
sys.path.insert(0, os.environ["ENGINE"])
fail = False
for mod in ("numpy", "cv2", "onnxruntime", "open_clip", "faster_whisper"):
    try:
        m = importlib.import_module(mod)
        print(f"PASS {mod} {getattr(m, '__version__', '')}".rstrip())
    except Exception as exc:
        print(f"FAIL {mod}: {exc}")
        fail = True
# 引擎包本身可导入（预标注/校准脚本的前置）
try:
    from highlight_core.detector import OnnxDetector  # noqa: F401
    from highlight_core.pipeline import HighlightPipeline  # noqa: F401
    print("PASS highlight_core 可导入")
except Exception as exc:
    print(f"FAIL highlight_core: {exc}")
    fail = True
sys.exit(1 if fail else 0)
EOF
[ $? -ne 0 ] && FAIL=1

# CLIP / whisper 缓存（首跑下载大文件，缓存命中与否决定耗时）
HF="$HOME/.cache/huggingface/hub"
ls "$HF" 2>/dev/null | grep -q "CLIP-ViT-B-32" && say "PASS CLIP checkpoint 已缓存" || say "WARN CLIP 未缓存（prompt_probe 首跑需下载 ~350MB）"
ls "$HF" 2>/dev/null | grep -q "faster-whisper" && say "PASS whisper-base 已缓存" || say "WARN whisper 未缓存"

say "---"
[ "$FAIL" -eq 0 ] && say "环境核验：全部通过" || say "环境核验：存在缺失项"
exit $FAIL
