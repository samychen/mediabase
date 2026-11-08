"""Tests for `vhl_bridge.py` — the product-owned half of the engine side.

Why this file exists: the analysis core (`highlight_core/`) is a synced copy of the
upstream engine and carries the upstream's own pytest suite. The bridge is not
synced from anywhere — it is ours, ~1000 lines, and until now it had no test at
all. The Node fake bridge covers the HOST's protocol handling by replacing Python
entirely, so a regression inside the bridge was only visible through
`verify:highlight:real`, which needs a working FFmpeg + OpenCV environment. The
functions below are exactly where a break is silent: a tab inside a value splits
one reply into two columns, and every later field shifts by one.

Run: python3 -m unittest discover -s product/highlight/engine/tests -v
(or `pnpm run test:highlight:py`)

Standard library only, on purpose. Adding pytest to the product tree for one file
would put a test dependency in the runtime's way; `unittest` ships with Python.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import contract  # noqa: E402
import vhl_bridge as b  # noqa: E402
from highlight_core import HighlightConfig, ScoringWeights  # noqa: E402


def codes(callable_, *args, **kwargs):
    """Run `callable_` and return the EngineError code it raised (or None)."""
    try:
        callable_(*args, **kwargs)
    except b.EngineError as exc:
        return exc.code
    return None


# --------------------------------------------------------------------------- #
# The wire: one reply is one line, and a column cannot contain a tab
# --------------------------------------------------------------------------- #

class WireTests(unittest.TestCase):
    def test_tabs_and_newlines_are_folded_into_spaces(self):
        # The host splits replies on '\t' and groups them by line. A tab inside a
        # value (a Windows path, an error message quoting the request) would shift
        # every following column by one — the reply would parse, and be wrong.
        self.assertEqual(b.wire("a\tb"), "a b")
        self.assertEqual(b.wire("a\nb"), "a b")
        self.assertEqual(b.wire("a\r\nb"), "a  b")

    def test_line_joins_columns_and_folds_each_of_them(self):
        self.assertEqual(b.line("ok", "x\ty", 7), "ok\tx y\t7")

    def test_json_column_never_spans_two_physical_lines(self):
        # A JSON column is the one place a newline could sneak through (it is a
        # string inside a string). `loads` round-trips it; the surface must not
        # contain a literal newline.
        text = b.jdump({"note": "line1\nline2\tend"})
        self.assertNotIn("\n", text)
        self.assertNotIn("\t", text)
        self.assertEqual(json.loads(text), {"note": "line1\nline2\tend"})


# --------------------------------------------------------------------------- #
# Options: refusal is a feature
# --------------------------------------------------------------------------- #

class WeightOptionTests(unittest.TestCase):
    def test_maps_camel_case_subkeys_onto_dataclass_fields(self):
        weights = b._build_weights("weights", {"sceneCut": 0.5, "audioRms": 0.5})
        self.assertIsInstance(weights, ScoringWeights)
        self.assertEqual((weights.scene_cut, weights.audio_rms), (0.5, 0.5))

    def test_unknown_subkey_is_refused_not_dropped(self):
        # Silently dropping it means the user tunes a signal that does not exist
        # and sees no change — a no-op parameter that looks applied.
        with self.assertRaises(b.EngineError) as caught:
            b._build_weights("weights", {"sceneCut": 0.5, "sceneCut2": 0.5})
        self.assertIn("sceneCut2", caught.exception.message)
        self.assertEqual(caught.exception.code, "INVALID_PARAMS")

    def test_boolean_is_not_a_number(self):
        # `isinstance(True, int)` is True in Python: without the explicit bool
        # check, `true` would pass as 1.0 and a typo would become a weight.
        self.assertEqual(codes(b._build_weights, "weights", {"audioRms": True}), "INVALID_PARAMS")

    def test_out_of_range_is_refused(self):
        self.assertEqual(codes(b._build_weights, "weights", {"audioRms": 1.5}), "INVALID_PARAMS")
        self.assertEqual(codes(b._build_weights, "weights", {"audioRms": -0.1}), "INVALID_PARAMS")

    def test_all_zero_is_refused(self):
        # ScoringWeights.normalized() substitutes its own defaults when the total
        # is 0, so an all-zero map would be accepted and silently ignored — the
        # most expensive kind of parameter bug.
        self.assertEqual(codes(b._build_weights, "weights", {"audioRms": 0.0}), "INVALID_PARAMS")
        self.assertEqual(codes(b._build_weights, "weights", {}), "INVALID_PARAMS")

    def test_a_non_object_is_refused_with_the_available_subkeys(self):
        with self.assertRaises(b.EngineError) as caught:
            b._build_weights("weights", [0.5])
        self.assertIn("audioRms", caught.exception.message)


class CoerceTests(unittest.TestCase):
    def test_wire_values_arrive_as_strings_and_are_coerced(self):
        # Every column on the wire is text; "3" must become an int, not stay str.
        self.assertEqual(b._coerce("maxHighlights", "3", b._INT), 3)
        self.assertEqual(b._coerce("sceneThreshold", "0.4", b._FLOAT), 0.4)

    def test_comma_string_becomes_a_clean_list(self):
        # Keywords are a `strs` option: a client may send "a, b,,c" and get three
        # entries — empty segments dropped, whitespace trimmed.
        self.assertEqual(b._coerce("keywords", " a, b ,,c ", b._STRS), ["a", "b", "c"])

    def test_uncoercible_value_names_the_option(self):
        with self.assertRaises(b.EngineError) as caught:
            b._coerce("maxHighlights", "many", b._INT)
        self.assertIn("maxHighlights", caught.exception.message)


class BoundsTests(unittest.TestCase):
    def test_bounds_come_from_the_contract(self):
        self.assertEqual(codes(b._check_bounds, "maxHighlights", 0), "INVALID_PARAMS")
        self.assertEqual(codes(b._check_bounds, "maxHighlights", 51), "INVALID_PARAMS")
        self.assertIsNone(codes(b._check_bounds, "maxHighlights", 50))

    def test_enum_membership_is_enforced(self):
        self.assertEqual(codes(b._check_bounds, "whisperModelSize", "turbo"), "INVALID_PARAMS")
        self.assertIsNone(codes(b._check_bounds, "whisperModelSize", "small"))


class BuildConfigTests(unittest.TestCase):
    def test_unknown_option_is_refused_with_the_list_of_valid_ones(self):
        with self.assertRaises(b.EngineError) as caught:
            b.build_config({"clipDuratonSec": 3})
        self.assertIn("clipDurationSec", caught.exception.message)

    def test_prompt_without_guidance_is_refused(self):
        # A prompt with the guidance switch off changes nothing and says nothing —
        # the caller believes they steered the result and did not.
        self.assertEqual(
            codes(b.build_config, {"clipPrompt": "a sunset"}),
            "INVALID_PARAMS",
        )
        self.assertIsNotNone(
            b.build_config({"clipPrompt": "a sunset", "enableClipGuidance": True})
        )

    def test_special_and_private_keys_are_not_passed_to_the_config(self):
        # `srtPath` is handled by the bridge (it is not a HighlightConfig field),
        # and `_`-prefixed keys are host bookkeeping.
        config = b.build_config({"srtPath": "/tmp/x.srt", "_trace": "abc", "maxHighlights": 4})
        self.assertEqual(config.max_highlights, 4)

    def test_explicit_opt_in_to_a_missing_model_is_unavailable(self):
        # Defaults may degrade silently; an explicit request may not. "I asked for
        # CLIP guidance and got a 0 weighted signal" is a lie, not a degradation.
        report = {
            "runtime": {"opencv": True, "numpy": True, "onnxruntime": False},
            "face": {"available": False},
            "clip": {"available": False},
            "whisper": {"available": False},
            "degraded": False,
        }
        with self.assertRaises(b.EngineError) as caught:
            b.build_config({"enableClipGuidance": True}, report)
        self.assertEqual(caught.exception.code, "UNAVAILABLE")
        self.assertIn("open-clip-torch", caught.exception.message)  # the fix, not just the fact

    def test_switched_off_option_does_not_require_anything(self):
        report = {"clip": {"available": False}, "runtime": {}, "face": {}, "whisper": {}}
        config = b.build_config({"enableClipGuidance": False}, report)
        self.assertFalse(config.enable_clip_guidance)


class CatalogTests(unittest.TestCase):
    def test_catalog_covers_every_contract_option_once(self):
        rows = b.options_catalog()
        self.assertEqual(len(rows), len(contract.OPTION_META))
        self.assertEqual(len({row["key"] for row in rows}), len(rows))

    def test_catalog_is_sorted_and_carries_limits(self):
        rows = b.options_catalog()
        self.assertEqual(rows, sorted(rows, key=lambda row: (row["group"], row["key"])))
        clip = next(row for row in rows if row["key"] == "clipDurationSec")
        self.assertEqual((clip["min"], clip["max"]), (0.5, 120))

    def test_weights_row_exposes_its_seven_subkeys(self):
        # The composite type is only rendered correctly if the catalog carries the
        # sub-specs; without them the panel would draw a text box for an object.
        row = next(row for row in b.options_catalog() if row["key"] == "weights")
        self.assertEqual(len(row["fields"]), 7)
        self.assertIn("audioRms", row["fields"])

    def test_availability_follows_the_report(self):
        report = {"clip": {"available": False}, "runtime": {}, "face": {}, "whisper": {}}
        rows = {row["key"]: row for row in b.options_catalog(report)}
        self.assertFalse(rows["enableClipGuidance"]["available"])
        self.assertTrue(rows["clipDurationSec"]["available"])  # no `requires`


# --------------------------------------------------------------------------- #
# EDL: the seam an editor reads
# --------------------------------------------------------------------------- #

class TimecodeTests(unittest.TestCase):
    def test_zero_and_whole_seconds(self):
        self.assertEqual(b._timecode(0, 25), "00:00:00:00")
        self.assertEqual(b._timecode(1.0, 25), "00:00:01:00")

    def test_frames_round_to_the_nearest_frame(self):
        # 59.96s at 25fps is 1499.0 frames — one frame short of the minute. Off by
        # one here is off by one frame in someone's timeline, at every cut.
        self.assertEqual(b._timecode(59.96, 25), "00:00:59:24")
        self.assertEqual(b._timecode(60.0, 25), "00:01:00:00")

    def test_hour_rollover_uses_the_frame_rate_not_a_constant(self):
        self.assertEqual(b._timecode(3600.0, 25), "01:00:00:00")
        self.assertEqual(b._timecode(3600.0, 30), "01:00:00:00")

    def test_unknown_frame_rate_falls_back_and_negative_clamps(self):
        self.assertEqual(b._timecode(2.0, 0), "00:00:02:00")
        self.assertEqual(b._timecode(-5.0, 25), "00:00:00:00")


class EdlTests(unittest.TestCase):
    def job(self, segments, fps=25.0):
        return b.Job(
            job_id="j1",
            input="/tmp/in.mp4",
            output="/tmp/out.mp4",
            config=HighlightConfig(),
            srt_path="",
            token=b.CancelToken(),
            segments=segments,
            fps=fps,
        )

    def test_one_event_per_segment_with_the_source_and_record_columns(self):
        edl = b.render_edl(self.job([
            {"startSec": 2.8, "endSec": 12.0, "score": 0.45, "signals": {}},
            {"startSec": 20.0, "endSec": 22.0, "score": 0.51, "signals": {}},
        ]))
        events = [row for row in edl.splitlines() if re.match(r"^\d{3}\s", row)]
        self.assertEqual(len(events), 2)
        # Source columns come from the input timebase; the record columns are
        # cumulative, because the rendered clip is a concatenation.
        self.assertIn("00:00:02:20 00:00:12:00 00:00:00:00 00:00:09:05", events[0])
        self.assertIn("00:00:20:00 00:00:22:00 00:00:09:05", events[1])

    def test_header_is_cmx3600_and_the_file_ends_with_a_newline(self):
        edl = b.render_edl(self.job([{"startSec": 0, "endSec": 1, "score": 1, "signals": {}}]))
        self.assertTrue(edl.startswith("TITLE:"))
        self.assertIn("FCM: NON-DROP FRAME", edl)
        self.assertTrue(edl.endswith("\n"))

    def test_no_segments_is_an_empty_but_valid_edl(self):
        edl = b.render_edl(self.job([]))
        self.assertEqual([row for row in edl.splitlines() if re.match(r"^\d{3}\s", row)], [])


class ArgsTests(unittest.TestCase):
    def test_short_argument_lists_are_padded(self):
        # `probe` may be called with no arguments; the dispatcher indexes by
        # position, so the pad is what keeps `analyze.status` from reading None.
        self.assertEqual(b._args("analyze.status", []), [""])
        self.assertEqual(len(b._args("analyze.start", ["j"])), 4)

    def test_a_long_argument_list_names_the_real_cause(self):
        # Too many columns means a tab inside a value, not a caller error; the
        # message has to say so or the diagnosis is "invalid params" forever.
        with self.assertRaises(b.EngineError) as caught:
            b._args("analyze.start", ["a", "b", "c", "d", "e"])
        self.assertIn("制表符", caught.exception.message)


# --------------------------------------------------------------------------- #
# Provenance: who computed these numbers
# --------------------------------------------------------------------------- #

class FileIdentityTests(unittest.TestCase):
    def test_missing_checkpoint_is_recorded_as_absent_not_omitted(self):
        entry = b._file_identity("detector", "/nonexistent/model.onnx")
        self.assertFalse(entry["present"])
        self.assertNotIn("sha256_16", entry)

    def test_present_checkpoint_carries_size_iso_mtime_and_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "model.onnx")
            with open(path, "wb") as handle:
                handle.write(b"hello")
            entry = b._file_identity("detector", path)
            self.assertTrue(entry["present"])
            self.assertEqual(entry["bytes"], 5)
            self.assertRegex(entry["mtime"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
            expected = hashlib.sha256(b"hello").hexdigest()[:16]
            self.assertEqual(entry["sha256_16"], expected)

    def test_digest_is_sixteen_hex_characters(self):
        # A fingerprint for humans and diffs, not a security primitive.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.onnx")
            pathlib.Path(path).write_bytes(b"x" * 1000)
            digest = b._file_identity("detector", path)["sha256_16"]
            self.assertRegex(digest, r"^[0-9a-f]{16}$")


class ProvenanceTests(unittest.TestCase):
    def test_fingerprint_is_16_hex_and_reproducible(self):
        first = b.provenance({"a": 1})
        second = b.provenance({"a": 1})
        self.assertRegex(first["fingerprint"], r"^[0-9a-f]{16}$")
        self.assertEqual(first["fingerprint"], second["fingerprint"])

    def test_fingerprint_depends_on_the_recipe_but_not_on_key_order(self):
        # Two JSON objects with the same content are the same recipe; a fingerprint
        # that reordered with the writer would be unusable for comparison.
        left = b.provenance({"a": 1, "b": 2})["fingerprint"]
        right = b.provenance({"b": 2, "a": 1})["fingerprint"]
        self.assertEqual(left, right)
        self.assertNotEqual(left, b.provenance({"a": 1, "b": 3})["fingerprint"])

    def test_environment_records_a_backend_per_signal(self):
        signals = b.environment()["signals"]
        self.assertEqual(
            set(signals),
            {"sceneCut", "audioRms", "visualMotion", "objectSaliency",
             "faceSaliency", "clipGuidance", "keywordMatch"},
        )
        allowed = {
            "ffmpeg-scene", "ffmpeg-astats", "opencv-optflow", "ffmpeg-signalstats",
            "onnx-detector", "mediapipe", "open_clip", "faster-whisper", "none",
        }
        for name, backend in signals.items():
            self.assertIn(backend, allowed, f"{name} 的后端 {backend!r} 不在白名单里")

    def test_environment_carries_no_job_level_data(self):
        # Provenance is deployment-scoped: two jobs on one machine must produce a
        # byte-identical environment, so anything per-job here is a bug.
        text = json.dumps(b.environment(), sort_keys=True)
        self.assertNotIn("jobId", text)
        self.assertNotIn(".mp4", text)
        self.assertNotIn("output", text)

    def test_opencv_judgement_agrees_across_the_two_surfaces(self):
        # `models.list` and `provenance` describe one machine; if they disagree a
        # reader has no way to tell which one is lying. This is the assertion that
        # would have caught find_spec() reporting a broken-but-installed OpenCV.
        report = b.models_report()
        signals = b.environment()["signals"]
        self.assertEqual(report["degraded"], not b.opencv_usable())
        self.assertEqual(
            signals["visualMotion"] == "opencv-optflow", b.opencv_usable()
        )

    def test_protocol_version_matches_the_contract(self):
        self.assertEqual(b.environment()["protocol"], int(contract.PROTOCOL_VERSION))


class AttachProvenanceTests(unittest.TestCase):
    def write(self, tmp, payload):
        path = os.path.join(tmp, "timeline.json")
        pathlib.Path(path).write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_stamps_the_report_and_leaves_the_payload_intact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, {"selected_highlights": [{"start_sec": 1}], "timeline_series": []})
            b.attach_provenance(path, HighlightConfig())
            payload = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
            self.assertEqual(payload["selected_highlights"], [{"start_sec": 1}])
            self.assertIn("provenance", payload)
            self.assertRegex(payload["provenance"]["fingerprint"], r"^[0-9a-f]{16}$")

    def test_weights_are_recorded_normalised(self):
        # 0/1/0 and 0/2/0 are the same scoring recipe and produce the same clip.
        # Recording raw values would hand two equivalent runs different
        # fingerprints and send someone hunting a difference that is not there.
        def stamp(weights):
            with tempfile.TemporaryDirectory() as tmp:
                path = self.write(tmp, {})
                b.attach_provenance(path, HighlightConfig(weights=weights))
                return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))["provenance"]

        one = stamp(ScoringWeights(0, 1, 0, 0, 0, 0, 0))
        two = stamp(ScoringWeights(0, 2, 0, 0, 0, 0, 0))
        self.assertEqual(one["recipe"]["weights"]["audio_rms"], 1.0)
        self.assertEqual(one["fingerprint"], two["fingerprint"])

    def test_no_staged_file_is_left_behind(self):
        # tmp + rename, because the report route may be serving the old file while
        # the new one is written: a reader must see one whole file or the other.
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, {})
            b.attach_provenance(path, HighlightConfig())
            self.assertEqual(sorted(p.name for p in pathlib.Path(tmp).iterdir()), ["timeline.json"])

    def test_a_broken_report_logs_and_does_not_raise(self):
        # The render is already on disk and correct; a missing stamp is a smaller
        # problem than a failed job. Bookkeeping must not fail the work it describes.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "timeline.json")
            pathlib.Path(path).write_text("not json", encoding="utf-8")
            b.attach_provenance(path, HighlightConfig())  # must not raise
            self.assertEqual(pathlib.Path(path).read_text(encoding="utf-8"), "not json")

    def test_empty_path_is_a_no_op(self):
        b.attach_provenance("", HighlightConfig())  # jobs without a report


# --------------------------------------------------------------------------- #
# Capability report: WHY it is reduced, not just THAT it is
# --------------------------------------------------------------------------- #

class CapabilityReportTests(unittest.TestCase):
    def test_reason_and_degraded_flag_cannot_disagree(self):
        # Two fields describing one state will eventually describe two states. The
        # UI branches on `degraded` and prints the reason, so a mismatch shows a
        # healthy machine's reason or an empty reason on a broken one.
        report = b.models_report()
        self.assertEqual(report["degraded"], report["degradedReason"] != "")
        self.assertEqual(report["degraded"], not report["runtime"]["opencv"])

    def test_absent_and_unimportable_are_named_separately(self):
        # Different machines, different fixes. "Install OpenCV" is wrong advice for
        # one that has it: a Homebrew keg whose libprotobuf moved imports with
        # `Library not loaded`, and find_spec still says the module is there.
        def issue(has_cv2, has_numpy, usable=False):
            with mock.patch.object(b, "opencv_usable", return_value=usable), \
                    mock.patch.object(b, "_has_module", side_effect=lambda name: {"cv2": has_cv2, "numpy": has_numpy}[name]):
                return b.opencv_issue()

        self.assertEqual(issue(False, False), "opencv-missing")
        self.assertEqual(issue(True, True), "opencv-import-failed")
        # cv2 present, numpy absent: the analyzer imports BOTH in one try, so this
        # would otherwise be reported as a broken OpenCV — and "reinstall OpenCV"
        # is the same wrong advice one level down. Real with a Homebrew opencv and
        # a python that has no pip numpy.
        self.assertEqual(issue(True, False), "numpy-missing")
        self.assertEqual(issue(True, True, usable=True), "")
        self.assertEqual(issue(False, False, usable=True), "")

    def test_the_reason_is_a_stable_code(self):
        # The panel maps these values onto message keys and falls back to a generic
        # sentence for anything else, so this list is the contract.
        self.assertIn(b.opencv_issue(), {"", "opencv-missing", "numpy-missing", "opencv-import-failed"})
        self.assertEqual(b.doctor()["models"]["degradedReason"], b.opencv_issue())


class UnknownVerbTest(unittest.TestCase):
    """The refusal has to be answerable, not just correct.

    Reported from a real session: `[-32602] highlight: 未知动词: nalyze.status`.
    Everything that made it unanswerable is in that line — the verb is not quoted,
    so nothing shows that it is 13 characters where `analyze.status` is 14; the
    message is the ENGINE's, so it blames the caller for a verb this engine does
    support; and nothing says which verb table answered, so "old engine" and
    "mangled request line" are indistinguishable.
    """

    def test_it_quotes_and_counts_what_arrived(self):
        err = b._unknown_verb("nalyze.status")
        self.assertEqual(err.code, "INVALID_PARAMS")
        self.assertIn("'nalyze.status'", err.message)
        self.assertIn(f"({len('nalyze.status')} 字符", err.message)

    def test_it_lists_what_this_engine_does_support(self):
        message = b._unknown_verb("nalyze.status").message
        supported = message.split("本引擎支持: ", 1)[1].split(", ")
        # The near miss is visible next to the real thing: a reader can see the
        # verb exists and that what arrived is not it.
        self.assertIn("analyze.status", supported)
        self.assertNotIn("nalyze.status", supported)
        self.assertEqual(sorted(supported), sorted(b.contract.VERBS))

    def test_it_names_the_table_that_answered(self):
        # "Old engine on a stale protocol_generated.py" and "host sent garbage"
        # need different fixes; the source is what tells them apart.
        self.assertIn(b.contract.SOURCE, b._unknown_verb("x").message)

    def test_the_dispatch_uses_it(self):
        class Quiet:  # handle() only touches rt after the verb is known
            pass

        with self.assertRaises(b.EngineError) as caught:
            b.handle(Quiet(), "nalyze.status", [])  # type: ignore[arg-type]
        self.assertIn("'nalyze.status'", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
