#!/bin/sh
# Optional model runtime for the highlight engine (OpenCV / ONNX / MediaPipe /
# Whisper / OpenCLIP). Safe to re-run: every step is idempotent.
#
# Without this, the engine still runs — on FFmpeg's own filters alone, with
# `degraded: true` and four of the seven signals at zero. That is a supported
# deployment, not a broken one. This script buys the other four.
#
#   sh product/highlight/scripts/setup-models.sh
#
# Then point the host at the environment it created:
#   VHL_PYTHON=<repo>/product/highlight/engine/.venv/bin/python
#   VHL_ONNX_MODEL=<repo>/product/highlight/engine/models/yolox_s.onnx
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)          # product/highlight
ENGINE="$HERE/engine"
VENV="$ENGINE/.venv"
INDEX="${VHL_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
HF="${HF_ENDPOINT:-https://hf-mirror.com}"

say() { printf '\n== %s\n' "$*"; }

# --- interpreter ------------------------------------------------------------
# 3.11, not the newest Python: this is the newest interpreter with wheels for
# the whole set on macOS x86_64. torch stopped publishing Intel-macOS wheels
# after 2.2.2, and MediaPipe 0.10.9 stops at 3.12.
PY="${VHL_PYTHON_BUILD:-}"
if [ -z "$PY" ]; then
  for cand in python3.11 python3.12 python3; do
    if command -v "$cand" >/dev/null 2>&1 &&
       "$cand" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)' 2>/dev/null; then
      PY=$(command -v "$cand"); break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "找不到 3.10–3.12 的 Python。装一个（brew install python@3.11 / pyenv install 3.11），" >&2
  echo "或用 VHL_PYTHON_BUILD=/path/to/python3.11 指定。" >&2
  exit 1
fi
say "解释器 $PY ($("$PY" -c 'import platform,sys;print(sys.version.split()[0], platform.machine())'))"

if [ ! -x "$VENV/bin/python" ]; then
  say "创建 $VENV"
  "$PY" -m venv "$VENV"
fi
PIP="$VENV/bin/python -m pip"
$PIP install -q --upgrade pip >/dev/null 2>&1 || true
run() { $PIP install -q --timeout 180 -i "$INDEX" "$@"; }

# --- vision core ------------------------------------------------------------
# numpy 1.x on purpose: MediaPipe 0.10.9 and the torch 2.2.x Intel wheel are
# both built against it, and numpy 2 aborts them at import.
say "OpenCV + numpy"
run "numpy==1.26.4" "opencv-python-headless==4.10.0.84"

# --- object detection -------------------------------------------------------
# 1.23 is the macOS x86_64 build that exposes CoreMLExecutionProvider; on
# YOLOX-s it claims 276 of 277 nodes, versus CPU only.
say "ONNX Runtime"
run "onnxruntime==1.23.2"

# --- face detection ---------------------------------------------------------
# protobuf is pinned because MediaPipe 0.10.9 ships _pb2 modules generated
# against the 4.x runtime; pip's resolver reads an older `<4` bound off its
# metadata and refuses the combination it actually works with. Hence --no-deps
# plus an explicit protobuf — and the import check below, so "installed" never
# stands in for "works". The other deps are the subset its `solutions` import
# chain actually touches.
say "MediaPipe (protobuf 4.x + --no-deps)"
$PIP install -q --timeout 180 -i "$INDEX" "protobuf==4.25.8" 2>/dev/null || {
  # pip 24 on macOS fails to uninstall protobuf >=5: it renames the directory to
  # `~upb` and then tries to `rm` a directory. Clear both by hand, then retry.
  rm -rf "$VENV"/lib/python*/site-packages/google/protobuf \
         "$VENV"/lib/python*/site-packages/google/_upb \
         "$VENV"/lib/python*/site-packages/protobuf-*.dist-info \
         "$VENV"/lib/python*/site-packages/google/~* 2>/dev/null || true
  $PIP install -q --timeout 180 -i "$INDEX" --no-deps "protobuf==4.25.8"
}
$PIP install -q --no-deps --timeout 180 -i "$INDEX" "mediapipe==0.10.9"
run "absl-py" "attrs" "matplotlib" "sounddevice"
"$VENV/bin/python" - <<'PY'
import numpy as np, mediapipe as mp
det = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)
det.process(np.zeros((180, 320, 3), dtype=np.uint8))
print("   MediaPipe 人脸检测推理 OK")
PY

