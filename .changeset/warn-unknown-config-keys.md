---
"@tailored-ai/core": patch
---

`validateConfig` now warns on unrecognized **top-level** `config.yaml` keys. A feature configured under a typo'd key, or one a newer doc describes but the installed version predates, was silently ignored before — the warning names the key, lists the supported keys, and hints at version skew. Top-level only: nested bags (`tools.<id>`, `providers.<id>`, `channels.<id>`, plugin config) stay open and are never checked. The recognized-key set is typed `Record<keyof AgentConfig, true>`, so it can't drift from the interface. New export: `KNOWN_TOP_LEVEL_CONFIG_KEYS`. Closes #252.
