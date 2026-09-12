// The composition gate (`scripts/verify-composition.mjs`) — checked by RUNNING it, the same
// way a maintainer and CI do, because what matters is the verdict and the message a person
// reads, not an internal function's return value.
//
// What the gate is for: a composition is data, so a row naming a package the app does not
// depend on, a `!!js` expression the Loader never interpolates, or a patch targeting an id
// no layer declares are all invisible until a specific deployment boots — and then they
// surface as "loader entries failed to apply". Each case below is one of those mistakes.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOT } from './support/host.ts'

const GATE = join(ROOT, 'scripts', 'verify-composition.mjs')
const BUNDLE_LAYER = join(ROOT, 'packages', 'bundle', 'app', 'cordis.patch.yml')

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

/** Write a layer file into a throwaway directory and return its path. */
function layer(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediabase-layer-'))
  made.push(dir)
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, content)
  return file
}

/** Run the gate and report its exit code plus everything it printed. */
function gate(...files: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [GATE, ...files], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('the composition gate', () => {
  it('passes every composition file the repo ships (host layers and the client roster)', () => {
    const result = gate()
    expect(result.code).toBe(0)
    // Two files today: the host bundle layer and the UI bundle's browser roster.
    expect(result.out).toContain('verify-composition: 2 个组合文件通过')
  }, 60_000)

  it('refuses a client roster that does not end with the shell its manifest names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediabase-ui-'))
    made.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@fake/ui-bundle',
      dependencies: { '@mediabase/ui': 'workspace:^', '@mediabase/ui-web': 'workspace:^' },
      mediabase: { uiBundle: { roster: 'client.yml', shell: '@mediabase/ui-web' } },
    }))
    // The shell renders what ctx.ui holds, so a roster that mounts it FIRST renders an empty
    // page — with no error anywhere. The order is the file's whole meaning, so it is checked.
    writeFileSync(join(dir, 'client.yml'), [
      "- id: shell",
      "  name: '@mediabase/ui-web'",
      "- id: ui",
      "  name: '@mediabase/ui'",
      '',
    ].join('\n'))
    const result = gate(join(dir, 'client.yml'))
    expect(result.code).toBe(1)
    expect(result.out).toContain('最后一行必须是外壳 @mediabase/ui-web')
  })

  it('refuses a client roster row that tries to be a patch', () => {
    const file = layer([
      '- id: ui',
      '  config:',
      '    level: debug',
      '',
    ].join('\n'))
    const result = gate(file)
    // `layer()` writes cordis.patch.yml; the roster rule is about client.yml, so this only
    // proves the file name decides the checker — see the roster cases above.
    expect(result.code).toBe(1)
  })

  it('accepts the shipped bundle layer on its own, with its own manifest as the owner', () => {
    const result = gate(BUNDLE_LAYER)
    expect(result.code).toBe(0)
  }, 60_000)

  it('accepts a relative row (a deployment resolves it beside the profile)', () => {
    const file = layer([
      '- insert:',
      '    - id: mine',
      "      name: './my-capability.mjs'",
      '',
    ].join('\n'))
    expect(gate(file).code).toBe(0)
  })

  it('refuses a bare row name the owning manifest does not depend on', () => {
    const file = layer([
      '- insert:',
      '    - id: ghost',
      "      name: '@mediabase/not-a-dependency'",
      '',
    ].join('\n'))
    const result = gate(file)
    expect(result.code).toBe(1)
    expect(result.out).toContain('行 "ghost" 的模块 @mediabase/not-a-dependency 无法从 apps/cli/package.json 解析')
  })

  it('refuses a !!js expression in a field the Loader never interpolates', () => {
    const file = layer([
      '- insert:',
      '    - id: dynamic-name',
      "      name: !!js ctx.env.MODULE",
      '',
    ].join('\n'))
    const result = gate(file)
    expect(result.code).toBe(1)
    // Two problems, both worth reporting: the expression is inert, and the name cannot resolve.
    expect(result.out).toContain('name 里有 !!js 表达式')
    expect(result.out).toContain('loader 只对 config/disabled 求值')
  })

  it('accepts !!js under config, where the Loader does evaluate it', () => {
    const file = layer([
      '- id: log',
      '  config:',
      "    scope: !!js ctx.env.MEDIABASE_LOG_SCOPE ?? 'mediabase'",
      '',
    ].join('\n'))
    // The bundle declares `log`; this layer overrides its config with an expression.
    expect(gate(BUNDLE_LAYER, file).code).toBe(0)
  })

  it('refuses one layer inserting the same id twice', () => {
    const file = layer([
      '- insert:',
      '    - id: twice',
      "      name: '@mediabase/log'",
      '    - id: twice',
      "      name: '@mediabase/api'",
      '',
    ].join('\n'))
    const result = gate(file)
    expect(result.code).toBe(1)
    expect(result.out).toContain('行 id "twice" 在本层被插入了两次')
  })

  it('refuses a patch that targets an id no layer declares', () => {
    const file = layer([
      '- id: lnog',
      '  config:',
      '    level: debug',
      '',
    ].join('\n'))
    const result = gate(file)
    expect(result.code).toBe(1)
    expect(result.out).toContain('覆盖行 "lnog",但没有任何层声明这个 id')
  })

  it('accepts a patch that overrides a row declared by an earlier layer', () => {
    const file = layer([
      '- id: log',
      '  config:',
      '    level: debug',
      '',
    ].join('\n'))
    // The bundle declares `log`; a deployment layer may override it by id.
    const result = gate(BUNDLE_LAYER, file)
    expect(result.code).toBe(0)
  })

  it('refuses a layer that is not a list of entries', () => {
    const result = gate(layer('id: not-a-list\n'))
    expect(result.code).toBe(1)
    expect(result.out).toContain('顶层必须是数组')
  })
})
