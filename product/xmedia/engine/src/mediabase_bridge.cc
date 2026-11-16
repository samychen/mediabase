// Copyright 2026 The mediabase Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// xmedia-bridge — the PRODUCT-OWNED sidecar that turns xmedia-kit (C++20
// media SDK) into a mediabase engine subprocess.
//
// WHY a separate process and not a Node addon: mediabase's one layering rule
// says pixels, codecs and rendering belong to a product layer, in a native
// process the product owns. The host only issues COMMANDS; media bytes never
// cross the WS control plane.
//
// WHAT THIS PROCESS ACTUALLY DOES (the product is a transcode/encode service):
//   `publish.*` drives xmedia::media::TranscodeJob: demux a source, encode
//   (or stream-copy) and mux to a LIVE RTMP endpoint with `realtime` pacing,
//   or to a local file for offline jobs. The viewer plays the output straight
//   from MediaMTX via WHEP/HLS — the browser does the rendering, no frame
//   pixels ever travel through mediabase (neither stdout nor scratch).
//
// There is deliberately NO xmedia::Player pipeline here: no compositor, no
// window, no TakeSnapshot, no JPEG/scratch byte exchange, no playback verbs.
// Playback is the browser's job, not the engine's.
//
// WIRE CONTRACT (owned by @mediabase/engine-client, implemented here):
//   * stdin:  one tab-separated command per line.
//   * stdout: exactly ONE tab-separated response line per command, in order
//             (the client matches replies FIFO). stdout is a CLEAN protocol
//             channel — every diagnostic goes to stderr.
//   * hello:  "<verb>\t<protocol>\t<engine>\t<sandboxed>" — protocol MUST equal
//             ENGINE_PROTOCOL_VERSION in @mediabase/engine-client (currently 1).
//   * ok:     "ok\t<col>\t<col>…"; a refusal is "err\t<code>\t<message>",
//             which callOk() turns into a coded ENGINE RpcError.
//   * events: the line protocol is strictly request/response, so the engine
//             CANNOT push notifications to stdout (that would desynchronise the
//             FIFO). It queues them and `events` drains the queue on demand.
//
// The verb/column vocabulary is generated from protocol/contract.json into
// engine/src/xmedia_protocol.h (see scripts/gen-protocol.mjs). Edit the JSON,
// not the header.

#include <algorithm>
#include <chrono>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <initializer_list>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include "media/transcode/ffmpeg_transcode_job.h"
#include "player/public/global.h"
#include "sandbox.h"
#include "xmedia_protocol.h"

namespace {

// Process-level: was --sandbox engaged? Reported in every status so operators
// (and the host's engine-state) can confirm the hardening is active.
bool g_sandboxed = false;

// argv[0] of this bridge: the bake binary is probed as a SIBLING of the bridge
// (engine/build/xmedia-bake[.app/...]) unless bake.start's optionsJson names
// one explicitly.
std::string g_argv0;

constexpr size_t kMaxQueuedEvents = 256;

std::mutex g_events_mutex;
std::deque<std::string> g_events;

void QueueEvent(std::string json) {
  std::lock_guard<std::mutex> lock(g_events_mutex);
  if (g_events.size() >= kMaxQueuedEvents) g_events.pop_front();
  g_events.push_back(std::move(json));
}

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

bool IsNetworkUrl(std::string_view url) {
  const size_t scheme = url.find("://");
  return scheme != std::string_view::npos && scheme > 0;
}

// A response column must never contain a tab or a newline: either would split
// one reply into two (or misalign the FIFO). Applied to EVERY column we emit.
std::string ColumnSafe(std::string_view in) {
  std::string out;
  out.reserve(in.size());
  for (const char c : in) {
    out.push_back((c == '\t' || c == '\n' || c == '\r') ? ' ' : c);
  }
  return out;
}

std::string JsonEscape(std::string_view in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (const char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\t': out += "\\t"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
          out += buf;
        } else {
          out.push_back(c);
        }
    }
  }
  return out;
}

std::vector<std::string> SplitTabs(const std::string& line) {
  std::vector<std::string> parts;
  size_t start = 0;
  for (;;) {
    const size_t tab = line.find('\t', start);
    if (tab == std::string_view::npos) {
      parts.push_back(line.substr(start));
      return parts;
    }
    parts.push_back(line.substr(start, tab - start));
    start = tab + 1;
  }
}

