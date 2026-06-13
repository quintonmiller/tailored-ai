---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/provider-openai": patch
"@tailored-ai/provider-anthropic": patch
"@tailored-ai/provider-bedrock": patch
"@tailored-ai/provider-deepseek": patch
"@tailored-ai/provider-openrouter": patch
---

First-class reasoning support (#254). Providers now capture their reasoning
trace into `ChatResponse.reasoning` (and a streamed `reasoning` event), and a
provider-agnostic `thinking` level (`off`/`auto`/`low`/`medium`/`high`) on
`ChatParams` maps to each provider's wire format — `reasoning_effort` (OpenAI),
`thinking:{type}` (DeepSeek), `thinking` budgets (Anthropic / Bedrock
`reasoning_config`), `chat_template_kwargs.enable_thinking` (vLLM via the
`openai_compatible` `thinkingDialect`). Set it per provider
(`providers.<id>.thinking`) or per agent (`agents.<name>.thinking`). Reasoning
is persisted on the assistant message and rendered as a collapsible "Thinking"
disclosure in the chat UI, and is stripped from every outgoing request so it
never re-enters the model. Retires the per-plugin `thinking` hack in
provider-deepseek (its boolean config still works).
