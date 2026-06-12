---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

Retire the built-in `openai` and `anthropic` provider registrations (#236) — they live in `@tailored-ai/provider-openai` and `@tailored-ai/provider-anthropic` now. Core keeps `openai_compatible`; unknown provider ids fail with a plugin install hint; the server model-list endpoint and editor provider rendering are now generic over registered providers.
