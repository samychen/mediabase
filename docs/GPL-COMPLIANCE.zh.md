# GPL 分发合规说明

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

消费仓若链接 FFmpeg/x264，可能选择 **整体按 GPL 分发**(引擎静态链接 FFmpeg + x264 ⇒ 整个分发包受 GPL 约束),
自有代码仍为 MIT(见 `LICENSE`;MIT 与 GPLv3 兼容,可包含在 GPL 分发物中)。

**但 GPL 不代表什么都能带**:`--enable-nonfree`(fdk-aac)的 FFmpeg 构建按 FFmpeg 自身
说明**不可再分发**,所以这条路线**同时要求去掉 nonfree**。当前本机引擎二进制里确实含有它
(实测:`strings engine/bin/engine | grep -i fdk` → `Fraunhofer FDK AAC` / `libfdk_aac`)。

## 现在的门禁(已生效)

| 位置 | 行为 |
|---|---|
| `pnpm run check:native` | 报告模式:扫描引擎二进制与将被打包的 ffmpeg,标出 GPL/nonfree 组件 |
| `pnpm run check:native --gate` | 门禁模式:发现 nonfree → **exit 1**;`AVSTUDIO_ALLOW_NONFREE=1` 可临时放行(仅本机自用) |
| `packaging/desktop-electron` 的 `pnpm run dist` | 已改为先跑 `check-native-licenses.mjs --gate`,再 `prepare-ffmpeg.mjs`,最后 `electron-builder` |
| `prepare-ffmpeg.mjs` | 待捆绑的 ffmpeg 带 `--enable-nonfree` → **拒绝捆绑并 exit 1**(同样可用 `AVSTUDIO_ALLOW_NONFREE=1` 放行) |
| 随包文件 | `licenses/LICENSE-GPL-3.0.txt`(GPLv3 全文,674 行)、`licenses/LICENSE-MIT.txt`、`licenses/GPL-NOTICE.txt`(分发声明 + 对应源码说明)、`licenses/NOTICE.md`(第三方清单) |

实测:`node scripts/check-native-licenses.mjs --gate` → exit 1;`AVSTUDIO_ALLOW_NONFREE=1 …` → exit 0;
`AVSTUDIO_FFMPEG=<nonfree ffmpeg> node prepare-ffmpeg.mjs` → 拒绝(exit 1)。

## 路线 B(不发原生 FFmpeg 代码)——**已实测通过**

除了重建 FFmpeg,还有一条同样合规、而且不需要动 MediaComponent 检出的路:

```sh
# 1) 引擎不静态链接 FFmpeg(走 ffmpeg CLI 回退;这也是 CI 的构建方式)
bash engine/build.sh -DAVSTUDIO_USE_MEDIACOMPONENT=OFF
# 2) 不把 ffmpeg 打进分发包(运行时用目标机自己的 ffmpeg)
AVSTUDIO_BUNDLE_FFMPEG=0 node scripts/check-native-licenses.mjs --gate     # → exit 0
# 3) 打包(沙箱/CI 用 dir 目标;DMG 需要正常会话,见 docs/INSTALL.zh.md)
cd packaging/desktop-electron && AVSTUDIO_BUNDLE_FFMPEG=0 pnpm run dist:dir
```

实测(本机,macOS arm64):

| 检查 | 结果 |
|---|---|
| `strings engine/bin/engine` 找 `fdk-aac/x264` | 无(二进制 66KB,对比静态链接版 32MB) |
| `node scripts/check-native-licenses.mjs --gate` | 引擎 ✅、ffmpeg 不随包分发 → **exit 0** |
| 该引擎起宿主 + `verify:base` / `verify` | 全通过(`backend: ffmpeg CLI(回退)`, `caps: {mediacomponent:false,…}`) |
| 打出的 `AVStudio.app` 的 `Resources/` | 无 `ffmpeg/` 目录;`host/` 自带封闭运行时(`plugins.json` + `plugins/` + `node_modules/@mediabase/rpc` + `bundles/@avstudio/bundle-app/`) |
| 直接跑包内宿主(`node Resources/host/host.cjs`,以 Resources 路径为 env) | 组合成功 + `verify:base` / `verify` 全通过 |
| Electron 壳 `AVSTUDIO_SMOKE=1` | `[electron] host ready` → `[electron] smoke ok`,SIGINT 干净退出 |

