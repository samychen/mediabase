# MCP：把工具暴露给外部 agent

mediabase 的工具注册表（`ctx.tools`）有一个 MCP（Model Context Protocol）端点：
`@mediabase/mcp` 把组合里注册的全部工具以 MCP Streamable HTTP 暴露出去，外部 agent
（Claude Desktop、Cursor 等）由此驱动与内置 LLM agent 完全相同的工具面——
mtxconsole 的 8 个运维动词、openvideo 的 8 个编辑动词，或任何产品注册的工具。

## 端点

- **路径**：`POST /mcp`（组合行可配 `path`）
- **传输**：无状态 Streamable HTTP——一个 POST 一条 JSON-RPC 2.0，应答直接以
  `application/json` 返回；GET/DELETE 得到 405（无服务端主动推送流）
- **方法**：`initialize`（版本协商）· `ping` · `tools/list` · `tools/call`
- **名字**：注册表里的点号名（`mediamtx.path.add`）按 OpenAI/MCP 规则折叠为
  `mediamtx_path_add`；撞名确定性消解，两个消费方（LLM agent 与 MCP）共享同一映射
- **注解**：工具声明的 `mutates` 映射为 `readOnlyHint`；未声明的工具不带注解
- **鉴权**：`${prefix}TOKEN` 设置时与 `/api/*` 相同的 token 门控（`?token=` 或
  `Authorization: Bearer`）；未设置时是本地信任边界
- **策略**：`tools/call` 内部走 `ctx.api.call('tools.run')`，与控制面同 readonly/ACL
  策略、同审计、同 schema 校验；工具失败与策略拒绝按 MCP 规范作为
  `isError: true` 的结果返回

## 接入

**原生 Streamable HTTP 客户端**（如 Cursor）直接填 URL：

```
http://127.0.0.1:3088/mcp
```

**stdio 客户端**（如 Claude Desktop）用仓库自带的桥（零依赖 Node 脚本）：

```json
{
  "mcpServers": {
    "mediabase": {
      "command": "node",
      "args": ["/path/to/mediabase/scripts/mcp-stdio.mjs"],
      "env": {
        "MEDIABASE_URL": "http://127.0.0.1:3088",
        "MEDIABASE_TOKEN": "<部署设置了 TOKEN 时>"
      }
    }
  }
}
```

桥按行读 stdin 的 JSON-RPC，逐条 POST 到宿主端点，应答写回 stdout；
`MEDIABASE_MCP_PATH` 可换端点路径。

## 与内置 agent 的关系

内置 `agent.run` 与 MCP 端点是**同一个注册表的两个消费方**：工具只注册一次
（`ctx.tools.register`），两边同时可见。区别只在调用方——一个是宿主内的 LLM
循环，一个是外部 agent。给 agent 加一个工具，MCP 表自动多一行，反之亦然。

在浏览器里打开 `/mcp` 会看到 405——那是端点存活的表现：它只说 POST。
