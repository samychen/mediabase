# @mediabase/rpc

能力无关的 **JSON-RPC 2.0**(base 包,route-B 抽取的第一步):

- `makeServer(methods)` — host 侧:JSON-RPC 分发;通知(无 id)永不回响应
  (符合规范),副作用照跑
- `makeClient(send, onNotify?)` — client 侧:`call()` + `handle()` 路由响应/通知

零依赖,Node 与浏览器都能用;不感知任何 avstudio 业务类型。@avstudio/protocol
是对本包的再导出 + 它自己的领域契约——新产品可直接依赖 `@mediabase/rpc`。
