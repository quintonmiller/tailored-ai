---
"@tailored-ai/core": minor
"@tailored-ai/cli": patch
"@tailored-ai/server": patch
---

Stop privileging built-in LLM providers in config. `config.providers` is now
a generic id-keyed map of backend-opaque option bags
(`{ [id: string]: Record<string, unknown> }`) instead of three typed blocks
(`openai_compatible` / `openai` / `anthropic`). Each provider — built-in or
plugin — reads its own slice (`baseUrl` / `defaultModel` / `apiKey`, plus
`name` for openai_compatible); core carries no per-provider schema.
`agent.defaultProvider` still selects the active provider by id.

`populateBuiltinProviders` now registers every configured provider whose
factory is available by iterating the map, instead of hard-coding the three
built-in ids. The editor's `ProviderKind` widens to `string` so any
registered provider id is valid.

Non-breaking: existing flat `providers.openai_compatible: { baseUrl, … }`
configs remain valid (they're already option bags), so no migration is
needed and existing config files keep working unchanged.
