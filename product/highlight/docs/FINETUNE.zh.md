# 模型 Fine-tune 操作手册（highlight 产品层）

> 本文回答一个问题：**想把这套引擎适配到它没见过的素材领域，每条路分别怎么走、每一步改哪里、改完怎么验收。**
> 四个方向按"训练浓度"从低到高排列：A 检测器、B CLIP 语义、C Whisper 转写、D 评分权重配方。
> 所有接口描述都核对过当前代码：`engine/highlight_core/`（detector.py / config.py / classify.py /
> subtitle_engine.py / vision_analyzer.py）、`protocol/contract.json`、`scripts/setup-models.sh`。

---

## 0. 读前必知：三条边界

**1. `highlight_core/` 是同步副本，禁止就地改。**
算法代码的唯一真源是上游仓 `video_highlight_engine/highlighter`。任何算法侧修改（类别表、
prompt 表、评分逻辑）都在上游做，然后：

```sh
pnpm run sync:highlight-engine          # 上游 → highlight_core（默认 ../../video_highlight_engine）
VHL_UPSTREAM_ENGINE=/path/to/video_highlight_engine/highlighter \
  node product/highlight/scripts/sync-engine.mjs   # 指向任意检出位置
pnpm run check:highlight-drift          # 漂移闸门：副本/协议/名册单向改动会红
```

**2. 任务参数只有一张契约表。**
宿主与引擎都从 `protocol/contract.json` 的 `options` 读旋钮（camelCase → `HighlightConfig` 字段），
未知选项**拒绝而不是忽略**。今天已暴露、可直接用的模型相关旋钮：

| 选项 | 类型 | 默认 | 依赖能力 | 能否指向本地模型 |
|---|---|---|---|---|
| `onnxModelPath` | str | "" | onnxruntime | ✅ 任务级本地 ONNX 路径 |
| `onnxModelFormat` / `onnxConfThreshold` / `onnxIouThreshold` | str+float | yolox / 0.35 / 0.45 | onnxruntime | 检测器旋钮（2026-11-11 暴露，见 §A8） |
| `whisperModelSize` | str(枚举) | "base" | whisper | ❌ 枚举钉死 hub 尺寸名，两侧强制 |
| `whisperModelPath` | str | "" | whisper | ✅ **本地 CTranslate2 目录**（special，桥自理：能力门 + 存在性校验后覆盖 `whisper_model_size`，见 §C2） |
| `enableClipGuidance` + `clipPrompt` | bool+str | false/"" | clip | — 引导文本 |
| `clipModelName` + `clipPretrained` | str | ViT-B-32 / laion2b_s34b_b79k | clip | ✅ `clipPretrained` 接受**本地 state_dict 路径**（2026-11-11 暴露，见 §B2） |
| `enableFaceDetection` | bool | false | face | ❌ MediaPipe 内置，无路径旋钮 |
| `keywords` | strs | [] | — | 免模型 |
| `contentPreset` / `adaptiveWeights` / `weights` | str/bool/weights | — | auto 需 clip | 权重配方，见方向 D |

`HighlightConfig` 里仍未进契约的旋钮只剩两个：`onnx_input_size`（640，尺寸通常由 ONNX
session 自报，没有暴露需求）和 `saliency_class_weights`（dict，契约类型表
float/int/bool/str/strs/weights 装不下，要暴露得先扩类型）。

**3. 部署机只装用得到的栈。**
只用 ONNX 检测的部署**不需要 torch**（`onnxruntime` + `opencv-python-headless` 即可）；
torch 只为 CLIP（guidance/auto 分类）服务；faster-whisper 走 CTranslate2，也不需要 torch。
全栈钉版与安装坑见 `engine/README.zh.md`（Python 3.11 venv、`sh product/highlight/scripts/setup-models.sh`）。

---

## 方向 A：目标检测器 fine-tune（主力训练位）

**什么时候需要。** 报告里 `saliency` 信号在目标域素材上没区分度（整段饱和或整段为 0）、
或领域目标不在 COCO 80 类里（特定球类、游戏角色、舞台道具）。检测器是本体系里唯一
"训练出权重文件 → 喂给引擎"的现成插槽。