std::string Ok(std::initializer_list<std::string_view> columns = {}) {
  std::string out = "ok";
  for (const std::string_view column : columns) {
    out += '\t';
    out += ColumnSafe(column);
  }
  return out;
}

std::string Err(std::string_view code, std::string_view message) {
  return "err\t" + ColumnSafe(code) + "\t" + ColumnSafe(message);
}

// Read request column `idx` (from the generated enum), or `fallback` if absent.
//
// The contract's indices count PAYLOAD columns only: on the wire the line is
// `<verb>\t<col0>\t<col1>…`, so `parts[0]` is the verb and col0 lives at
// `parts[1]`. Forgetting that offset silently shifts every argument by one
// (jobId would become the verb token) — see the smoke assertion that pins it.
//
// Returns BY VALUE: `fallback` is a call-site temporary, so returning a
// reference to it would dangle whenever the column is absent.
template <typename E>
std::string Col(const std::vector<std::string>& parts, E idx, const std::string& fallback) {
  const size_t i = static_cast<size_t>(idx) + 1;  // +1: skip the leading verb
  return parts.size() > i ? parts[i] : fallback;
}

// Per-job snapshot of progress/terminal state. Plain value type (no mutex); the
// containing Job owns the lock. Defined before Job because Job embeds it.
struct PublishSnapshot {
  bool running = false;
  bool done = false;
  bool ok = false;
  int progress = 0;
  std::string input;
  std::string output;
  std::string format;
  std::string error;
  int64_t started_ms = 0;
  int64_t finished_ms = 0;
};

// Per-job state. Address is stable while held in std::map, so the TranscodeJob
// worker callbacks may capture the `Job*` safely.
struct Job {
  std::mutex mutex;
  PublishSnapshot snap;
  std::unique_ptr<xmedia::media::TranscodeJob> job;
};

// ---------------------------------------------------------------------------
// bake.* — the offline HTML→MP4 pipeline (HyperFrames aligned).
//
// The pipeline itself runs in a ONE-SHOT `xmedia-bake` child process (CEF
// requires a .app bundle and its own multiprocess model, which cannot live
// inside this bridge's seccomp/Seatbelt sandbox). The bridge owns the job
// lifecycle only: spawn, drain the child's stderr for structured
// `PROGRESS\t<stage>\t<percent>` lines, wait, cancel via SIGTERM → SIGKILL.
// The child removes its own partial output on cancel/failure (exit 3 =
// cancelled); the bridge never invents an output file.
struct BakeSnapshot {
  bool running = false;
  bool done = false;
  bool ok = false;
  bool cancelled = false;
  int progress = 0;
  std::string stage = "queued";
  std::string html;
  std::string output;
  std::string error;
  int64_t started_ms = 0;
  int64_t finished_ms = 0;
  int exit_code = -1;
};

struct BakeJob {
  std::mutex mutex;
  BakeSnapshot snap;
  pid_t pid = -1;
  int stderr_fd = -1;  // owned by the reader thread; closed there
};

std::string BakeStatusJson(const BakeSnapshot& snap) {
  std::ostringstream os;
  os << "{\"kind\":\"bake\""
     << ",\"running\":" << (snap.running ? "true" : "false")
     << ",\"done\":" << (snap.done ? "true" : "false")
     << ",\"ok\":" << (snap.ok ? "true" : "false")
     << ",\"cancelled\":" << (snap.cancelled ? "true" : "false")
     << ",\"progress\":" << snap.progress
     << ",\"stage\":\"" << JsonEscape(snap.stage) << "\""
     << ",\"html\":\"" << JsonEscape(snap.html) << "\""
     << ",\"output\":\"" << JsonEscape(snap.output) << "\""
     << ",\"error\":\"" << JsonEscape(snap.error) << "\""
     << ",\"exitCode\":" << snap.exit_code
     << ",\"elapsedMs\":" << (snap.started_ms > 0
          ? (snap.running ? NowMs() : snap.finished_ms) - snap.started_ms
          : 0)
     << "}";
  return os.str();
}

