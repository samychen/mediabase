# 实战:用 mediabase 做一个计算器(JS / Python / C++ 三种计算后端)

> 这是一条**可以照抄**的路径:在 mediabase 旁边新建一个项目,把「计算」做成三种可互换的
> 实现,并说明每一步落在基座的哪个机制上。文中的命令与输出都是实际跑出来的
> (绝对路径已用 `<repo>` 代指,免得把某一台机器的目录写进文档)。
>
> 参考实现同时存在于 `../calculator`(与 `mediabase` 平级)。全部代码只有 12 个文件,
> 没有一个字改动基座。

## 0. 先分清:哪些要你写,哪些基座已经给了

| 你要写的 | 基座已经给的 |
|---|---|
| 身份(4 行:命令行名/环境前缀/状态目录/清单键) | 组合机制:profile → bundle 层 → patch 覆盖层 |
| 一个能力包(`Config` + 方法注册) | 注册表:`ctx.api` 方法/路由/健康、`ctx.tools`、`ctx.capabilities` |
| 一层 bundle(`cordis.patch.yml` 一行) | 前端门户 HTTP/WS、日志、设置、插件管理、沙箱边界 |
| 计算后端(任意语言,一套行协议) | 子进程传输原语 `@mediabase/engine-client`(排队/超时/死亡拒答) |
| 一个冒烟脚本 | 验证小工具 `scripts/lib/host-rpc.mjs`、`verify.base.mjs`、`verify-composition.mjs` |

最终目录(与 `../calculator` 一致):

```
calculator/
  pnpm-workspace.yaml             ← 把基座当作「旁边的包」
  package.json
  apps/cli/src/identity.ts        ← 身份
  apps/cli/src/index.ts           ← 入口(薄)
  packages/host/calc/src/index.ts ← 能力包(三种后端在这里选)
  packages/host/calc/src/evaluate.ts
  packages/bundle/app/cordis.patch.yml  ← 挂上去的那一行
  backends/python/calc_server.py  ← 独立进程后端
  backends/cpp/calc.cpp + build.sh
  scripts/verify.mjs              ← 三个后端结果必须一致
```

## 1. 建工作区:把基座当成"旁边的包"

```
<repo>/                      ← 工作根目录,例如 ~/develop/harness
  mediabase/                 ← 基座(已存在)
  calculator/                ← 你现在要建的
```

`calculator/pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*/*'
  - 'apps/*'
  - '../mediabase/packages/base/*'        # 基元
  - '../mediabase/packages/host/*'        # 宿主
  - '../mediabase/packages/bundle/app'    # 基座的宿主组合层(注意:不要写 bundle/*)
```

**只列你真正用到的包,这一条不是洁癖,是实测踩出来的。** 把基座的客户端包或整个
`bundle/*` 也列进来会怎样:

- 写 `bundle/*` 会拉进 `@mediabase/bundle-ui`,它依赖 `@mediabase/connection` —— 而后者不在
  你的工作区里,pnpm 直接拒绝安装:

  ```
  [ERR_PNPM_WORKSPACE_PKG_NOT_FOUND] In ../mediabase/packages/bundle/ui:
  "@mediabase/connection@workspace:^" is in the dependencies but no package named
  "@mediabase/connection" is present in the workspace
  ```

- 于是你"顺手"把 `client/*` 也加上 —— 四条 glob 齐了,安装成功,但**代价是基座被改**:
  pnpm 会按**你的工作区**给这些包解析依赖,并把**基座自己 node_modules 里的链接**改指到
  你的 store。实测结果:`mediabase/packages/client/ui/node_modules/react` 被改指过来,
  基座自己的 UI 测试立刻变成「两个 React 实例」而挂掉:

  ```
  FAIL tests/ui-shell.test.tsx > <App/> shell > renders an empty but working shell …
  TypeError: Cannot read properties of null (reading 'useCallback')
  ```

  恢复只要在基座里再跑一次安装(它会按基座自己的工作区把链接指回去):

  ```sh
  cd ../mediabase && CI=true pnpm install --ignore-scripts
  ```

  所以:**工作区 glob 尽量窄**;一旦动过某个消费方的安装,回头在基座里跑一次
  `pnpm install`(或至少跑一次 `pnpm test`)是值得的习惯。

然后把依赖写成 `workspace:^`(`calculator/packages/host/calc/package.json` 里就是):

```json
"dependencies": {
  "@mediabase/schema": "workspace:^",
  "@mediabase/rpc": "workspace:^",
  "@mediabase/engine-client": "workspace:^"
}
```

```sh
cd calculator && pnpm install
# Progress: resolved … added …, done
# Done in 728ms using pnpm v11.7.0
```

(再跑一次是幂等的:`Lockfile is up to date, resolution step is skipped` / `Already up to date`。)