**引擎的推理契约（`detector.py`，导出必须对齐）：**

```
输入   letterbox 到正方形（尺寸取 session 输入 shape，缺省 onnx_input_size=640）
yolox  输入喂 RAW 0–255 像素（归一化折进图里）；输出 [N, 5+nc]：
       cx,cy,w,h + obj_conf + nc 列类别分（>1 时引擎自做 sigmoid）；
       引擎自己做 grid decode（strides 8/16/32，640 → 8400 个 anchor）
rtdetr 输入喂 0–1；输出 [num_queries, 4+nc]：cxcywh 按原帧归一 + logits（引擎做 sigmoid）
后处理  逐类贪心 NMS（IoU 0.45）；类别名固定按 COCO_CLASSES[id] 查表
显著度  raw = Σ(类别权重 × 框面积占比 × 置信度) → 1 − e^(−raw) 平滑饱和
```

> ⚠️ **首选 yolox 布局。** rtdetr 布局在主流导出工具里不保证是引擎期望的形态
> （Ultralytics 导出 `[1,300,6]` 框+分+类，PaddleDetection 是分离输出），对不上就要改上游
> postprocess。YOLOX 官方仓的导出（raw head，不带 decode）与引擎逐列对齐，
> `setup-models.sh` 下载的官方 `yolox_s.onnx` 就是这条路径的参照物。

### A1. 环境准备（训练机，独立于部署机）

```sh
# 训练机建议 Linux + GPU（任何 CUDA 12.x 机型）；部署机不需要这些
git clone https://github.com/Megvii-BaseDetection/YOLOX && cd YOLOX
pip install -r requirements.txt
python setup.py build_ext --inplace     # yolox 自带 CUDA/C++ 层，CPU 训练极慢，别跳过
# 预训练权重
wget https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.pth
```

### A2. 数据采集与标注

1. **采样**：从目标域素材抽有代表性的帧（覆盖不同镜头/光照/目标尺寸；几百到几千帧起步）。
   抽帧可以直接用引擎同款参数看分布：`ffmpeg -i input.mp4 -vf "select=not(mod(n\,150))" -vsync vfr frame_%04d.jpg`
2. **标注**：CVAT / Label Studio / Roboflow 任选，导出 **COCO json**（images / annotations /
   categories，bbox 为 xywh 绝对像素）。
   **人工成本怎么压**（监督检测器必须吃框+类别，但不必逐帧硬标）：
   - *模型辅助预标注*——现成 `yolox_s.onnx` 就是免费初标注员：COCO 内目标先批量推理出框
     （CVAT 内置模型推理，或 Label Studio 预标注后端），人工只做**修正**；第一轮训完用新模型
     预标第二批，成本继续降；
   - *开放词汇伪标签*——领域目标不在 COCO 里时用 Grounding DINO 这类文本驱动检测器批量出框
     + 人工抽检修正（伪标签的错误会被训练放大，抽检不可省）；
   - *合成场景零人工*——gameplay 等虚拟画面可从引擎侧直接拿对象坐标出完美真值；
   - **绕行判断前置**：目标若已在 COCO 80 类内，先跑一遍看 `saliency` 区分度，可能根本不用训；
     高光由语义承载走方向 B1、只想调偏好走 D1，都是零标注。预算有限时，D2 的"高光时间区间"
     标注（一维时间轴）比画框（二维像素）便宜得多，性价比通常更高。
3. **类别设计——两条路线，先选再训：**
   - **路线 1（推荐）：保持 80 类头不收缩。** `num_classes=80`，只拿领域数据训练
     （未标注的 COCO 类自然没有 GT）。导出的模型列数与 COCO 完全对齐，
     `detector.py` 的 `COCO_CLASSES` 查表、报告里的类别名、未来按类别加权**全部零改动可用**。
   - **路线 2：自定义 N 类。** 训练更省、域内更准，但类别 id 不再对齐 COCO——引擎会把
     id 0..N-1 查成 person/bicycle/…（错名），id ≥ 80 才回退成数字名。显著度**分数本身不受影响**
     （缺省权重按 1.0 均一），但要正确类别名就必须改上游 `detector.py` 的 `COCO_CLASSES`
     为你的类别表，再 `pnpm run sync:highlight-engine` 同步。

