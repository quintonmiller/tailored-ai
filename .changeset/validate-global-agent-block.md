---
"@tailored-ai/core": patch
---

Type-check the global `agent:` block, which the shape walk skipped.

`findShapeIssues` covered `agents.<name>.*`, `cron.jobs[]`, `tools.exec`
and the `enabled` flag across the open bags. It never walked the global
`agent:` block — where the deployment-wide defaults live. Reproduced
against a live config: a bad `temperature` on a named agent was flagged,
the identical mistake on `agent.temperature` was not.

The case that bites is `agent.maxTokens: "8192"`, quoted the way YAML
users write things. It reaches `if (params.maxTokens)`, and a non-empty
string is truthy, so the guard does not catch it and the quoted value
goes out on the wire. That is exactly what `quotingHint()` was written
for; it just never got a chance to fire.

Checked `.partial()`: this is a type checker, not a required-fields
checker, and `DEFAULT_CONFIG` supplies anything the file omits.

`tasks`, `memory.embeddings` and `memory.chunks` are now walked too —
closed, all-scalar blocks where a quoted number hides best.
`tasks.options` is deliberately left alone: it is the selected backend's
own bag, and core does not know its shape. `rooms` remains unchecked; it
is nested enough to want its own pass.

Each schema carries the same `Identical<>` drift assertion the agent
schema has, so a field added to one side and not the other is a compile
error rather than a silent hole.
