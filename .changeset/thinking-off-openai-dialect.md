---
"@tailored-ai/core": patch
"@tailored-ai/provider-openai": patch
---

`thinking: off` now reaches servers that speak OpenAI's `reasoning_effort`: it is sent as `reasoning_effort: "none"`. Before, `off` sent nothing, so the server's default (thinking on) won silently, and an agent configured not to think spent hundreds of tokens reasoning before every reply. This covers the `openai` thinking dialect on `openai_compatible` providers (local servers such as NInfer honour `none`) and the OpenAI provider plugin, whose effort ladder already drops the field for a model that rejects it.
