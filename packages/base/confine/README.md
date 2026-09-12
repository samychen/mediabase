# @mediabase/confine

**声明式子进程限制**:把一份策略变成真正生效的 spawn 参数,并**如实报告**哪些做不到。

子进程本身不是边界。宿主 fork 出来的孩子与宿主同用户、同文件系统、同网络权限 ——
"放进独立进程"能兜住崩溃与死循环,**兜不住恶意模块**。本包是补这一层的地方。

## 两层机制

| 层 | 覆盖 | 可用性 |
| --- | --- | --- |
| `node-permission`(Node `--permission`) | 文件系统只允许声明的根;**禁止**子进程、worker 线程、原生 addon | 只要有支持该模型的 Node(实测 `node --permission` 可用) |
| `seatbelt`(macOS `sandbox-exec`)/ `bubblewrap`(Linux `bwrap`) | Node 模型**表达不了**的部分:网络禁止、命名空间/系统调用级限制 | 依机器而定,**按执行探测**,不可用时给出机制自己的报错 |

三条设计底线:

1. **探测靠执行,不靠 `which`/版本号。** 二进制存在不等于能用(macOS 上
   `sandbox-exec` 可能返回 `sandbox_apply: Operation not permitted`,嵌套沙箱、
   硬化内核都会这样)。`probeMechanisms()` 真的跑一次,失败原因原样带出。
2. **绝不宣称做不到的事。** 请求了但无法生效的禁止会进 `unavailable`,并且**不会**出现在
   `enforced` 里;`complete` 为 false 时,调用方可以选择 fail closed。
3. **报告不能误诊。** 只指名**这个平台上可能存在**的机制:被真实尝试并拒绝的机制写它的名字
   (含它自己的报错原文);而一个平台上根本没有 OS 层机制时(Windows),写
   `no-os-mechanism` —— 在 Windows 上说"bubblewrap 不可用"会让人去找一个它永远跑不了的
   Linux 工具。类型上也是分开的:`available`/`layers`/`plan` 只接受真实机制
   (`ConfineMechanism`),`no-os-mechanism` 只能出现在报告里(`UnavailableMechanism`)。

## 用法

```ts
import { planConfinement } from '@mediabase/confine'

const plan = planConfinement({
  read: ['/app', '/plugins/my-plugin'],  // 必须包含运行时与插件文件,否则子进程连入口都读不到
  write: ['/home/me/.app/plugin-data/my-plugin'], // 不填 = 只读
  denyNetwork: true,
  confineProcesses: true,
})
if (!plan.complete && required) throw new Error(plan.describe())
const { bin, args } = plan.spawn('/app/build/sandbox.cjs')  // 入口放最后
spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
```

`plan.describe()` 给日志/health/状态卡用,例如本机实测输出:

```
层=node-permission · 文件系统=读写(仅声明目录) · 子进程=禁止 · 网络=未限制 · 未生效=seatbelt: sandbox_apply: Operation not permitted
```

## 两个必须知道的实现事实(实测)

- **路径按字面比较,不做符号链接解析。** Node 权限模型把子进程请求的路径与声明的根
  逐字比较:macOS 上 `/tmp/x` 与 `/private/tmp/x` 是同一目录、两个字符串。所以
  `resolveRoots()` **同时给出原样路径与 realpath 两种形式**,否则总有一半访问被静默拒绝。
- **`tsx` 需要 worker 线程**(它用 worker 注册 ESM loader 钩子),而禁止 worker 正是限制的
  一部分。所以受限子进程优先用:打包后的 `build/sandbox.cjs` → 仓库内 `node entry.ts`
  (Node 自带类型剥离,无 loader) → 最后才是 `tsx`,并且此时把"放弃 worker 禁止"作为
  `unavailable` **明确报出来**(`allowWorker`),不静默降级。

## 边界(诚实说明)

- Node 权限模型**不管网络**(没有 `--allow-net`):网络禁止只能靠 OS 层。
- OS 层不可用时,`denyNetwork` 只是"没做到",不是"做到了但很弱"。
- 本包只负责**计划**(参数、包装、报告),真正的加载/监督/超时在
  `@mediabase/plugins` 的沙箱宿主里。
