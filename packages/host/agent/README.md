# @mediabase/agent

Host plugin: **LLM agent loop** (`ctx.agent`) over whatever tools the host tool
registry currently exposes. OpenAI-compatible function calling: the model plans
steps, we run them through `ctx.tools`, feed results back, and loop until the
model answers.

Runtime config comes from the composition row via short env names
(`LLM_BASE` / `LLM_KEY` / `LLM_MODEL` → `${prefix}…`). Base default prefix is
`MEDIABASE_`; a product that boots with `AVSTUDIO_` reads `AVSTUDIO_LLM_*` instead.

Which tools the model can call is entirely registry-driven — this package hard-codes
none. Verified against a mock OpenAI-compatible endpoint in tests; a real endpoint
only needs the env vars above.
