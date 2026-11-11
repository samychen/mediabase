"""YOLOX 训练 exp 模板（A3）：拷到训练机的 YOLOX 仓 exps/ 下按注释改三处。

两条路线（详见 product/highlight/docs/FINETUNE.zh.md A2）：
  路线 1（推荐）: num_classes=80 不收缩，领域数据训练 → COCO 类别名/查表零改动可用
  路线 2: num_classes=N → 必须同步改上游 detector.py 的 COCO_CLASSES，否则类别名错位

导出（A4，关键：不要在图里烘焙 decode/NMS，引擎自己做 grid decode）:
  python tools/export.py -f exps/vhl_domain.py -n yolox-s \
    -c output/vhl_domain_run/best_ckpt.pth --output-name yolox_s_domain.onnx
导出后跑 scripts/finetune/check_layout.py 对拍（训练机 + 部署机各一次）。
"""
import os

from yolox.exp import Exp


class MyExp(Exp):
    def __init__(self):
        super().__init__()
        # ── 改这里三处 ─────────────────────────────────────────────
        self.num_classes = 80                       # 路线 2 改成你的类别数
        self.data_dir = os.path.abspath("datasets/vhl_domain")
        self.train_ann = "train.json"               # COCO json（images/annotations/categories）
        self.val_ann = "val.json"
        # ──────────────────────────────────────────────────────────
        self.input_size = (640, 640)                # 引擎 letterbox 同款尺寸
        self.test_size = (640, 640)
        self.depth = 0.33                           # yolox-s
        self.width = 0.50
        self.max_epoch = 60                         # 小数据集（<1k 帧）30 就够，看 val 曲线
        self.fp16 = True
