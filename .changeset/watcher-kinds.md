---
"@tailored-ai/core": patch
---

Plugins can bring kinds of watcher: cheap checks, with no model call, that
something changed.

A watcher asks one narrow question on an interval (is there anything new on
this page, has this price moved, has mail from this sender arrived), compares
the answer with last time, and reports one line when something changed. A
plugin registers a kind through `ctx.watcherKinds.register(kind)`, with a
config schema, a default and a shortest interval, and a `check` that returns a
small JSON snapshot (4 KB at most), an optional reading, and a `change` line
only when something changed. The first check of a watch sets a baseline and
reports nothing.

Core ships no kinds and runs no watches, so nothing changes for a deployment
until it loads a plugin that runs them. A runner plugin finds kinds with
`ctx.watcherKinds.get` and `list` and uses the new helpers to check a watch's
config against its kind (`validateWatchConfig`), apply the kind's interval
floor (`watchInterval`), and make a result safe to keep (`watcherResult`).
Like every other registration through `ctx`, a plugin's kinds are taken back
when it is unloaded and replaced on reload. See `docs/watchers.md`.
