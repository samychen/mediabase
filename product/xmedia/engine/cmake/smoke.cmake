# Line-protocol smoke, run by ctest. Deliberately exercises ONLY the verbs that
# need no media file, no window system and no network: it proves the binary
# links against xmedia-kit (INCLUDING the opt-in transcode target) and speaks
# the @mediabase/engine-client contract. A real publish round trip is covered
# by scripts/verify.mjs against a live RTMP peer.
#
# Every publish.* line below carries an EXPLICIT jobId. That is not cosmetic:
# the wire line is `<verb>\t<col0>\t…`, and a bridge that forgets to skip the
# verb reads jobId from the verb token and shifts every argument by one. Such a
# bug is invisible to a command that omits jobId (the shifted columns still
# land in the same error branch), so the successful start below asserts the
# echoed input/output/format — those three only line up when the offset is right.

cmake_policy(SET CMP0054 NEW)

set(input "${CMAKE_CURRENT_BINARY_DIR}/bridge-smoke.in")
file(WRITE "${input}"
    "hello\n"
    "ping\n"
    "publish.status\n"
    "publish.start\t\t\n"
    "publish.start\tjob-badfmt\t/tmp/x.mp4\trtmp://127.0.0.1:1935/live/x\n"
    "publish.start\tjob-smoke\t/tmp/in.mp4\t/tmp/out.mp4\tmp4\n"
    "publish.status\tjob-smoke\n"
    "publish.stop\tjob-smoke\n"
    "publish.pause\tjob-smoke\n"
    "publish.resume\tjob-smoke\n"
    "publish.pause\tunknown-id\n"
    "publish.list\n"
    "events\n"
    "quit\n")

execute_process(
    COMMAND "${BRIDGE_BIN}"
    INPUT_FILE "${input}"
    OUTPUT_VARIABLE stdout
    ERROR_VARIABLE stderr
    RESULT_VARIABLE result)

if(NOT result EQUAL 0)
  message(FATAL_ERROR "xmedia-bridge exited ${result}\nstderr: ${stderr}")
endif()

# One reply line per request, strictly in order.
string(STRIP "${stdout}" trimmed)
string(REPLACE "\r" "" trimmed "${trimmed}")
string(REPLACE "\n" ";" lines "${trimmed}")
list(LENGTH lines count)
if(NOT count EQUAL 14)
  message(FATAL_ERROR "expected 14 response lines, got ${count}: ${trimmed}")
endif()

list(GET lines 0 hello)
list(GET lines 1 pong)
list(GET lines 2 status)
list(GET lines 3 bad_args)
list(GET lines 4 bad_format)
list(GET lines 5 started)
list(GET lines 6 by_id)
list(GET lines 7 stopped)
list(GET lines 8 paused)
list(GET lines 9 resumed)
list(GET lines 10 pause_unknown)
list(GET lines 11 listed)
list(GET lines 12 events)
list(GET lines 13 quit)

if(NOT hello MATCHES "^hello\t1\t")
  message(FATAL_ERROR "hello reply must announce protocol 1: '${hello}'")
endif()
if(NOT pong STREQUAL "pong")
  message(FATAL_ERROR "ping reply must be 'pong': '${pong}'")
endif()
if(NOT status MATCHES "^ok\t\\{\"running\":false")
  message(FATAL_ERROR "publish.status must report an idle job: '${status}'")
endif()
if(NOT bad_args MATCHES "^err\tINVALID_PARAMS\t")
  message(FATAL_ERROR "publish.start with no args must be refused: '${bad_args}'")
endif()
if(NOT bad_format MATCHES "^err\tINVALID_PARAMS\ta network output needs")
  message(FATAL_ERROR "a network output without an explicit format must be refused: '${bad_format}'")
endif()

# The offset pin: input/output/format must be the columns we sent, in order.
if(NOT started MATCHES "^ok\t\\{\"running\":true,\"done\":false,\"ok\":false,\"progress\":0,\"input\":\"/tmp/in.mp4\",\"output\":\"/tmp/out.mp4\",\"format\":\"mp4\"")
  message(FATAL_ERROR
          "publish.start must parse <jobId> <input> <output> <format> at the right offsets: '${started}'")
endif()
if(NOT by_id MATCHES "\"input\":\"/tmp/in.mp4\",\"output\":\"/tmp/out.mp4\"")
  message(FATAL_ERROR "publish.status <jobId> must find the job it started: '${by_id}'")
endif()
if(NOT stopped MATCHES "^ok\t\\{\"running\":")
  message(FATAL_ERROR "publish.stop <jobId> must report a status: '${stopped}'")
endif()

# Pause/resume are idempotent on a (already stopped) job: the reply is still a
# well-formed status snapshot, never an error. An unknown id yields the idle
# snapshot too. publish.list answers the whole pool as one JSON array.
if(NOT paused MATCHES "^ok\t\\{\"running\":")
  message(FATAL_ERROR "publish.pause <jobId> must report a status: '${paused}'")
endif()
if(NOT resumed MATCHES "\"paused\":false")
  message(FATAL_ERROR "publish.resume must clear the paused flag: '${resumed}'")
endif()
if(NOT pause_unknown MATCHES "^ok\t\\{\"running\":false")
  message(FATAL_ERROR "publish.pause on an unknown id must answer the idle snapshot: '${pause_unknown}'")
endif()
if(NOT listed MATCHES "^ok\t\\[\\{")
  message(FATAL_ERROR "publish.list must answer a JSON array of job snapshots: '${listed}'")
endif()
if(NOT events MATCHES "^ok\t\\[")
  message(FATAL_ERROR "events reply must be ok + JSON array: '${events}'")
endif()
if(NOT quit STREQUAL "ok")
  message(FATAL_ERROR "quit reply must be 'ok': '${quit}'")
endif()

message(STATUS "xmedia-bridge line protocol OK: ${hello} | ${pong} | publish.* (jobId offsets pinned) | ${events}")
