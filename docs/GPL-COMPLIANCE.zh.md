# GPL 分发合规说明（基座视角）

> **本仓默认不发原生二进制**：Electron 模板的 `PRODUCT.resources` 为空，app bundle 里只有
> MIT 的自有代码与 npm 依赖，所以**默认分发物整体是 MIT**。
>
> 本文是给**消费仓**（如 avstudio）用的清单：一旦你通过 `PRODUCT.resources` 追加了静态链接
> FFmpeg/x264 的引擎二进制，分发条款就变了。相关工具在本仓，义务在你的仓。

## 为什么 GPL 会蔓延到整个分发包

引擎**静态链接** `libavformat/libavcodec/...`（来自一份 `--enable-gpl` 的 FFmpeg）+ x264 时，
引擎二进制整体受 GPL 约束；它被打进 app bundle，于是**整个分发物按 GPL-3.0-or-later 分发**。
自有代码可以继续 MIT（MIT 与 GPLv3 兼容，因此允许被包含在 GPL 分发物中）。

**但 GPL 也不代表什么都能带**：`--enable-nonfree`（fdk-aac）的 FFmpeg 构建按 FFmpeg 自身说明
**不可再分发**，与 GPL 也冲突。所以"接受 GPL"这条路线**同时要求去掉 nonfree**。

## 本仓现成的工具

| 命令 / 文件 | 行为 |
|---|---|
| `pnpm run check:native` | 报告模式：扫描**消费仓**的引擎二进制与将被打包的 ffmpeg，标出 GPL/nonfree 组件。本仓没有 `engine/`，它会直接说明"基座仓跳过" |
| `pnpm run check:native --gate` | 门禁模式：发现 nonfree → **exit 1**；`MEDIABASE_ALLOW_NONFREE=1` 可临时放行（**仅本机自用，不得对外分发**） |
| `packaging/desktop-electron/scripts/prepare-ffmpeg.mjs` | 待捆绑的 ffmpeg 带 `--enable-nonfree` → **拒绝捆绑并 exit 1**（同样可用 `MEDIABASE_ALLOW_NONFREE=1` 放行） |
| `MEDIABASE_BUNDLE_FFMPEG=0` | 打包时**不捆绑** ffmpeg（走"不发原生二进制"路线），`prepare-ffmpeg.mjs` 会清掉 `vendor-ffmpeg/` |
| `packaging/desktop-electron/GPL-NOTICE.txt` | 随包分发声明**模板**：基座版说明"默认纯 MIT"，并列出追加原生二进制后必须补齐的条目 |
| `packaging/desktop-electron/LICENSE-{MIT,GPL-3.0}.txt` | 两份许可全文，随包进 `licenses/` |

⚠️ **基座的 `pnpm run dist` 只是 `electron-builder --mac dmg`，不跑门禁**。门禁要由**消费仓**的
打包流水线自己串上（先生成引擎 → `check:native --gate` → `prepare-ffmpeg` → 打包），
否则可能打出不可分发的产物。本仓保留这些脚本，是给采用该模板的仓当工具/参考。

## 分发时要一并给出（GPLv3 §4–§6）

1. **GPLv3 全文** —— 模板已提供 `LICENSE-GPL-3.0.txt`，打包时进 `licenses/`。
2. **对应源码（Complete Corresponding Source）** —— 至少包含：
   - 你的产品仓源码（含引擎源码与构建脚本）
   - 构建引擎所用的上游检出（如 MediaComponent）或源码归档
   - 构建引擎所用 FFmpeg 的源码 + 该次 `configure` 参数
   - 能重建同一二进制的构建脚本
   做法：把上述源码放进 `packaging/desktop-electron/sources/`（或挂在下载页），并在
   `extraResources` 里加一条 `{ "from": "sources", "to": "sources" }`。
   接受"书面要约"（§6(b)）也可，但要写清获取方式与有效期 —— 建议直接随包给源码，省事且无期限问题。
3. **修改声明** —— 若你改过 FFmpeg/上游库的源码，需注明改动（GPLv3 §5a）。
4. **NOTICE** —— 第三方归属清单，`pnpm run notice` 生成，打包时进 `licenses/NOTICE.md`。

## 两条路线（消费仓按需选）

**路线 B：不发原生 FFmpeg 代码（最省事，保住 MIT）**
让你的引擎退回"调用用户自己的 ffmpeg"后端（消费仓的构建脚本一般有对应开关，如
`-D…_USE_MEDIACOMPONENT=OFF`），并设 `MEDIABASE_BUNDLE_FFMPEG=0` 打包 —— 结果：
分发包里没有 FFmpeg/上游库代码，`check:native --gate` → exit 0，但用户必须自备 ffmpeg，
且失去进程内解码与流式会话能力。消费仓的文档应当写明这一取舍。

**路线 A：接受 GPL（重建一份去掉 nonfree 的 FFmpeg）**
1. 在上游 FFmpeg 构建里从 configure 参数中**删除 `--enable-nonfree`**（它只带来 libfdk-aac；
   改用 FFmpeg 自带 AAC 编码器），其余保持（含 `--enable-gpl --enable-version3 --enable-libx264`）。
   确认：`<新建的 ffmpeg> -version | grep -o -- '--enable-gpl\|--enable-nonfree'` → 应只看到 `--enable-gpl`。
2. 用新的 FFmpeg 重建上游静态库与引擎，然后 `pnpm run check:native` → 期望"⚠️ GPL(x264) 但无 nonfree"，
   再打包并把上节四项一起给出。

## 仍需消费仓确认的细节

- **上游检出的许可**：构建引擎用的那个上游库（如 MediaComponent）若自身没有 license 文件，
  必须先确认它与 GPL 兼容 —— 否则不能与 GPL 的 FFmpeg 链在一起分发。
- ✅ 已决定：本仓自有代码**保持 MIT**（各包 `license` 字段均为 MIT）—— 目的是让 `@mediabase/*`
  仍能被闭源项目复用；GPLv3 义务由分发包承担，不写进基座。
- 签名 / 公证：与本文无关，属于消费仓的发布流程。
