---
"@tailored-ai/core": patch
---

Built-in workflow step executors now construct through StepExecutorRegistry factories (#62).

`createWorkflowEngine` no longer maintains a hardcoded executor array; instead it
calls `StepExecutorRegistry.buildAll(ctx)` on the runtime's registry. Built-ins
register factories via `populateBuiltinExecutors` (a side-effect called inside
`createWorkflowEngine`). Plugins register custom step types through
`ctx.stepExecutors.register(type, factory)` in their plugin function — factories
run in the same pass as built-ins, giving plugins first-class parity. Existing
workflow YAML and step-type strings are unchanged.
