---
"@tailored-ai/core": patch
---

Let an agent narrow which global context files it receives

Global context is injected into every turn and is never truncated, so it comes
out of the history budget. `skipGlobalContext` was the only control and it is
all-or-nothing, which does not fit the usual case: one directory holds both
deployment-wide plumbing every agent needs and material only one role does.

Agents now take `globalContext: { include, exclude }`, shell-style globs matched
against the file name. `include` is a whitelist applied first; `exclude` then
removes from what survived. An agent's own context directory is never filtered —
it is already scoped to that agent.
