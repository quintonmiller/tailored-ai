---
"@tailored-ai/core": patch
---

Say so when a workflow trigger kind has no runner.

A plugin can register a trigger kind, and until now every signal said that
worked. `TriggerKindRegistry` accepted it, `setExtraTriggerKinds` fed it to the
workflow loader, so the workflow file validated and the UI picker listed it.
Then `WorkflowTriggerCoordinator.reconcile` filtered it out against a hardcoded
set of the nine built-in pollers and moved on — no warning, no error, no run.
The only symptom was that the workflow never fired.

That is the same shape as #561, where `tool_called` was a declared kind nothing
dispatched, and it is the failure this codebase keeps rediscovering: something
that validates cleanly and silently does nothing.

The coordinator now reports it. A trigger kind that is neither dispatched here
nor run elsewhere (`cron`, `manual`, `webhook`, `tool_called`, `document_event`,
`config_event` each have their own subsystem) warns once, naming the workflow,
the kind, and the issue tracking the fix. Once per workflow per change, not once
per reconcile — this runs on every registry change, and a per-tick warning is
noise people learn to scroll past, which is the same outcome as silence.

**This does not make plugin triggers work.** Nothing dispatches one until #61
lands the executable trigger factory contract. What changes is that the gap is
audible instead of costing an afternoon to find. A workflow's runnable triggers
still register normally alongside an unrunnable one.

`docs/modularity-plan.md` scored triggers fully pluggable on all three columns
throughout. That row is corrected, with the reason: a registry consulted only by
the validator will score green while nothing runs. The general rule is now in
`docs/defensive-patterns.md`, next to its sibling "config that parses but is
never read".
