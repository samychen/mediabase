# AVStudio 打包与安装(中文)

> 先给结论,别被"打包"二字误导:
> **当前交付形态 = 源码 + 工具链**(Mode B),不是一键安装器。
> 真正"双击安装"的桌面安装包依赖 Mode A(Tauri)或 Node 打包(sea/pkg),
> 那两块仍是脚手架/未立项(见 `desktop/README.zh.md`)。本文把**现在能用的**
> 打包/部署方式写清楚。

## 0. 交付物构成(打包里有什么)

| 产物 | 位置 | 说明 |
|---|---|---|
| C++ 媒体引擎 | `engine/bin/engine` | 链接了 MediaComponent(进程内解码),**本机/同架构可用**;换机需重编或走 OFF 回退 |
| 原生示例插件 | `engine/bin/plugins/checker.{dylib,so}` | 平台相关 |
| Web 前端 | `apps/web/dist/` | Vite 产物,由宿主静态伺服 |
| Node 宿主源码 | `apps/cli/` + `packages/` | tsx 直跑 TypeScript |
| Python sidecar | `python/sidecar/` | 独立进程工具 |
| 依赖锁 | `pnpm-lock.yaml` / 各 `package.json` | 目标机据此 `pnpm install` |

## 1. 方式 A:新机器源码部署(推荐,跨平台)

1. **目标机准备**:`node ≥ 20` + `pnpm` + C++ 编译器(g++/cc)+ `python3`
   + `ffmpeg`(可用 `AVSTUDIO_FFMPEG` 指定路径);`cmake` 可选。
2. 得到源码(二选一):
   - git 克隆/拷贝仓库(排除 `node_modules`/`.git`);
   - 或解压发行包(见 §3)。
3. 安装与体检:
   ```sh
   pnpm install
   pnpm doctor          # 缺什么它会直接告诉你
   ```
4. **重新适配本机工具链(关键)**:
   ```sh
   pnpm run build:engine   # 本机重编;无 MediaComponent 会自动走 ffmpeg CLI 回退
   pnpm run build:web
   ```
5. 运行:
   ```sh
   pnpm run host        # http://127.0.0.1:3088,浏览器打开
   PORT=3090 pnpm run host   # 换端口
   ```
6. 可选功能配置(env):
   `AVSTUDIO_LLM_BASE/KEY/MODEL`(AI 助手)· `AVSTUDIO_FFMPEG` ·
   `AVSTUDIO_SAMPLES_DIRS`(媒体扫描目录,冒号分隔)。
   有 MediaComponent 检出时,重编前设 `-DMEDIACOMPONENT_ROOT=...`(engine 构建)。

> ⚠️ **引擎二进制与平台强相关**:本机构建的 `engine/bin/engine` 链接了
> MediaComponent 与本机 brew/系统库,**不要把二进制直接拷去另一台机器**;
> 换机一律 §1 第 4 步重编(没 MediaComponent 就自动 CLI 回退,一样能跑)。

## 2. 方式 B:同机多实例 / 局域网使用

- 每实例一个端口:改 `PORT` 再起一个 host;各自浏览器访问对应端口。
- 只监听 `127.0.0.1`,不出本机;要开放局域网请自担风险(把 `HOST`/监听地址改
  `0.0.0.0` 需要改代码,未提供配置)。

## 3. 打一个"源码发行包"(现成脚本)

把构建产物与源码一起归档,便于拷到另一台开发机(省去重新 clone):

```sh
pnpm run package
# 产物: release/avstudio-src-<version>.tar.gz(约几十 MB,不含 node_modules/.git)
```

目标机解压 → 走 §1 第 3–6 步即可。

## 4. 桌面窗口打包(跨平台,免 Rust)

打包链路已就位,分四块:

0. **打包出来的东西长什么样(实测)**:`release/electron/mac-arm64/AVStudio.app`(约 257MB,
   Electron 33 + arm64)的 `Contents/Resources/` 下是:`host/host.cjs`(宿主单文件)+
   `host/plugins.json` + `host/plugins/*.cjs` + `host/node_modules/@mediabase/rpc`(封闭运行时)
   + `host/bundles/@avstudio/bundle-app/`(宿主行表那一层,目标机没有仓库也能组合)
   + `engine/`、`web/`、`python/`、`sandbox/`、`examples/`、`licenses/`,以及可选的 `ffmpeg/`。
   实测:直接 `node Resources/host/host.cjs`(env 指向 Resources 内的各路径)能组合并跑过
   `verify:base` + `verify`;Electron 壳用 `AVSTUDIO_SMOKE=1` 能跑到 `[electron] smoke ok`。
   把安装锚点指到一个**不存在的路径**(模拟目标机没有仓库)后,宿主仍能从
   `host/bundles/` + `host/plugins.json` 组合并跑过 `verify:base`。

