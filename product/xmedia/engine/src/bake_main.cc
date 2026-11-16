// Copyright 2026 The mediabase Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// xmedia-bake — the PRODUCT-OWNED offline HTML→MP4 bake CLI (HyperFrames
// aligned), spawned by xmedia-bridge for `bake.start` jobs.
//
// The pipeline wiring follows xmedia-kit's examples/html_bake.cc (CEF OSR with
// the VirtualTime bake clock → GlElementComposer element-to-texture → GlScene
// composite → BGRA readback → I420 → FFmpegVideoEncoder → FFmpegEncodeMuxer,
// optional audio mixdown, chunked bake + lossless concat, element metadata
// export) — but this is NOT a copy of the example: it is the product shape of
// the same pipeline,
//   * structured `PROGRESS\t<stage>\t<percent>` lines on stderr (the bridge
//     parses them into the events queue; everything else on stderr is plain
//     logging routed through the host's scoped logger),
//   * cooperative cancellation on SIGTERM (partial output + chunk files are
//     removed, exit code 3),
//   * explicit exit codes: 0 ok / 1 failure / 2 usage / 3 cancelled,
//   * `--audio 0` to skip the audio leg (default on, HyperFrames contract).
//
// macOS CEF contract: Chromium relaunches this binary as --type=... child
// processes, and the host must run inside a .app bundle (assembled by the kit's
// xmedia_assemble_cef_app(); see engine/CMakeLists.txt). The helper
// interception below MUST stay the first thing in main().
//
// Known pipeline boundaries (inherited from the upstream example, stated here
// so nobody rediscovers them the hard way):
//   * the first frame of an element's birth window may miss the element (CEF
//     renderer repaint laziness on visibility restore),
//   * tiling raster clips assume NON-overlapping elements,
//   * file:// pages must inline their script subresources (OSR renders
//     relative file:// scripts black).

#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "base/logging.h"
#include "media/base/video_frame.h"
#include "media/cef/cef_app.h"
#include "media/cef/cef_layer_source.h"
#include "media/cef/cef_runtime.h"
#include "media/ffmpeg/av_includes.h"
#include "media/ffmpeg/compat.h"
#include "media/ffmpeg/video_convert.h"
#include "media/gl/gl_element_composer.h"
#include "media/gl/gl_present.h"
#include "media/gl/gl_scene.h"
#include "media/media_export.h"
#include "media/transcode/ffmpeg_concat_job.h"
#include "media/transcode/ffmpeg_encode_muxer.h"
#include "media/transcode/audio_mixdown.h"
#include "media/transcode/ffmpeg_audio_encoder.h"
#include "media/transcode/ffmpeg_video_encoder.h"
#include "platform/glfw/glfw_gl_context.h"
#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"
#include "render/gl/gl_api.h"

#if defined(XMEDIA_HAS_LOTTIE) && XMEDIA_HAS_LOTTIE
#include "media/lottie/lottie_animation.h"
#include "media/lottie/lottie_clock.h"
#endif

#if !(defined(XMEDIA_HAS_CEF) && XMEDIA_HAS_CEF)
int main() {
  std::fprintf(stderr, "xmedia-bake: built without XMEDIA_ENABLE_CEF\n");
  return 1;
}
#else

namespace ff = xmedia::media::ffmpeg;

// CEF single-binary child-process model: Chromium relaunches this binary with
// --type=... for its renderer/GPU/network roles. Intercept, load the framework
// and delegate — falling through would run the full bake main in a GPU child,
// which crashes and takes the whole bake down.
namespace xmedia::cef {
bool LoadFrameworkForHelperProcess() {
  static std::unique_ptr<CefScopedLibraryLoader> loader;
  if (!loader) {
    loader = std::make_unique<CefScopedLibraryLoader>();
  }
  return loader->LoadInHelper();
}
}  // namespace xmedia::cef

