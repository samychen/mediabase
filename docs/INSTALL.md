# mediabase packaging & install

> **产品/引擎相关内容已迁至消费仓（如 avstudio）；本仓为中立基座。**


## Ship contents (this base)

Host packages (`@mediabase/*`), web bundle (`apps/web/dist`), thin CLI, optional
Electron shell template, and `pnpm-lock.yaml`. **No** C++ engine or product
sidecars — those stay in consumer repos.

## Install on a new machine

1. Prereqs: Node ≥ 20, pnpm. `pnpm doctor` reports what is missing for the base.
2. `pnpm install`
3. `pnpm run build:web` (optional if you only need the host smoke)
4. `pnpm run host` → http://127.0.0.1:3088 (`PORT=` to change; env prefix
   `MEDIABASE_`).

## Packaging

- `pnpm run build:base` / `build:host` / `package` — base artifacts (MIT-friendly;
  default Electron resources exclude an engine).
- Product installers, native rebuilds, and GPL bundling: see the consumer repo.

Full Chinese notes in `INSTALL.zh.md` (historical product steps may remain below
the banner — treat engine sections as consumer-facing).
