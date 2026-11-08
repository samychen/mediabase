// Which interpreter runs the engine bridge.
//
// The failure this file exists for: `python3` on PATH is whatever the machine
// happens to have first. On a developer box that is often an interpreter
// nobody installed OpenCV into, so the engine reports `opencv-missing` and the
// panel says "OpenCV not installed" — which is FALSE, because OpenCV IS
// installed, in the venv that `scripts/setup-models.sh` created three
// directories away. The operator installs OpenCV a second time into the wrong
// interpreter and the banner does not change.
//
// So the host now picks the interpreter, and the rules are worth pinning:
//
//   * nothing pinned        -> the repository's own venv, if it can do vision
//   * `python` in the config -> honoured, even when it cannot do vision
//   * VHL_PYTHON             -> honoured, same reason
//   * an explicit `python3`  -> honoured: writing it down is a decision
//
// The probes here use REAL interpreters (the test runs under node, so it
// spawns shell scripts that print what the probe expects). That keeps the
// assertions about behaviour rather than about a mock's bookkeeping.

import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInterpreter } from '../packages/host/highlight/src/index.ts'
/**
 * A fake interpreter: a shell script that answers the vision probe.
 *
 * The probe imports the bridge and prints `opencv_issue()` — empty means
 * usable, a reason code means not. A script that prints the wanted answer
 * stands in for an interpreter with (or without) OpenCV.
 */
function fakePython(withVision: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'vhl-py-'))
  const path = join(dir, 'python')
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' ${withVision ? "''" : "'opencv-missing'"}\n`,
  )
  chmodSync(path, 0o755)
  return path
}

/**
 * A root whose engine/.venv/bin/python is the given interpreter.
 *
 * The venv interpreter is a SYMLINK to the fake, not a copy of it: the host
 * probes `<root>/engine/.venv/bin/python` by running it, and a copy would
 * need the script body — a symlink keeps one definition of "fake interpreter"
 * and mirrors how a venv actually points at its interpreter.
 */
function rootWithVenv(venvPython: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'vhl-root-'))
  mkdirSync(join(root, 'engine'), { recursive: true })
  if (venvPython !== null) {
    const bin = join(root, 'engine', '.venv', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(venvPython, join(bin, 'python'))
  }
  return root
}

/** A bridge path that exists — the probe reads it only to find its directory. */
const BRIDGE = join(tmpdir(), 'vhl-bridge', 'vhl_bridge.py')

describe('the interpreter that runs the engine', () => {
  it('uses the repository venv when nothing pins an interpreter', () => {
    // The whole point: the operator installed the model stack, and the host
    // finds it without being told.
    const root = rootWithVenv(fakePython(true))
    const result = resolveInterpreter('', root, BRIDGE, {})
    expect(result.source).toBe('venv')
    expect(result.python).toBe(join(root, 'engine', '.venv', 'bin', 'python'))
  })

  it('honours an explicit interpreter even when it cannot do vision', () => {
    // An operator who pinned an interpreter meant it, even if that interpreter
    // is a deliberate downgrade to the FFmpeg-only deployment.
    const root = rootWithVenv(fakePython(true))
    const pinned = fakePython(false)
    const result = resolveInterpreter(pinned, root, BRIDGE, {})
    expect(result.source).toBe('explicit')
    expect(result.python).toBe(pinned)
  })

  it('honours an explicit "python3"', () => {
    // Writing "python3" is a decision, not an omission. The schema default is
    // '' precisely so that "explicitly wrote python3" and "said nothing" stay
    // distinguishable — collapsing them would override a deliberate choice.
    const root = rootWithVenv(fakePython(true))
    const result = resolveInterpreter('python3', root, BRIDGE, {})
    expect(result.source).toBe('explicit')
    expect(result.python).toBe('python3')
  })

  it('honours VHL_PYTHON', () => {
    const root = rootWithVenv(fakePython(true))
    const pinned = fakePython(false)
    const result = resolveInterpreter('', root, BRIDGE, { VHL_PYTHON: pinned })
    expect(result.source).toBe('env')
    expect(result.python).toBe(pinned)
  })

  it('prefers an explicit interpreter over VHL_PYTHON', () => {
    const root = rootWithVenv(fakePython(true))
    const explicit = fakePython(true)
    const result = resolveInterpreter(explicit, root, BRIDGE, { VHL_PYTHON: fakePython(false) })
    expect(result.source).toBe('explicit')
    expect(result.python).toBe(explicit)
  })

  it('falls back to the PATH interpreter when there is no venv', () => {
    const root = rootWithVenv(null)
    const result = resolveInterpreter('', root, BRIDGE, {})
    expect(result.source).toBe('path')
    expect(result.python).toBe('python3')
  })

  it('does not use a venv that cannot do vision either', () => {
    // A stale or half-built .venv must not be worse than the PATH default: the
    // engine would report a DIFFERENT and equally true reason.
    const root = rootWithVenv(fakePython(false))
    const result = resolveInterpreter('', root, BRIDGE, {})
    expect(result.source).toBe('path')
    expect(result.python).toBe('python3')
  })
})
