"""
GENERATED from product/highlight/protocol/contract.json — DO NOT EDIT BY HAND.

Regenerate:  node product/highlight/scripts/gen-protocol.mjs
Why it exists: the bridge must still know its verbs when it runs outside the
product tree (a packaged engine, a test double), and a hand-maintained second
copy of the verb table is exactly the drift this contract design removed.

SPDX-License-Identifier: Apache-2.0
"""

PROTOCOL_VERSION = 1

VERBS = {
    "hello": {"framing": "verb", "request": [], "response": ["protocol", "engine", "python", "ffmpeg"]},
    "ping": {"framing": "verb", "request": [], "response": ["verdict"]},
    "probe": {"framing": "ok", "request": ["path"], "response": ["mediaJson"]},
    "analyze.start": {"framing": "ok", "request": ["jobId", "input", "output", "optionsJson"], "response": ["jobJson"]},
    "analyze.status": {"framing": "ok", "request": ["jobId"], "response": ["jobJson"]},
    "analyze.cancel": {"framing": "ok", "request": ["jobId"], "response": ["jobJson"]},
    "jobs.list": {"framing": "ok", "request": [], "response": ["jobsJson"]},
    "export.edl": {"framing": "ok", "request": ["jobId", "path"], "response": ["path"]},
    "models.list": {"framing": "ok", "request": [], "response": ["modelsJson"]},
    "options.list": {"framing": "ok", "request": [], "response": ["optionsJson"]},
    "quit": {"framing": "ok", "request": [], "response": []},
}

# key -> (HighlightConfig attribute, coercion). Options flagged 'special' are
# handled by the bridge itself and never reach HighlightConfig.
OPTIONS = {
    "clipDurationSec": ("clip_duration_sec", "float"),
    "maxHighlights": ("max_highlights", "int"),
    "minGapSec": ("min_gap_sec", "float"),
    "timeBinSec": ("time_bin_sec", "float"),
    "sceneThreshold": ("scene_threshold", "float"),
    "frameSkip": ("frame_skip", "int"),
    "contextLeadInSec": ("context_lead_in_sec", "float"),
    "contextLeadOutSec": ("context_lead_out_sec", "float"),
    "contextMergeGapSec": ("context_merge_gap_sec", "float"),
    "keywords": ("keywords", "strs"),
    "enableWhisper": ("enable_whisper", "bool"),
    "whisperModelSize": ("whisper_model_size", "str"),
    "subtitleLanguage": ("subtitle_language", "str"),
    "translateToLang": ("translate_to_lang", "str"),
    "fastStreamCopy": ("fast_stream_copy", "bool"),
    "frameAccurate": ("frame_accurate", "bool"),
    "embedSoftSubtitles": ("embed_soft_subtitles", "bool"),
    "onnxModelPath": ("onnx_model_path", "str"),
    "enableFaceDetection": ("enable_face_detection", "bool"),
    "enableClipGuidance": ("enable_clip_guidance", "bool"),
    "clipPrompt": ("clip_prompt", "str"),
    "srtPath": ("", "str"),
    "contentPreset": ("content_preset", "str"),
    "adaptiveWeights": ("adaptive_weights", "bool"),
    "weights": ("weights", "weights"),
}

# The full declaration (min/max/enum/requires/group/default) as declared in the
# contract; both sides validate against it and the UI renders from it.
OPTION_META = {
    "clipDurationSec": {"field":"clip_duration_sec","type":"float","default":6,"min":0.5,"max":120,"group":"output"},
    "maxHighlights": {"field":"max_highlights","type":"int","default":5,"min":1,"max":50,"group":"output"},
    "minGapSec": {"field":"min_gap_sec","type":"float","default":1.5,"min":0,"max":60,"group":"selection"},
    "timeBinSec": {"field":"time_bin_sec","type":"float","default":0.5,"min":0.1,"max":5,"group":"selection"},
    "sceneThreshold": {"field":"scene_threshold","type":"float","default":0.25,"min":0,"max":1,"group":"analysis"},
    "frameSkip": {"field":"frame_skip","type":"int","default":5,"min":1,"max":60,"group":"analysis"},
    "contextLeadInSec": {"field":"context_lead_in_sec","type":"float","default":1.2,"min":0,"max":15,"group":"selection"},
    "contextLeadOutSec": {"field":"context_lead_out_sec","type":"float","default":1.2,"min":0,"max":15,"group":"selection"},
    "contextMergeGapSec": {"field":"context_merge_gap_sec","type":"float","default":0.75,"min":0,"max":30,"group":"selection"},
    "keywords": {"field":"keywords","type":"strs","default":[],"group":"text"},
    "enableWhisper": {"field":"enable_whisper","type":"bool","default":True,"group":"text","requires":"whisper"},
    "whisperModelSize": {"field":"whisper_model_size","type":"str","default":"base","enum":["tiny","base","small","medium","large-v3"],"group":"text","requires":"whisper"},
    "subtitleLanguage": {"field":"subtitle_language","type":"str","default":"zho","group":"text"},
    "translateToLang": {"field":"translate_to_lang","type":"str","default":"","group":"text"},
    "fastStreamCopy": {"field":"fast_stream_copy","type":"bool","default":True,"group":"output"},
    "frameAccurate": {"field":"frame_accurate","type":"bool","default":False,"group":"output"},
    "embedSoftSubtitles": {"field":"embed_soft_subtitles","type":"bool","default":True,"group":"output"},
    "onnxModelPath": {"field":"onnx_model_path","type":"str","default":"","group":"analysis","requires":"onnxruntime"},
    "enableFaceDetection": {"field":"enable_face_detection","type":"bool","default":False,"group":"analysis","requires":"face"},
    "enableClipGuidance": {"field":"enable_clip_guidance","type":"bool","default":False,"group":"analysis","requires":"clip"},
    "clipPrompt": {"field":"clip_prompt","type":"str","default":"","group":"analysis","requires":"clip"},
    "srtPath": {"field":"","type":"str","default":"","group":"text","special":True},
    "contentPreset": {"field":"content_preset","type":"str","default":"general","enum":["general","sports","interview","gameplay","music","auto"],"group":"scoring","comment":"Weight profile per video type; presets are heuristic starting points, not learned. 'auto' classifies content via OpenCLIP and so needs the clip capability (enforced host-side and bridge-side, since the generic requires is per-option not per-value); the other values are pure weight vectors needing no model. An explicit weights choice overrides any preset."},
    "adaptiveWeights": {"field":"adaptive_weights","type":"bool","default":True,"group":"scoring","comment":"Down-weight signals that are near-constant on THIS video so they cannot mask discriminative ones (e.g. object saliency saturated at 1.0). Pure selection improvement; set False to compare against the raw recipe. The report records the effective weights and per-signal activity."},
    "weights": {"field":"weights","type":"weights","group":"scoring","fields":{"sceneCut":{"field":"scene_cut","default":0.18},"audioRms":{"field":"audio_rms","default":0.22},"visualMotion":{"field":"visual_motion","default":0.18},"objectSaliency":{"field":"object_saliency","default":0.16},"faceSaliency":{"field":"face_saliency","default":0.1},"clipGuidance":{"field":"clip_guidance","default":0.1},"keywordMatch":{"field":"keyword_match","default":0.06}}},
}
