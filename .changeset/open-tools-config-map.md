---
"@tailored-ai/core": patch
"@tailored-ai/google-tools": patch
---

The `tools` config section is now an open map (`[toolId: string]: { enabled?: boolean; ... }`): plugin tools read `tools.<id>` through the index instead of needing typed slots in core. The `gmail` / `google_calendar` / `google_drive` shapes move out of core's `AgentConfig` into `@tailored-ai/google-tools`, and `validateConfig` no longer special-cases those tool ids (the plugin already warns and skips at factory time when `account` is missing).
