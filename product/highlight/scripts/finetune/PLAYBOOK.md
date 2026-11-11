# FINETUNE 看护手册（自包含，给定时器/新会话执行用）

> 本目录是 highlight 产品层四个 fine-tune 方向的**工具与账本**。
> 你（执行者）不需要读对话历史：本文件 + `state.json` 就是全部上下文。
> `state.json`、`watchdog.log`、`work/` 是运行期产物，已 gitignore——新克隆上它们
> 不存在属正常，看护会按本手册重新生成账本并推进。

## 硬规则（先读这个）

1. **禁止修改** `product/highlight/engine/highlight_core/` —— 同步副本，改上游仓再
   `pnpm run sync:highlight-engine`。本目录的脚本都是**产品侧工具**，不在副本里。
2. **禁止在本机尝试训练**：本机是 macOS Intel x86_64 **无 GPU**（torch 2.2.2 CPU 上限），
   YOLOX/CLIP/Whisper 的训练步骤在 GPU 训练机跑（命令见 `docs/FINETUNE.zh.md`）。
3. **禁止重做 status=done 的步骤**；脚本幂等，只有 status=running（中断残留）或
   pending 且 unblocked 的步骤才允许执行。
4. 完成任何步骤后：更新 `state.json` 对应条目（status/result/updated），并向
   `watchdog.log` 追加一行 `<ISO时间> <step-id> <status> <一句话结果>`。
5. 输出保持简短；不要长篇叙述。

## 目录

```
scripts/finetune/
├─ PLAYBOOK.md            ← 本文件（执行规则 + 各步骤命令）
├─ state.json             ← 步骤账本（status: done|pending|running|blocked）
├─ watchdog.log           ← 看护追加日志
├─ env_check.sh           环境核验（依赖齐全性，~3s）
├─ fixture.py             生成结构化测试素材（高光位置由构造已知）+ ground_truth.json
├─ extract_frames.py      A2 抽帧 → 标注工具导入
├─ preannotate.py         A2 预标注：引擎 OnnxDetector 批量出框 → COCO json（人工只修正）
├─ check_layout.py        A5 ONNX 布局对拍（训练机/部署机都要跑）
├─ exp_template/          A3 YOLOX exp 模板（拷到训练机 YOLOX 仓）
├─ calibrate_weights.py   D1 多权重配方完整 pipeline 校准 + IoU 对比
├─ learn_weights.py       D2 标注 + timeline 报告 → 学 7 维权重（非负最小二乘）
├─ report_diff.py         多份报告对比（effective_weights / 片段 / IoU / 信号统计）
├─ prompt_probe.py        B1 CLIP prompt 区分度探针（--auto-check 顺带验引擎分类）
├─ keyword_eval.py        C1 转写 + 关键词召回评测（model 可传本地 CT2 目录）
├─ convert_whisper_ct2.sh C2 HF fine-tune 产物 → CTranslate2（训练机跑）
└─ work/                  产物（fixture / calibration / learned_weights.json …）
```

## 执行协议

1. 读 `state.json`。
2. 找到**第一个** `status` 为 `running` 或 `pending` 且 `unblocked==true` 的步骤，
   在 `scripts/finetune/` 目录下用 `engine/.venv/bin/python` 执行其 `cmd`。
3. 成功 → status=done + result 摘要；失败 → status=running 保留（下次看护重试），
   错误写进 result。
4. 全部步骤都是 done 或 blocked 时：跑 `sh env_check.sh` 确认健康，追加一行
   `watchdog OK`，结束。**不要发明新工作**。
5. blocked 步骤的解阻塞条件写在各条目 `unblock` 字段里，条件不满足就跳过。

## 已完成的关键实测结果（不要重跑，引用即可）

- `check_layout.py`：官方 `yolox_s.onnx` = `[1,8400,85]`，nc=80，COCO 对齐 PASS。
- `calibrate_weights.py`（40s 夹具，4 变体）：显式权重通路已修复（`weights_explicit`
  必须置位，否则 pipeline 1b 步用 general 预设改写 config.weights——桥在 RPC 路径上做，
  直跑 pipeline 必须自己置）；`motion_heavy` 使片段边界移动（[4.4-14.6] vs [3.9-14.1]），
  证明权重真实进评分；各变体 vs ground-truth IoU≈0.523。
- `learn_weights.py`：从构造标注学得权重区分度 0.917 vs 引擎默认 0.507（夹具上
  object_saliency 独大 0.93 是单信号完美相关的夹具特性；真实素材需地板/正则）。
- `prompt_probe.py`：CLIP 缓存命中后 43s 跑完；`--auto-check` 实跑引擎分类成功
  （resolved=gameplay，五类分数齐全）。
- `preannotate.py`：34 帧批量推理 + COCO json 合法（合成素材 0 检出属预期）。
- `keyword_eval.py`：whisper 加载→转写→关键词评分全链路通（正弦音 1 cue 幻觉、0 命中）。

## blocked 步骤总览（解阻塞条件）

| id | 需要 | 解阻塞后动作 |
|---|---|---|
| a3_train / a4_export | GPU 训练机 + **人工标注过的领域数据集** | FINETUNE.zh.md A1-A4 + exp_template |
| a6_deploy_domain | a4 产物 onnx | 部署 + A7 验收（provenance sha256 / signals 后端 / signal_activity） |
| b3_clip_finetune | GPU + 领域图文对 | FINETUNE.zh.md B3 + B2 的两个契约行 |
| c2_whisper_finetune | GPU + 领域语音数据 | convert_whisper_ct2.sh → whisperModelSize 本地目录 |
| a8_expose_knobs / b2_expose_clip_model | **用户决策**（改 RPC 契约表面） | contract.json 加行 + gen-protocol + messages.ts 双语标签 + 三道测试 |
| d3_freeze_preset | 用户确认的权重向量 + 上游仓 | presets.py/TYPE_PROMPTS/enum → sync → drift 闸门 |
| b1_real / c1_real | ✅ 已完成（2026-11-11，本机找到的真实素材 /Users/samychen/Develop/cf原视频.mp4） | 换领域时对现有脚本直接跑 |
