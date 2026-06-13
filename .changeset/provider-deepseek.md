---
"@tailored-ai/provider-deepseek": patch
---

New plugin: `@tailored-ai/provider-deepseek` — DeepSeek model provider for the V4 hybrid models (`deepseek-v4-flash`, `deepseek-v4-pro`) over DeepSeek's OpenAI-compatible API. Builds on core's `OpenAIProvider` (chat, streaming, tool calling, `listModels`) and adds a `thinking` config toggle that injects DeepSeek's per-request `thinking: { type }` field — `false` for snappy non-thinking tool calls (the durable replacement for the soon-deprecated `deepseek-chat`), `true` to reason first. Install with `tai plugin install @tailored-ai/provider-deepseek` and select with `agent.defaultProvider: deepseek`.
