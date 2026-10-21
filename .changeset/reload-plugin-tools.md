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
- A request to a plugin route that is gone, or to any `/api/` path nothing
  serves, is answered `404 {"error":"not_found"}`. Before, a GET got the web
  UI's page with a 200, so a caller expecting JSON failed to parse it.
- A plugin turned off by reload takes its world-state types, the registration
  of any world-state provider it adds, and its interface component kinds with
  it. These were the registrations a plugin's teardown missed, so they stayed
  until a restart. A world-state provider already built keeps serving until a
  restart; no runtime plugin registers one today.
- A built-in tool that depends on what plugins registered follows them too:
  `state`, which is offered once any world-state type exists, appears and goes
  with the types.
- A plugin that throws partway through loading no longer leaves behind what it
  registered before the throw. Before, its tools and routes stayed, and if it
  had registered a route, every later reload failed to load it again (the
  route was already registered), even once its config was fixed.

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
- `loadPlugins` undoes a plugin's registrations when its `register(ctx)`
  throws, before recording the failure.
- `HttpRouteRegistry` has a `version` that changes with the route set, and the
  server's `mountPluginHttpRoutes` serves the registry as it is at each
  request. `ToolRegistry` gains `remove(tool)`.