### A3. 训练（以路线 1 为例）

YOLOX 用 exp 文件描述数据集，复制一份改 `num_classes` / 数据路径：

```python
# exps/vhl_domain.py —— 继承 yolox_s 的 exp，只改数据三件套
import os
from yolox.exp import Exp

class MyExp(Exp):
    def __init__(self):
        super().__init__()
        self.num_classes = 80              # 路线 2 改成你的类别数
        self.data_dir = os.path.abspath("datasets/vhl_domain")
        self.train_ann = "train.json"      # COCO json
        self.val_ann = "val.json"
```

```sh
python tools/train.py -f exps/vhl_domain.py -n yolox-s -d 1 -b 16 --fp16 -o \
  -c yolox_s.pth \
  --name vhl_domain_run
# 产物在 YOLOX/output/vhl_domain_run/，取 best_ckpt.pth
```

验收训练本身：看 val mAP 曲线；再拿几张**训练集外的**真实帧目测框。检测框错了，
后面引擎信号全错，这一步不要省。

### A4. 导出 ONNX（对齐布局的关键一步）

```sh
python tools/export.py -f exps/vhl_domain.py -n yolox-s \
  -c output/vhl_domain_run/best_ckpt.pth \
  --output-name yolox_s_domain.onnx
```

注意：**不要**在导出里打开 decode/NMS——引擎自己做 grid decode 和逐类 NMS，
图里烘焙了后处理反而会让 `_decode_yolox` 拿到像素坐标当 cell 偏移解。

### A5. 对拍校验（训练机跑完，部署机复跑同一脚本）

```python
# check_layout.py —— 只用 onnxruntime，无其他依赖
import sys, onnxruntime as ort
s = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
i, o = s.get_inputs()[0], s.get_outputs()[0]
print("input :", i.name, i.shape)      # 期望 [1,3,640,640]（或动态 H/W）
print("output:", o.name, o.shape)      # yolox: [1,8400,5+nc]；rtdetr: [1,300,4+nc]
```

```sh
python check_layout.py yolox_s_domain.onnx
# 部署机上对官方基线复跑一次作对照：
python check_layout.py engine/models/yolox_s.onnx    # 期望 [1,8400,85]
```

形状对不上就回 A4 检查导出参数；`nc` 与你声明的类别数一致才能继续。

### A6. 部署到引擎

两个层面任选，都读（任务级优先）：

```sh
# 部署默认（环境变量，宿主启动桥时传入）：
export VHL_ONNX_MODEL=/abs/path/to/yolox_s_domain.onnx
export VHL_PYTHON=/abs/path/to/engine/.venv/bin/python   # 启用模型栈的 venv
```

```jsonc
// 任务级（RPC highlight.start 的 options；面板"检测模型路径"就是这个）：
{ "onnxModelPath": "/abs/path/to/yolox_s_domain.onnx" }
```

自检三连（不用启动宿主也能做前两步）：

```sh
python3 engine/vhl_bridge.py --doctor          # 解释器/FFmpeg/模型栈可用性 + environment 段
# 宿主起来后：
#   highlight.models  → onnxruntime/检测条目 available 与 license
#   highlight.options → onnxModelPath 的 available（缺 onnxruntime 时该控件应禁用并标注原因）
```

### A7. 验收（信报告，不信"参数被收下了"）

1. **指纹确认模型真的换了**：跑一个任务，读报告 `provenance.environment.models` 里检测条目的
   path + size + sha256 前 16 位——与旧 checkpoint 不同、与新文件一致。
2. **后端确认信号真的走了 ONNX**：`provenance.environment.signals.objectSaliency`
   必须是 `onnx-detector`（而不是 `ffmpeg-signalstats` 或 `none`）；
   与 `highlight.models` 的 `degraded` 判断一致（这是测试钉死过的跨面一致性）。
