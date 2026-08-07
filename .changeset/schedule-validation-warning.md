---
"@tailored-ai/core": patch
---

Stop warning that the `schedule` tool is not enabled when it is.

`validateConfig` builds its set of enabled tools from `config.tools` alone.
`schedule` is gated by its own top-level `schedules:` block, because the tool is
one surface on a subsystem that also runs a poll tick — so it never appeared in
that set, and every agent listing it drew

    Agent "X" references tool "schedule" which is not enabled

on every startup and every config write, while the tool was registered,
resolvable, and being called successfully.

A false warning is worse than none. It sits in the same list as the true ones —
in the deployment where this surfaced, beside eleven real "room is not declared"
warnings — and teaches an operator to skim the list rather than read it.

Same shape as the `tasks`/`task_query` coupling handled directly above it, and
fixed the same way.
