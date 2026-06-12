---
"@tailored-ai/cli": patch
---

`tai edit` provider screen: the Kind list is now discovered live (registry built-ins + providers registered by the config's plugins, probed via a capture context) instead of hardcoded, and the Model field offers a picker populated from the provider's `listModels` capability when available — free-text entry remains the fallback.
