---
"@tailored-ai/core": minor
---

Stop privileging built-in task backends in config (matches the `repo`
backend treatment). `tasks.backend` is now an open `string` resolved
through the task-backend registry instead of the closed union
`"native" | "github" | "beans" | "beads"`, and backend-specific settings
move to a generic, opaque `tasks.options` bag the selected backend reads
itself — the same path a third-party backend uses. Core carries no
per-backend schema, and `validateConfig` no longer hard-codes a list of
valid backend names or github-specific checks (an unknown backend throws a
dynamic `Known: …` error at construction; a github backend missing
`options.repo`/`options.token` throws with a clear message).

Backward compatible: the legacy `tasks.github` / `tasks.beans` /
`tasks.beads` blocks are folded into `tasks.options` at load (and on
project overlays) with a deprecation warning, mirroring the existing
`providers.ollama` migration.