3. **区分度确认信号真的在干活**：报告 `signal_activity.object_saliency` 应明显高于
   换模型前的取值；`timeline_series` 里 saliency 序列应在目标出现的窗口抬升
   （参照 `engine/README.zh.md` 那张 43 秒素材七路信号区间表的做法）。
4. **回归**：`pnpm run verify:highlight:real`（全模型栈本机验收）。

### A8. 把 conf/IoU/format 暴露成任务旋钮（✅ 已完成，2026-11-11）

三个旋钮已在契约中（`onnxModelFormat` / `onnxConfThreshold` / `onnxIouThreshold`，
双侧生成表已同步、双语标签已补、73 桥用例 + 85 TS 用例 + 漂移闸门 + fake 冒烟全绿）。
留档当初的加行步骤，日后同类改动的模板：

1. `protocol/contract.json` 的 `options` 加（min/max 两侧都会强制）：

```json
"onnxModelFormat":   { "field": "onnx_model_format",   "type": "str",   "default": "yolox", "enum": ["yolox", "rtdetr"], "group": "vision" },
"onnxConfThreshold": { "field": "onnx_conf_threshold", "type": "float", "default": 0.35, "min": 0.0, "max": 1.0, "group": "vision" },
"onnxIouThreshold":  { "field": "onnx_iou_threshold",  "type": "float", "default": 0.45, "min": 0.0, "max": 1.0, "group": "vision" }
```

2. 重新生成协议表：`node product/highlight/scripts/gen-protocol.mjs`。
3. 加双语标签（**选项标签覆盖闸门会红**）：`packages/client/panel/src/messages.ts` 两个语言块
   各加 `'vhl.opt.onnxModelFormat': '…'` 等。
4. 跑 `pnpm run test:highlight`（选项目录断言）+ `check:highlight-drift` + `verify:highlight:fake`。

---

## 方向 B：CLIP 语义信号

引擎里 CLIP 承担两件事，训练价值不同，**先分清**：

- **`clipGuidance`**（逐帧语义打分）：`clip_prompt` 编码一次，与每帧图像嵌入算余弦，
  `(cos+1)/2` 后按本素材 98 分位归一进 `clip` 信号；
- **`contentPreset: "auto"`**（内容分类）：均匀采 12 帧（320×180），与每类手写 prompt
  （`classify.py` 的 `TYPE_PROMPTS`）的平均文本嵌入做余弦 argmax，选一个预设。粗先验。

### B1. Prompt 工程（免训练，永远先试这条）

`clipPrompt` 写法要点（cos 相似度对措辞敏感）：

- 用**英文、复数、具体名词短语**描述"高光时刻该是什么样"，多个场景用逗号并列
  （config 注释里的示例就是 `a goal celebration, a person speaking`）；
- 描述**画面**而不是描述价值判断：`two players embracing after scoring` 好过 `an exciting moment`
  （"exciting" 没有视觉锚点，分数退化为噪声）；
- 一次任务只支持**一条** prompt（单文本编码）；要区分多类时刻，跑多个任务换 prompt 对比，
  或等 B3 的多 prompt 扩展（上游改动）；
- **auto 分类的 prompt 表**在 `classify.py` 的 `TYPE_PROMPTS`（每类 2–3 条措辞取平均去偏）。
  新增一类（配合方向 D3 的新预设）就是在这里加一组 prompt——上游改，同步副本。

### B2. 换 CLIP checkpoint / 本地权重（✅ 已完成，2026-11-11）

`clipModelName` / `clipPretrained` 已暴露进契约（同一批改动，闸门全绿）。
`open_clip.create_model_and_transforms(config.clip_model_name, pretrained=config.clip_pretrained)`
的 `pretrained` 参数**接受本地 checkpoint 路径**（架构匹配的 state_dict），所以
fine-tune 产物直接可挂：

```json
{ "clipModelName": "ViT-B-32", "clipPretrained": "/abs/path/domain_ft.pt" }
```

**成本先看清楚**（本机实测，Intel x86_64 纯 CPU）：CLIP ViT-B-32 首次加载 + 下载 350 MB
617 s；`auto` 与 `clipGuidance` 目前**各加载一份**不共享（已知内存翻倍点）。换更大的
backbone（ViT-L 等）前先确认部署机扛得住。

