// @vhl/ui-highlight / messages.ts — every string the panels show.
//
// No UI string lives in a component (base rule): components call
// `t('vhl.…')`, and `stageLabel` / `stateLabel` map the engine's stable
// identifiers onto these keys. The host's error keys
// (`highlight.engineRejected`, `engine.commandFailed`) are resolved by
// `ctx.i18n.errorText`, so the dictionary below only needs the product's own
// copy.

export const HIGHLIGHT_MESSAGES = {
  'zh-CN': {
    'vhl.control.title': '高光分析',
    'vhl.control.input': '输入视频(绝对路径)',
    'vhl.control.inputPlaceholder': '/Users/you/Movies/match.mp4',
    'vhl.control.topK': '片段数',
    'vhl.control.duration': '单段时长(秒)',
    'vhl.control.probe': '探测',
    'vhl.control.start': '开始分析',
    'vhl.control.cancel': '取消',
    'vhl.control.idle': '未提交任务',
    'vhl.control.engine': '引擎',
    'vhl.control.engineDown': '引擎未握手',
    // One key per CAUSE, because each cause is a different fix: "install OpenCV" is
    // wrong advice on a machine that has it and cannot import it (a Homebrew keg
    // whose libprotobuf moved), and wrong again on one whose cv2 is fine but numpy
    // is missing. The bare key is the fallback for a reason this build does not
    // know, and it deliberately does not name a cause.
    'vhl.control.degraded': '降级模式:视觉依赖不可用 · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.degraded.opencv-missing': '降级模式:未安装 OpenCV · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.degraded.numpy-missing': '降级模式:缺少 numpy · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.degraded.opencv-import-failed': '降级模式:OpenCV 已安装但导入失败 · 视觉信号回退到 FFmpeg signalstats',
    // The interpreter variants name WHICH interpreter is missing the dependency.
    // On a machine with several Pythons, "OpenCV not installed" is false —
    // OpenCV is installed, in the other interpreter. So the text says which one
    // is running, and asks the question that has an answer.
    'vhl.control.degraded.opencv-missing.interpreter': '降级模式:当前解释器({interpreter})未安装 OpenCV · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.degraded.numpy-missing.interpreter': '降级模式:当前解释器({interpreter})缺少 numpy · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.degraded.opencv-import-failed.interpreter': '降级模式:当前解释器({interpreter})的 OpenCV 导入失败 · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.degraded.interpreter': '降级模式:当前解释器({interpreter})的视觉依赖不可用 · 视觉信号回退到 FFmpeg signalstats',
    'vhl.control.media': '媒体',
    'vhl.control.jobs': '任务',
    'vhl.control.noJobs': '本进程内暂无任务',
    'vhl.control.stage': '阶段',
    'vhl.control.progress': '进度',
    'vhl.control.advanced': '高级参数',
    'vhl.control.requiresMissing': '缺少依赖',

    'vhl.group.analysis': '分析信号',
    'vhl.group.scoring': '评分权重',
    'vhl.group.selection': '选片策略',
    'vhl.group.text': '文本与字幕',
    'vhl.group.output': '输出',

    'vhl.opt.frameSkip': '抽帧间隔(帧)',
    'vhl.opt.sceneThreshold': '场景切换阈值',
    'vhl.opt.enableFaceDetection': '人脸显著性',
    'vhl.opt.enableClipGuidance': '零样本文本引导',
    'vhl.opt.clipPrompt': '引导提示词',
    'vhl.opt.onnxModelPath': '检测模型路径',
    'vhl.opt.minGapSec': '片段最小间隔(秒)',
    'vhl.opt.timeBinSec': '时间粒度(秒)',
    'vhl.opt.contextLeadInSec': '前置上下文(秒)',
    'vhl.opt.contextLeadOutSec': '后置上下文(秒)',
    'vhl.opt.contextMergeGapSec': '相邻片段合并间隔(秒)',
    'vhl.opt.enableWhisper': '语音转写',
    'vhl.opt.whisperModelSize': '转写模型',
    'vhl.opt.subtitleLanguage': '字幕语言',
    'vhl.opt.translateToLang': '翻译目标语言',
    'vhl.opt.keywords': '关键词(逗号分隔)',
    'vhl.opt.fastStreamCopy': '流拷贝(快,关键帧对齐)',
    'vhl.opt.frameAccurate': '帧级精确(重编码)',
    'vhl.opt.contentPreset': '内容预设',
    'vhl.opt.adaptiveWeights': '自适应降权',
    'vhl.opt.weights': '信号权重',
    'vhl.opt.weightsHint': '相对权重,引擎按总和归一',
    'vhl.weight.sceneCut': '场景切换',
    'vhl.weight.audioRms': '音频能量',
    'vhl.weight.visualMotion': '画面运动',
    'vhl.weight.objectSaliency': '目标显著性',
    'vhl.weight.faceSaliency': '人脸显著性',
    'vhl.weight.clipGuidance': '文本引导',
    'vhl.weight.keywordMatch': '关键词命中',
    'vhl.opt.embedSoftSubtitles': '内嵌软字幕',

    'vhl.result.title': '片段与成片',
    'vhl.result.empty': '提交任务后在此查看片段与成片',
    'vhl.result.clip': '成片',
    'vhl.result.noClip': '任务成功后出现成片',
    'vhl.result.segments': '片段',
    'vhl.result.exportEdl': '导出 EDL',
    'vhl.result.edl': 'EDL 路径',
    'vhl.result.report': '报告',
    'vhl.result.srt': '字幕',
    'vhl.result.seek': '定位',
    'vhl.result.score': '分数',
    'vhl.result.signals': '信号',
    'vhl.result.open': '打开',
    'vhl.result.subtitlesTrack': '中文字幕',
    'vhl.result.artifacts': '产物',

    'vhl.error.inputRequired': '请先填写输入视频的绝对路径',

    'vhl.state.queued': '排队中',
    'vhl.state.running': '分析中',
    'vhl.state.succeeded': '已完成',
    'vhl.state.failed': '失败',
    'vhl.state.cancelled': '已取消',
    // The host went away mid-job. Not "failed" — the work never got a verdict —
    // and the label says so, because the next action (resubmit) is different.
    'vhl.state.interrupted': '已中断(宿主重启)',

    'vhl.stage.probe': '探测媒体',
    'vhl.stage.scenes': '场景切分',
    'vhl.stage.audio': '音频能量',
    'vhl.stage.vision': '视觉显著性',
    'vhl.stage.subtitles': '字幕',
    'vhl.stage.scoring': '多模态融合',
    'vhl.stage.render': '渲染成片',
    'vhl.stage.report': '导出报告',
    'vhl.stage.done': '完成',
    'vhl.stage.cancelling': '正在取消',
    'vhl.stage.cancelled': '已取消',
    'vhl.stage.failed': '失败',
    'vhl.stage.queued': '排队中',
  },
  en: {
    'vhl.control.title': 'Highlights',
    'vhl.control.input': 'Input video (absolute path)',
    'vhl.control.inputPlaceholder': '/Users/you/Movies/match.mp4',
    'vhl.control.topK': 'Clips',
    'vhl.control.duration': 'Clip length (s)',
    'vhl.control.probe': 'Probe',
    'vhl.control.start': 'Analyze',
    'vhl.control.cancel': 'Cancel',
    'vhl.control.idle': 'No job submitted',
    'vhl.control.engine': 'Engine',
    'vhl.control.engineDown': 'engine not handshaken',
    'vhl.control.degraded': 'Degraded: vision dependencies unavailable — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.opencv-missing': 'Degraded: OpenCV not installed — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.numpy-missing': 'Degraded: numpy is missing — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.opencv-import-failed': 'Degraded: OpenCV is installed but fails to import — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.opencv-missing.interpreter': 'Degraded: the running interpreter ({interpreter}) has no OpenCV — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.numpy-missing.interpreter': 'Degraded: the running interpreter ({interpreter}) has no numpy — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.opencv-import-failed.interpreter': 'Degraded: OpenCV fails to import in the running interpreter ({interpreter}) — visual signals fall back to FFmpeg signalstats',
    'vhl.control.degraded.interpreter': 'Degraded: vision dependencies unavailable in the running interpreter ({interpreter}) — visual signals fall back to FFmpeg signalstats',
    'vhl.control.media': 'Media',
    'vhl.control.jobs': 'Jobs',
    'vhl.control.noJobs': 'No job in this process yet',
    'vhl.control.stage': 'Stage',
    'vhl.control.progress': 'Progress',
    'vhl.control.advanced': 'Advanced',
    'vhl.control.requiresMissing': 'missing dependency',

    'vhl.group.analysis': 'Analysis signals',
    'vhl.group.scoring': 'Scoring weights',
    'vhl.group.selection': 'Selection',
    'vhl.group.text': 'Text & subtitles',
    'vhl.group.output': 'Output',

    'vhl.opt.frameSkip': 'Frame skip (frames)',
    'vhl.opt.sceneThreshold': 'Scene cut threshold',
    'vhl.opt.enableFaceDetection': 'Face saliency',
    'vhl.opt.enableClipGuidance': 'Zero-shot text guidance',
    'vhl.opt.clipPrompt': 'Guidance prompt',
    'vhl.opt.onnxModelPath': 'Detector model path',
    'vhl.opt.minGapSec': 'Min gap between clips (s)',
    'vhl.opt.timeBinSec': 'Time bin (s)',
    'vhl.opt.contextLeadInSec': 'Lead-in context (s)',
    'vhl.opt.contextLeadOutSec': 'Lead-out context (s)',
    'vhl.opt.contextMergeGapSec': 'Merge gap (s)',
    'vhl.opt.enableWhisper': 'Transcribe speech',
    'vhl.opt.whisperModelSize': 'Transcription model',
    'vhl.opt.subtitleLanguage': 'Subtitle language',
    'vhl.opt.translateToLang': 'Translate to',
    'vhl.opt.keywords': 'Keywords (comma separated)',
    'vhl.opt.fastStreamCopy': 'Stream copy (fast, keyframe aligned)',
    'vhl.opt.frameAccurate': 'Frame accurate (re-encode)',
    'vhl.opt.contentPreset': 'Content preset',
    'vhl.opt.adaptiveWeights': 'Adaptive down-weighting',
    'vhl.opt.weights': 'Signal weights',
    'vhl.opt.weightsHint': 'relative; the engine normalises by the total',
    'vhl.weight.sceneCut': 'Scene cuts',
    'vhl.weight.audioRms': 'Audio energy',
    'vhl.weight.visualMotion': 'Motion',
    'vhl.weight.objectSaliency': 'Object saliency',
    'vhl.weight.faceSaliency': 'Face saliency',
    'vhl.weight.clipGuidance': 'Text guidance',
    'vhl.weight.keywordMatch': 'Keyword hits',
    'vhl.opt.embedSoftSubtitles': 'Embed soft subtitles',

    'vhl.result.title': 'Segments & clip',
    'vhl.result.empty': 'Submit a job to review segments and the clip here',
    'vhl.result.clip': 'Clip',
    'vhl.result.noClip': 'The clip appears once the job succeeds',
    'vhl.result.segments': 'Segments',
    'vhl.result.exportEdl': 'Export EDL',
    'vhl.result.edl': 'EDL path',
    'vhl.result.report': 'Report',
    'vhl.result.srt': 'Subtitles',
    'vhl.result.seek': 'Seek',
    'vhl.result.score': 'Score',
    'vhl.result.signals': 'Signals',
    'vhl.result.open': 'Open',
    'vhl.result.subtitlesTrack': 'Subtitles',
    'vhl.result.artifacts': 'Artifacts',

    'vhl.error.inputRequired': 'Enter the absolute path of the input video first',

    'vhl.state.queued': 'Queued',
    'vhl.state.running': 'Running',
    'vhl.state.succeeded': 'Succeeded',
    'vhl.state.failed': 'Failed',
    'vhl.state.cancelled': 'Cancelled',
    'vhl.state.interrupted': 'Interrupted (host restarted)',

    'vhl.stage.probe': 'Probing',
    'vhl.stage.scenes': 'Scene cuts',
    'vhl.stage.audio': 'Audio energy',
    'vhl.stage.vision': 'Visual saliency',
    'vhl.stage.subtitles': 'Subtitles',
    'vhl.stage.scoring': 'Fusion',
    'vhl.stage.render': 'Rendering',
    'vhl.stage.report': 'Report',
    'vhl.stage.done': 'Done',
    'vhl.stage.cancelling': 'Cancelling',
    'vhl.stage.cancelled': 'Cancelled',
    'vhl.stage.failed': 'Failed',
    'vhl.stage.queued': 'Queued',
  },
} as const

