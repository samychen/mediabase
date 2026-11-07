// GENERATED from protocol/contract.json — do not edit by hand.
// Re-run: node scripts/gen-protocol.mjs <contract.json> <out.h>
#pragma once
#include <string_view>

namespace xmedia_protocol {

inline constexpr int kProtocolVersion = 1;

// How a verb's reply is framed on the wire.
enum class Framing { kVerb, kOk };

// Verb string literals (single source of truth).
inline constexpr std::string_view kHello = "hello";
inline constexpr std::string_view kPing = "ping";
inline constexpr std::string_view kEvents = "events";
inline constexpr std::string_view kQuit = "quit";
inline constexpr std::string_view kPublishStart = "publish.start";
inline constexpr std::string_view kPublishStop = "publish.stop";
inline constexpr std::string_view kPublishStatus = "publish.status";

// Framing per verb (kVerb: reply starts with the verb token, e.g. "hello\t1\t..";
// kOk: reply starts with "ok\t", e.g. "ok\t{...}").
inline constexpr Framing kFraming_Hello = Framing::kVerb;
inline constexpr Framing kFraming_Ping = Framing::kVerb;
inline constexpr Framing kFraming_Events = Framing::kOk;
inline constexpr Framing kFraming_Quit = Framing::kOk;
inline constexpr Framing kFraming_PublishStart = Framing::kOk;
inline constexpr Framing kFraming_PublishStop = Framing::kOk;
inline constexpr Framing kFraming_PublishStatus = Framing::kOk;

// Request / response column indices, per verb. Indices are 0-based over the
// PAYLOAD columns only: a wire line is "<verb>\t<col0>\t<col1>…" (request) or
// "ok\t<col0>\t…" (response), so col0 sits at parts[1], NOT parts[0].
// A reader that indexes split parts with these values directly is off by one.
enum class HelloReq : int {

};

enum class HelloRes : int {
  kProtocol = 0,
  kEngine = 1,
  kSandboxed = 2,
};

enum class PingReq : int {

};

enum class PingRes : int {
  kVerdict = 0,
};

enum class EventsReq : int {

};

enum class EventsRes : int {
  kEventsJson = 0,
};

enum class QuitReq : int {

};

enum class QuitRes : int {

};

enum class PublishStartReq : int {
  kJobId = 0,
  kInput = 1,
  kOutput = 2,
  kFormat = 3,
  kVcodec = 4,
  kAcodec = 5,
  kRealtime = 6,
};

enum class PublishStartRes : int {
  kStatusJson = 0,
};

enum class PublishStopReq : int {
  kJobId = 0,
};

enum class PublishStopRes : int {
  kStatusJson = 0,
};

enum class PublishStatusReq : int {
  kJobId = 0,
};

enum class PublishStatusRes : int {
  kStatusJson = 0,
};

}  // namespace xmedia_protocol
