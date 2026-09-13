// Composition through PATCH LAYERS (route C): a profile directory, bundle layers, and
// id-targeted overrides — the mechanism deepseek-harness uses, mounted by the vendored
// Loader. This is the ONLY composition path; the in-code capability table is gone.
//
// What this suite proves, in order of importance:
//
//   1. The composed host mounts EXACTLY the shipped capability set, with a control plane that
//      answers for every capability. A dropped row (or a renamed one) fails here.
//   2. The profile directory is created from a template and is the thing a deployment
//      edits — not the bundle, and not code.
//   3. Layers apply in order, and a later layer overrides an earlier row BY ID: a
//      `--patch` overlay changes one row's config without forking the bundle — and because
//      a patch replaces the WHOLE config, a row that loses a required field fails the boot
//      naming the row and the path.
//   4. A deployment value reaches the host as CONFIG: the row states it from the
//      environment through the loader-context readers (`!!js ctx.env.*`), so `MEDIABASE_*`
//      still works with no code path of its own. The env vocabulary lives in ONE map here,
//      which a row that forgets a knob (or invents one) fails against.
//   5. Misconfiguration fails LOUD: an unresolvable bundle, a malformed patch file, a row
//      whose module is not installed and a row whose config does not validate must all stop
//      the boot with an actionable message.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOME_PATCH_FILENAME,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
  initProfile,
  insertedRows,
  loadPatches,
  loadProfile,
  resolveBundleDir,
  resolveHome,
  resolveProfileDir,
  applyPluginManifest,
  deploymentEnv,
  describeBootFailure,
  loadPluginManifest,
} from '@mediabase/boot'
import { IDENTITY } from '../apps/cli/src/identity.ts'
import { parse, type Schema } from '../packages/base/schema/src/index.ts'
import * as log from '../packages/base/log/src/index.ts'
import * as settings from '../packages/host/settings/src/index.ts'
import * as agent from '../packages/host/agent/src/index.ts'
import * as plugins from '../packages/host/plugins/src/index.ts'
import * as server from '../packages/host/server/src/index.ts'
import { ROOT, bootHost, expectError, waitFor } from './support/host.ts'

const made: string[] = []
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'mediabase-home-'))
  made.push(home)
  return home
}

/** The CLI's own anchor: `apps/cli/package.json` declares the bundle it templates. */
const CLI_ANCHOR = join(ROOT, 'apps', 'cli', 'package.json')