namespace {

using namespace xmedia;  // NOLINT -- product CLI, not the SDK.
using namespace xmedia::media;  // NOLINT

std::atomic<bool> g_cancelled{false};

void OnSignal(int) { g_cancelled.store(true); }

constexpr int kExitOk = 0;
constexpr int kExitFailure = 1;
constexpr int kExitUsage = 2;
constexpr int kExitCancelled = 3;

struct Args {
  std::string url;
  std::string out;
  double seconds = 1.0;
  int fps = 10;
  int width = 320;
  int height = 240;
  std::string codec = "h264";  // the product bakes MP4, not MJPEG
  std::string clock = "virtual_time";
  int chunks = 1;
  std::string data_json;
  bool hf_seconds = false;
  bool audio = true;
  std::string lottie_path;
  int lottie_z = -1;
  double lottie_speed = 1.0;
  int lottie_loop = 1;
};

Args ParseArgs(int argc, char** argv) {
  Args a;
  for (int i = 1; i < argc; ++i) {
    const std::string v = i + 1 < argc ? argv[i + 1] : "";
    if (std::strcmp(argv[i], "--url") == 0 && !v.empty()) a.url = v, ++i;
    else if (std::strcmp(argv[i], "--out") == 0 && !v.empty()) a.out = v, ++i;
    else if (std::strcmp(argv[i], "--seconds") == 0) a.seconds = std::atof(v.c_str()), ++i;
    else if (std::strcmp(argv[i], "--fps") == 0) a.fps = std::atoi(v.c_str()), ++i;
    else if (std::strcmp(argv[i], "--width") == 0) a.width = std::atoi(v.c_str()), ++i;
    else if (std::strcmp(argv[i], "--height") == 0) a.height = std::atoi(v.c_str()), ++i;
    else if (std::strcmp(argv[i], "--codec") == 0 && !v.empty()) a.codec = v, ++i;
    else if (std::strcmp(argv[i], "--clock") == 0 && !v.empty()) a.clock = v, ++i;
    else if (std::strcmp(argv[i], "--chunks") == 0) a.chunks = std::max(1, std::atoi(v.c_str())), ++i;
    else if (std::strcmp(argv[i], "--data") == 0 && !v.empty()) a.data_json = v, ++i;
    else if (std::strcmp(argv[i], "--hf-seconds") == 0) a.hf_seconds = true;
    else if (std::strcmp(argv[i], "--audio") == 0) a.audio = v != "0", ++i;
    else if (std::strcmp(argv[i], "--lottie") == 0 && !v.empty()) a.lottie_path = v, ++i;
    else if (std::strcmp(argv[i], "--lottie-z") == 0) a.lottie_z = std::atoi(v.c_str()), ++i;
    else if (std::strcmp(argv[i], "--lottie-speed") == 0) a.lottie_speed = std::atof(v.c_str()), ++i;
    else if (std::strcmp(argv[i], "--lottie-loop") == 0) a.lottie_loop = std::atoi(v.c_str()), ++i;
  }
  return a;
}

// One structured progress line. The bridge parses the `PROGRESS\t` prefix into
// its events queue; plain stderr logging stays unstructured (host logger).
void Progress(std::string_view stage, int percent) {
  std::fprintf(stderr, "PROGRESS\t%.*s\t%d\n",
               static_cast<int>(stage.size()), stage.data(), percent);
}

// Deterministic pipeline: a dropped frame = a shifted timeline, so a paint
// timeout in VT mode is fatal rather than something to paper over.
bool WaitNewFrame(CefLayerSource* layer, const void* previous, int timeout_ms) {
  for (int waited = 0; waited < timeout_ms; waited += 5) {
    if (g_cancelled.load()) return false;
    layer->Pump();
    const auto frame = layer->last_frame();
    if (frame && frame.get() != previous) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return false;
}

void RemoveFile(const std::string& path) {
  if (!path.empty()) std::remove(path.c_str());
}

}  // namespace

int main(int argc, char** argv) {
  // Helper interception FIRST (see the comment above main's body).
  for (int i = 0; i < argc; ++i) {
    if (std::strncmp(argv[i], "--type=", 7) == 0) {
      if (!xmedia::cef::LoadFrameworkForHelperProcess()) {
        std::fprintf(stderr, "xmedia-bake: helper framework load failed\n");
        return kExitFailure;
      }
      CefMainArgs main_args(argc, argv);
      CefRefPtr<xmedia::cef::MediaCefApp> app(new xmedia::cef::MediaCefApp);
      return CefExecuteProcess(main_args, app.get(), nullptr);
    }
  }

  std::signal(SIGTERM, OnSignal);
  std::signal(SIGINT, OnSignal);

  const Args args = ParseArgs(argc, argv);
  if (args.url.empty() || args.out.empty()) {
    std::fprintf(stderr, "usage: xmedia-bake --url <file:///...> --out <path> "
                         "[--seconds s] [--fps n] [--width w] [--height h] "
                         "[--codec name] [--clock virtual_time|seek|live] "
                         "[--chunks n] [--data json] [--hf-seconds] [--audio 0|1]"
#if defined(XMEDIA_HAS_LOTTIE) && XMEDIA_HAS_LOTTIE
                         " [--lottie path]"
#endif
                         "\n");
    return kExitUsage;
  }
  std::fprintf(stderr, "[xmedia-bake] url=%s out=%s seconds=%.2f fps=%d %dx%d "
                       "codec=%s clock=%s chunks=%d hf_seconds=%d audio=%d\n",
               args.url.c_str(), args.out.c_str(), args.seconds, args.fps,
               args.width, args.height, args.codec.c_str(), args.clock.c_str(),
               args.chunks, args.hf_seconds ? 1 : 0, args.audio ? 1 : 0);
  Progress("init", 0);

  // --- GL: hidden window (offscreen composite + readback); the DRAWABLE size
  // is authoritative (HiDPI scales the framebuffer past the logical size).
  if (glfwInit() != GLFW_TRUE) {
    std::fprintf(stderr, "xmedia-bake: glfwInit failed\n");
    return kExitFailure;
  }
  glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
  glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
  GLFWwindow* window = glfwCreateWindow(args.width, args.height,
                                        "xmedia-bake", nullptr, nullptr);
  if (window == nullptr) {
    std::fprintf(stderr, "xmedia-bake: glfwCreateWindow failed\n");
    return kExitFailure;
  }
  auto ctx = std::make_unique<GlfwGLContext>(window);
  if (!ctx->MakeCurrent()) {
    std::fprintf(stderr, "xmedia-bake: MakeCurrent failed\n");
    return kExitFailure;
  }
  GlPresenter presenter(std::move(ctx));
  if (!presenter.Init()) {
    std::fprintf(stderr, "xmedia-bake: presenter init failed\n");
    return kExitFailure;
  }
  std::string gl_error;
  auto scene = GlScene::Create(*presenter.api(), &gl_error);
  if (!scene) {
    std::fprintf(stderr, "xmedia-bake: scene create failed: %s\n", gl_error.c_str());
    return kExitFailure;
  }
  int drawable_w = args.width;
  int drawable_h = args.height;
  glfwGetFramebufferSize(window, &drawable_w, &drawable_h);
  Progress("init", 5);

  // --- encoder + muxer params (chunk loops re-initialize their own copies).
  FFmpegVideoEncoder::Params ep;
  ep.codec_name = args.codec;
  ep.width = drawable_w;
  ep.height = drawable_h;
  ep.fps_num = args.fps;
  ep.fps_den = 1;
  {
    FFmpegVideoEncoder probe;
    if (!probe.Initialize(ep)) {
      std::fprintf(stderr, "xmedia-bake: encoder %s init failed\n", args.codec.c_str());
      return kExitFailure;
    }
  }
  ff::VideoConverter converter;
  if (!converter.Configure(drawable_w, drawable_h, AV_PIX_FMT_BGRA,
                           drawable_w, drawable_h, AV_PIX_FMT_YUV420P)) {
    std::fprintf(stderr, "xmedia-bake: BGRA->I420 conversion setup failed\n");
    return kExitFailure;
  }
  Progress("init", 10);

  // --- CEF OSR with the VT bake clock. GLFW owns the main thread run loop, so
  // CEF must pump on the caller thread too (the pump-thread mode deadlocks in
  // CefInitialize — measured upstream).
  CefLayerSource::Config config;
  config.name = "xmedia-bake";
  config.width = args.width;
  config.height = args.height;
  config.fps = args.fps;
  config.url = args.url;
  config.bake_virtual_time = args.clock == "virtual_time";
  config.pump_on_caller_thread = true;
  CefLayerSource layer;
  if (!layer.Start(config)) {
    std::fprintf(stderr, "xmedia-bake: CEF layer failed to start "
                         "(must run inside the .app bundle)\n");
    return kExitFailure;
  }
  const auto cancelled = []() { return g_cancelled.load(); };

  if (!WaitNewFrame(&layer, nullptr, 30000)) {
    // 30 s, not the example's 15 s: the FIRST bake in a process pays CEF init
    // cold (framework load + GPU process bring-up measured >15 s on a cold
    // Intel iGPU), and a warm start only ever waits a few seconds anyway.
    std::fprintf(stderr, "xmedia-bake: %s\n",
                 cancelled() ? "cancelled before first frame"
                             : "no first frame in 30s");
    layer.Stop();
    return cancelled() ? kExitCancelled : kExitFailure;
  }
  if (!args.data_json.empty() && !layer.SetHtmlData(args.data_json)) {
    std::fprintf(stderr, "xmedia-bake: --data rejected (invalid JSON)\n");
    layer.Stop();
    return kExitFailure;
  }
  Progress("first-frame", 12);

#if defined(XMEDIA_HAS_LOTTIE) && XMEDIA_HAS_LOTTIE
  std::unique_ptr<lottie::LottieAnimation> lottie_anim;
  GlScene::LayerId lottie_layer = GlScene::kNoLayer;
  if (!args.lottie_path.empty()) {
    lottie::LottieSourceParams lp;
    lp.path = args.lottie_path;
    lp.speed = args.lottie_speed;
    lp.loop = args.lottie_loop != 0;
    lottie_anim = lottie::LottieAnimation::Open(lp, std::max(drawable_w, drawable_h));
    if (lottie_anim) {
      lottie_layer = scene->AddVideoLayer(args.lottie_z);
      scene->SetLayerRect(lottie_layer, 0.f, 0.f, 1.f, 1.f);
      std::fprintf(stderr, "[xmedia-bake] lottie %s — %d frames @ %.2f fps\n",
                   args.lottie_path.c_str(), lottie_anim->total_frame(),
                   lottie_anim->src_fps());
    }
  }
#endif

  // Timing warm-up: the collector script is re-injected at OnLoadEnd, and
  // ExecuteJavaScript needs ~2 frames of warm-up before the timeline actually
  // lands. Drop two t=0 steps before recording.
  for (int prime = 0; prime < 2; ++prime) {
    if (cancelled()) {
      layer.Stop();
      return kExitCancelled;
    }
    if (args.clock == "virtual_time") {
      layer.ApplyTimeline(0);
      layer.RequestVtStep();
      if (!WaitNewFrame(&layer, layer.last_frame().get(), 5000)) {
        std::fprintf(stderr, "xmedia-bake: warmup %d timed out\n", prime);
        layer.Stop();
        return cancelled() ? kExitCancelled : kExitFailure;
      }
    } else {
      layer.ApplyTimeline(0);
      layer.TickBakeClock(0);
      if (args.clock == "seek") layer.AwaitSeekDone(0, 2000);
      WaitNewFrame(&layer, layer.last_frame().get(), 300);
    }
    Progress("prime", 12 + (prime + 1) * 3);
  }

  GlElementComposer::Config composer_config;
  composer_config.target_w = drawable_w;
  composer_config.target_h = drawable_h;
  composer_config.default_z = 0;
  GlElementComposer composer(composer_config);

  const int total_frames = static_cast<int>(args.seconds * args.fps + 0.5);
  int64_t encoded = 0;

  FFmpegEncodeMuxer* active_muxer = nullptr;
  FFmpegVideoEncoder* active_encoder = nullptr;

  uint64_t prev_raster_hash = 0;
  auto raster_hash = [](const VideoFrame& f) {
    const auto bytes = f.visible_data(VideoFrame::kYPlane);
    uint64_t h = 1469598103934665603ull;
    for (const uint8_t b : bytes) {
      h = (h ^ b) * 1099511628211ull;
    }
    return h;
  };

  auto bake_frame = [&](int f, bool record) -> bool {
    const int64_t t_ms = static_cast<int64_t>(f) * 1000 / std::max(1, args.fps);
    const void* previous = layer.last_frame().get();
    layer.TickBakeClock(t_ms);
    if (args.clock == "seek") {
      if (!layer.AwaitSeekDone(t_ms, 2000)) {
        if (layer.seek_unsupported()) {
          layer.ApplyTimeline(t_ms);
          if (!layer.AwaitTimelineApplied(t_ms, 2000)) {
            std::fprintf(stderr, "xmedia-bake: fallback ack %d miss\n", f);
          }
        } else {
          // Align with MC deadline semantics: keep going rather than fail on
          // a slow page (the seek clock dedupes, so t repeats are cheap).
          std::fprintf(stderr, "xmedia-bake: seek %d done not in 2s\n", f);
        }
      }
    }
    if (args.clock == "virtual_time") {
      if (!WaitNewFrame(&layer, previous, 5000)) {
        std::fprintf(stderr, "xmedia-bake: paint %d timed out\n", f);
        return false;
      }
    } else {
      WaitNewFrame(&layer, previous, 300);
    }
    if (record && args.clock == "virtual_time") {
      // Boundary frames (element enter/leave windows): the composer's commit
      // can lag a few beats behind the pre-applied timeline, so "a new frame
      // arrived" is not "the frame carries the new state". Invalidate until the
      // raster content actually differs from the previous recorded frame.
      const auto entries = layer.SnapshotElements().entries();
      const int64_t dt = 1000 / std::max(1, args.fps);
      bool boundary = false;
      for (const auto& e : entries) {
        if (IsElementPresentAt(e.has_start, e.start_ms,
                               e.has_duration, e.duration_ms, t_ms) !=
            IsElementPresentAt(e.has_start, e.start_ms,
                               e.has_duration, e.duration_ms, t_ms - dt)) {
          boundary = true;
          break;
        }
      }
      if (boundary) {
        for (int retry = 0; retry < 5; ++retry) {
          if (raster_hash(*layer.last_frame()) != prev_raster_hash) break;
          layer.Invalidate();
          if (!WaitNewFrame(&layer, layer.last_frame().get(), 500)) break;
        }
      }
    }
    if (!record) return true;

    const auto frame = layer.last_frame();
    auto elements = layer.SnapshotElements().entries();
    if (args.hf_seconds) {
      // HyperFrames unit contract: data-start/duration/end are SECONDS.
      for (auto& e : elements) {
        e.start_ms *= 1000;
        e.duration_ms *= 1000;
        if (e.has_end) e.end_ms *= 1000;
      }
    }
    composer.Sync(*scene, frame.get(), elements, t_ms);
#if defined(XMEDIA_HAS_LOTTIE) && XMEDIA_HAS_LOTTIE
    if (lottie_anim && lottie_layer != GlScene::kNoLayer) {
      auto lf = lottie_anim->RenderAtMs(t_ms);
      if (lf) scene->Upload(lottie_layer, *lf);
    }
#endif
    if (!presenter.ComposeScene(*scene)) {
      std::fprintf(stderr, "xmedia-bake: compose failed at frame %d\n", f);
      return false;
    }
    std::vector<uint8_t> bgra(static_cast<size_t>(drawable_w) * drawable_h * 4);
    presenter.api()->context().ReadPixels(0, 0, drawable_w, drawable_h,
                                          GL_BGRA, GL_UNSIGNED_BYTE, bgra.data());
    // glReadPixels row 0 = GL bottom; the encoder wants top-down. Flip in
    // place or the whole output is upside down.
    {
      const size_t row_bytes = static_cast<size_t>(drawable_w) * 4;
      std::vector<uint8_t> tmp(row_bytes);
      for (int top = 0, bottom = drawable_h - 1; top < bottom; ++top, --bottom) {
        uint8_t* a = bgra.data() + static_cast<size_t>(top) * row_bytes;
        uint8_t* b = bgra.data() + static_cast<size_t>(bottom) * row_bytes;
        std::memcpy(tmp.data(), a, row_bytes);
        std::memcpy(a, b, row_bytes);
        std::memcpy(b, tmp.data(), row_bytes);
      }
    }
    ff::FramePtr src = ff::MakeFrame();
    src->width = drawable_w;
    src->height = drawable_h;
    src->format = AV_PIX_FMT_BGRA;
    src->data[0] = bgra.data();
    src->linesize[0] = drawable_w * 4;
    auto out_frame = VideoFrame::CreateBlackFrame(
        VideoFormat::kI420, Size{drawable_w, drawable_h},
        Size{drawable_w, drawable_h}, Rational{1, 1},
        xmedia::base::Milliseconds(f * 1000 / std::max(1, args.fps)),
        xmedia::base::Milliseconds(1000 / std::max(1, args.fps)), 0);
    std::vector<uint8_t*> dst(4, nullptr);
    std::vector<int> dst_ls(4, 0);
    dst[0] = out_frame->mutable_data(VideoFrame::kYPlane).data();
    dst_ls[0] = out_frame->stride(VideoFrame::kYPlane);
    dst[1] = out_frame->mutable_data(VideoFrame::kUPlane).data();
    dst_ls[1] = out_frame->stride(VideoFrame::kUPlane);
    dst[2] = out_frame->mutable_data(VideoFrame::kVPlane).data();
    dst_ls[2] = out_frame->stride(VideoFrame::kVPlane);
    if (!converter.Convert(*src, dst.data(), dst_ls.data())) {
      std::fprintf(stderr, "xmedia-bake: BGRA->I420 failed at frame %d\n", f);
      return false;
    }
    std::vector<EncodedPacket> packets;
    if (!active_encoder->Encode(std::move(out_frame), &packets)) {
      std::fprintf(stderr, "xmedia-bake: encode failed at frame %d\n", f);
      return false;
    }
    for (const auto& pkt : packets) {
      if (active_muxer == nullptr || !active_muxer->WritePacket(0, pkt)) {
        std::fprintf(stderr, "xmedia-bake: muxer rejected packet at frame %d\n", f);
        return false;
      }
      ++encoded;
    }
    // Pre-apply the NEXT frame's timeline and wait for the ACK: the DOM sits
    // at its target state before the next VT step, so frame f+1's paint
    // carries exactly visibility(t_{f+1}) with no compositor lag in between.
    const int64_t next_t = static_cast<int64_t>(f + 1) * 1000 / std::max(1, args.fps);
    prev_raster_hash = raster_hash(*frame);
    if (args.clock == "virtual_time") {
      layer.ApplyTimeline(next_t);
      if (!layer.AwaitTimelineApplied(next_t, 2000)) {
        std::fprintf(stderr, "xmedia-bake: pre-apply %d ack miss\n", f);
      }
    }
    return true;
  };

  const std::string ext = [&] {
    const auto dot = args.out.find_last_of('.');
    return dot == std::string::npos ? ".mp4" : args.out.substr(dot);
  }();
  const int per = (total_frames + args.chunks - 1) / args.chunks;
  std::vector<std::string> chunk_paths;
  std::vector<std::string> residue;  // removed on failure/cancel
  Progress("render", 15);

  for (int c = 0; c < args.chunks; ++c) {
    if (cancelled()) break;
    const int begin = c * per;
    const int end = std::min(begin + per, total_frames);
    if (begin >= end) break;
    const bool single = args.chunks == 1;
    const std::string chunk_out =
        single ? args.out : args.out + ".chunk" + std::to_string(c) + ext;
    if (!single) residue.push_back(chunk_out);
    auto chunk_encoder = std::make_unique<FFmpegVideoEncoder>();
    FFmpegVideoEncoder::Params cep = ep;
    if (!chunk_encoder->Initialize(cep)) {
      std::fprintf(stderr, "xmedia-bake: chunk %d encoder init failed\n", c);
      layer.Stop();
      return kExitFailure;
    }
    auto chunk_muxer = std::make_unique<FFmpegEncodeMuxer>();
    active_muxer = chunk_muxer.get();
    active_encoder = chunk_encoder.get();
    if (!chunk_muxer->Open(chunk_out)) {
      std::fprintf(stderr, "xmedia-bake: cannot open %s\n", chunk_out.c_str());
      layer.Stop();
      return kExitFailure;
    }
    FFmpegEncodeMuxer::VideoStreamParams csp;
    csp.codec_name = args.codec;
    csp.width = drawable_w;
    csp.height = drawable_h;
    const AVRational ctb = chunk_encoder->time_base();
    csp.time_base_num = ctb.num;
    csp.time_base_den = ctb.den;
    csp.extradata = chunk_encoder->codec_parameters()
                        ? std::vector<uint8_t>(
                              chunk_encoder->codec_parameters()->extradata,
                              chunk_encoder->codec_parameters()->extradata +
                                  chunk_encoder->codec_parameters()->extradata_size)
                        : std::vector<uint8_t>();
    if (chunk_muxer->AddVideoStream(csp) < 0) {
      std::fprintf(stderr, "xmedia-bake: chunk %d add stream failed\n", c);
      layer.Stop();
      return kExitFailure;
    }

    // Audio stream (HyperFrames audio contract): a deterministic mixdown of
    // the page's audio/media elements. `--audio 0` skips the leg entirely.
    int audio_stream = -1;
    FFmpegAudioEncoder aac_encoder;
    if (args.audio) {
      FFmpegAudioEncoder::Params ap;
      ap.codec_name = "aac";
      ap.sample_rate = 48000;
      ap.channels = 2;
      ap.bit_rate = 192000;
      if (aac_encoder.Initialize(ap)) {
        FFmpegEncodeMuxer::AudioStreamParams asp;
        asp.sample_rate = 48000;
        asp.channels = 2;
        asp.extradata = aac_encoder.extradata();
        audio_stream = chunk_muxer->AddAudioStream(asp);
      }
    }

    if (args.clock == "virtual_time") {
      const int64_t begin_t = static_cast<int64_t>(begin) * 1000 / std::max(1, args.fps);
      layer.ApplyTimeline(begin_t);
      if (!layer.AwaitTimelineApplied(begin_t, 2000)) {
        std::fprintf(stderr, "xmedia-bake: chunk %d pre-apply ack miss\n", c);
      }
    }
    bool ok = true;
    for (int f = 0; ok && f < begin; ++f) {
      if (cancelled()) { ok = false; break; }
      ok = bake_frame(f, /*record=*/false);
      if (f % 32 == 0) Progress("fast-forward", 15 + static_cast<int>(30.0 * f / std::max(1, total_frames)));
    }
    for (int f = begin; ok && f < end; ++f) {
      if (cancelled()) { ok = false; break; }
      ok = bake_frame(f, /*record=*/true);
      if (f % 8 == 0 || f + 1 == end) {
        Progress("render", 15 + static_cast<int>(75.0 * (f + 1) / std::max(1, total_frames)));
      }
    }

    if (ok && audio_stream >= 0) {
      std::vector<xmedia::media::transcode::AudioMixClip> mix_clips;
      const auto entries = layer.SnapshotElements().entries();
      const std::string page_dir =
          args.url.rfind("file://", 0) == 0
              ? args.url.substr(7, args.url.find_last_of('/') - 7)
              : std::string();
      for (const auto& e : entries) {
        if (!e.is_media || !e.has_src) continue;
        xmedia::media::transcode::AudioMixClip clip;
        clip.src = e.src.rfind("file://", 0) == 0
                       ? e.src.substr(7)
                       : (e.src.rfind("/", 0) == 0 ? e.src : page_dir + "/" + e.src);
        const int64_t chunk_begin_ms =
            static_cast<int64_t>(begin) * 1000 / std::max(1, args.fps);
        clip.start_ms = std::max<int64_t>(0, e.start_ms - chunk_begin_ms);
        clip.duration_ms = e.duration_ms;
        clip.media_start_ms = e.media_start_ms;
        clip.volume = e.has_volume ? e.volume : 1.0;
        clip.fade_in = e.fade_in;
        clip.fade_out = e.fade_out;
        mix_clips.push_back(std::move(clip));
      }
      const int64_t window_ms =
          static_cast<int64_t>(end - begin) * 1000 / std::max(1, args.fps);
      if (!mix_clips.empty()) {
        xmedia::media::transcode::AudioMixResult mix;
        if (MixAudioClips(mix_clips, window_ms, &mix) && mix.sample_count > 0) {
          auto audio_buffers = AudioMixToBuffers(mix, 1024);
          for (auto& buf : audio_buffers) {
            std::vector<EncodedPacket> audio_pkts;
            if (aac_encoder.Encode(std::move(buf), &audio_pkts)) {
              for (const auto& pkt : audio_pkts) {
                if (chunk_muxer->WritePacket(audio_stream, pkt)) ++encoded;
              }
            }
          }
          std::vector<EncodedPacket> aflushed;
          aac_encoder.Flush(&aflushed);
          for (const auto& pkt : aflushed) {
            if (chunk_muxer->WritePacket(audio_stream, pkt)) ++encoded;
          }
        }
      }
      Progress("audio", 90);
    }
    if (cancelled()) ok = false;
    if (ok) {
      std::vector<EncodedPacket> flushed;
      chunk_encoder->Flush(&flushed);
      for (const auto& pkt : flushed) {
        chunk_muxer->WritePacket(0, pkt);
        ++encoded;
      }
      chunk_muxer->Finish();
      chunk_paths.push_back(chunk_out);
      active_muxer = nullptr;
      active_encoder = nullptr;
    } else {
      layer.Stop();
      // No half-baked artifacts: a cancelled/failed bake leaves nothing that
      // could be mistaken for a result.
      for (const auto& path : residue) RemoveFile(path);
      RemoveFile(args.out);
      std::fprintf(stderr, "xmedia-bake: %s at chunk %d\n",
                   cancelled() ? "cancelled" : "failed", c);
      return cancelled() ? kExitCancelled : kExitFailure;
    }
  }
  layer.Stop();
  Progress("mux", 95);

  // Element metadata export (<out>.html_elements.json): per-element timing and
  // rects, MC render_demo aligned. Written even on the success path only.
  {
    HtmlElementMetaDoc doc;
    doc.html_url = args.url;
    doc.mode = "bake";
    doc.bake_clock = args.clock;
    doc.view_width = drawable_w;
    doc.view_height = drawable_h;
    const auto table = layer.SnapshotElements();
    doc.report.collect_requested = true;
    doc.report.any_report = table.last_t_ms() >= 0;
    doc.report.entries = table.entries();
    doc.report.last_report_t_ms = table.last_t_ms();
    const std::string meta = BuildElementsMetaJson(doc);
    const std::string meta_path = HtmlElementsMetaJsonPath(args.out);
    std::FILE* mf = std::fopen(meta_path.c_str(), "wb");
    if (mf != nullptr) {
      std::fwrite(meta.data(), 1, meta.size(), mf);
      std::fclose(mf);
    } else {
      std::fprintf(stderr, "xmedia-bake: cannot write %s\n", meta_path.c_str());
    }
  }

  if (chunk_paths.size() > 1) {
    ConcatParams cp;
    cp.inputs = chunk_paths;
    cp.output_path = args.out;
    const Status cst = Concat(cp);
    if (!cst) {
      std::fprintf(stderr, "xmedia-bake: concat failed: %s\n",
                   cst.error().ToString().c_str());
      for (const auto& path : chunk_paths) RemoveFile(path);
      RemoveFile(args.out);
      return kExitFailure;
    }
    for (const auto& path : chunk_paths) RemoveFile(path);
  }

  Progress("done", 100);
  std::fprintf(stderr, "[xmedia-bake] result ok out=%s frames=%d packets=%lld %dx%d @ %d fps clock=%s\n",
               args.out.c_str(), total_frames, static_cast<long long>(encoded),
               drawable_w, drawable_h, args.fps, args.clock.c_str());
  glfwDestroyWindow(window);
  glfwTerminate();
  return kExitOk;
}

#endif  // XMEDIA_HAS_CEF
