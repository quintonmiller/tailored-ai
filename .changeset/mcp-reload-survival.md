---
"@tailored-ai/cli": patch
---

MCP tools survive startup reloads: the reconcile-on-reload hook is now registered the moment the manager is constructed, before any runtime.reload() can swap the tool registry. Previously, activating a project overlay during startup (setActiveProject → reload) silently dropped freshly-registered MCP tools because the hook was only installed later in server mode.