### B3. 真 fine-tune CLIP（最后才考虑）

本产品里 CLIP 只出"先验/引导"两路**粗**信号，逐帧 cosine 归一后还要过 98 分位归一——
轻度 fine-tune 的收益经常被这个流程抹平。触发条件：领域画面与 CLIP 预训练分布差距极大
（俯拍棋盘、显微图像、特殊渲染风格），且 B1 调 prompt 已到头。

1. **数据**：领域帧 + 文本对（帧截图 + 一句画面描述；几百对即可起步，CSV: `caption\timage_path`）。
2. **训练**（GPU 机）：open_clip 自带训练模块，冻结塔做轻适配：

```sh
git clone https://github.com/mlfoundations/open_clip && cd open_clip && pip install -e .
python -m open_clip_train.main \
  --train-data pairs.csv --dataset-type csv --csv-separator '\t' \
  --model ViT-B-32 --pretrained laion2b_s34b_b79k \
  --lock-image --lock-text          # 冻结两塔、只训对齐层（轻适配起步；LoRA 走 peft 另加）
  --epochs 5 --batch-size 64 --workers 4
```

3. **导出**：训练产物是架构兼容的 state_dict，`torch.save` 成 `.pt`；
   校验 `open_clip.create_model_and_transforms("ViT-B-32", pretrained="<该文件>")` 能加载。
4. **部署**：走 B2 暴露的两个旋钮。
5. **验收**：同一段素材新旧 checkpoint 各跑一遍，对比报告 `clip` 信号的
   `signal_activity` 与被选片段——目标域内区分度提升、域外不劣化才算数。

---

## 方向 C：Whisper 转写 fine-tune（领域词）

**什么时候需要。** 转写把领域专有名词（选手 ID、招式名、品牌词）写错 → `keywords`
命中率塌掉 → `keyword` 信号失灵。这是 C 方向唯一的正当触发条件；普通字幕质量
提升不值得为它训模型。

### C1. 免训练替代（先做）

`keywords` 是普通字符串匹配（大小写不敏感，命中数/词数×2 封顶 1.0）。专有名词少时，
把**常见误写形态一并列入**（`["TheShy", "the shy", "THE SHY"]`）经常就够了。
顺带：Whisper base 在纯 CPU Intel 上建模 ~79 s，无语音素材直接 `enableWhisper:false`。

### C2. Fine-tune 全流程

**关键事实**：桥里 `WhisperModel(self.config.whisper_model_size, device='cpu', compute_type='int8')`
——faster-whisper 的第一个参数是 `size_or_path`，本地 CTranslate2 目录是合法值。
**但任务旋钮要走 `whisperModelPath`**（2026-11-11 新增的 special 选项）：`whisperModelSize`
在契约里被 enum 钉死为 hub 尺寸名（tiny/base/small/medium/large-v3），两侧都强制——
直传本地路径会在创建任务前被拒（这正是"拼错就在边界拦"的同一哲学；本手册初版说
`whisperModelSize` 可直传本地目录，是错的，以此为准）。

1. **造数据**（GPU 机）：
   - 拿目标域素材先用 base 模型粗转，人工/LLM 修正成参考文本（几十分钟素材即可起步）；
   - 按 HF transformers ASR 期望组织（audio 16k + text）；训练/验证切分留出领域词密集的验证集。

2. **训练**：transformers 官方 `run_speech_recognition_seq2seq.py` 起步（whisper-small 是
   CPU 推理可承受的上限，别直接 fine-tune large）：

```sh
python run_speech_recognition_seq2seq.py \
  --model_name_or_path openai/whisper-small \
  --dataset_name <你的数据集> \
  --language Chinese --task transcribe \
  --do_train --do_eval \
  --output_dir whisper_domain_ft \
  --per_device_train_batch_size 16 --learning_rate 1e-5 --warmup_steps 200 \
  --fp16 --evaluation_strategy steps --eval_steps 200
```

3. **转 CTranslate2**（faster-whisper 只吃这个格式）：