/** Map an engine stage identifier to its message key (unknown → raw id). */
export function stageKey(stage: string): string {
  return `vhl.stage.${stage}`
}

/** Map a job state identifier to its message key. */
export function stateKey(state: string): string {
  return `vhl.state.${state}`
}

/**
 * Map the engine's degradation code onto its message key.
 *
 * Unknown codes fall back to the bare key, which names no cause: a panel that
 * guessed "not installed" for a machine that has OpenCV sends the operator to
 * install what is already there. The engine's codes are the contract
 * (`opencv-missing` / `numpy-missing` / `opencv-import-failed`, see
 * `opencv_issue()`), and it sends '' when nothing is degraded.
 */
export function degradedKey(reason: string): string {
  return reason === 'opencv-missing' || reason === 'numpy-missing' || reason === 'opencv-import-failed'
    ? `vhl.control.degraded.${reason}`
    : 'vhl.control.degraded'
}

/**
 * The degradation text, with the interpreter that caused it.
 *
 * Why the interpreter goes IN the sentence rather than beside it: the fact
 * being reported is about an interpreter, not about the machine. A laptop with
 * three Pythons usually has OpenCV in one of them, and "OpenCV not installed"
 * sends the operator to install it a fourth time — into whichever interpreter
 * happens to be first on PATH, which is not the one that reported the problem.
 *
 * So the text names the interpreter and asks the question that actually has an
 * answer: is this the interpreter you meant? If it is not, point the host at
 * the right one (VHL_PYTHON) or let it find the engine's own venv.
 *
 * The code-only text stays for the case where no interpreter was reported (an
 * older engine): a specific guess beats no guess, but a wrong guess about the
 * machine is worse than an incomplete one.
 */
export function degradedText(
  reason: string,
  interpreter: string,
): { key: string; params?: Record<string, string> } {
  const key = degradedKey(reason)
  if (interpreter === '') return { key }
  return { key: `${key}.interpreter`, params: { interpreter } }
}