# --- speech-to-text ---------------------------------------------------------
say "faster-whisper (CTranslate2)"
run "ctranslate2" "tokenizers" "av" "huggingface_hub"
$PIP install -q --no-deps --timeout 180 -i "$INDEX" "faster-whisper"

# --- zero-shot guidance -----------------------------------------------------
# torch 2.2.2 is the last release with a macOS x86_64 wheel; 2.3+ is arm64 only.
say "PyTorch 2.2.2 + OpenCLIP"
run "torch==2.2.2" "torchvision==0.17.2"
run "open-clip-torch"

# --- one OpenMP runtime -----------------------------------------------------
# torch and ctranslate2 each ship their own libiomp5.dylib. Two copies in one
# process abort the interpreter ("OMP: Error #15") the moment the second one
# initialises — which is why it surfaces mid-analysis, on the first Whisper
# call, and only when OpenCLIP already ran. Merging them here means the
# problem is gone before it can happen; the engine also repairs it at runtime
# for anyone who installs by hand.
say "合并重复的 OpenMP runtime"
"$VENV/bin/python" -c "
import sys, os
sys.path.insert(0, os.path.join('$ENGINE', 'highlight_core'))
import importlib.util
spec = importlib.util.spec_from_file_location('omp_guard', os.path.join('$ENGINE', 'highlight_core', 'openmp_guard.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
print('  ', mod.repair_duplicate_openmp() or '无需合并（只有一份或非 macOS）')
"

# --- checkpoints ------------------------------------------------------------
# Weights are not pip packages. YOLOX-s is Apache-2.0, 34 MB, COCO 80 classes,
# and its ONNX layout is the one `_postprocess_yolox` decodes.
say "YOLOX-s 检测模型"
MODEL="$ENGINE/models/yolox_s.onnx"
mkdir -p "$ENGINE/models"
if [ -s "$MODEL" ]; then
  echo "   已存在: $MODEL"
else
  URL="${VHL_YOLOX_URL:-https://gh-proxy.com/https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx}"
  curl -fSL --retry 3 --retry-delay 2 -o "$MODEL.tmp" "$URL" && mv "$MODEL.tmp" "$MODEL"
  echo "   已下载: $MODEL"
fi

# Whisper's own weights come from the Hub on first use; pulling them here turns a
# first-run stall into an install-time one.
say "Whisper base 权重"
HF_ENDPOINT="$HF" "$VENV/bin/python" - <<'PY'
from faster_whisper import WhisperModel
WhisperModel("base", device="cpu", compute_type="int8")
print("   Whisper base 就绪")
PY

# Same reasoning for OpenCLIP, except this one is 350 MB and took 10 minutes on
# this machine — far too long to leave inside the first analysis. The Hub caches
# by repo id, so this is a no-op once it has landed.
say "OpenCLIP ViT-B-32 权重"
HF_ENDPOINT="$HF" "$VENV/bin/python" - <<'PY'
import open_clip
open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
print("   ViT-B-32 就绪")
PY

say "完成"
cat <<EOF
实测环境:
  $( "$VENV/bin/python" -c 'import sys;print("python", sys.version.split()[0])')
  $( "$VENV/bin/python" -c 'import cv2,numpy,onnxruntime as o;print("cv2",cv2.__version__,"numpy",numpy.__version__,"onnxruntime",o.__version__)')
  $( "$VENV/bin/python" -c 'import torch,mediapipe,faster_whisper,open_clip as c;print("torch",torch.__version__,"mediapipe",mediapipe.__version__,"faster-whisper",faster_whisper.__version__,"open-clip",c.__version__)')

让宿主用它:
  export VHL_PYTHON="$VENV/bin/python"
  export VHL_ONNX_MODEL="$MODEL"

确认引擎自己怎么看这份环境:
  VHL_ONNX_MODEL="$MODEL" "$VENV/bin/python" "$ENGINE/vhl_bridge.py" --doctor

OpenCLIP 的 clipGuidance 默认关闭; 需要时在任务配置里设 clipPrompt 即可,
权重已在上面拉好, 不会在第一次分析时卡住。
EOF
