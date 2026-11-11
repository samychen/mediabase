#!/usr/bin/env python3
"""A5 对拍：核对 ONNX 检测模型的输入/输出布局是否匹配引擎契约。

引擎期望（engine/highlight_core/detector.py）：
  yolox  输入 [1,3,S,S]（喂 RAW 0-255）；输出 [N, 5+nc]，N 为 8400@640（strides 8/16/32）
  rtdetr 输入 [1,3,S,S]（喂 0-1）；输出 [num_queries, 4+nc]

训练机与部署机都要跑同一脚本各对拍一次。退出码 0 = 形状能被引擎解码。
"""
import sys
from pathlib import Path

try:
    import onnxruntime as ort
except ImportError:
    print("FAIL 需要 onnxruntime：engine/.venv/bin/python 或 pip install onnxruntime")
    sys.exit(2)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"用法: {Path(sys.argv[0]).name} <model.onnx>")
        return 2
    path = sys.argv[1]
    if not Path(path).exists():
        print(f"FAIL 模型不存在: {path}")
        return 2

    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp, outp = session.get_inputs()[0], session.get_outputs()[0]
    print(f"input : {inp.name} {inp.shape}")
    print(f"output: {outp.name} {outp.shape}")

    ishape = list(inp.shape)
    oshape = list(outp.shape)
    # 输入：3 通道、方形或动态 H/W
    if len(ishape) != 4 or ishape[1] != 3:
        print(f"FAIL 输入应为 [N,3,H,W]，实际 {ishape}")
        return 1
    h, w = (ishape[2], ishape[3])
    if isinstance(h, int) and isinstance(w, int) and h != w:
        print(f"FAIL 输入应方形（引擎 letterbox 到 size×size），实际 {h}×{w}")
        return 1
    if len(oshape) == 3:
        anchors, cols = oshape[1], oshape[2]
        if cols >= 6 and anchors == 8400 and (isinstance(h, int) and h == 640 or not isinstance(h, int)):
            nc = cols - 5
            print(f"PASS yolox 布局: [N,{anchors},{cols}] → nc={nc}"
                  + ("（与 COCO 80 对齐，类别名可直接查表）" if nc == 80
                     else "（nc≠80：引擎类别名将按 COCO 位置查表错名，见 FINETUNE.zh.md A2 路线选择）"))
            return 0
        if cols == 4 + (oshape[2] - 4) and anchors == 300 and cols > 4:
            # rtdetr: [1, num_queries, 4+nc]，引擎按归一化 cxcywh + logits 解
            print(f"WARN 疑似 rtdetr 布局 [1,{anchors},{cols}]：引擎 _postprocess_rtdetr 期望"
                  "归一化 cxcywh + logits。Ultralytics/PaddleDetection 的导出格式与此不保证一致，"
                  "先按 FINETUNE.zh.md A5 用真实帧对拍检测框再部署。")
            return 0
        print(f"FAIL 未知布局 [N,{anchors},{cols}]：既不是 yolox raw head（8400×[5+nc]）"
              f"也不是 rtdetr（num_queries×[4+nc]）")
        return 1
    print(f"FAIL 输出应为 3 维，实际 {oshape}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