1. **宿主单文件 + 封闭运行时**:`pnpm run build:host` →
   `build/host.cjs` + `build/plugins.json` + `build/plugins/*.cjs`
   (+ `build/node_modules/@mediabase/rpc`,见下),运行时资源路径走 `AVSTUDIO_*` env。
   宿主是按"行 = 模块名"组合的,单文件产物旁边没有 `node_modules` 可解析,
   所以构建会把 bundle 层里每个裸包名各自打成 `build/plugins/<slug>.cjs` 并写进
   `plugins.json`;宿主启动时优先读这个清单,把行挂到打包好的文件上。
   实测:把这一坨(约 850KB)整目录拷到 `/tmp` 用**纯 node** 启动,能力树照常组合
   (`api 37 / tools 6 / 8 manifest`),`verify:base` 与 `verify` 全通过。
   唯一的共享单例是 `@mediabase/rpc`:网关的 `makeServer` 用 `instanceof RpcError`
   区分"能力自己抛的带码错误"和"内部错误",两份副本会把 `-32001/-32602` 变成
   `-32603` 并丢掉 `messageKey`(构建脚本里的 `SHARED_MODULES` 记录了这条)。
2. **Electron 壳**:`packaging/desktop-electron/` —— fork 宿主单文件 → 健康检查
   → 开窗口;`extraResources` 把引擎/web/python/插件打进 Resources。
   出包:`cd packaging/desktop-electron && pnpm install && pnpm run dist`(mac
   DMG;win/linux 用 `--win/--linux`)。
   ✅ **已在本机实测(`--dir` 目标)**:`.app` 组装成功、包内宿主与 Electron 壳都跑通(见上)。
   ⚠️ **DMG 那一步在本机(DSH 沙箱内)跑不了**:`hdiutil create` 对*任何*镜像都返回
   `hdiutil: create failed - 目录非空`(三种调用方式都一样,是沙箱不给出 hdiutil 需要的设备
   访问,不是工程问题)。所以沙箱/CI 用 `pnpm run dist:dir`,DMG 请在**普通终端会话**里跑
   `pnpm run dist`。另外 `release/electron/` 里那个 9 月 9 日的 `AVStudio-0.1.0-arm64.dmg`
   是迁移前的旧产物,不要当成当前构建。
3. **引擎三平台矩阵**:`.github/workflows/engine-matrix.yml` 在 mac/win/linux
   各编一份引擎+插件(无 MediaComponent 自动回退),产物上传 artifact;桌面包
   组装时按平台选对应 artifact 放进 `extraResources/engine/`。
4. **分发给他人**:未签名会被 Gatekeeper/SmartScreen 拦——需要 Developer ID +
   公证(mac)与代码签名(win),以及 MediaComponent 许可清单(静态 ffmpeg/x264/
   fdk-aac/openssl 等各自 License)。

> 代价提示:Electron 自带 Chromium,包体 ~150MB+;若日后可接受 Rust,Tauri 的
> sidecar 机制对"每平台引擎二进制"更顺手(体积也小),二选一即可。

## 5. 还差什么才有一键安装器(如实)

| 方案 | 状态 | 说明 |
|---|---|---|
| **Mode A(Tauri)** | 脚手架,未编译 | 装 Rust 后 `cargo tauri dev` 出窗口;要安装包还需**把 Node+仓库打成 sidecar**、应用图标、签名公证(详见 `desktop/README.md` Notes) |
| **Node SEA/单文件** | 未做 | 把 host 打成单可执行需先做一次 esbuild 打包(把 tsx/workspace 依赖合入),未立项 |
| **安装包/更新通道/签名** | 未做 | 与 CI/打包流程一起做更合适(本仓库不发布任何包) |

## 5. 常见安装期问题

- **端口 3088 被占**:旧宿主没退;`lsof -ti tcp:3088 | xargs kill -INT`,或换 `PORT`。
- **AI 助手报"未配置 key"**:启动日志应显示 `key=已配置`;env 一定要和
  `pnpm run host` 同一命令行或先 `export`。
- **解码报错**:先 `pnpm doctor` 确认 ffmpeg;换机忘重编引擎会得到
  "dlopen/mach-o"类错误——回 §1 第 4 步。
- **想卸载**:本工程无系统级安装,删除目录即卸载;`localStorage` 里仅存面板
  偏好。
