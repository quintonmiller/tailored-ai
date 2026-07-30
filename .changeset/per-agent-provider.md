---
"@tailored-ai/core": patch
---

Make an agent's `provider:` actually select a provider.

`AgentDefinition.provider` parsed, `validateConfig` checked it against
`config.providers`, and `findOrCreateSession` wrote it into the session row —
but `buildLoopOptions` passed `this._provider` unconditionally, so every agent
ran on `agent.defaultProvider` regardless of what it declared. Another config
key that parses and reaches nothing.

The symptom is indirect, which is why it survived: the agent's model name goes
to the default provider's endpoint and comes back as a 404 for a model that
does exist, just not there.

`createProvider` now takes an optional provider id, and the runtime builds and
caches one per declared provider, clearing the cache on reload so an edited
key or baseUrl takes effect. A declared provider that cannot be built falls
back to the default and says so once, naming both the agent and the provider —
the plugin that would register it may simply not be installed, and taking the
agent offline is a worse answer than a named fallback. Silence there is what
made the original bug present as a bare 404.

Also fixes model defaulting: an agent that names a provider and no model now
gets that provider's `defaultModel` rather than the global one, which was the
other half of sending one vendor's model name to another's endpoint.
