# 拿这套当基座:交付清单(handoff)

这套代码的定位是"**可复用的基座 + 一个可用它做出来的示例产品**"。这份清单说的是:
**哪些是基座(不动)、哪些是产品(要改)、改的时候按什么顺序、以及哪些属性有测试守着。**

配套阅读:`docs/DEPENDENCIES.zh.md`(依赖在哪一层)、`docs/FRAMEWORK.zh.md`(架构取舍)。

---

## 一、分层:什么是基座、什么是产品

| | 包 | 换产品时要动吗 |
|---|---|---|
| **组合层** | `packages/bundle/app/cordis.patch.yml`(宿主行表)+ `apps/cli/src/profile-boot.ts`(profile/bundle/patch 机制),profile 落在 `$AVSTUDIO_HOME/profiles/<name>/`;改一行用 `--patch` 或 profile 自己的 `cordis.patch.yml`,不必改代码 |
| **中立基座** | `@mediabase/rpc` · `schema` · `log` · `protocol` · `engine-client` · `gateway` · `confine`(子进程权限限制,含 OS 层探测) · `shm`(共享内存帧环) | ❌ 不动 |
| **可复用能力** | `@mediabase/api`(控制面注册表 + 能力清单) · `server`(门面/握手/ACL) · `tools`(工具注册表) · `plugins`(含**进程沙箱**) · `settings` · `agent`(LLM 循环) | ❌ 不动 |
| **可复用 UI** | `@mediabase/ui`(面板注册表 + JSON Schema 表单) · `ui-web`(能力无关外壳) · `i18n`(错误码+消息键本地化) · `connection`(rpc/stream/net + 环形接收) | ❌ 不动 |
| **示例产品** | `@avstudio/media` · `python` · `workflow` · `preview` · `ui-media` · `ui-panels` · `@avstudio/protocol` | ✅ 你的能力包替代/改写 |
| **引擎** | `engine/`(C++,两条后端) · `python/sidecar/` | ✅ 换成你的引擎或改用现成 |
| **应用装配** | `apps/cli`(能力表) · `apps/web`(组合顺序) | ✅ 改成你的组合 |
| **桌面壳** | `packaging/desktop-electron/` · `desktop/`(Tauri 脚手架) | ✅ 改 PRODUCT 块 / 或不要 |

**判据**:`@mediabase/*` **不允许依赖 `@avstudio/*`**(有测试守着);能力无关的东西放进 `@mediabase/*`,
领域能力放进 `@avstudio/*`。要改基座行为时先问:这是基座的事,还是我的产品的事?

---

## 二、Fork 顺序(建议照做,每步都可独立验证)

### 1. 改名与身份(10 分钟)

