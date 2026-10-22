---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Plugins can bring kinds of watcher: cheap checks, with no model call, that
something changed.

A watcher asks one narrow question on an interval (is there anything new on
this page, has this price moved, has mail from this sender arrived), compares
the answer with last time, and reports one line when something changed. A
plugin registers a kind through `ctx.watcherKinds.register(kind)`, with a
one-line description, a config schema, a default and a shortest interval, and
a `check` that returns a small JSON snapshot (4 KB at most), an optional
reading, and a `change` line only when something changed. The first check of a
watch sets a baseline and reports nothing.

Core ships no kinds and runs no watches, so nothing changes for a deployment
until it loads a plugin that runs them. A runner plugin finds kinds with
`ctx.watcherKinds.get` and `list`, and uses `validate` to check a watch's
config against its kind, `interval` to apply the kind's interval floor, and
`result` to make a check's result safe to keep. All of it is on the context,
so a runner installed with `tai plugin` needs nothing from its own copy of
core at run time. A kind comes out when its plugin is unloaded: a `builtin:*`
plugin's kinds are replaced on every reload, while a plugin loaded before the
runtime (google-tools, or one installed with `tai plugin`) keeps its kinds
until a restart. See `docs/watchers.md`.

`tai edit` no longer drops a plugin's providers from the provider picker when
the plugin also registers world-state types, interface components, media
stores, time providers, slash commands or watcher kinds. The editor probes
plugins against a stand-in context that lacked those views, so the plugin
failed partway through, out of sight, before reaching its providers.