// Minimal extraction of one STRING field from a flat JSON object. The host
// validates optionsJson against a zod schema BEFORE it reaches the wire, so
// this only has to understand the JSON the host emits (compact, one level).
// Returns "" when absent — indistinguishable from empty, which is the same
// decision the host's own "optional string" decoding makes.
std::string JsonStringField(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\":";
  size_t at = json.find(needle);
  if (at == std::string::npos) {
    // Tolerate a space after the colon too.
    at = json.find("\"" + key + "\": ");
    if (at == std::string::npos) return "";
  }
  size_t cursor = at + needle.size();
  while (cursor < json.size() && json[cursor] == ' ') ++cursor;
  if (cursor >= json.size() || json[cursor] != '"') return "";
  ++cursor;
  std::string out;
  while (cursor < json.size() && json[cursor] != '"') {
    if (json[cursor] == '\\' && cursor + 1 < json.size()) {
      ++cursor;  // keep escapes verbatim: values are paths/enum names
      if (cursor < json.size()) out += json[cursor++];
      continue;
    }
    out += json[cursor++];
  }
  return out;
}

double JsonNumberField(const std::string& json, const std::string& key,
                       double fallback) {
  const std::string needle = "\"" + key + "\":";
  size_t at = json.find(needle);
  if (at == std::string::npos) {
    at = json.find("\"" + key + "\": ");
    if (at == std::string::npos) return fallback;
  }
  size_t cursor = at + needle.size();
  while (cursor < json.size() && (json[cursor] == ' ')) ++cursor;
  const char* begin = json.c_str() + cursor;
  char* end = nullptr;
  const double value = std::strtod(begin, &end);
  return end != begin ? value : fallback;
}

bool JsonBoolField(const std::string& json, const std::string& key,
                   bool fallback) {
  const std::string value = JsonStringField(json, key);
  if (value == "true") return true;
  if (value == "false") return false;
  return fallback;
}

// file:// URL from a caller-supplied path/URL: network URLs pass through, a
// plain path becomes absolute and gets the scheme. CEF consumes UTF-8 URLs.
std::string ToCefUrl(const std::string& html_path) {
  if (html_path.rfind("http://", 0) == 0 || html_path.rfind("https://", 0) == 0 ||
      html_path.rfind("file://", 0) == 0) {
    return html_path;
  }
  std::vector<char> resolved(PATH_MAX + 1, '\0');
  if (realpath(html_path.c_str(), resolved.data()) == nullptr) {
    return html_path;  // let the child fail with its own clear message
  }
  return std::string("file://") + resolved.data();
}

std::string DirOf(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? std::string(".") : path.substr(0, slash);
}

// Build the status JSON blob for one job. `sandboxed` is process-level and is
// echoed here so the host can read it even before any publish is issued.
std::string StatusJson(const PublishSnapshot& snap, bool sandboxed) {
  const int64_t now = snap.running ? NowMs() : snap.finished_ms;
  std::ostringstream os;
  os << "{\"running\":" << (snap.running ? "true" : "false")
     << ",\"done\":" << (snap.done ? "true" : "false")
     << ",\"ok\":" << (snap.ok ? "true" : "false")
     << ",\"progress\":" << snap.progress
     << ",\"input\":\"" << JsonEscape(snap.input) << "\""
     << ",\"output\":\"" << JsonEscape(snap.output) << "\""
     << ",\"format\":\"" << JsonEscape(snap.format) << "\""
     << ",\"error\":\"" << JsonEscape(snap.error) << "\""
     << ",\"elapsedMs\":" << (snap.started_ms > 0 ? now - snap.started_ms : 0)
     << ",\"sandboxed\":" << (sandboxed ? "true" : "false")
     << "}";
  return os.str();
}

std::string DrainEvents() {
  std::lock_guard<std::mutex> lock(g_events_mutex);
  std::string out = "[";
  for (size_t i = 0; i < g_events.size(); ++i) {
    if (i != 0) out += ',';
    out += g_events[i];
  }
  out += ']';
  g_events.clear();
  return Ok({out});
}

