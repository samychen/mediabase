# @mediabase/agent

Host plugin: **LLM agent loop** (`ctx.agent`) over the same tools the WS control
plane exposes. OpenAI-compatible function calling: the model plans steps, we run
them through `ctx.media` / `ctx.python` / `ctx.workflow`, feed results back, and
loop until the model answers.

Runtime config (env, composed by `apps/cli`):
`AVSTUDIO_LLM_BASE` (default `https://api.deepseek.com/v1`) · `AVSTUDIO_LLM_KEY` ·
`AVSTUDIO_LLM_MODEL` (default `deepseek-chat`).

Tools the model can call: `media.probe`, `media.decode`, `python.run`,
`workflow.run`. Verified against a mock OpenAI-compatible endpoint in the host
integration suite; a real endpoint only needs the env vars above.
