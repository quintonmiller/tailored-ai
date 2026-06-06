---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Add a typed runtime event bus — Slice 1 of the platform vision
(`docs/platform-vision.md`). The bus is the seam the rest of the
plugin model gets to use: task lifecycle, runtime reloads, and the
default behaviors that will move out of the core in later slices all
flow through one shared pub/sub surface.

- New `TypedEventBus` (`packages/core/src/events.ts`) with a strongly
  typed `RuntimeEventMap`. Subscribing returns a disposer; emit is
  fire-and-forget from the emitter's point of view, sync throws and
  async rejections in handlers are logged and isolated so one bad
  subscriber can't break the rest.
- `AgentRuntime` owns a single bus instance (`runtime.events`) and
  emits `runtime.reloaded` at the end of `reload()` before clearing
  the bus for the next generation.
- `PluginContext.events` exposes the same bus to plugins so
  `ctx.events.on(...)` lands on the runtime's wiring.
- The CLI pre-constructs the bus before `loadPlugins` and hands the
  same instance to both `createPluginContext` and the runtime.

No emissions are wired beyond `runtime.reloaded` yet — Slice 2 lands
the task lifecycle events (`task.created`, `task.updated`,
`task.transitioned`, `task.commented`), and later slices migrate the
in-core watchers + default behaviors onto the bus.

17 unit tests cover delivery, dispose semantics, error isolation,
iteration safety during dispatch, listener counts, and clear().
