---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

A config reload now replaces what runtime plugins registered, instead of
adding to it. Runtime plugins are the ones loaded with `ctx.runtime`: the
`builtin:*` set (places among them) and trusted-actions.

What changes for a deployment:

- A plugin turned off by reload loses its tools straight away. Before, agents
  kept them until a restart, and calling one reached a plugin that had been
  torn down.
- A plugin's config change reaches its tools on the first reload. Before, it
  took two: the first rebuilt the tools from the old config. Turning on places'
  `build: true` while TAI runs is one example.
- A plugin turned on by reload serves its HTTP routes from that reload on, one
  turned off stops serving them, and a changed handler is served at once.
  Before, routes were fixed when TAI started. Paths stay under
  `/api/ext/<plugin>/` and auth works as before, including `auth: "none"`
  routes, which are exempt (or not) from the reload that adds (or removes)
  them.
- A plugin turned off by reload takes its world-state types and providers and
  its interface component kinds with it. These were the registrations a
  plugin's teardown missed, so they stayed until a restart.
- A built-in tool that depends on what plugins registered follows them too:
  `state`, which is offered once any world-state type exists, appears and goes
  with the types.

For code that embeds core:

- New `AgentRuntime.syncToolFactories()`: runs every tool factory and puts what
  they build now in place of what the last walk built, leaving tools
  registered straight into the registry (MCP tools) alone, and destroying the
  ones it replaces or removes. It returns `{ added, removed }`. Call it after
  loading runtime plugins, at startup and after each reload.
  `applyPendingToolFactories()` now calls it and returns the added names, so
  it also rebuilds and removes rather than only adding.
- `reload()` no longer destroys a tool instance its factory handed back again,
  which stayed in use.
- `HttpRouteRegistry` has a `version` that changes with the route set, and the
  server's `mountPluginHttpRoutes` serves the registry as it is at each
  request. `ToolRegistry` gains `remove(tool)`.
