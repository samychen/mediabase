// mediabase / scripts / doctor.mjs
//
// Environment & artifact health check. Prints a table and exits non-zero only when a
// HARD requirement is missing.
//
// Two deliberate properties, because this repo doubles as a base to hand over:
//
//   * nothing machine-specific is hardcoded — every path comes from an env var or is
//     derived from the repo root;
//   * the app-specific rows live in ONE clearly marked block at the bottom
//     (`APP CHECKS`). A fork edits that block, not the logic above it.
//
// Run: pnpm doctor

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const APP_NAME = typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : 'app'
const env = process.env
const rows = []

function has(cmd, arg = '--version') {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- neutral checks
rows.push(['Node.js ≥ 20', `ok (${process.versions.node})`, Number(process.versions.node.split('.')[0]) >= 20])
rows.push(['pnpm', has('pnpm') ? 'ok' : 'FAIL (需要 pnpm)', has('pnpm')])
rows.push(['python3 (可选)', has('python3') ? 'ok' : '缺失(可选)', true])

/**
 * A sandbox mechanism is only usable if it can be APPLIED. Mirrors @mediabase/confine's
 * probe (which cannot be imported here: this script runs under plain Node with no
 * TypeScript loader): run the mechanism and keep its own error.
 */
function probeConfinement() {
  const run = (bin, args) => {
    try {
      execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5_000 })
      return null
    } catch (e) {
      const stderr = (e.stderr?.toString() ?? '').trim()
      return stderr.split('\n').filter(Boolean).at(-1)?.replace(/^sandbox-exec:\s*/, '') ?? e.message ?? 'unknown'
    }
  }
  const permission = run(process.execPath, ['--permission', '-e', ''])
  const osMechanism = process.platform === 'darwin'
    ? run('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
    : process.platform === 'linux'
      ? run('bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', process.execPath, '-e', ''])
      : 'no OS mechanism for this platform'
  return { permission, osMechanism }
}

const webDist = join(ROOT, 'apps/web/dist/index.html')
rows.push(['web 构建产物', existsSync(webDist) ? 'ok' : '缺失 (运行 pnpm run build:web)', true])
const confine = probeConfinement()
rows.push([
  '插件子进程限制(node 权限模型)',
  confine.permission === null ? 'ok(文件系统限声明根 · 禁子进程/worker/addon)' : `不可用: ${confine.permission}`,
  true,
])
rows.push([
  '插件子进程限制(OS 层:网络禁止)',
  confine.osMechanism === null
    ? `ok(${process.platform === 'darwin' ? 'Seatbelt' : 'Bubblewrap'})`
    : `不可用,网络限制将如实上报为未生效: ${confine.osMechanism}`,
  true,
])

/** The browser the real-browser e2e suite would use. Discovery only — never launched. */
function findBrowser() {
  const fromEnv = env['MEDIABASE_CHROME']
  if (fromEnv !== undefined && fromEnv !== '') return existsSync(fromEnv) ? fromEnv : null
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((p) => existsSync(p)) ?? null
}

const browser = findBrowser()
rows.push([
  '真实浏览器测试(可选)',
  env['MEDIABASE_NO_BROWSER'] === '1'
    ? '已用 MEDIABASE_NO_BROWSER=1 关闭(测试会跳过并说明)'
    : browser === null
      ? '未找到 Chrome/Chromium(test:browser 会跳过并说明;MEDIABASE_CHROME 可指定)'
      : `找到 ${browser}(外层沙箱挡住 Chrome 自身沙箱时用 MEDIABASE_CHROME_ARGS=--no-sandbox)`,
  true,
])

const hostBundle = join(ROOT, 'build/host.cjs')
rows.push(['宿主单文件(打包用)', existsSync(hostBundle) ? 'ok' : '缺失 (运行 pnpm run build:host)', true])

// The bundle alone is not enough: it composes from a profile, so it needs the CLOSED
// RUNTIME the build emits beside it (bare specifier → bundled module). Reported separately
// because "host.cjs exists" and "host.cjs can actually compose without node_modules" are
// different facts, and only the second one survives being copied to another machine.
const pluginManifest = join(ROOT, 'build/plugins.json')
if (!existsSync(hostBundle)) {
  rows.push(['宿主封闭运行时', '未构建 (运行 pnpm run build:host)', true])
} else if (!existsSync(pluginManifest)) {
  rows.push(['宿主封闭运行时', '缺失 plugins.json —— 重新运行 pnpm run build:host', false])
} else {
  const manifest = JSON.parse(readFileSync(pluginManifest, 'utf8'))
  const count = Object.keys(manifest.plugins ?? {}).length
  const missing = Object.values(manifest.plugins ?? {})
    .filter((file) => !existsSync(join(ROOT, 'build', file)))
  rows.push([
    '宿主封闭运行时',
    missing.length === 0
      ? `ok(${count} 个模块,可整目录拷走:node build/host.cjs)`
      : `清单里的 ${missing.length} 个模块不存在,重新构建`,
    missing.length === 0,
  ])
}

// ------------------------------------------------- APP CHECKS: a fork edits this block
const llmKey = env['MEDIABASE_LLM_KEY']
rows.push(['AI 助手 key (MEDIABASE_LLM_KEY)', llmKey ? 'ok' : '未配置(AI 助手会报错,agent 其余测试仍用 mock)', true])

// The composition is DATA now, so its mistakes are checked by running the same gate CI
// runs: a row naming a package the app does not depend on, a `!!js` where the Loader never
// looks, a patch whose id no layer declares. Hard requirement: the shipped layer is ours.
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify-composition.mjs')], { encoding: 'utf8' })
  rows.push(['组合层门禁 (pnpm run verify:compose)', out.trim().replace(/^verify-composition: /, ''), true])
} catch (e) {
  const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(1).join(' | ')
  rows.push(['组合层门禁 (pnpm run verify:compose)', `失败: ${detail || '见 pnpm run verify:compose'}`, false])
}

// ------------------------------------------------------------------------- output
const width = Math.max(...rows.map(([label]) => label.length))
console.log(`\n${APP_NAME} — 环境检查\n`)
for (const [label, message, ok] of rows) {
  const mark = ok === false ? '✗' : message.startsWith('⚠️') ? '!' : '✓'
  console.log(`${mark} ${label.padEnd(width)}  ${message}`)
}

console.log('说明:本脚本不含机器相关硬编码 —— 路径来自环境变量或仓库根。')

const failed = rows.filter(([, , ok]) => ok === false)
if (failed.length > 0) {
  console.error(`\ndoctor: ${failed.length} 项硬性要求未满足:${failed.map(([l]) => l).join(', ')}`)
  process.exit(1)
}
console.log('\ndoctor: 环境就绪。')