门禁对这条路线的支持也已修正:`AVSTUDIO_BUNDLE_FFMPEG=0` 时不再去扫描/拦截一个"根本不会
随包"的 ffmpeg(此前会拦住它自己推荐的这条路线),报告里改为明确写"不随包分发"。

`dist` 仍会先跑 `--gate`:所以哪条路线的产物能被 `dist` 出来,就是可分发的那一份;当前本机
默认引擎(静态 FFmpeg + fdk-aac)只会被 `AVSTUDIO_ALLOW_NONFREE=1` 放行,那仅限自用。

## 路线 A(重建 FFmpeg)的两步(一次性)

### 1. 重建 FFmpeg,去掉 `--enable-nonfree`

在 MediaComponent 的 FFmpeg 构建里,从 configure 参数中**删除 `--enable-nonfree`**
(它只带来 libfdk-aac;改用 FFmpeg 自带 AAC 编码器即可),其余保持(含 `--enable-gpl
--enable-version3 --enable-libx264`,这正是"接受 GPL"的路线)。改完重跑那份构建脚本,
确认:

```sh
<新建的 ffmpeg> -version | grep -o -- '--enable-gpl\|--enable-nonfree'
# 期望:只看到 --enable-gpl
```

### 2. 用新的 FFmpeg 重建库与引擎

```sh
# 在 MediaComponent 检出里重建(它会带上新的 FFmpeg 静态库)
#   然后在本仓:
bash engine/build.sh                       # 复用 MediaComponent 的 libcomposesdk.a
pnpm run check:native                      # 期望:⚠️ GPL(x264)但不再有 nonfree
pnpm run build:web && pnpm run build:host
cd packaging/desktop-electron && pnpm run dist
```

`pnpm run dist` 现在会在有任何 nonfree 组件时直接失败,所以**不会再打出不可分发的 DMG**。

## 分发时要一并给出(GPLv3 §4–§6)

1. **GPLv3 全文** —— 已随包(`licenses/LICENSE-GPL-3.0.txt`)。
2. **对应源码(Complete Corresponding Source)** —— 至少包含:
   - 本仓源码(含 `engine/` 与构建脚本)
   - 构建引擎所用的 MediaComponent 检出
   - 构建引擎所用 FFmpeg 的源码 + 该次 `configure` 参数
   - 能重建同一二进制的构建脚本
   做法:把上述源码放进 `packaging/desktop-electron/sources/`(或挂在下载页),并在
   `extraResources` 里加一条 `{ "from": "sources", "to": "sources" }`。
   接受"书面要约"(§6(b))也可,但要写清获取方式与有效期 —— 建议直接随包给源码,省事且无期限问题。
3. **修改声明** —— 若你改过 FFmpeg/MediaComponent 的源码,需注明改动(GPLv3 §5a)。
4. **NOTICE** —— 第三方归属清单,已随包(`licenses/NOTICE.md`,`pnpm run notice` 生成)。

## 仍需你确认的细节

- MediaComponent 检出里没有 license 文件:它若**不是** GPL 兼容许可,就不能与 GPL 的 FFmpeg
  链在一起分发 —— 需要先跟它的维护者确认(见 `docs/LICENSING.zh.md`)。
- ✅ 已决定:自有代码**保持 MIT**(26 个包的 `license` 字段均为 MIT)—— 目的是让
  `@mediabase/*` 仍能被闭源项目复用;GPLv3 义务由分发包承担(见上)。
- 签名/公证:与本路线无关,仍未做。