`workspace:^` 解析到的是**兄弟目录里的真源码**,不是打包产物:改一行基座代码,产品下次启动
就生效(不用重装、不用重打包)。这是本地开发路径;CI 里改成按 tag 拉同级检出即可
(见 `docs/HANDOFF.zh.md`)。

## 2. 身份:一个文件决定这套部署的词表

`apps/cli/src/identity.ts`(全部 4 个字段):

```ts
export const IDENTITY: BootIdentity = {
  bin: 'calc',          // 日志与诊断里的名字
  envPrefix: 'CALC_',   // 环境变量前缀(行里写短名,拼前缀由基座做)
  homeDir: '.calc',     // 状态目录($HOME 下)
  defaultProfile: 'web',
  profileKey: 'calc',   // profile 清单里的嵌套键:calc.profile.bundles
}
```

基座**不写死任何产品名**:它只认这份身份。于是 `CALC_PORT`、`CALC_HOME`、`CALC_STRICT_CAPABILITIES`
全部自动可用,而基座代码里不会出现 `CALC_` 这个词。想整体换词表(测试/嵌入)用
`CALC_ENV_PREFIX=EXPT_`。

## 3. 入口:薄到只剩四件事

`apps/cli/src/index.ts` 与基座自己的入口同形(基座那个文件约 100 行),做四件事:
给身份、给 anchor、把启动结果说清楚、收到信号优雅退出。组合机制、`--dump-config`、
drop-in、flag 解析全在 `@mediabase/boot` 里。

唯一需要你自己决定的是**首次启动写哪些 bundle 层**:

```ts
const TEMPLATES: Record<string, ProfileTemplate> = {
  web: { bundles: ['@mediabase/bundle-app', '@calc/bundle-app'] },
  headless: { bundles: ['@mediabase/bundle-app', '@calc/bundle-app'] },
}
```

基座自带的模板只列它自己的 bundle;要让你的层也挂上,就得由部署来声明 —— 这就是
「组合是数据,由部署决定」的落点。(也可以不传,而是手工编辑
`$CALC_HOME/profiles/web/package.json` 里的 `calc.profile.bundles`。)

## 4. 能力包:一个方法 + 三种后端

`packages/host/calc/package.json` 里**必须有入口声明**,否则行解析不到:

```json
"main": "src/index.ts",
"types": "src/index.ts",
"exports": { ".": "./src/index.ts" }
```

实测漏掉时的报错(基座的预检会点名是哪一行):

```
[calc] boot failed: calc: 以下组合行无法从安装锚点解析(<repo>/calculator/apps/cli/package.json):
  行 "calc": @calc/host-calc
把该包加进锚点(或对应 bundle)的 dependencies,先运行 pnpm install;…
```

能力包的结构(`src/index.ts`,要点):

```ts
export const name = 'calc'
export const inject = ['api', 'log'] as const          // 先就位的服务

export const Config = z.object({                        // 本行的配置契约
  root: z.string().required(),                          // 应用根:路径由能力自己拼
  backend: z.union([z.const('js'), z.const('python'), z.const('cpp')]).default('js'),
  pythonBin: z.string().default('python3'),
})

export function apply(ctx, rawConfig) {
  const config = parse(Config, rawConfig)               // 类型不对 → 带路径失败
  const log = ctx.log.child('calc')                     // 日志带作用域

  ctx.effect(() => () => { /* 关闭所有后端子进程 */ })   // 副作用都挂在 fiber 上

  ctx.api.register({ name: 'calc.eval', params: z.object({ expr: z.string().required() }),
                     handler: async (p) => ({ value: await evalWith(p.expr), backend: config.backend }) })
  ctx.api.register({ name: 'calc.backends', params: z.object({}),
                     handler: () => ({ active: config.backend, available: ['js', 'python', 'cpp'] }) })
}
```

三条纪律(都来自基座 `AGENTS.md`,照做就行):

1. **错误带码**:表达式本身的问题 → `RpcError(RpcCode.INVALID_PARAMS, …)`,调用方按 `code`
   分支,而不是去匹配文案;
2. **副作用可逆**:子进程、定时器、临时文件全部进 `ctx.effect(...)`,树一销毁就干净(实测
   宿主被 `SIGTERM` 后 `pgrep -fl backends/cpp/calc` 无残留);
3. **边界要被执行验证**:子进程起来了先握手 `hello`,不匹配就报 `UNAVAILABLE`,不靠约定。

`js` 后端(`src/evaluate.ts`)是一个只认 `+ - * / ( )` 与十进制数的递归下降解析器 —— 约 80 行,
**刻意不用 `eval()`**:行为可预测、报错可读,而且能作为「同一批输入、三个后端、结果必须逐个
相同」的基准。

