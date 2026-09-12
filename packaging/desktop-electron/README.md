# desktop-electron — Mode B as a native window

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**  
> 本模板默认 **不**捆绑 C++ 引擎或 FFmpeg。自有代码 MIT。若产品在 `PRODUCT.resources`
> 中追加原生二进制，分发义务由该产品自行处理（见消费仓的 GPL / licensing 文档）。

把 Mode B（浏览器里开的宿主界面）包成「双击即用的桌面窗口」。**无需 Rust**。
壳极薄：fork 打包好的宿主（`build/host.cjs`）→ 等健康检查 → 开窗口指向
`http://127.0.0.1:3088`；关窗即停宿主。

## 三步出包（macOS 示例）

```sh
# 0) 在仓库根构建
pnpm run build:host        # -> build/host.cjs
pnpm run build:web         # -> apps/web/dist

# 1) 安装 Electron 构建工具（本目录独立安装）
cd packaging/desktop-electron
pnpm install

# 2) 出安装包（未签名；本地双击可用）
pnpm run dist
# 或开发态直接跑窗口
pnpm start
```

## 产品身份：只改 `PRODUCT` 块

`main.cjs` 顶部的 **`PRODUCT`**（窗口标题、`configDir`、`envPrefix`、`resources[]`）是
产品该改的全部。基座示例用 `mediabase` / `MEDIABASE_` / `.mediabase`；消费产品可改为
`AVSTUDIO_` / `~/.avstudio` 等，并按需追加引擎资源行。

## AI / 部署 env（双击启动时）

Finder 启动的 App 没有 shell 环境变量。壳启动时读取用户级
`~/.{configDir}/env`（每行一个，`#` 注释），已有 shell env 优先。基座示例：

```sh
mkdir -p ~/.mediabase
cat > ~/.mediabase/env <<'EOF'
MEDIABASE_LLM_KEY=sk-你的key
# MEDIABASE_LLM_BASE=https://api.deepseek.com/v1
# MEDIABASE_LLM_MODEL=deepseek-chat
EOF
```

产品换 `configDir` / `envPrefix` 后，路径与变量名跟着换。

## 现状

- 基座包：无引擎资源，MIT 友好。
- 跨平台：`pnpm run dist:all` 需在对应 OS 上跑（electron-builder 不跨平台出包）。
