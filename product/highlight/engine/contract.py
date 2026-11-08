"""
The Python side of the single-source wire contract.

`protocol/contract.json` is the only place verbs, their column layouts AND the
`analyze.start` knob table are declared. The TypeScript capability imports it
directly; this module loads the SAME file so the bridge and the host cannot
drift apart. When the contract file is absent (an engine copied out of the
product tree for a standalone run), the GENERATED module
`protocol_generated.py` is used — it is emitted from the same JSON by
scripts/gen-protocol.mjs and committed, so there is still exactly one
hand-edited source.

`--doctor` reports which of the two answered (`source`), because "the engine is
running on a stale verb table" is a question worth being able to ask.

SPDX-License-Identifier: Apache-2.0
"""

import json
import pathlib
from typing import Any, Dict, List, Optional, Tuple

CONTRACT_PATH = pathlib.Path(__file__).resolve().parent.parent / "protocol" / "contract.json"

# Last resort: an engine that lost BOTH files can still handshake and say so.
_MINIMAL_VERSION = 1
_MINIMAL_VERBS: Dict[str, Dict[str, object]] = {
    "hello": {"framing": "verb", "request": [], "response": ["protocol", "engine", "python", "ffmpeg"]},
    "quit": {"framing": "ok", "request": [], "response": []},
}


def _generated() -> Tuple[int, Dict[str, Dict[str, object]], Dict[str, Tuple[str, str]], Dict[str, Any], bool]:
    try:
        import protocol_generated as generated  # noqa: PLC0415 - optional sibling

        return (
            int(generated.PROTOCOL_VERSION),
            dict(generated.VERBS),
            dict(getattr(generated, "OPTIONS", {})),
            dict(getattr(generated, "OPTION_META", {})),
            True,
        )
    except Exception:
        return _MINIMAL_VERSION, _MINIMAL_VERBS, {}, {}, False


def _load() -> Tuple[int, Dict[str, Dict[str, object]], Dict[str, Tuple[str, str]], Dict[str, Any], str]:
    if CONTRACT_PATH.exists():
        data = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        raw_options = dict(data.get("options") or {})
        # Drop the prose key the contract carries for editors that show top-level
        # keys as a tree; it is documentation, not a knob.
        raw_options.pop("comment", None)
        options = {
            key: (str(spec.get("field", "")), str(spec.get("type", "str")))
            for key, spec in raw_options.items()
        }
        return (
            int(data["protocolVersion"]),
            dict(data["verbs"]),
            options,
            raw_options,
            "contract.json",
        )
    version, verbs, options, meta, found = _generated()
    return version, verbs, options, meta, "protocol_generated.py" if found else "embedded-minimal"


PROTOCOL_VERSION, VERBS, OPTIONS, OPTION_META, SOURCE = _load()
CONTRACT_FOUND = SOURCE == "contract.json"


def framing(verb: str) -> str:
    return str(VERBS[verb]["framing"])


def request_columns(verb: str) -> List[str]:
    return list(VERBS[verb]["request"])  # type: ignore[arg-type]


def response_columns(verb: str) -> List[str]:
    return list(VERBS[verb]["response"])  # type: ignore[arg-type]


def known(verb: str) -> bool:
    return verb in VERBS


def describe() -> Optional[Dict[str, object]]:
    """Diagnostics for `--doctor`: what the bridge actually loaded."""
    return {
        "contractPath": str(CONTRACT_PATH),
        "contractFound": CONTRACT_FOUND,
        "source": SOURCE,
        "protocolVersion": PROTOCOL_VERSION,
        "verbs": sorted(VERBS),
        "options": len(OPTIONS),
    }
