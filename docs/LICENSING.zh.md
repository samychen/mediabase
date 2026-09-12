# 许可证与分发合规

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**

## 结论速览

| 部分 | 许可 | 能不能随安装包分发 |
|---|---|---|
| 本仓库自有代码（`@mediabase/*` + apps + 脚本；无 engine） | **MIT**(根目录 `LICENSE`) | ✅ 可以 |
| npm 运行时依赖(cordis / cosmokit / schemastery / react / react-dom / scheduler / ws / js-tokens / loose-envify / standard-schema) | **全部 MIT**(`pnpm licenses list --prod` 实测) | ✅ 可以 |
| **FFmpeg**(引擎静态链接 + 打包脚本会拷进 app bundle) | 取决于**那份 FFmpeg 的构建参数** | ⚠️ **当前这份不行** —— 见下 |
| MediaComponent(本机检出 `/Users/chensi/develop/MediaComponent`) | 以该仓库自身许可为准(此仓库未声明 license 文件) | 视其许可而定 |

## FFmpeg 的问题(实测证据,不是猜测)

本机 MediaComponent 自带的 FFmpeg 构建参数:

```
ffmpeg version 297bf5c4-macOS_build
configuration: ... --enable-gpl --enable-version3 --enable-nonfree
               --enable-libx264 --enable-libfdk-aac --enable-libvpx --enable-libopus ...
```

两个标志各自都改变了分发条件:

- `--enable-gpl`(配合 `--enable-libx264`)→ 该二进制整体按 **GPL** 分发,链接它的程序也要满足 GPL。
  而 `AVSTUDIO_USE_MEDIACOMPONENT=ON`(默认)时,`engine/CMakeLists.txt` 正是把这些
  `avformat/avcodec/avutil/swscale/...` **静态链接**进引擎二进制。
- `--enable-nonfree`(配合 `--enable-libfdk-aac`)→ 按 FFmpeg 自己的说法,这种构建
  **不可再分发**(unredistributable),与 GPL 也冲突。`packaging/desktop-electron/scripts/prepare-ffmpeg.mjs`
  默认会把这份 `ffmpeg` 拷进 app bundle,所以**现在跑 `pnpm run dist` 出来的 DMG 里带着它**。

**自有代码是 MIT 这一点没问题;有问题的是随包分发的原生二进制。**

## 已选择的路线:**3 —— 整体按 GPL 分发**

自有代码保持 MIT(GPLv3 兼容),而**分发包整体按 GPL-3.0-or-later** 分发(引擎静态链接
FFmpeg + x264)。这条路线**同时要求去掉 `--enable-nonfree`**(fdk-aac 不可再分发),因此:

- `pnpm run check:native --gate` 会在打包前拒绝含 nonfree 的产物(`pnpm run dist` 已内置该门禁);
- `prepare-ffmpeg.mjs` 拒绝捆绑 nonfree 的 ffmpeg;
- 随包带上 GPLv3 全文、MIT 全文、分发声明与第三方 NOTICE(`licenses/` 目录);
- 具体两步操作(重建 FFmpeg、重建引擎)与"分发时要给什么"见 **`docs/GPL-COMPLIANCE.zh.md`**。

## 三条可选路线(当初的取舍,留档)

1. **不发原生二进制(最省事,保住 MIT)**
   ```sh
   bash engine/build.sh -DAVSTUDIO_USE_MEDIACOMPONENT=OFF   # 引擎退回 ffmpeg CLI 后端
   ```
   引擎不再链接任何 FFmpeg 代码,改为调用**用户自己安装的** ffmpeg;
   同时**不要**跑 `prepare-ffmpeg.mjs`(或设 `AVSTUDIO_FFMPEG` 指向系统 ffmpeg 而不打包)。
   代价:用户必须自备 ffmpeg;失去 MediaComponent 的进程内解码与流式会话能力。
2. **自己出一份 LGPL 构建再分发**
   去掉 `--enable-nonfree`(改用原生 AAC 编码器)与 `--enable-gpl`(去掉 x264/x265,
   用 libvpx/AV1/VideoToolbox),得到 LGPL 构建;再满足 LGPL 义务(动态链接或提供可重链接对象、
   附许可全文与源码获取方式)。工作量大,但可以随包分发。
3. **整个应用接受 GPL**
   仍**必须**去掉 `--enable-nonfree`(fdk-aac),否则不可再分发;然后应用整体按 GPL 分发,
   与本仓库的 MIT 不冲突(可继续 MIT + GPL 二进制组合,但分发条款按 GPL 走)。

## 工具(都在仓库里,可复现)

| 命令 / 文件 | 作用 |
|---|---|
| `pnpm run notice` → `NOTICE.md` | 生成第三方归属清单:npm 运行时依赖取自 `pnpm licenses list --prod --json`(锁文件为准),原生条目**逐个读本机 license 文件核实**,FFmpeg 那一族明说"本机无法确知许可"而不是编一个 SPDX |
| `pnpm doctor` | 环境检查里加两条**分发相关**提示:当前 ffmpeg 的 `--enable-gpl`/`--enable-nonfree` 标志;引擎是否以 `AVSTUDIO_USE_MEDIACOMPONENT=ON` 构建(即二进制里是否含 FFmpeg/x264/fdk-aac) |
| `AVSTUDIO_BUNDLE_FFMPEG=0` | 打包时**不捆绑** ffmpeg(走路线 1),`prepare-ffmpeg.mjs` 会清掉 `vendor-ffmpeg/` 并说明运行时靠用户自带 |
| `prepare-ffmpeg.mjs` | 默认捆绑,但会读源 ffmpeg 的构建参数并在带 GPL/nonfree 时告警 |

## 现状与待办

- ✅ 根 `LICENSE` = MIT;26 个自有包 `license: MIT`;`@mediabase/*` 打出的 tarball 里**带 LICENSE 正文**
  (由 `scripts/build-base.mjs` 拷贝,`tests/base-packaging.test.ts` 断言;注意:本仓库
  **不发布** —— 所有包 `private: true`,`pnpm publish` 会被拒绝)。
- ✅ **第三方归属清单已生成**:`NOTICE.md`(10 个 npm 运行时依赖全 MIT;glog/gflags BSD-3、
  jsoncpp MIT、cJSON MIT、SDL2 Zlib、lz4 BSD-2(lib/)等逐项附本机 license 文件路径)。
- ✅ 引擎与 ffmpeg 的许可风险在 `pnpm doctor` 里可见;打包可一键不捆绑原生二进制。
- ⬜ **未做**:MediaComponent 自身许可确认(其检出里没有 license 文件;GPL 链要求它许可兼容);
  macOS 之外平台的等价清单(win/linux 的 ffmpeg 构建参数可能不同);签名/公证。
- ✅ 已决定:**自有代码保持 MIT**(不改为 GPL)。理由不只是"合法":`@mediabase/*` 的目标是
  **被别人复用**,GPL 的基座包会被闭源项目直接排除;源码 MIT + 组装后的应用 GPLv3 既保住
  基座可采纳性,也满足分发包的 GPL 义务。