class Bridge {
 public:
  std::string Dispatch(const std::vector<std::string>& parts) {
    const std::string& verb = parts[0];
    if (verb == xmedia_protocol::kHello.data()) {
      return std::string(xmedia_protocol::kHello) + "\t" +
             std::to_string(xmedia_protocol::kProtocolVersion) + "\txmedia-kit/" +
             xmedia::GetVersion() + "\t" + (g_sandboxed ? '1' : '0');
    }
    if (verb == xmedia_protocol::kPing.data()) return "pong";
    if (verb == xmedia_protocol::kEvents.data()) return DrainEvents();
    if (verb == xmedia_protocol::kQuit.data()) return Ok();
    if (verb == xmedia_protocol::kPublishStart.data()) return PublishStart(parts);
    if (verb == xmedia_protocol::kPublishStop.data()) return PublishStop(parts);
    if (verb == xmedia_protocol::kPublishStatus.data()) return PublishStatus(parts);
    if (verb == xmedia_protocol::kBakeStart.data()) return BakeStart(parts);
    if (verb == xmedia_protocol::kBakeStatus.data()) return BakeStatus(parts);
    if (verb == xmedia_protocol::kBakeCancel.data()) return BakeCancel(parts);
    return Err("UNKNOWN_COMMAND", verb);
  }