## 5. 挂上去:一行 bundle

`packages/bundle/app/cordis.patch.yml`:

```yaml
- insert:
    - id: calc
      name: '@calc/host-calc'
      config:
        root: !!js ctx.appPaths.root
        backend: !!js ctx.env.choice('BACKEND', ['js', 'python', 'cpp'])
        pythonBin: !!js ctx.env.str('PYTHON')
```

三件事值得注意:

- `!!js` 在**行激活时**求值,上下文里有 `ctx.appPaths`(`root`/`home`)与 `ctx.env` 读取器;
- 行里写**短名**:`ctx.env.choice('BACKEND', …)` 读的是 `CALC_BACKEND`;
- `choice` 的语义是「值不在集合里 → `undefined` → 交给 `Config` 的默认值」,所以拼错
  `CALC_BACKEND=cppp` 不会把启动搞崩;而 `ctx.env.str('PYTHON')` 未设置时字段缺席,
  `Config` 的 `python3` 生效 —— 这是基座推荐的两种读法。

另外别忘了把能力包加进**安装锚点** `apps/cli/package.json` 的 `dependencies`
(profile 层与 `--patch` 覆盖行的裸包名从锚点解析)。

## 6. 先别启动:`--dump-config` 看会启动成什么样

```sh
CALC_HOME=$PWD/.calc pnpm run dump
```

```yaml
# == <repo>/calculator/packages/bundle/app/cordis.patch.yml
- id: calc
  name: '@calc/host-calc'
  config:
    root: !!js ctx.appPaths.root
    backend: !!js ctx.env.choice('BACKEND', ['js', 'python', 'cpp'])
    pythonBin: !!js ctx.env.str('PYTHON')
```

它只解析层、不挂载、不连端口、不求值 `!!js` —— 组合写错时,这里是第一个能发现问题的地方。

## 7. 三种后端:同一套行协议

| 请求(一行,`\t` 分隔) | 响应 |
|---|---|
| `hello` | `ok\tcalc-python` / `ok\tcalc-cpp` |
| `eval\t<表达式>` | `ok\t<数值>` 或 `err\t<原因>` |

这正是 `@mediabase/engine-client` 的 `call()` 说的协议(它负责排队、超时、进程死亡时拒绝
在途调用;重启/退避这类策略留给你)。两个后端各自独立可测:

```sh
printf 'hello\neval\t1+2*3\neval\t(1+2)*3.5\neval\t1+(\n' | ./backends/cpp/calc
# ok	calc-cpp
# ok	7
# ok	10.5
# err	表达式不完整
```

Python 后端(`backends/python/calc_server.py`,纯标准库)三个要点:文件头 `#!/usr/bin/env python3`
且 `chmod +x`(它本身就是可执行文件,不需要额外参数)、每条响应 `flush`(否则调用方等到超时)、
**任何坏输入都不许把后端弄死**(转成 `err\t…` 返回)。

C++ 后端(`backends/cpp/calc.cpp`)零依赖,`build.sh` 里一条 `g++ -O2 -std=c++17` 就够;
它和 Python 后端、JS 后端实现的是同一套文法。

## 8. 启动 + 调用

```sh
CALC_HOME=$PWD/.calc PORT=3213 pnpm run host
```

```text
INFO  calc.calc    计算器就绪:后端 = js {"backends":"js / python / cpp"}
INFO  calc.server  宿主就绪: http://127.0.0.1:3213  (ws /rpc 20 方法, ws /stream 0 通道, /api/* 0 条数据面路由)
INFO  calc         已组合 能力树(其中 5 个登记 manifest) {"api":20,"tools":0,"layers":3,
     "layerFiles":["…/mediabase/packages/bundle/app/cordis.patch.yml",
                   "…/calculator/packages/bundle/app/cordis.patch.yml",
                   "…/calculator/.calc/profiles/web/cordis.patch.yml"]}
```

调用(复用基座的 `connect`,它就是一个最小 JSON-RPC over WS 客户端):

```js
const { connect } = await import('../mediabase/scripts/lib/host-rpc.mjs')
const rpc = connect('http://127.0.0.1:3213'); await rpc.open()
await rpc.call('calc.backends')                  // { active: 'js', available: ['js','python','cpp'] }
await rpc.call('calc.eval', { expr: '2*(3+(4-1))' })  // { value: 12, backend: 'js' }
await rpc.call('calc.eval', { expr: '5/0' })     // 抛错:code -32602, message "calc: 除以零"
```

## 9. 换后端的两条路(这条最值得看)

**a) 环境变量(一次运行)**

```sh
CALC_BACKEND=python PORT=3214 pnpm run host     # 同一份组合,换成 Python 子进程
```

**b) 改一行数据(一套部署)**