```sh
pip install ctranslate2
ct2-transformers-converter --model whisper_domain_ft \
  --output_dir whisper_domain_ct2 --quantization float16 --force
```

4. **部署**：目录拷到部署机（如 `engine/models/whisper-domain-ct2/`），任务里：

```json
{ "whisperModelPath": "/abs/path/to/whisper-domain-ct2" }
```

桥在创建任务时校验：whisper 能力缺失回 `UNAVAILABLE`（带安装提示）、目录不存在回
`NOT_FOUND`——都在任务被接受**之前**；通过后覆盖 `whisper_model_size`（`WhisperModel(size_or_path)`）。

5. **验收**：
   - 领域词召回：同一段素材 base vs fine-tune 各跑一次，比对转写里领域词出现次数
     （`keyword` 信号命中段数直接反映在报告 `timeline_series.keyword` 上）；
   - 报告 `provenance` 里 whisper 条目应指向你的目录（缺失也写明的同一规则适用）；
   - 注意 compute_type 固定 `int8`、device 固定 cpu（`auto` 解析成 cpu）——
     转换时的 float16 权重在加载时被再量化，属预期；
   - torch + ctranslate2 同进程的 OpenMP 冲突由 `openmp_guard.py` 自动修复
     （`setup-models.sh` 已做软链），手动装环境也不会踩。

---

## 方向 D：评分权重配方（不训模型，但属于"量化适配特殊场景"）

**先复述优先级**（`pipeline.py` 第 1b 步）：显式 `weights` > `contentPreset` > 默认；
`adaptiveWeights`（默认开）作用在解析后的配方上，按本素材逐信号离散度降权
（地板 0.1，再归一）。预设与分类都是**启发式**，没有一个环节学习过。

### D1. 手调校准闭环（每个新场景的第一步）

```sh
# ① 基线：关掉自适应，看这段素材各信号的原生活性
highlight.start → options: { "contentPreset": "general", "adaptiveWeights": false }
# ② 读报告 content_adaptation / timeline_series：
#    signal_activity 高的信号才是这段素材的"承重墙"
# ③ 显式权重实验（beats 一切预设）：
highlight.start → options: { "weights": { "audioRms": 0.4, "faceSaliency": 0.25, "keywordMatch": 0.2, "sceneCut": 0.05, "visualMotion": 0.05, "objectSaliency": 0.03, "clipGuidance": 0.02 }, "adaptiveWeights": false }
# ④ 对比被选片段与你的期望，迭代 ③；权重会按总和归一，绝对大小无意义、比例才有效
# ⑤ 稳定后回到 adaptiveWeights: true 验证地板行为（全平坦信号退回 base）
```

七个子键对应 `ScoringWeights` 场序：`sceneCut / audioRms / visualMotion / objectSaliency /
faceSaliency / clipGuidance / keywordMatch`。**全零会被两侧拒绝**（归一化会把全零静默换回
默认——接受了却没生效是最贵的 bug），未知子键/越界同样在创建任务前被拒。

### D2. 从标注数据学权重（上游扩展，今天不存在）

真有标注预算时的最短路径（不引入新模型，只学一个 7 维向量）：

1. **标注**：对 20–50 段领域素材标高光区间（任意时间轴标注工具，导出
   `[{startSec, endSec}]` JSON）；
2. **取特征**：每段素材跑一次分析，报告 `timeline_series` 就是逐窗口七路信号序列；
   窗口标签 = 与任一高光区间的 IoU（或 0/1）；
3. **拟合**：对窗口特征做排序学习（LambdaMART / RankNet）或最简单的带非负约束的
   线性回归，目标 = 窗口标签；回归系数按和归一，即权重向量；
4. **回验**：学出的向量 vs D1 手调向量 vs 默认，三组对照看被选片段与标注区间的重合率；
5. **固化**：进 D3。

### D3. 把配方固化成新预设（✅ 首个已完成，2026-11-11：`fps`）

