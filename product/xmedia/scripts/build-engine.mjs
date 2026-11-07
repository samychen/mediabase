// product/xmedia / scripts / build-engine.mjs — build + smoke the C++ sidecar.
//
// The engine is a PRODUCT artifact; the base repo never builds or vendors it.
// This script only forwards deployment-specific paths to the independent CMake
// project in ../engine. Nothing machine-specific is baked in.
//
//   XMEDIA_KIT_DIR=<installed SDK prefix> pnpm run build:xmedia:engine
//   XMEDIA_KIT_SOURCE_DIR=<source tree>  pnpm run build:xmedia:engine
//
// Optional: XMEDIA_FFMPEG_ROOT (custom FFmpeg/libyuv prefix),
//           XMEDIA_DEPS_LIBDIR (dylib directory for the runtime rpath),
//           CMAKE_BUILD_PARALLEL_LEVEL.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_DIR = fileURLToPath(new URL('../engine/', import.meta.url))
const BUILD_DIR = fileURLToPath(new URL('../engine/build/', import.meta.url))
const kitDir = process.env.XMEDIA_KIT_DIR
const kitSource = process.env.XMEDIA_KIT_SOURCE_DIR

if (!kitDir && !kitSource) {
  console.error(`缺少 xmedia-kit 位置。二选一:

  # A) 已安装的 SDK（推荐，秒级）
  cmake --install <xmedia-kit 构建目录> --prefix /path/to/prefix
  XMEDIA_KIT_DIR=/path/to/prefix pnpm run build:xmedia:engine

  # B) 源码树（无需 install，会重建 SDK）
  XMEDIA_KIT_SOURCE_DIR=/path/to/xmedia-kit pnpm run build:xmedia:engine

可选: XMEDIA_FFMPEG_ROOT=<deps prefix>  XMEDIA_DEPS_LIBDIR=<deps prefix>/lib`)
  process.exit(1)
}

// A stale cache from the other consumption mode makes CMake mix find_package()
// and add_subdirectory() in one tree (e.g. an old `xmedia-kit_DIR` survives).
// Drop the build directory whenever the selected seam or its path changes.
const cacheFile = join(BUILD_DIR, 'CMakeCache.txt')
if (existsSync(cacheFile)) {
  const text = readFileSync(cacheFile, 'utf8')
  const cachedValue = (key) => new RegExp(`^${key}:PATH=(.*)$`, 'm').exec(text)?.[1] ?? ''
  const wantDir = kitSource ? '' : (kitDir ?? '')
  const wantSource = kitSource ?? ''
  if (cachedValue('XMEDIA_KIT_DIR') !== wantDir ||
      cachedValue('XMEDIA_KIT_SOURCE_DIR') !== wantSource) {
    console.log('SDK 消费方式已变化，清理旧的 CMake 构建目录…')
    rmSync(BUILD_DIR, { recursive: true, force: true })
  }
}

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const configure = ['-S', ENGINE_DIR, '-B', BUILD_DIR]
if (kitSource) configure.push(`-DXMEDIA_KIT_SOURCE_DIR=${kitSource}`)
else configure.push(`-DXMEDIA_KIT_DIR=${kitDir}`)
if (process.env.XMEDIA_FFMPEG_ROOT) configure.push(`-DXMEDIA_FFMPEG_ROOT=${process.env.XMEDIA_FFMPEG_ROOT}`)
if (process.env.XMEDIA_DEPS_LIBDIR) configure.push(`-DXMEDIA_DEPS_LIBDIR=${process.env.XMEDIA_DEPS_LIBDIR}`)

run('cmake', configure)
run('cmake', ['--build', BUILD_DIR])
run('ctest', ['--test-dir', BUILD_DIR, '--output-on-failure'])
console.log(`\n引擎二进制: ${BUILD_DIR}xmedia-bridge`)
