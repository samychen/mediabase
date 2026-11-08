"""
Duplicate OpenMP Runtime Repair (macOS).

PyTorch and CTranslate2 each ship their own copy of Intel's OpenMP runtime as
`libiomp5.dylib`. Two copies in one process is a hard abort, not a slowdown:

    OMP: Error #15: Initializing libiomp5.dylib, but found libiomp5.dylib
    already initialized.
    Fatal Python error: Aborted

It aborts the moment the SECOND runtime initialises — so the order matters and
not in the obvious way. Merely importing both is fine; the crash lands on the
first real call, which is why it surfaces mid-analysis rather than at startup:

    import torch; (x @ x).sum()               # torch's runtime initialises
    from faster_whisper import WhisperModel   # <- aborts here

The engine needs both: OpenCLIP runs on torch, Whisper runs on CTranslate2,
and the pipeline loads them in the same process. So this is not a corner case.

Intel documents `KMP_DUPLICATE_LIB_OK=TRUE` as a workaround, but calls it
"unsafe, unsupported, undocumented" — it lets both runtimes initialise and
warns of "crashes or silently produce incorrect results". We do not set it.

Instead we remove the second copy: the duplicate is replaced by a symlink to
the copy already in use, so the dynamic linker loads one runtime and only one.
`DYLD_PRINT_LIBRARIES` confirms the outcome — the second path disappears from
the loaded set rather than merely ceasing to abort.

Called before the first CTranslate2 import, since after that library loads the
process is already past the point where the duplicate can be swapped out.

SPDX-License-Identifier: Apache-2.0
"""

import pathlib
import sys
from typing import Dict, List, Optional, Tuple

# The runtime both wheels duplicate. Intel's OpenMP ships under this name on
# macOS; on Linux it is libgomp/libiomp5.so and the conflict does not arise,
# because the wheels resolve to one system copy.
_OMP_NAME = "libiomp5.dylib"

# Which copy to keep, and what each duplicate becomes. The link is relative to
# the directory holding the copy, so the venv stays relocatable — an absolute
# path breaks the moment the project directory moves.
#
# torch binds to the functorch copy (libtorch_global_deps.dylib points at
# @loader_path/../../functorch/.dylibs/libiomp5.dylib), so that one is the
# survivor; ctranslate2 and torch/lib are pointed at it.
_KEEP = "functorch/.dylibs"
_LINK_TARGETS: Dict[str, str] = {
    # site-packages/ctranslate2/.dylibs -> site-packages/functorch/.dylibs
    "ctranslate2/.dylibs": "../../functorch/.dylibs/libiomp5.dylib",
    # site-packages/torch/lib -> site-packages/functorch/.dylibs
    "torch/lib": "../../functorch/.dylibs/libiomp5.dylib",
}


def _site_packages() -> Optional[pathlib.Path]:
    """Where the wheels put their shared libraries."""
    try:
        import sysconfig

        paths = sysconfig.get_paths()
    except Exception:
        return None
    for key in ("purelib", "platlib"):
        path = paths.get(key)
        if path:
            return pathlib.Path(path)
    return None


def _copies(site: pathlib.Path) -> List[Tuple[str, pathlib.Path]]:
    """Every OpenMP runtime copy inside site-packages, as (key, path)."""
    found: List[Tuple[str, pathlib.Path]] = []
    for parent in site.glob("*/.dylibs"):
        candidate = parent / _OMP_NAME
        if candidate.exists():
            found.append((f"{parent.parent.name}/.dylibs", candidate))
    candidate = site / "torch" / "lib" / _OMP_NAME
    if candidate.exists():
        found.append(("torch/lib", candidate))
    return found


def _resolved(path: pathlib.Path) -> Optional[pathlib.Path]:
    try:
        return path.resolve()
    except OSError:
        return None


def repair_duplicate_openmp() -> Optional[str]:
    """
    Make the process load a single OpenMP runtime.

    Returns a short description of what was changed, or None when there was
    nothing to do — no duplicate, not macOS, or the wheels are not where we
    expect. Safe to call more than once: the second call finds every copy
    already pointing at the same file and does nothing.
    """
    if sys.platform != "darwin":
        return None

    site = _site_packages()
    if site is None or not site.is_dir():
        return None

    copies = _copies(site)
    if len(copies) < 2:
        return None

    # The survivor: the copy torch actually binds to.
    keep: Optional[Tuple[str, pathlib.Path]] = None
    for key, path in copies:
        if key == _KEEP:
            keep = (key, path)
            break
    if keep is None:
        return None

    keep_real = _resolved(keep[1])
    if keep_real is None:
        return None

    # Already merged? Every other copy resolves to the survivor.
    others = [(key, path) for key, path in copies if path != keep[1]]
    if others and all(_resolved(path) == keep_real for _, path in others):
        return None

    changed: List[str] = []
    for key, path in others:
        target = _LINK_TARGETS.get(key)
        if target is None:
            continue
        link_target = (path.parent / target).resolve()
        if not link_target.exists():
            continue
        try:
            # Keep the original alongside as .orig — the wheel can be restored
            # without reinstalling, and `pip install --force-reinstall` would
            # overwrite it anyway.
            backup = path.with_name(path.name + ".orig")
            if not backup.exists():
                path.replace(backup)
            else:
                path.unlink()
            path.symlink_to(pathlib.Path(target))
        except OSError:
            continue
        changed.append(f"{key} -> {target}")

    if not changed:
        return None
    return "合并重复 OpenMP runtime: " + ", ".join(changed)
