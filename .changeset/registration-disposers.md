---
"@tailored-ai/core": patch
---

Every registration hands back its inverse, and the plugin loader keeps it.

Plugin teardown was one sledgehammer: `reload()` calls `events.clear()` and
re-runs every plugin. That is complete for bus subscriptions and nothing at all
for the rest of what a plugin owns, because nothing tracked it. The same defect
shipped as #58 (duplicate channel listeners after a config reload) and #65
(trigger pollers that hot reload never reconciled), and `HttpRouteRegistry`
still documents it in its own comment: the registry "survives `reload()` because
Hono can't unmount routes once added."

`Registry<T>.register()` now returns a `Disposer`, and so do all ten
`register*Factory` functions, `StepExecutorRegistry.registerFactory`, and every
`PluginContext` registry view. The disposer removes **only the entry that call
made**: if something re-registered the same id afterwards, that entry belongs to
whoever registered it, and disposing an older one must not silently delete it.
Calling a disposer twice is a no-op.

`loadPlugins` collects the disposers per entry and composes them onto
`LoadedPlugin.stop`, so unloading a plugin is the inverse of loading it. The
plugin's own returned disposer runs first — it may still need what it registered
while shutting down — and the registrations then come out last-in-first-out. A
throwing disposer is logged and the rest still run, because teardown that gives
up halfway leaves a half-removed plugin nothing will retry.

Source-compatible: a caller that ignores the return value behaves exactly as
before. Side-effect plugins are unchanged — they register at module scope with
no context, so nothing observes what they added and there is nothing to hand
back.
