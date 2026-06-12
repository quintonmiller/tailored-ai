---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

DEFAULT_CONFIG no longer ships a specific local model name (`devstral-small-2:latest`). `providers.openai_compatible.defaultModel` defaults to empty; `validateConfig` warns until a model is set, and `tai init` discovers installed models as before. The deprecated `providers.ollama` migration also stops injecting the model name.
