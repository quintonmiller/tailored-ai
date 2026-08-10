---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Preserve the host timezone through the clean launcher environment, add explicit
`time.timezone` configuration, and expose a plugin-registerable time provider
for runtime clocks and timezone-aware schedules.