**`fps` 预设已固化**（keyword_heavy 候选，CF 素材弱标注 IoU 0.361 vs 默认 0.262，同口径对拍胜出；
向量 `(0.10, 0.25, 0.00, 0.00, 0.15, 0.00, 0.50)`）——上游 `presets.py` + `classify.py` TYPE_PROMPTS
+ 契约枚举 + sync + gen-protocol，73 桥用例 + 85 TS 用例 + 漂移闸门 + fake/real 冒烟全绿。
证据是**单片段弱标注**（28.8s CF 录像、agent 目检 ±1.2s），用你自己的素材跑 §D1 闭环复核；
不合适就显式 `weights` 覆盖或再校准。日后同款固化步骤链：

1. `presets.py`：`PRESET_WEIGHTS` 加一行（七元组，和为 1.0；`normalized()` 幂等）；
2. `classify.py`：`TYPE_PROMPTS` 加该类英文 prompt（否则 `auto` 永远分不出它）；
3. `protocol/contract.json`：`contentPreset.enum` 加名（宿主与引擎两侧同时生效）；
   `packages/client/panel/src/messages.ts` 加预设枚举显示文案（若有枚举文案闸门）；
4. `pnpm run sync:highlight-engine` 同步副本 → `check:highlight-drift` 全绿；
5. `pnpm run test:highlight`（内容适配契约 8 例：枚举恰为 5+auto、未知名拒绝等会自动覆盖新值）
   + `verify:highlight:real`。

预设**只是一份权重向量**：不打开/关闭任何信号、不强制任何模型依赖——选了 `interview`
而没装 MediaPipe，face 照样是 0，预设不会假装它跑过。

---

## 附录一：诊断与验收命令速查

```sh
sh product/highlight/scripts/setup-models.sh   # venv + 模型栈 + yolox_s.onnx + CLIP/whisper 预缓存
python3 engine/vhl_bridge.py --doctor          # 不启动宿主，现场打印 environment（与报告 provenance 同源）
pnpm run host:highlight                        # http://127.0.0.1:3093
# RPC: highlight.models（各模型 available/license/degradedReason）
#      highlight.options（全部旋钮 + 本机 available）
#      highlight.status → jobJson；报告 = GET /api/highlight.report.<jobId>
pnpm run test:highlight            # 85 用例，不需要 Python/FFmpeg
pnpm run test:highlight:py         # 桥自身 70 用例
pnpm run verify:highlight:real     # 端到端真引擎验收（需要模型栈）
pnpm run check:highlight-drift     # 副本/协议/名册三道漂移闸门
```

**报告里的三类"是谁在算"字段，验收一律以它们为准**：

- `provenance.environment.signals`：七路信号各自的后端实现名
  （`opencv-framediff` / `ffmpeg-signalstats` / `onnx-detector` / `mediapipe` / `open_clip` /
  `faster-whisper` / `none`）——布尔值会掩盖两台不可比的机器，后端名不会；
- `provenance.environment.models`：模型 path + size + mtime + sha256 前 16 位
  （**缺失也写明**）；同机两次任务 `environment` 逐字节相同、`fingerprint` 随配方不同而不同；
- `content_adaptation`：requested/resolved preset、effective_weights、signal_activity、
  classification（auto 的分数与降级原因）。

## 附录二：版本约束速查（部署机钉版，训练机自由）

| 组件 | 部署机钉版 | 原因 |
|---|---|---|
| Python | 3.11 | torch 2.2.2 与 MediaPipe 0.10.9 的 Intel mac wheel 天花板 |
| numpy | 1.26.4 | 上述两者按 1.x 编译 |
| onnxruntime | 1.23.2 | macOS x86_64 带 CoreML EP |
| torch / torchvision | 2.2.2 / 0.17.2 | 最后一个 Intel mac wheel |
| mediapipe / protobuf | 0.10.9 / 4.25.8 | mediapipe `--no-deps` 装并单独钉 protobuf |
| open-clip-torch | 3.3.0 | — |
| faster-whisper / ctranslate2 | 1.2.1 / 4.8.5 | 双 libiomp5 冲突由 openmp_guard 兜底 |

训练机（A/B/C 的训练环节）不受此表约束——训练产物是 ONNX / CT2 目录 / state_dict 三种
**格式中性的文件**，拷过去即插即用；这正是把训练与部署拆成两台机器的理由。