  // quit: terminate bake children so an exiting bridge does not orphan a
  // Chromium multiprocess tree mid-bake.
  void TerminateBakes() {
    std::vector<pid_t> pids;
    {
      std::lock_guard<std::mutex> lk(bakes_mutex_);
      for (const auto& [id, job] : bakes_) {
        std::lock_guard<std::mutex> jlk(job->mutex);
        if (job->snap.running && job->pid > 0) pids.push_back(job->pid);
      }
    }
    for (const pid_t pid : pids) kill(pid, SIGTERM);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(800);
    for (;;) {
      bool alive = false;
      {
        std::lock_guard<std::mutex> lk(bakes_mutex_);
        for (const auto& [id, job] : bakes_) {
          std::lock_guard<std::mutex> jlk(job->mutex);
          if (job->snap.running) alive = true;
        }
      }
      if (!alive || std::chrono::steady_clock::now() > deadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    std::lock_guard<std::mutex> lk(bakes_mutex_);
    for (const auto& [id, job] : bakes_) {
      std::lock_guard<std::mutex> jlk(job->mutex);
      if (job->snap.running && job->pid > 0) kill(job->pid, SIGKILL);
    }
  }

 private:
  // `publish.start <jobId> <input> <output> <format> <vcodec> <acodec> <realtime>`
  // starts ONE async TranscodeJob keyed by jobId. Several may run at once — the
  // host assigns a unique jobId per task, which is how the product breaks the
  // old single-BUSY limit. A live RTMP target needs output_format="flv" and
  // realtime pacing; a file target wants the opposite. Media bytes go straight
  // from the SDK's muxer to the peer — they never enter this protocol.
  std::string PublishStart(const std::vector<std::string>& parts) {
    const std::string jobId = Col(parts, xmedia_protocol::PublishStartReq::kJobId, "");
    const std::string input = Col(parts, xmedia_protocol::PublishStartReq::kInput, "");
    const std::string output = Col(parts, xmedia_protocol::PublishStartReq::kOutput, "");
    const std::string format = Col(parts, xmedia_protocol::PublishStartReq::kFormat, "");
    const std::string vcodec = Col(parts, xmedia_protocol::PublishStartReq::kVcodec, "copy");
    const std::string acodec = Col(parts, xmedia_protocol::PublishStartReq::kAcodec, "copy");
    const bool realtime = Col(parts, xmedia_protocol::PublishStartReq::kRealtime, "1") != "0";

    if (jobId.empty() || input.empty() || output.empty()) {
      return Err("INVALID_PARAMS",
                 "publish.start requires <jobId> <input> <output> [format] [vcodec] [acodec] [realtime]");
    }
    if (IsNetworkUrl(output) && format.empty()) {
      return Err("INVALID_PARAMS", "a network output needs an explicit format (flv for rtmp)");
    }
    {
      std::lock_guard<std::mutex> lk(jobs_mutex_);
      if (jobs_.count(jobId)) return Err("BUSY", "job already exists: " + jobId);
    }

    // Bound memory: drop finished jobs before queueing a new one.
    {
      std::lock_guard<std::mutex> lk(jobs_mutex_);
      for (auto it = jobs_.begin(); it != jobs_.end();) {
        std::lock_guard<std::mutex> jlk(it->second->mutex);
        if (it->second->snap.done) it = jobs_.erase(it);
        else ++it;
      }
      auto job = std::make_unique<Job>();
      job->snap.running = true;
      job->snap.input = input;
      job->snap.output = output;
      job->snap.format = format;
      jobs_.emplace(jobId, std::move(job));
    }

    Job* raw = nullptr;
    {
      std::lock_guard<std::mutex> lk(jobs_mutex_);
      raw = jobs_.at(jobId).get();
    }

    xmedia::media::TranscodeParams params;
    params.output_path = output;
    params.output_format = format;
    params.video_codec.codec = vcodec;
    params.audio_codec.codec = acodec;
    params.realtime = realtime;
    // A cancelled FILE job should still leave a playable container; a live
    // endpoint has no trailer to write.
    params.finalize_on_cancel = !IsNetworkUrl(output);

    raw->job = std::make_unique<xmedia::media::TranscodeJob>();
    const bool started_ok = raw->job->Start(
        input, params,
        [raw](int percent) {
          std::lock_guard<std::mutex> l(raw->mutex);
          raw->snap.progress = percent;
        },
        [raw, jobId](xmedia::media::Status status) {
          const bool ok = static_cast<bool>(status);
          std::string reason;
          if (!ok) reason = status.error().ToString();
          {
            std::lock_guard<std::mutex> l(raw->mutex);
            raw->snap.running = false;
            raw->snap.done = true;
            raw->snap.ok = ok;
            raw->snap.error = reason;
            raw->snap.finished_ms = NowMs();
            if (ok) raw->snap.progress = 100;
          }
          QueueEvent(std::string("{\"type\":\"PublishDone\",\"jobId\":\"") +
                     JsonEscape(jobId) + "\",\"ok\":" + (ok ? "true" : "false") +
                     ",\"error\":\"" + JsonEscape(reason) + "\"}");
        });
    if (!started_ok) {
      std::lock_guard<std::mutex> l(raw->mutex);
      raw->snap.running = false;
      raw->snap.done = true;
      raw->snap.error = "the previous job has not finished yet";
      return Err("BUSY", raw->snap.error);
    }
    std::fprintf(stderr, "[xmedia-bridge] publish %s -> %s (format=%s realtime=%d)\n",
                 input.c_str(), output.c_str(), format.empty() ? "auto" : format.c_str(),
                 realtime ? 1 : 0);
    std::lock_guard<std::mutex> l(raw->mutex);
    return Ok({StatusJson(raw->snap, g_sandboxed)});
  }

  // Status for one job, or a neutral snapshot when the id is unknown (which is
  // also the idle-pool answer for an empty jobId). Shared so stop/status can
  // never disagree about an unknown job's shape.
  std::string StatusOf(const std::string& jobId) {
    Job* raw = Find(jobId);
    if (raw == nullptr) return Ok({StatusJson(PublishSnapshot{}, g_sandboxed)});
    std::lock_guard<std::mutex> l(raw->mutex);
    return Ok({StatusJson(raw->snap, g_sandboxed)});
  }

  std::string PublishStop(const std::vector<std::string>& parts) {
    const std::string jobId = Col(parts, xmedia_protocol::PublishStopReq::kJobId, "");
    if (Job* raw = Find(jobId); raw != nullptr) {
      raw->job->Cancel();  // returns immediately; the worker stops at a packet boundary
    }
    return StatusOf(jobId);
  }

  std::string PublishStatus(const std::vector<std::string>& parts) {
    return StatusOf(Col(parts, xmedia_protocol::PublishStatusReq::kJobId, ""));
  }

  // Locate a job under the map lock; returns nullptr if absent (caller must not
  // hold jobs_mutex_ when calling this).
  Job* Find(const std::string& jobId) {
    std::lock_guard<std::mutex> lk(jobs_mutex_);
    auto it = jobs_.find(jobId);
    return it == jobs_.end() ? nullptr : it->second.get();
  }

  // ------------------------------------------------------------------
  // bake.* — spawn/supervise/cancel the one-shot xmedia-bake child.
  // ------------------------------------------------------------------

  std::string BakeStatusOf(const std::string& jobId) {
    BakeJob* job = FindBake(jobId);
    if (job == nullptr) return Ok({BakeStatusJson(BakeSnapshot{})});
    std::lock_guard<std::mutex> l(job->mutex);
    return Ok({BakeStatusJson(job->snap)});
  }

  std::string BakeStatus(const std::vector<std::string>& parts) {
    return BakeStatusOf(Col(parts, xmedia_protocol::BakeStatusReq::kJobId, ""));
  }

  std::string BakeCancel(const std::vector<std::string>& parts) {
    const std::string jobId = Col(parts, xmedia_protocol::BakeCancelReq::kJobId, "");
    if (BakeJob* job = FindBake(jobId); job != nullptr) {
      // SIGTERM first: the child's handler stops the frame loop, removes its
      // partial output and exits 3. The waiter escalates to SIGKILL (below)
      // when a stuck page swallows the signal.
      kill(job->pid, SIGTERM);
      {
        std::lock_guard<std::mutex> l(job->mutex);
        job->snap.cancelled = true;
      }
    }
    return BakeStatusOf(jobId);
  }

  std::string BakeStart(const std::vector<std::string>& parts) {
    const std::string jobId = Col(parts, xmedia_protocol::BakeStartReq::kJobId, "");
    const std::string html_path = Col(parts, xmedia_protocol::BakeStartReq::kHtmlPath, "");
    const std::string out_path = Col(parts, xmedia_protocol::BakeStartReq::kOutPath, "");
    const std::string options_json = Col(parts, xmedia_protocol::BakeStartReq::kOptionsJson, "{}");
    if (jobId.empty() || html_path.empty() || out_path.empty()) {
      return Err("INVALID_PARAMS", "bake.start requires <jobId> <htmlPath> <outPath> [optionsJson]");
    }
    if (IsNetworkUrl(out_path)) {
      return Err("INVALID_PARAMS", "bake output must be a local file path");
    }
    {
      std::lock_guard<std::mutex> lk(bakes_mutex_);
      if (bakes_.count(jobId)) return Err("BUSY", "bake job already exists: " + jobId);
    }

    // Resolve the bake binary: optionsJson override first, then a sibling of
    // this bridge (macOS: the assembled .app bundle's MacOS/<bin>). Absence is
    // a CODED rejection — the bridge never pretends the capability exists.
    std::string bake_bin = JsonStringField(options_json, "bakeBin");
    if (bake_bin.empty()) {
      const std::string dir = DirOf(g_argv0.empty() ? out_path : g_argv0);
      // macOS prefers the assembled bundle (CEF resolves its framework and
      // Helper.app relative to it); the flat binary covers Linux/Windows.
      const std::string apple_bundle =
          dir + "/xmedia-bake.app/Contents/MacOS/xmedia-bake";
      if (access(apple_bundle.c_str(), X_OK) == 0) {
        bake_bin = apple_bundle;
      } else {
        const std::string flat = dir + "/xmedia-bake";
        if (access(flat.c_str(), X_OK) == 0) bake_bin = flat;
      }
    }
    if (bake_bin.empty() || access(bake_bin.c_str(), X_OK) != 0) {
      return Err("UNAVAILABLE",
                 "bake binary not found or not executable "
                 "(build the engine with XMEDIA_BUILD_CEF=1)");
    }
    // Existence check on the RAW path (a caller-supplied file:// URL is taken
    // on faith; converting it back would need URL decoding). ToCefUrl() below
    // realpaths plain paths into absolute file:// URLs.
    if (!IsNetworkUrl(html_path) && html_path.rfind("file://", 0) != 0 &&
        access(html_path.c_str(), R_OK) != 0) {
      return Err("NOT_FOUND", "html page not found: " + html_path);
    }

    // Build the child argv. Values are single argv elements (no shell), so an
    // inline JSON payload is safe here.
    std::vector<std::string> argv;
    argv.push_back(bake_bin);
    argv.push_back("--url");
    argv.push_back(ToCefUrl(html_path));
    argv.push_back("--out");
    argv.push_back(out_path);
    const double seconds = JsonNumberField(options_json, "seconds", 1.0);
    const int fps = static_cast<int>(JsonNumberField(options_json, "fps", 10));
    const int width = static_cast<int>(JsonNumberField(options_json, "width", 320));
    const int height = static_cast<int>(JsonNumberField(options_json, "height", 240));
    const int chunks = static_cast<int>(JsonNumberField(options_json, "chunks", 1));
    const std::string codec = JsonStringField(options_json, "codec");
    const std::string clock = JsonStringField(options_json, "clock");
    auto push_opt = [&argv](const char* name, const std::string& value) {
      if (!value.empty()) {
        argv.push_back(name);
        argv.push_back(value);
      }
    };
    argv.push_back("--seconds");
    argv.push_back(std::to_string(seconds));
    argv.push_back("--fps");
    argv.push_back(std::to_string(std::max(1, fps)));
    argv.push_back("--width");
    argv.push_back(std::to_string(std::max(2, width)));
    argv.push_back("--height");
    argv.push_back(std::to_string(std::max(2, height)));
    push_opt("--codec", codec);
    push_opt("--clock", clock);
    if (chunks > 1) {
      argv.push_back("--chunks");
      argv.push_back(std::to_string(chunks));
    }
    push_opt("--data", JsonStringField(options_json, "data"));
    if (JsonBoolField(options_json, "hfSeconds", false)) argv.push_back("--hf-seconds");
    if (!JsonBoolField(options_json, "audio", true)) {
      argv.push_back("--audio");
      argv.push_back("0");
    }

    // Register the job BEFORE forking so a fast-exiting child cannot race the
    // pool. The child removes its own partial output; the bridge only records.
    BakeJob* raw = nullptr;
    {
      std::lock_guard<std::mutex> lk(bakes_mutex_);
      auto job = std::make_unique<BakeJob>();
      job->snap.running = true;
      job->snap.html = html_path;
      job->snap.output = out_path;
      job->snap.stage = "spawn";
      job->snap.started_ms = NowMs();
      raw = job.get();
      bakes_.emplace(jobId, std::move(job));
    }

    int stderr_pipe[2];
    if (pipe(stderr_pipe) != 0) {
      std::lock_guard<std::mutex> l(raw->mutex);
      raw->snap.running = false;
      raw->snap.done = true;
      raw->snap.error = "pipe() failed";
      raw->snap.finished_ms = NowMs();
      return Err("ENGINE", "pipe() failed for the bake child");
    }
    const pid_t pid = fork();
    if (pid < 0) {
      close(stderr_pipe[0]);
      close(stderr_pipe[1]);
      std::lock_guard<std::mutex> l(raw->mutex);
      raw->snap.running = false;
      raw->snap.done = true;
      raw->snap.error = "fork() failed";
      raw->snap.finished_ms = NowMs();
      return Err("ENGINE", "fork() failed for the bake child");
    }
    if (pid == 0) {
      // Child: stderr goes to the pipe (stdout inherited — unused but harmless
      // as long as nothing prints; the child only logs to stderr).
      dup2(stderr_pipe[1], 2);
      close(stderr_pipe[0]);
      close(stderr_pipe[1]);
      signal(SIGTERM, SIG_DFL);
      signal(SIGINT, SIG_DFL);
      std::vector<char*> child_argv;
      for (const std::string& a : argv) child_argv.push_back(const_cast<char*>(a.c_str()));
      child_argv.push_back(nullptr);
      execv(bake_bin.c_str(), child_argv.data());
      _exit(127);
    }
    close(stderr_pipe[1]);
    {
      std::lock_guard<std::mutex> l(raw->mutex);
      raw->pid = pid;
      raw->stderr_fd = stderr_pipe[0];
    }

    // Reader thread: PROGRESS lines update the snapshot + the events queue;
    // every other line is forwarded to THIS process's stderr, which the host
    // routes into the scoped logger.
    std::thread([raw, jobId, fd = stderr_pipe[0]]() {
      std::string buffer;
      char chunk[4096];
      bool open = true;
      while (open) {
        const ssize_t n = ::read(fd, chunk, sizeof(chunk));
        if (n <= 0) break;
        buffer.append(chunk, chunk + n);
        size_t nl;
        while ((nl = buffer.find('\n')) != std::string::npos) {
          const std::string line = buffer.substr(0, nl);
          buffer.erase(0, nl + 1);
          if (line.rfind("PROGRESS\t", 0) == 0) {
            const size_t tab = line.find('\t', 9);
            if (tab == std::string::npos) continue;
            const std::string stage = line.substr(9, tab - 9);
            const int percent =
                std::atoi(line.c_str() + tab + 1);
            std::lock_guard<std::mutex> l(raw->mutex);
            raw->snap.stage = stage;
            raw->snap.progress = std::max(0, std::min(100, percent));
            QueueEvent(std::string("{\"type\":\"BakeProgress\",\"jobId\":\"") +
                       JsonEscape(jobId) + "\",\"stage\":\"" + JsonEscape(stage) +
                       "\",\"progress\":" + std::to_string(raw->snap.progress) + "}");
          } else if (!line.empty()) {
            std::fprintf(stderr, "[bake %s] %s\n", jobId.c_str(), line.c_str());
          }
        }
      }
      close(fd);
    }).detach();

    // Waiter thread: reap the child, apply the terminal snapshot once, emit
    // the terminal event. Escalation: a cancel that the child ignores for 8 s
    // becomes SIGKILL (the child removes partials itself on SIGTERM; after a
    // SIGKILL the bridge removes the output it knows about).
    std::thread([raw, jobId]() {
      int status = 0;
      const auto started = std::chrono::steady_clock::now();
      const auto cancel_deadline = started + std::chrono::seconds(8);
      const auto hard_deadline = started + std::chrono::hours(6);
      int exit_code = -1;
      for (;;) {
        const pid_t r = waitpid(raw->pid, &status, WNOHANG);
        if (r == raw->pid) {
          exit_code = WIFEXITED(status) ? WEXITSTATUS(status)
                                        : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : -1);
          break;
        }
        if (r < 0) break;
        {
          std::lock_guard<std::mutex> l(raw->mutex);
          if (raw->snap.cancelled &&
              std::chrono::steady_clock::now() > cancel_deadline) {
            kill(raw->pid, SIGKILL);
          }
        }
        if (std::chrono::steady_clock::now() > hard_deadline) {
          kill(raw->pid, SIGKILL);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
      bool was_cancelled = false;
      std::string output;
      {
        std::lock_guard<std::mutex> l(raw->mutex);
        was_cancelled = raw->snap.cancelled;
        output = raw->snap.output;
        raw->snap.running = false;
        raw->snap.done = true;
        raw->snap.ok = exit_code == 0;
        raw->snap.exit_code = exit_code;
        raw->snap.finished_ms = NowMs();
        if (exit_code == 0) {
          raw->snap.progress = 100;
          raw->snap.stage = "done";
        } else if (exit_code == 3 || was_cancelled) {
          raw->snap.cancelled = true;
          raw->snap.error = "cancelled";
          raw->snap.stage = "cancelled";
        } else {
          raw->snap.error = "bake exited with code " + std::to_string(exit_code);
          raw->snap.stage = "failed";
        }
      }
      if (was_cancelled && exit_code == 128 + SIGKILL) {
        // SIGKILLed children get no cleanup chance: remove the partial output
        // the bridge knows about so a cancelled bake never leaves a result.
        RemoveFileQuiet(output);
      }
      QueueEvent(std::string("{\"type\":\"BakeDone\",\"jobId\":\"") + JsonEscape(jobId) +
                 "\",\"ok\":" + (exit_code == 0 ? "true" : "false") +
                 ",\"cancelled\":" + (was_cancelled ? "true" : "false") +
                 ",\"exitCode\":" + std::to_string(exit_code) +
                 ",\"output\":\"" + JsonEscape(output) + "\"}");
    }).detach();

    {
      std::lock_guard<std::mutex> l(raw->mutex);
      std::fprintf(stderr, "[xmedia-bridge] bake %s %s -> %s (bin=%s)\n",
                   jobId.c_str(), raw->snap.html.c_str(), out_path.c_str(),
                   bake_bin.c_str());
      raw->snap.stage = "init";
      return Ok({BakeStatusJson(raw->snap)});
    }
  }

  BakeJob* FindBake(const std::string& jobId) {
    std::lock_guard<std::mutex> lk(bakes_mutex_);
    auto it = bakes_.find(jobId);
    return it == bakes_.end() ? nullptr : it->second.get();
  }

  static void RemoveFileQuiet(const std::string& path) {
    if (!path.empty()) std::remove(path.c_str());
  }

  std::mutex jobs_mutex_;
  std::map<std::string, std::unique_ptr<Job>> jobs_;
  std::mutex bakes_mutex_;
  std::map<std::string, std::unique_ptr<BakeJob>> bakes_;
};

}  // namespace

int main(int argc, char** argv) {
  if (argc > 0) g_argv0 = argv[0];
  bool sandbox = false;
  for (int i = 1; i < argc; ++i) {
    if (std::string_view(argv[i]) == "--sandbox") sandbox = true;
  }
  g_sandboxed = xmedia_sandbox::ApplySandbox(sandbox);

  Bridge bridge;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    const std::vector<std::string> parts = SplitTabs(line);
    std::cout << bridge.Dispatch(parts) << '\n' << std::flush;
    if (parts[0] == xmedia_protocol::kQuit.data()) break;
  }
  bridge.TerminateBakes();
  return 0;
}
