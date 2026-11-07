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

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <initializer_list>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "media/transcode/ffmpeg_transcode_job.h"
#include "player/public/global.h"
#include "sandbox.h"
#include "xmedia_protocol.h"

namespace {

// Process-level: was --sandbox engaged? Reported in every status so operators
// (and the host's engine-state) can confirm the hardening is active.
bool g_sandboxed = false;

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
    return Err("UNKNOWN_COMMAND", verb);
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

  std::mutex jobs_mutex_;
  std::map<std::string, std::unique_ptr<Job>> jobs_;
};

}  // namespace

int main(int argc, char** argv) {
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
  return 0;
}
