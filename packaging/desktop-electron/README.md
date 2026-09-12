# desktop-electron — Mode B as a native window(Electron 壳)

> **许可(重要)**:本分发物整体按 **GPL-3.0-or-later**(引擎链接了 FFmpeg + x264),
> 自有代码仍是 MIT。`pnpm run dist` 会先跑 `check-native-licenses.mjs --gate`:
> 待打包产物里若有 `--enable-nonfree`(fdk-aac,按 FFmpeg 条款**不可再分发**)则直接失败。
> 重建步骤、随包必须给出的许可文件与对应源码要求见 **`docs/GPL-COMPLIANCE.zh.md`**。
> 仅本机自用可临时 `AVSTUDIO_ALLOW_NONFREE=1`;不捆绑原生二进制用 `AVSTUDIO_BUNDLE_FFMPEG=0`。

把 Mode B(浏览器里开的那个宿主界面)包成"双击即用的桌面窗口"。**无需 Rust**。
壳极薄:fork 打包好的单文件宿主(`build/host.cjs`)→ 等健康检查 → 开窗口指向
`http://127.0.0.1:3088`;关窗即停宿主。媒体能力仍在 C++ 引擎(进程外)。

## 三步出 .dmg(macOS)

```sh
# 0) 先构建宿主单文件与资源(在仓库根)
pnpm run build:host        # -> build/host.cjs
pnpm run build:engine      # 本机引擎;打包给别人需按目标机重编(见根 README 换机说明)
pnpm run build:web         # -> apps/web/dist

# 1) 安装 Electron 构建工具(本目录独立安装,不进主仓库 node_modules)
cd packaging/desktop-electron
pnpm install

# 2) 出 DMG(未签名;本地双击可用)
pnpm run dist              # 先跑原生产物许可门禁 -> prepare-ffmpeg -> electron-builder
                           # -> release/electron/AVStudio-*.dmg
pnpm run check:native      # 只做许可体检(报告模式),不打包

# 开发态直接跑窗口(指向仓库资源)
pnpm start
```

## 跨平台打包

`pnpm run dist:all`(需在对应 OS 上跑,electron-builder 不跨平台打包):
- Windows:`electron-builder --win` 出 nsis/exe(引擎用 CI 矩阵里的
  `engine-windows-x64` 产物替换 `extraResources` 里那份)
- Linux:`electron-builder --linux` 出 AppImage/deb

引擎三平台二进制由 `.github/workflows/engine-matrix.yml` 产出并上传 artifact;
组装桌面包时把对应 artifact 放进 `extraResources` 的 `engine/` 即可。

## AI 助手 key(双击启动时)

Finder 启动的 App 没有 shell 环境变量。壳启动时读取用户级配置
`~/.avstudio/env`(每行一个,`#` 注释),已有 shell env 优先:

```sh
mkdir -p ~/.avstudio
cat > ~/.avstudio/env <<'EOF'
AVSTUDIO_LLM_KEY=sk-你的key
# AVSTUDIO_LLM_BASE=https://api.deepseek.com/v1
# AVSTUDIO_LLM_MODEL=deepseek-chat
EOF
```

改完需重新 `pnpm run dist` 打包(壳代码进 app)。

## 现状与代价(如实)

- 本目录**尚未在本机执行过 `pnpm install` 与 `dist`**(Electron 二进制下载约
  200MB+,且此前约定先聚焦 Mode B 功能);代码按上述流程写好,首次运行若报错
  把日志发我
- 体积:Chromium 让包到 ~150MB+(相对 Tauri/SEA 大);换来免 Rust + 三平台成熟
  builder
- 分发给别人:未签名会被 Gatekeeper/SmartScreen 拦,需 Developer ID + 公证
  (后话)
- python sidecar 工具需目标机有 python3,缺失时宿主正常、仅 python 面板报错
