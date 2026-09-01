---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

A runtime plugin's tools now reach the agent at startup, not on the next reload.

`PluginContext` offers `ctx.tools.register` to every plugin, but `createTools()`
walks the tool-factory registry exactly once, in the `AgentRuntime` constructor.
Registry-pass plugins load before that walk. **Runtime-pass plugins load after
it by definition** — they load late precisely because they need `ctx.runtime` —
so a tool they registered went into the factory registry with nothing left to
read it. The plugin loaded, `register` returned a disposer, nothing warned, and
the tool first appeared if and when something unrelated triggered a reload.

Same class as #561 and #609: a registration that validates and does nothing.

`AgentRuntime.applyPendingToolFactories()` re-runs the factories and registers
what is not already present, returning the names it added; the CLI calls it
after loading runtime plugins and logs what appeared.

**Additive rather than a rebuild**, for a specific reason: the tool registry
also holds tools no factory produced — `McpManager` registers discovered MCP
tools straight into it — and rebuilding would silently drop every one. It also
does not remove a tool whose config gate has since closed; this runs at startup
before any turn, where the only difference between the two walks is the
factories that were not registered yet. Reacting to config changes stays
`reload()`'s job.

No behaviour change for any current install: no shipped plugin registers a tool
from the runtime pass today. The path had never had a user, which is why the
gap survived — it was found writing the first one (#616).
