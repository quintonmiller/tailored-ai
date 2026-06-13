---
"@tailored-ai/core": patch
---

Support multiple OpenAI-compatible providers under arbitrary ids. Any `providers.<id>` that sets `type: openai_compatible` (or carries a bare `baseUrl`) is now served by the built-in `OpenAIProvider` under that id — so a local vLLM gateway, DeepSeek, Groq, Together, and any other OpenAI-wire endpoint can coexist without a per-vendor plugin, and `agent.defaultProvider` can select among them. A registered factory id still wins over an inline `type`. New exports: `buildOpenAICompatibleProvider`, `isInlineOpenAICompatible`. Closes #253.