> scope 分工:`@mediabase/*` 是**中立基座**(不带产品身份,直接沿用;它只承诺"不依赖
> `@avstudio/*`",有测试守着);`@avstudio/*` 是**产品 scope**,下面这些改名动作针对它。
> 基座之所以叫 `mediabase` 而不是"某个产品的 base":基座是要被别的产品原样采纳的一层,
> 名字里带上某个产品的缩写就等于把身份漏进了声称中立的地方。

- 根 `package.json`:`name` / `version` / `license`(自有代码建议保持 MIT —— 基座包才能被闭源项目采纳)。
- **boot 身份**:`apps/cli/src/identity.ts` 的 `bin` / `envPrefix` / `homeDir` / `defaultProfile`
  —— 这一个文件决定产品叫什么、环境变量前缀是什么、状态目录在哪。基座默认
  `mediabase` / `MEDIBAE_`… 正确值是 `MEDIABASE_` / `.mediabase`;产品改成自己的即可,
  行表与能力包都不用动。
- 产品能力包:把 `@avstudio/*` 换成你的 scope(全局搜索替换即可,基座包不受影响)。
- 桌面壳:`packaging/desktop-electron/main.cjs` 顶部的 **`PRODUCT` 块**(窗口标题、配置目录
  `.avstudio`、env 前缀 `AVSTUDIO_`、资源表)。**只改这一处**,下面的 130 行是通用逻辑。
- `packaging/desktop-electron/package.json` 的 `name` / `appId` / `productName` / `extraResources`。

### 2. 组合(改两处)

- **宿主行表**:`packages/bundle/app/cordis.patch.yml`(一条 bundle 层;顺序 = 挂载顺序,
  基础设施 `log`/`api` 在最前,门面 `server` 在最后)。这是**唯一**的组合路径 ——
  旧的 in-code 能力表已经删除。门禁:`pnpm run verify:compose` 检查裸包名是否在所属清单的
  dependencies 里、`!!js` 是否只出现在 `config`/`disabled`、覆盖的 id 是否存在。
- **客户端名册**:`packages/bundle/ui/client.yml`(UI bundle,一条数据层:注册表在注册者之前,
  壳最后 —— 壳必须最后,因为它挂载 React 并渲染**已注册**面板)。改完运行
  `pnpm run gen:ui-roster`(或 `pnpm run build:web`,它会先自动生成);
  `apps/web/src/main.tsx` 只做"按名册挂载",不要再往里加 import。

### 3. 能力包(每个:一个包 + 一行)

能力包要自带:
- `Config`(`@mediabase/schema` 校验的部署契约)—— **一行能说什么由它定义**:必填字段缺了
  就启动失败并给出路径;依赖应用根的默认路径在 `apply` 里解析,不要写进组合层。部署值
  (端口、开关、路径覆盖)由行从环境读进来,而且写**短名**(`!!js ctx.env.str('TOKEN')` 解析成
  `${前缀}TOKEN`;环境自己的变量用 `raw/rawNum`,如 `ctx.env.rawNum('PORT')`),能力自己不读 env
  (需要读的只有插件管理器:它从 `Config` 拿 `envPrefix`)
- 在**声明这一行的清单**里写依赖:bundle 的行从该 bundle 的 `package.json` 解析,
  profile/`--patch` 的行从 `apps/cli/package.json` 解析(`pnpm run verify:compose` 会查)
- `ctx.api.register(...)` —— 方法/路由/health,标 `mutates: true` 表示会改状态
- `ctx.capabilities.register(...)` —— manifest 声明(启动时 `verify()` 会对账)
- 需要 UI 就 `ctx.ui.register(...)`;需要给 LLM 用就 `ctx.tools.register(...)`
- 文案放 `messages.ts`,组件里不写字符串(有测试守着)

### 4. 引擎后端(三选一)

见 `docs/DEPENDENCIES.zh.md` 的"三种处方":不带原生二进制 / 自出 LGPL 构建 / 接受 GPL。
`caps` 命令会如实告诉宿主当前二进制是哪条后端,`media.engineCaps` 与 `pnpm doctor` 都能看到。

### 5. 工具链与许可

- `pnpm run notice` 重新生成 `NOTICE.md`(第三方归属;npm 取自锁文件,原生条目逐个核实)。
- `pnpm run check:native --gate` 接到你的打包流程里(它会拒绝不可再分发的产物)。
- 根 `LICENSE` 与各包 `license` 字段:基座包建议 MIT;分发物整体许可按你的路线(见 `docs/GPL-COMPLIANCE.zh.md`)。

---

## 三、有测试守着的"中立性"属性

不是口头承诺,是 `tests/handoff-neutrality.test.ts` 在守:

| 属性 | 断言 |
|---|---|
| 脚本里没有机器相关绝对路径 | `scripts/**`、`packaging/**`(跳过 node_modules)不含 `/Users/…`、`/home/…` |
| 基座可用的脚本与产品解耦 | `doctor` / `verify.base` / `package` / `build-base` / `notice` / `check-native-licenses` / `lib/host-rpc` 里不出现 `@avstudio/`,端口必须来自 env |
| 产品身份集中在标记块 | Electron `main.cjs` 有 `PRODUCT IDENTITY` + `PRODUCT.resources` 表;`doctor.mjs` 有 `APP CHECKS` 块;宿主能力集合在 `packages/bundle/app/cordis.patch.yml` |
| 基座包不依赖产品包 | 靠"每包独立编译"(`pnpm run build:base`)强制:基座包一旦 import `@avstudio/*` 就编译失败 |

另外几条守卫:`tests/i18n-coverage.test.ts`(组件里不许有文案)、`tests/base-packaging.test.ts`
(所有包 `private: true`,发布被工具拒绝)。

---

## 四、开箱可用的工具(基座视角)

| 命令 | 作用 | 是否产品相关 |
|---|---|---|
| `pnpm run typecheck` | 三平面 typecheck(host/client/test) | 否 |
| `pnpm test` | 全套测试(含真实子进程、真实引擎) | 否(测试内容含产品) |
| `pnpm run lint` | oxlint | 否 |
| `pnpm run build:base` | 把 `@mediabase/*` 编译成可打包的 dist + d.ts,并**逐包独立编译**(暴露跨包耦合) | 否 |
| `pnpm run notice` | 生成 `NOTICE.md` | 否(内容含产品依赖) |
| `pnpm doctor` | 环境/产物体检(路径全部来自 env 或仓库根) | 部分(APP CHECKS 块) |
| `node scripts/verify.base.mjs` | **中性冒烟**:外壳 + health + 控制面 + `api.list` + `capabilities.verify()` | 否 |
| `node scripts/verify.mjs` | 产品冒烟:媒体动词 + 拉取/推送数据面 + 带码错误 | 是 |
| `pnpm run check:native` / `--gate` | 原生产物许可体检 / 打包门禁 | 部分 |
| `AVSTUDIO_STRICT_CAPABILITIES=1 pnpm run host` | 启动即校验能力声明(CI 门禁) | 否 |
| `AVSTUDIO_READONLY=1 pnpm run host` | 方法级只读(拒绝所有 `mutates` 方法) | 否 |

两个 verify 脚本都接受 `AVSTUDIO_URL` / `PORT` / `AVSTUDIO_TOKEN`,不再假设端口与路径。

---

## 五、交接时还欠你两个决定

1. **git 与 CI**:仓库尚未 `git init`(按你的意愿搁置),所以 `.github/workflows/*` 从未真正执行过。
   我在本地验证了 CI 的等价命令(CI 无 MediaComponent ⇒ 回退后端 ⇒ 129 绿 + 2 跳过),但"CI 跑过"
   这件事需要你先建仓库。`engine-matrix`(win/linux)也还没在真机验证。
2. **分发路线**:已选"自有代码 MIT + 分发物 GPL-3.0-or-later",但必须先去 `--enable-nonfree`
   (fdk-aac)才能真的分发 —— 步骤在 `docs/GPL-COMPLIANCE.zh.md`。
