# 依赖边界（基座视角）

> **产品/引擎相关内容在消费仓（如 avstudio）；本仓为中立基座。**
> 基座自己**不需要任何原生依赖**：没有引擎、没有 ffmpeg、没有 cmake。这张表说的是
> 「基座由什么构成」以及「消费产品会往哪里加东西」。

## 一张图：谁在哪一层

消费产品通常有四个进程/世界，**基座只覆盖 ①②**（宿主 + 浏览器）：

```
浏览器(React)  ──WS/HTTP──  Node 宿主(Cordis 插件树)  ──行协议──  ③ 原生引擎(进程)
    ①纯 JS                      ②纯 JS                          └──④ 分析 sidecar(进程)
```

层次规则（AGENTS.md 第一条）：**逐帧媒体数据只在 ③/④ 里流动，宿主 JS 从不解码**；
帧以字节过数据面（pull / push / 共享内存环），控制面只走命令与状态。

## 速查表：基座自己的依赖

| 依赖 | 在哪一层 | 必需？ | 换掉 / 去掉要动什么 | 许可与分发 |
|---|---|---|---|---|
| **npm 运行时依赖**（14 个：cordis / cordis-plugin-loader / cordis-plugin-include / cosmokit / schemastery / standard-schema / js-yaml / argparse / react / react-dom / scheduler / ws / js-tokens / loose-envify） | ①② | 是 | 见 `NOTICE.md`（`pnpm run notice` 生成） | 全部宽松许可（MIT；`argparse` 为 Python-2.0）→ 分发物整体 MIT |
| **`@deepseek-ai/cordis` 4.0.2**（真实 vendored，非自研替身） | ② | 是 | 插件形状 `name/inject/Config/apply` 就是它定的；换掉等于换框架 | MIT |
| **Electron / electron-builder** | 打包工作区（`packaging/desktop-electron`，非运行时） | 否（只有出安装包时需要） | 删掉不影响 Mode A/B（浏览器访问宿主） | MIT；模板默认不捆绑原生二进制 |
| **原生引擎 / ffmpeg / sidecar** | ③④ | **基座不含** | 由消费仓通过 `PRODUCT.resources` + 自己的包追加 | 由那份二进制决定，消费仓自负其分发义务（见 `docs/LICENSING.zh.md`） |

`scripts/doctor.mjs` 里 `python3 (可选)` 只是提示性的环境探测（消费仓的 sidecar 会用到），
基座自身不调 Python。

## 基座提供的运行时扩展点

| 扩展点 | 怎么装 | 隔离级别 |
|---|---|---|
| 能力包(drop-in) | 把 `*.mjs/cjs/js` 放进 `${prefix}CAPABILITY_DIR`（`@mediabase/boot` 的 `dropins.ts` 发现；yml 路径把它合成一层 insert 行） | 与宿主同进程 |
| 运行时插件 | 目录条目 + `plugins.load`（`${prefix}HELLO` 是随包 demo） | 同进程 + `requires` 最小权限 |
| 沙箱插件 | 目录条目 `isolation: 'process'` | **独立子进程**，只有消息通道（崩溃/卡死受控；不能 `provide` 宿主服务） |
| 受限执行边界 | `@mediabase/confine`：Node 权限模型 + OS 层（Seatbelt / Bubblewrap） | 探针**靠执行**验证；不可用的拒绝**从不**报成 `enforced`；`confinement.required: true` 时 fail closed |

## 环境变量与它们的归属

每个变量由**组合层的那一行**读进配置（`packages/bundle/app/cordis.patch.yml`，用
`!!js ctx.env.str/num/flag/list/choice`），再由**拥有该资源的包**用自己的 `Config` schema 校验。
**前缀由 boot 身份决定**（`packages/host/boot/src/identity.ts`）。由此推出四条规则：

- 行里写的是**短名**：`ctx.env.str('TOKEN')` 解析成 `${prefix}TOKEN`；
- `ctx.env.raw/rawNum` 用于**环境自己的变量**（如 `PORT`，一个套部署只该有一个）；
- `ctx.env.choice(name, allowed)` 用于**拼错不该拦住启动**的旋钮（`LOG_LEVEL` → 未知值回落到 `info`）；
- `${prefix}ENV_PREFIX` 可整体换词表（测试 / 嵌入用），且**不支持两套前缀同时生效**
  （`tests/env-prefix.test.ts` 守着）。

基座默认身份：`bin=mediabase` · 前缀 `MEDIABASE_` · home `~/.mediabase`。消费产品通过
`BootIdentity` 注入自己的名字（如 `AVSTUDIO_` / `~/.avstudio`）——**不是** fork `profile-boot`。

| 变量（短名，前缀由身份决定） | 读它的包 | 作用 |
|---|---|---|
| `PORT`（raw）/ `DIST_INDEX` / `TOKEN` / `READONLY` / `ACL_ALLOW` / `ACL_DENY` / `CROSS_ORIGIN_ISOLATION` | `@mediabase/server`（+ `@mediabase/gateway`） | 监听端口、静态目录、鉴权、方法级 ACL、COOP/COEP（共享内存环前置条件） |
| `HELLO` / `SANDBOX_HELLO` / `SANDBOX_ENTRY` / `PLUGIN_DATA_ROOT` / `SANDBOX_CONFINE_REQUIRED` | `@mediabase/plugins` | 目录条目、沙箱入口、受限插件数据目录根、限制不生效时是否拒绝加载 |
| `LLM_KEY` / `LLM_BASE` / `LLM_MODEL` | `@mediabase/agent` | 模型端点（可被 `ctx.settings` 覆盖） |
| `SETTINGS_FILE` | `@mediabase/settings` | 设置文件路径 |
| `LOG_LEVEL` | **log 行**通过 `ctx.env.choice(...)` 读 | 日志级别；能力本身不读环境 |
| `CAPABILITY_DIR` / `STRICT_CAPABILITIES` / `PLUGIN_MANIFEST` / `HOME` / `ENV_PREFIX` | `@mediabase/boot` 与 `apps/cli` | drop-in 目录、启动门禁（谎报清单即失败）、封闭运行时清单位置、profile home、整体换词表 |
| `BUNDLE_FFMPEG` / `ALLOW_NONFREE` / `FFMPEG` | 打包脚本（`packaging/desktop-electron/scripts/`） | **仅当消费仓要捆绑原生 ffmpeg 时**才相关；基座模板的 `PRODUCT.resources` 为空 |

> 交叉验证：每条都能在行表里查到（`grep -n "ctx.env" packages/bundle/app/cordis.patch.yml`），
> 由 `pnpm run verify:compose` 与 `tests/compose-yml.test.ts` 的"行 = 短名 + reader"用例守住
> （漏一个/多一个/写成产品前缀都会失败）。
> 组合层只负责"根目录 + 装载顺序 + 启动自检 + drop-in"，不认识任何具体资源路径。

## 移交给消费仓的边界

产品在基座之上追加什么、身份怎么注入、`PRODUCT` 块与 bundle/roster 怎么改、哪些性质由
`tests/handoff-neutrality.test.ts` 守着 —— 见 **`docs/HANDOFF.zh.md`**。
产品自己的原生依赖表（引擎 / ffmpeg / sidecar / 原生插件 / brew 库）就写在**消费仓的
`docs/DEPENDENCIES.zh.md`** 里，不回流到本仓。
