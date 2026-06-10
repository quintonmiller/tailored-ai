---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Register the four default plugins through `config.plugins` (#142).

`DiscordNotifier`, `ScopeCreepFlagger`, `StallGuard`, and `CoderProjectGuard`
were hardcoded `new …()` constructions in the CLI's `runServer()`. They now
ship as `builtin:*` entries in `config.plugins` and load through the existing
config-driven `loadPlugins` path, so they are user-toggleable.

- `PluginContext` gains `runtime?` (the live `AgentRuntime`) and a per-entry
  `config` bag; each plugin module adds a `default` `register(ctx)` export that
  wraps its class and returns a disposer.
- `loadPlugins` threads each entry's `config` into `ctx.config`, captures the
  disposer on `LoadedPlugin.stop`, and skips `{ module, enabled: false }`
  entries.
- The CLI importer resolves a `builtin:<name>` prefix to
  `@tailored-ai/core/plugins/<name>` (new `./plugins/*` subpath export); no
  builtin allowlist.
- `DEFAULT_CONFIG.plugins` seeds the four defaults, and `migrateDefaultPlugins`
  re-appends any missing `builtin:` entry on load — so **`enabled: false` is the
  durable off switch**; deleting an entry is re-added by the migration.
- Fixes a latent reload bug: `runtime.reload()` calls `events.clear()`, which
  silently killed the default plugins' subscriptions until restart. The
  `onReload` hook now disposes and re-loads the runtime plugins.

A default install behaves identically. The `scope-creep.ts` module is renamed
to `scope-creep-flagger.ts` so its subpath export matches the
`builtin:scope-creep-flagger` entry.