describe('profile files and patch parsing', () => {
  it('creates the three profile files on first boot and never overwrites an edit', () => {
    const home = tempHome()
    const dir = resolveProfileDir('web', home, IDENTITY.bin)
    initProfile(dir, ['@mediabase/bundle-app'], IDENTITY)

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      private?: boolean
      mediabase?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.private).toBe(true)
    expect(manifest.mediabase?.profile?.bundles).toEqual(['@mediabase/bundle-app'])
    // The user layer starts as an empty patch LIST, which is what the loader expects.
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')

    // A deployment's edits are the point of the directory: re-initializing keeps them.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: log\n  config: { level: debug }\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ mediabase: { profile: { bundles: ['custom'] } } }))
    initProfile(dir, ['@mediabase/bundle-app'], IDENTITY)
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('level: debug')
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { mediabase?: { profile?: { bundles?: string[] } } }
    expect(after.mediabase?.profile?.bundles).toEqual(['custom'])
  })

  it('refuses a profile name that would escape the profiles directory', () => {
    const home = tempHome()
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(bad, home, IDENTITY.bin), bad).toThrow(/非法 profile 名/)
    }
    expect(resolveProfileDir('web', home, IDENTITY.bin)).toBe(join(home, 'profiles', 'web'))
  })

  it('honours MEDIABASE_HOME and falls back to ~/.mediabase', () => {
    const home = tempHome()
    expect(resolveHome({ MEDIABASE_HOME: home }, IDENTITY)).toBe(home)
    expect(resolveHome({}, IDENTITY)).toMatch(/\.mediabase$/)
    expect(resolveHome({ MEDIABASE_HOME: '' }, IDENTITY)).toMatch(/\.mediabase$/)
  })

  it('parses the loader dialect, keeping !!js as an expression node for activation', () => {
    const home = tempHome()
    const file = join(home, 'patch.yml')
    writeFileSync(file, [
      '- insert:',
      '    - id: demo',
      "      name: '@mediabase/log'",
      '      config: !!js process.env.DEMO_LEVEL',
      '',
    ].join('\n'))

    const patches = loadPatches(file, true, IDENTITY.bin)!
    const rows = insertedRows(patches)
    expect(rows.map((r) => r.id)).toEqual(['demo'])
    // The expression survives as a node: the Loader evaluates it at entry activation,
    // against the context this composition provided (appPaths / env).
    const config = rows[0]?.config as Record<string, unknown> | undefined
    expect(config?.['__jsExpr']).toBe('process.env.DEMO_LEVEL')
  })

  it('treats a missing optional layer as absent and a missing required one as an error', () => {
    const home = tempHome()
    expect(loadPatches(join(home, 'nope.yml'), false, IDENTITY.bin)).toBeUndefined()
    expect(() => loadPatches(join(home, 'nope.yml'), true, IDENTITY.bin)).toThrow(/无法读取 patch 文件/)
  })

  it('fails loud on a patch file that is not a YAML list', () => {
    const home = tempHome()
    const bad = join(home, 'bad.yml')
    writeFileSync(bad, 'id: not-a-list\n')
    expect(() => loadPatches(bad, true, IDENTITY.bin)).toThrow(/顶层必须是数组/)
    const invalid = join(home, 'invalid.yml')
    writeFileSync(invalid, '- id: [unclosed\n')
    expect(() => loadPatches(invalid, true, IDENTITY.bin)).toThrow(/不是合法 YAML/)
  })

  it('resolves the shipped bundle from the installation anchor, and says what to do when it cannot', () => {
    const home = tempHome()
    const dir = resolveProfileDir('web', home, IDENTITY.bin)
    initProfile(dir, ['@mediabase/bundle-app'], IDENTITY)
    const bundleDir = resolveBundleDir('@mediabase/bundle-app', CLI_ANCHOR, dir, [], IDENTITY.bin)
    expect(existsSync(join(bundleDir, PROFILE_PATCH_FILENAME))).toBe(true)

    expect(() => resolveBundleDir('@mediabase/no-such-bundle', CLI_ANCHOR, dir, [], IDENTITY.bin)).toThrow(/无法解析 bundle.*pnpm install/s)
  })

  it('reads the bundle list from the profile manifest', () => {
    const home = tempHome()
    const dir = resolveProfileDir('web', home, IDENTITY.bin)
    initProfile(dir, ['@mediabase/bundle-app'], IDENTITY)
    const profile = loadProfile('web', home, CLI_ANCHOR, [], IDENTITY)
    expect(profile.bundlePatchPaths).toHaveLength(1)
    expect(profile.bundlePatches.length).toBeGreaterThan(0)
    expect(profile.profilePatches).toEqual([])
  })
})

describe('boot failure reporting', () => {
  it('keeps every reason a concurrent mount failure carries', () => {
    // The Loader reports a multi-entry failure as an AggregateError whose own message says
    // nothing; the rows and their causes are in `errors`, and a boot that prints only the
    // message sends the reader looking in the wrong place.
    const failure = new AggregateError(
      [new Error('invalid config: $.root missing required value'), new Error('Cannot find package \'@mediabase/log\'')],
      'loader entries failed to apply',
    )
    const text = describeBootFailure(new Error('failed to apply loader entry include (cordis:include): x', { cause: failure }))
    expect(text).toContain('failed to apply loader entry include')
    // …and the reasons must survive THAT wrapper: the Loader's own error is a plain Error
    // with a `cause`, so reporting only its line is the dead end this formatter prevents.
    expect(text).toContain('(2 个原因)')
    expect(text).toContain('invalid config: $.root missing required value')
    expect(text).toContain("Cannot find package '@mediabase/log'")

    const aggregate = describeBootFailure(failure)
    expect(aggregate).toContain('(2 个原因)')
    expect(aggregate).toContain('  invalid config: $.root missing required value')
    expect(aggregate).toContain("  Cannot find package '@mediabase/log'")
    // A single error stays one line — the formatter must not invent structure.
    expect(describeBootFailure(new Error('boom'))).toBe('boom')
    // A cause already quoted by its wrapper is not reprinted, but a cause of its own is.
    expect(describeBootFailure(new Error("failed to import x: Cannot find package 'y'", { cause: new Error("Cannot find package 'y'") })))
      .toBe("failed to import x: Cannot find package 'y'")
    expect(describeBootFailure(new Error('wrapper', { cause: new Error('inner', { cause: new Error('deep') }) })))
      .toBe('wrapper\n  inner\n    deep')
  })
})

