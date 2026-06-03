---
"@tailored-ai/google-tools": patch
"@tailored-ai/cli": patch
---

Migrate `@tailored-ai/google-tools` to the `register(ctx)` plugin contract (closes #55). The package previously registered Gmail / GoogleCalendar / GoogleDrive via module-load side effects, which broke when installed via `tai plugin install` outside the host's resolution tree (same class of bug as channel-slack pre-#47). Default export is now a `Plugin` function the host invokes with a `PluginContext`. CLI drops its `@tailored-ai/google-tools` workspace dep — Google tools are now fully optional, opt-in via `plugins: ["@tailored-ai/google-tools"]` in config.yaml.
