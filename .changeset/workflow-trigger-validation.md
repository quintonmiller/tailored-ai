---
"@tailored-ai/core": patch
---

Workflow loader now drives trigger validation from the trigger registry instead of a closed allowlist. Built-in pollers (`geofence`, `weather`, `sensor`, `finance`, `home_assistant`) were rejected by the loader despite being in `BUILTIN_TRIGGER_KINDS` and wired into the runtime — they now load cleanly. `validateWorkflow` and `loadWorkflowsFromDir` accept an optional `allowedTriggerKinds` for plugin-supplied trigger kinds. `WorkflowRegistry.setExtraTriggerKinds(supplier)` lets the runtime feed the active registry's kinds in. Closes #54.
