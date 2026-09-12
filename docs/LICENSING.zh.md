# 许可证与分发合规

> **产品/引擎相关内容已迁至消费仓(如 avstudio);本仓为中立基座。**
> 本文只讲**基座自己**的许可与默认分发物;消费仓追加原生二进制后的义务见下节清单,
> 由该产品自行落实。

## 结论速览

| 部分 | 许可 | 能不能随安装包分发 |
|---|---|---|
| 本仓库自有代码(`@mediabase/*` + apps + scripts;无 engine) | **MIT**(根目录 `LICENSE`) | ✅ 可以 |
| npm 运行时依赖(14 个,见 `NOTICE.md`:cordis / cordis-plugin-loader / cordis-plugin-include / cosmokit / schemastery / standard-schema / js-yaml / argparse / react / react-dom / scheduler / ws / js-tokens / loose-envify) | 全部宽松许可:**MIT**(`argparse` 为 Python-2.0)(`pnpm licenses list --prod` 实测) | ✅ 可以 |
| 原生二进制(引擎 / ffmpeg) | — | ⬜ **基座默认不含**:`packaging/desktop-electron` 的 `PRODUCT.resources` 为空,不捆绑任何原生文件 |

所以:**默认构建出来的分发物整体就是 MIT**。风险只在消费产品往 app bundle 里追加
原生二进制之后出现,那时分发条款由那份二进制决定。

## 消费产品追加原生二进制时的义务(清单)

设你的引擎静态链接了 GPL 组件(FFmpeg + x264),则:

- **整个分发物按 GPL-3.0-or-later 分发**,自有代码可以继续 MIT(GPLv3 兼容),但随包要带
  GPL 全文、MIT 全文、分发声明与第三方 NOTICE(`packaging/desktop-electron/licenses/`);
- **不得**包含 `--enable-nonfree` 的 FFmpeg(fdk-aac 不可再分发):打包前用
  `pnpm run check:native --gate` 拦一道,`prepare-ffmpeg.mjs` 也会拒绝捆绑这种 ffmpeg;
- GPLv3 的**对应源码**义务:向接收者提供源码或书面要约(引擎源码、该次 FFmpeg 构建的
  `configure` 参数、能重建同一二进制的构建脚本);
- 具体两步操作(重建 FFmpeg、重建引擎)与"分发时要给什么"见 **`docs/GPL-COMPLIANCE.zh.md`**。

不需要 GPL 的路线(留档,消费仓按需选):

1. **不发原生二进制(最省事,保住 MIT)** —— 引擎退回调用**用户自己安装的** ffmpeg,
   同时不要跑 `prepare-ffmpeg.mjs`;代价:用户自备 ffmpeg,失去进程内解码与流式会话能力。
2. **自己出一份 LGPL 构建再分发** —— 去掉 `--enable-nonfree`(改用原生 AAC 编码器)与
   `--enable-gpl`(去掉 x264/x265,用 libvpx/AV1/VideoToolbox),再满足 LGPL 义务
   (动态链接或提供可重链接对象、附许可全文与源码获取方式)。工作量大,但可以随包分发。

## 工具(都在仓库里,可复现)

| 命令 / 文件 | 作用 |
|---|---|
| `pnpm run notice` → `NOTICE.md` | 生成第三方归属清单:npm 运行时依赖取自 `pnpm licenses list --prod --json`(锁文件为准);基座没有原生条目,如果将来有了,这一节按**逐个读本机 license 文件核实**的规则补,确知不了就明说,不编 SPDX |
| `pnpm run check:native` | 扫描 app bundle / 引擎产物里有没有 nonfree 的 ffmpeg(加 `--gate` 时命中即退出码 1),给消费仓的打包流水线当门禁用 |
| `MEDIABASE_BUNDLE_FFMPEG=0` | 打包时**不捆绑** ffmpeg(走上面路线 1),`prepare-ffmpeg.mjs` 会清掉 `vendor-ffmpeg/` 并说明运行时靠用户自带 |
| `prepare-ffmpeg.mjs` | 默认捆绑,但会读源 ffmpeg 的构建参数并在带 GPL/nonfree 时告警;`MEDIABASE_FFMPEG` 可指定要打包的那份 |
| `packaging/desktop-electron/GPL-NOTICE.txt` | 随包的分发声明**模板**:基座版说明"默认纯 MIT",并列出追加原生二进制后必须补齐的条目 |

## 现状与待办

- ✅ 根 `LICENSE` = MIT;各自有包 `license: MIT`;`@mediabase/*` 打出的 tarball 里**带 LICENSE 正文**
  (由 `scripts/build-base.mjs` 拷贝,`tests/base-packaging.test.ts` 断言;注意:本仓库
  **不发布** —— 所有包 `private: true`,`pnpm publish` 会被拒绝)。
- ✅ **第三方归属清单已生成**:`NOTICE.md`(npm 运行时依赖全 MIT;基座不含原生二进制,
  因此没有 glog/FFmpeg 之类的条目)。
- ✅ 默认 Electron 模板**不带引擎**、不捆绑 ffmpeg,分发物保持 MIT。
- ⬜ **不属于本仓**:MediaComponent 自身许可确认、各平台 ffmpeg 构建参数、签名/公证 ——
  这些随消费仓的原生二进制一起处理。
- ✅ 已决定:**自有代码保持 MIT**(不改为 GPL)。理由不只是"合法":`@mediabase/*` 的目标是
  **被别人复用**,GPL 的基座包会被闭源项目直接排除;源码 MIT + 消费产品自行决定其组装物的
  分发条款,既保住基座可采纳性,也不替消费产品做许可决定。
