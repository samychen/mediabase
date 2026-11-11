#!/bin/sh
# C2 第 3 步：HF transformers fine-tune 产物 → CTranslate2 目录（faster-whisper 唯一吃的格式）。
# 在训练机跑（需要 transformers + ctranslate2；部署机只需要能读目录的 faster-whisper）。
# 用法: convert_whisper_ct2.sh <hf_model_dir> <out_ct2_dir>
set -e
[ $# -eq 2 ] || { echo "用法: $0 <hf_model_dir> <out_ct2_dir>"; exit 2; }

pip show ctranslate2 >/dev/null 2>&1 || pip install ctranslate2

# float16 转换；引擎加载时固定 compute_type=int8，会在载入时再量化，属预期
ct2-transformers-converter --model "$1" --output_dir "$2" --quantization float16 --force

echo "--- 自检（部署机同款加载路径）---"
python3 - <<EOF
from faster_whisper import WhisperModel
m = WhisperModel("$2", device="cpu", compute_type="int8")
print("PASS 模型可被 faster-whisper 加载:", "$2")
EOF
echo "部署: 任务选项 {\"whisperModelSize\": \"$2\"}（绝对路径）"