/**
 * Evaluate the shipped bundle's rows the way the Loader does.
 *
 * The dialect is the harness's own: a `!!js` scalar survives parsing as an expression node
 * and is evaluated against the loader context with `new Function('ctx', expr, 'with (ctx) {
 * return eval(expr) }')` when the row activates. Only the two things the composition provides
 * are needed here (`appPaths` and `env`), and the recursion mirrors the loader's own
 * `interpolate` — evaluating a copy rather than the real code would measure the copy.
 */
function evaluateRows(configs: Record<string, unknown>, scope: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }') as (ctx: object, expr: string) => unknown
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    if ('__jsExpr' in (value as Record<string, unknown>)) {
      // The dialect's own node shape (`loadPatches` keeps it for the Loader to evaluate).
      return evaluate(scope, String((value as Record<string, unknown>)['__jsExpr']))
    }
    if (Array.isArray(value)) return value.map(walk)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
  }
  return Object.fromEntries(Object.entries(configs).map(([id, config]) => [id, walk(config)]))
}

/** The rows of the shipped bundle, as `{ id: rawConfig }` (expressions not yet evaluated). */
function shippedRowConfigs(): Record<string, unknown> {
  const patches = loadPatches(join(ROOT, 'packages', 'bundle', 'app', PROFILE_PATCH_FILENAME), true, IDENTITY.bin)!
  const out: Record<string, unknown> = {}
  for (const row of insertedRows(patches)) {
    if (typeof row.id === 'string' && row.config !== undefined) out[row.id] = row.config
  }
  return out
}