编辑 `$CALC_HOME/profiles/web/cordis.patch.yml` —— 这是「用户会改的那个文件」:

```yaml
- id: calc
  config:
    root: !!js ctx.appPaths.root
    backend: cpp
```

`--dump-config` 会指出它被谁覆盖了:

```yaml
# == …/calculator/packages/bundle/app/cordis.patch.yml, patched by …/profiles/web/cordis.patch.yml
- id: calc
  config:
    root: !!js ctx.appPaths.root
    backend: cpp
```

启动后实测:

```
calc.backends            -> {"active":"cpp","available":["js","python","cpp"]}
calc.eval 2*(3+(4-1))    -> {"value":12,"backend":"cpp"}
calc.eval 5/0            -> -32602 calc(cpp): 除以零
```

注意这里的语义:**覆盖是整体替换 `config`**,所以要把它需要的字段重述一遍。上面这层没有
重述 `pythonBin` —— 结果是该字段缺席、`Config` 的默认值生效(而不是报错)。这正是基座文档
反复强调的那一点。

## 10. 把不变式固定成脚本

`scripts/verify.mjs` 逐个后端启动宿主,用**同一批表达式**问一遍,最后比对三个后端的结果:

```sh
pnpm run verify
```

```
✓ js: 生效的后端是它自己  {"active":"js","available":["js","python","cpp"]}
✓ js: 7 个表达式都算出来了  7, 10.5, 12.5, 6, 12, 6, -3
✓ js: 坏表达式返回 INVALID_PARAMS  -32602 calc: 表达式不完整
✓ python: …（同上）        ✓ cpp: …（同上）
✓ python 的结果与 js 逐个相同  [7,10.5,12.5,6,12,6,-3] vs [7,10.5,12.5,6,12,6,-3]
✓ cpp 的结果与 js 逐个相同     [7,10.5,12.5,6,12,6,-3] vs [7,10.5,12.5,6,12,6,-3]
CALC OK — JS / Python / C++ 三个后端的结果逐个一致。
```

脚本复用了基座的两个小工具(`connect` / `checker`),只自己拼了 URL —— 因为基座的
`hostUrl()` 读的是它自己的词表(`MEDIABASE_`),而你的是 `CALC_`。(基座的脚本目前把前缀
写死在这几处;要做成通用的,就是把这些前缀变成参数。)

## 11. 常见坑(全是这次实测踩到的)

| 症状 | 原因与解法 |
|---|---|
| `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` | workspace globs 写宽了(`bundle/*` 拉进 `bundle-ui`,它的 `connection` 不在工作区);改成显式 `bundle/app` |
| 基座自己的 UI 测试突然报 `useCallback` of null | 你的 `pnpm install` 把基座 `client/*` 的 react 链接改指到你的 store → 两个 React 实例。glob 别列 `client/*`;在基座里再跑一次 `pnpm install` 即恢复 |
| `以下组合行无法从安装锚点解析:行 "calc": @calc/host-calc` | 能力包缺 `main`/`types`/`exports`,或没加进锚点 `dependencies` |
| 覆盖行之后某个字段"丢了" | 覆盖整体替换 `config`,把需要的字段重述(或依赖 `Config` 默认值) |
| 子进程起不来(`spawn failed`) | Python 脚本没有可执行位(`chmod +x`),或 C++ 没编译 |
| 调用一直等到超时 | 后端忘了 `flush`;行协议必须一行一响应 |
| `EPERM: operation not permitted, mkdir '~/.calc/…'` | 状态目录不可写(沙箱/CI):用 `CALC_HOME` 指到可写目录 |
| 想看"到底挂了哪一行" | 基座会把失败链打全(行名 + 原因);启动失败先看最后缩进最深那几行 |

## 12. 接下来按需加(都不必改基座)

- **Web 面板**:加一个 client 包 + 在 `packages/bundle/ui/client.yml` 里排一行 + `pnpm run gen:ui-roster`;参考基座 `@mediabase/ui` 与 `@mediabase/ui-web`(外壳必须最后挂)。
- **单文件宿主 / 装机**:`pnpm run build:host` 会把每一行打成 `build/plugins/*.cjs`(`../mediabase/scripts/build-host-bundle.mjs` 可复用),Electron 模板见 `packaging/desktop-electron`。
- **测试**:`evaluate` 值得配 vitest;端到端的部分用 `scripts/verify.mjs` 就够了。
- **进 CI**:本地用兄弟目录,CI 里按 tag 拉基座(`MEDIABASE_REF`),见 `docs/HANDOFF.zh.md`。
- **许可**:自有代码 MIT;一旦随包分发原生二进制(比如把 C++ 后端打进安装包),义务随之变化,见 `docs/LICENSING.zh.md`。