describe('the shipped rows state the deployment environment', () => {
  const ROOT_PATH = '/opt/app'
  const PREFIX = IDENTITY.envPrefix
  /**
   * The env vocabulary, per capability: config field → the EXPRESSION the row must state.
   *
   * Written as the expression, not as a variable name, because that is the contract now: a
   * base row names a SHORT variable and a reader, and the boot supplies the prefix — so the
   * test fails if a row starts spelling a product name (`MEDIABASE_TOKEN`) again.
   */
  const vocabulary: Record<string, Record<string, string>> = {
    log: { level: "ctx.env.choice('LOG_LEVEL', ['debug', 'info', 'warn', 'error'])" },
    settings: { file: "ctx.env.str('SETTINGS_FILE')" },
    agent: {
      baseUrl: "ctx.env.str('LLM_BASE')",
      apiKey: "ctx.env.str('LLM_KEY')",
      model: "ctx.env.str('LLM_MODEL')",
      // 不是给请求用的,是给「该设哪个变量」那句话用的 —— 登记它,否则这就是个没人记录的旋钮。
      envPrefix: 'ctx.env.prefix',
    },
    plugins: {
      dataRoot: "ctx.env.str('PLUGIN_DATA_ROOT')",
      confinementRequired: "ctx.env.flag('SANDBOX_CONFINE_REQUIRED')",
      envPrefix: 'ctx.env.prefix',
    },
    server: {
      port: "ctx.env.rawNum('PORT')",
      distIndex: "ctx.env.str('DIST_INDEX')",
      token: "ctx.env.str('TOKEN')",
      crossOriginIsolation: "ctx.env.flag('CROSS_ORIGIN_ISOLATION')",
      'acl.readonly': "ctx.env.flag('READONLY')",
      'acl.allow': "ctx.env.list('ACL_ALLOW')",
      'acl.deny': "ctx.env.list('ACL_DENY')",
    },
  }

  /** The environment as a deployment would set it: every app variable carries the prefix. */
  const env: Record<string, string> = {
    [`${PREFIX}LLM_BASE`]: 'http://llm.local/v1',
    [`${PREFIX}LLM_KEY`]: 'k-123',
    [`${PREFIX}LLM_MODEL`]: 'model-x',
    [`${PREFIX}SETTINGS_FILE`]: '/tmp/settings.json',
    [`${PREFIX}PLUGIN_DATA_ROOT`]: '/tmp/plugin-data',
    [`${PREFIX}SANDBOX_CONFINE_REQUIRED`]: '1',
    [`${PREFIX}LOG_LEVEL`]: 'debug',
    PORT: '4444',
    [`${PREFIX}DIST_INDEX`]: '/opt/dist/index.html',
    [`${PREFIX}TOKEN`]: 'shared-secret',
    [`${PREFIX}READONLY`]: '1',
    [`${PREFIX}ACL_ALLOW`]: 'api.*, plugins.*',
    [`${PREFIX}ACL_DENY`]: 'settings.set',
    [`${PREFIX}CROSS_ORIGIN_ISOLATION`]: '1',
  }

  /** Configs by row id, for the schema check below. */
  const configs: Record<string, Schema<any, any>> = {
    log: log.Config,
    settings: settings.Config,
    agent: agent.Config,
    plugins: plugins.Config,
    server: server.Config,
  }

  /** Read a dotted path (`acl.readonly`) out of a parsed config. */
  function field(config: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config)
  }

  /** The value the environment gave, in the type the config field takes. */
  function expected(expression: string, prefix: string): unknown {
    // The reader decides the type: `flag` → boolean, `list` → array, `num` → number.
    if (expression.includes('ctx.env.flag(')) return true
    if (expression.includes('ctx.env.num(')) return Number(env[`${prefix}ENGINE_FPS`])
    if (expression.includes('ctx.env.rawNum(')) return Number(env['PORT'])
    if (expression.includes('ctx.env.prefix')) return prefix
    if (expression.includes('ctx.env.choice(')) return env[`${prefix}LOG_LEVEL`]
    const variable = /ctx\.env\.(?:str|list)\('([A-Z_]+)'/.exec(expression)?.[1] ?? ''
    const value = env[`${prefix}${variable}`]!
    return expression.includes('ctx.env.list(')
      ? (expression.includes("':'") ? value.split(':') : value.split(',').map((item) => item.trim()))
      : value
  }

  it('states every environment-derived field as a SHORT name plus a reader', () => {
    for (const [id, fields] of Object.entries(vocabulary)) {
      const raw = shippedRowConfigs()[id] as Record<string, unknown>
      for (const [path, expression] of Object.entries(fields)) {
        const key = path.includes('.') ? path.split('.')[0]! : path
        const node = field(raw, path) ?? (field(raw, key) as Record<string, unknown> | undefined)?.[path.split('.')[1] ?? '']
        expect(node, `${id}.${path}`).toEqual({ __jsExpr: expression })
        // The row must NOT spell a product name: the prefix comes from the boot identity.
        expect(expression).not.toContain('AVSTUDIO')
        expect(expression).not.toContain('MEDIABASE')
      }
    }
  })

  it('resolves those short names through the prefix, with the value the environment gave', () => {
    const rows = evaluateRows(shippedRowConfigs(), {
      appPaths: { root: ROOT_PATH, home: '/home/tester' },
      env: deploymentEnv(env, PREFIX, IDENTITY.bin),
    })

    for (const [id, fields] of Object.entries(vocabulary)) {
      const viaRow = parse(configs[id]!, (rows[id] ?? {}) as never) as Record<string, unknown>
      for (const [path, expression] of Object.entries(fields)) {
        expect(field(viaRow, path), `${id}.${path} 应来自 ${expression}`).toEqual(expected(expression, PREFIX))
      }
      // ...and nothing ELSE in the config came from the environment: a row field the
      // vocabulary does not name would be a knob nobody documented.
      const stated = Object.entries(rows[id] as Record<string, unknown>)
        .filter(([key, value]) => key !== 'root' && value !== undefined)
        .map(([key]) => key)
        // `acl` is registered through its dotted fields (`acl.readonly`, …).
        .filter((key) => !(key in fields) && !Object.keys(fields).some((path) => path.startsWith(`${key}.`)))
      expect(stated, `${id} 里有未登记的配置字段`).toEqual([])
    }
  })

  it('reads the same rows through a DIFFERENT prefix, which is the whole point', () => {
    // A product (or a small tool) swaps the vocabulary by changing one constant; the rows do
    // not move. Renamed values prove the readers really resolve through the prefix rather
    // than matching whatever happened to be in the environment.
    const other = 'EXPT_'
    const renamed = Object.fromEntries(
      Object.entries(env).map(([name, value]) => [name.startsWith(PREFIX) ? `${other}${name.slice(PREFIX.length)}` : name, value]),
    )
    const rows = evaluateRows(shippedRowConfigs(), {
      appPaths: { root: ROOT_PATH, home: '/home/tester' },
      env: deploymentEnv(renamed, other, IDENTITY.bin),
    })
    const viaRow = parse(server.Config, { root: ROOT_PATH, ...(rows['server'] as object) }) as unknown as Record<string, unknown>
    expect(viaRow['token']).toBe('shared-secret')
    expect(field(viaRow, 'acl.readonly')).toBe(true)
    expect(viaRow['port']).toBe(4444)
    // The prefix travels into the capabilities that still read the environment themselves.
    const viaPlugins = parse(plugins.Config, { root: ROOT_PATH, ...(rows['plugins'] as object) }) as unknown as Record<string, unknown>
    expect(viaPlugins['envPrefix']).toBe(other)
  })

  it('leaves a row field absent when nothing states it, so the capability default applies', () => {
    const rows = evaluateRows(shippedRowConfigs(), {
      appPaths: { root: ROOT_PATH, home: '/home/tester' },
      env: deploymentEnv({}, PREFIX, IDENTITY.bin),
    })
    // Nothing in the environment: a row states `undefined`, which the capability's schema
    // treats as absent — and then the static default (port 3088, python3, deepseek-chat)
    // is what the host runs with.
    expect(parse(server.Config, { root: ROOT_PATH, ...(rows['server'] as object) }))
      .toMatchObject({ port: 3088 })
    expect(parse(agent.Config, { root: ROOT_PATH, ...(rows['agent'] as object) }))
      .toMatchObject({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
    // The root-relative paths are resolved by the capability, never repeated in a row: an
    // unset variable leaves the field without a VALUE (the dialect keeps the key with
    // `undefined`, which the capability's `??` treats as unset), so the path stays unstated.
    const parsed = parse(server.Config, { root: ROOT_PATH, ...(rows['server'] as object) }) as unknown as Record<string, unknown>
    expect(parsed['distIndex'], 'server.distIndex').toBeUndefined()
  })
})

describe('the deployment environment readers', () => {
  const PREFIX = 'EXPT_'
  const env = deploymentEnv({
    EXPT_TOKEN: 'secret', EXPT_READONLY: '1',
    EXPT_DISABLED: 'false',
    EXPT_SAMPLES_DIRS: '/a:/b::/c',
    EXPT_EMPTY: '',
    EXPT_LEVEL: 'verbose',
    PORT: '4000',
    PATH: '/usr/bin',
  }, PREFIX, IDENTITY.bin)

  it('resolves SHORT names through the prefix, so a row never spells a product', () => {
    expect(env.prefix).toBe(PREFIX)
    expect(env.name('TOKEN')).toBe('EXPT_TOKEN')
    expect(env.str('TOKEN')).toBe('secret')
    // An unprefixed variable is invisible to `str` (the prefix is not optional), which is
    // what makes "one vocabulary" checkable rather than aspirational.
    expect(env.str('PORT')).toBeUndefined()
    expect(env.raw('PORT')).toBe('4000')
    expect(env.raw('PATH')).toBe('/usr/bin')
    expect(env.num('EMPTY')).toBeUndefined()
    expect(env.flag('READONLY')).toBe(true)
    expect(env.flag('DISABLED')).toBe(false)
    expect(env.flag('MISSING')).toBeUndefined()
    // A list keeps its own separator and drops empties, so PATH-like values work.
    expect(env.list('SAMPLES_DIRS', ':')).toEqual(['/a', '/b', '/c'])
    expect(env.list('MISSING')).toBeUndefined()
  })

  it('fails loud on a value that cannot mean what it says, naming the full variable', () => {
    expect(() => env.num('SAMPLES_DIRS')).toThrow(/EXPT_SAMPLES_DIRS.*不是合法数字/)
    expect(() => env.flag('TOKEN')).toThrow(/EXPT_TOKEN.*不是布尔值/)
  })

  it('offers `choice` for a knob whose typo must not stop the boot', () => {
    const allowed = ['debug', 'info', 'warn', 'error'] as const
    // A value outside the set is `undefined` (the schema default applies) rather than a
    // boot failure — the reason the log level is read here and not by the capability.
    expect(env.choice('LEVEL', allowed)).toBeUndefined()
    expect(deploymentEnv({ EXPT_LEVEL: 'warn' }, PREFIX, IDENTITY.bin).choice('LEVEL', allowed)).toBe('warn')
    expect(env.choice('MISSING', allowed)).toBeUndefined()
  })
})

describe('the closed runtime (a host with nothing beside it)', () => {
  /** A throwaway directory holding one module plus its manifest. */
  function packaged(modules: Record<string, string>): { dir: string; manifest: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mediabase-closed-'))
    made.push(dir)
    const manifest = join(dir, 'plugins.json')
    writeFileSync(manifest, JSON.stringify({ plugins: modules }))
    return { dir, manifest }
  }

  it('resolves the manifest: env wins, then the running entry, then the anchor', () => {
    const { dir, manifest } = packaged({ '@fake/one': 'one.cjs' })
    const entry = join(dir, 'host.cjs')
    writeFileSync(entry, '// bundle')

    // The running entry's own directory: what makes a copied build/ self-contained.
    expect(loadPluginManifest('/nowhere/apps/cli/package.json', {}, entry, IDENTITY.envPrefix, IDENTITY.bin)?.path).toBe(manifest)
    // The anchor's build/ dir: the checkout case.
    expect(loadPluginManifest('/nowhere/apps/cli/package.json', {}, undefined, IDENTITY.envPrefix, IDENTITY.bin)).toBeUndefined()
    // An explicit override, which is also how this suite exercises the mechanism.
    const elsewhere = packaged({ '@fake/two': 'two.cjs' })
    expect(loadPluginManifest('/nowhere/apps/cli/package.json', { MEDIABASE_PLUGIN_MANIFEST: elsewhere.manifest }, entry, IDENTITY.envPrefix, IDENTITY.bin)?.path)
      .toBe(elsewhere.manifest)
    // A manifest that says nothing about a name is not an error here; the pre-flight reports it.
    expect(loadPluginManifest('/nowhere/apps/cli/package.json', {}, undefined, IDENTITY.envPrefix, IDENTITY.bin)).toBeUndefined()
  })

  it('rewrites only the names the manifest ships, leaving the rest to the Loader', () => {
    const patches = [{
      insert: [
        { id: 'shipped', name: '@fake/one', config: { x: 1 } },
        { id: 'relative', name: './mine.mjs' },
        { id: 'builtin', name: 'cordis:include' },
        { id: 'other', name: '@mediabase/log' },
      ],
    }]
    const rewritten = applyPluginManifest(patches, { '@fake/one': '/opt/closed/one.cjs' }) as Array<{ insert: Array<{ id: string; name: string }> }>
    const byId = Object.fromEntries(rewritten[0]!.insert.map((row) => [row.id, row.name]))
    expect(byId['shipped']).toBe('/opt/closed/one.cjs')
    // Untouched: a path resolves beside the profile, a builtin is the Loader's, and a name the
    // manifest does not ship must FAIL rather than be silently skipped.
    expect(byId['relative']).toBe('./mine.mjs')
    expect(byId['builtin']).toBe('cordis:include')
    expect(byId['other']).toBe('@mediabase/log')
    // The original patches are not mutated: the rewrite is a copy.
    expect((patches[0]!.insert[0] as { name: string }).name).toBe('@fake/one')
  })

  it('mounts a row from a manifest entry that is not installed at all', async () => {
    const { dir, manifest } = packaged({ '@not-installed/extra': 'extra.cjs' })
    // The module the manifest points at: a real Cordis plugin, in the shape a shipped
    // closed runtime has (plain JS, no TypeScript, no loader).
    writeFileSync(join(dir, 'extra.cjs'), [
      "exports.name = 'extra'",
      // A capability declares the services it needs; the registry is what it registers into.
      "exports.inject = ['api']",
      'exports.apply = function (ctx) {',
      "  ctx.api.register({ name: 'extra.ping', description: 'pong', handler: () => 'extra-pong' })",
      '}',
      '',
    ].join('\n'))

    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/bundle-app'], IDENTITY)
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), [
      '- insert:',
      '    - id: extra',
      "      name: '@not-installed/extra'",
      '',
    ].join('\n'))

    const host = await bootHost({ MEDIABASE_HOME: home, MEDIABASE_PLUGIN_MANIFEST: manifest })
    try {
      expect(await host.rpc.call('extra.ping', {})).toBe('extra-pong')
      // The boot says which runtime it composed from: "which code is running" is a question
      // a packaged host must be able to answer.
      expect(host.output()).toContain('封闭运行时')
      expect(host.output()).toContain(manifest)
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('fails the boot when the manifest names a module that is not there', async () => {
    const { manifest } = packaged({ '@not-installed/gone': 'missing.cjs' })
    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/bundle-app'], IDENTITY)
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), [
      '- insert:',
      '    - id: gone',
      "      name: '@not-installed/gone'",
      '',
    ].join('\n'))

    const failure = await bootHost({ MEDIABASE_HOME: home, MEDIABASE_PLUGIN_MANIFEST: manifest })
      .then(() => null, (error: unknown) => (error as Error).message)
    // A stale manifest is a broken bundle, not something to paper over with a fallback —
    // and the report names BOTH the specifier the deployment wrote and the file it resolved to.
    expect(failure).toContain('行 "gone": @not-installed/gone →')
    expect(failure).toContain('missing.cjs')
    expect(failure).toContain('重新构建宿主')
  }, 120_000)
})

describe('the composed host exposes the expected composition', () => {
  it('mounts exactly the shipped capabilities, with a working control plane', async () => {
    const host = await bootHost({ MEDIABASE_HOME: tempHome() })
    try {
      // The capability SET is the composition's contract — the same thing the manifest
      // verification checks, and what a client discovers across (`capabilities.list`).
      // Frozen on purpose: dropping a row (or renaming one) must fail here.
      const caps = await host.rpc.call<Array<{ id: string; ok: boolean }>>('capabilities.list', {})
      expect(caps.map((c) => c.id).sort()).toEqual(
        ['agent', 'plugins', 'server', 'settings', 'tools'],
      )

      // Every declaration matches what actually registered.
      const reports = await host.rpc.call<Array<{ id: string; ok: boolean }>>('capabilities.verify', {})
      expect(reports.filter((r) => !r.ok)).toEqual([])

      // One representative method per capability, plus the registries' own: a row that
      // mounted but registered nothing would be invisible to a count.
      const methods = (await host.rpc.call<Array<{ name: string }>>('api.list', {})).map((m) => m.name)
      for (const name of [
        'api.list', 'server.info', 'capabilities.list', 'tools.list', 'settings.list',
        'plugins.list', 'agent.run',
      ]) {
        expect(methods, name).toContain(name)
      }
      expect(methods.length).toBeGreaterThan(10)

      expect(Array.isArray(await host.rpc.call<unknown[]>('tools.list', {}))).toBe(true)
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('creates the profile directory a deployment edits, and reports its layer stack', async () => {
    const home = tempHome()
    const host = await bootHost({ MEDIABASE_HOME: home })
    try {
      for (const file of ['package.json', PROFILE_PATCH_FILENAME, PROFILE_ROOT_FILENAME]) {
        expect(existsSync(join(home, 'profiles', 'web', file)), file).toBe(true)
      }
      // The layer report is the boot's own account of what composed, in order.
      const line = await waitFor(() => host.output().split('\n').find((l) => l.includes('"组合":"patch 层"')) ?? false, 5_000)
      const reported = JSON.parse(line.slice(line.indexOf('{'))) as { layers: number; layerFiles: string[] }
      expect(reported.layers).toBe(reported.layerFiles.length)
      expect(reported.layerFiles[0]).toContain('bundle/app/cordis.patch.yml')
      expect(reported.layerFiles.at(-1)).toContain(join(home, 'profiles', 'web', PROFILE_PATCH_FILENAME))
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('lets a deployment override ONE row by id, without forking the bundle', async () => {
    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/bundle-app'], IDENTITY)
    // The overlay in the profile's OWN layer: same file a deployment edits by hand.
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), [
      '- id: log',
      '  config:',
      '    level: debug',
      '    scope: deployment-scope',
      '',
    ].join('\n'))

    const host = await bootHost({ MEDIABASE_HOME: home })
    try {
      // The overridden scope is what the row's logger actually used, at debug level.
      const line = await waitFor(() => host.output().split('\n').find((l) => l.includes('DEBUG deployment-scope')) ?? false, 5_000)
      expect(line).toContain('DEBUG deployment-scope')
      // Everything else still ran: an override replaces one row's config, not the tree.
      expect(await host.rpc.call('server.info')).toMatchObject({ protocol: 1 })
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('applies the home-level layer AFTER the profile layer, so machine-local wins', async () => {
    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/bundle-app'], IDENTITY)
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), '- id: log\n  config: { scope: from-profile }\n')
    writeFileSync(join(home, HOME_PATCH_FILENAME), '- id: log\n  config: { scope: from-home }\n')

    const host = await bootHost({ MEDIABASE_HOME: home })
    try {
      const line = await waitFor(() => host.output().split('\n').find((l) => l.includes('from-home')) ?? false, 5_000)
      expect(line).toContain('from-home')
      expect(host.output()).not.toContain('from-profile')
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('takes a deployment value from the environment as CONFIG, and refuses what it implies', async () => {
    const home = tempHome()
    // Both values come from the environment, through the row's `!!js ctx.env.*` readers —
    // no capability needs an env path of its own, and the row states what it reads.
    const host = await bootHost({
      MEDIABASE_HOME: home,
      MEDIABASE_READONLY: '1',
    })
    try {
      // The policy the ROW built from the environment is the policy in force.
      const info = await host.rpc.call<{ acl?: Record<string, unknown> }>('server.info', {})
      expect(info.acl).toEqual({ readonly: true })
      // A mutating method is refused by code, from the policy the row built from the env.
      const denied = await expectError(host.rpc, 'settings.set')
      expect(denied.code).toBe(-32021)
      expect(denied.messageKey).toBe('error.acl.readonly')
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('names the row when its module cannot be resolved from the installation', async () => {
    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/bundle-app'], IDENTITY)
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), [
      '- insert:',
      '    - id: ghost',
      "      name: '@mediabase/not-installed'",
      '',
    ].join('\n'))

    // The Loader would report a nameless "loader entries failed to apply"; the pre-flight
    // (the runtime half of scripts/verify-composition.mjs) says WHICH row and what to do.
    const failure = await bootHost({ MEDIABASE_HOME: home })
      .then(() => null, (error: unknown) => (error as Error).message)
    expect(failure).toContain('行 "ghost": @mediabase/not-installed')
    expect(failure).toContain('dependencies')
  }, 120_000)

  it('fails the boot when a patch row loses a required field it must restate', async () => {
    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/bundle-app'], IDENTITY)
    // A patch REPLACES the whole config, so dropping `root` is a misconfiguration the
    // boot must report by row and path — not a capability that quietly never mounts.
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), '- id: server\n  config: { port: 3199 }\n')

    // The message names the ROW and the failing PATH, so the fix is obvious.
    const failure = await bootHost({ MEDIABASE_HOME: home })
      .then(() => null, (error: unknown) => (error as Error).message)
    expect(failure).toContain('loader entry server')
    expect(failure).toContain('$.root missing required value')
  }, 120_000)

  it('resolves a bundle shipped beside the host entry, for an app with no repo to resolve from', () => {
    // The packaged app: no repo, no node_modules, just `<entry dir>/bundles/<name>/`. Same
    // "beside the running entry" rule as the closed plugin runtime, checked directly because
    // on this machine the installation anchor happens to resolve and would hide the fallback.
    const dir = mkdtempSync(join(tmpdir(), 'mediabase-bundles-'))
    made.push(dir)
    // A name that exists NOWHERE but here: with `tsx` in the loop, resolution from a bogus
    // anchor still falls back to the repo's own packages, so a real bundle name would resolve
    // through the installation and never exercise this branch.
    const packaged = join(dir, 'bundles', '@fake', 'bundle-app')
    mkdirSync(packaged, { recursive: true })
    writeFileSync(join(packaged, 'package.json'), JSON.stringify({ name: '@fake/bundle-app', private: true }))
    writeFileSync(join(packaged, PROFILE_PATCH_FILENAME), '- insert: []\n')

    const home = tempHome()
    const profileDir = resolveProfileDir('web', home, IDENTITY.bin)
    initProfile(profileDir, ['@fake/bundle-app'], IDENTITY)

    // A bogus installation anchor: nothing can resolve from it, so the bundles directory wins.
    const profile = loadProfile('web', home, join(dir, 'no-such-anchor', 'package.json'), [join(dir, 'bundles')], IDENTITY)
    expect(profile.bundlePatchPaths).toEqual([join(packaged, PROFILE_PATCH_FILENAME)])

    // ...and with no such directory the failure still names what was tried.
    expect(() => loadProfile('web', home, join(dir, 'no-such-anchor', 'package.json'), [], IDENTITY))
      .toThrow(/无法解析 bundle/)
  }, 60_000)

  it('refuses to boot when a profile names a bundle that cannot be resolved', async () => {
    const home = tempHome()
    const profileDir = join(home, 'profiles', 'web')
    initProfile(profileDir, ['@mediabase/no-such-bundle'], IDENTITY)
    await expect(bootHost({ MEDIABASE_HOME: home })).rejects.toThrow(/无法解析 bundle/)
  }, 120_000)
})
