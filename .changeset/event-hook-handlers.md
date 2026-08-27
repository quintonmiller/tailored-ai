---
"@tailored-ai/core": patch
---

What runs a hook is a registry.

`hooks.on` could do one thing: invoke a registered tool. That is the right
default and the wrong ceiling — a hook that calls an HTTP endpoint, runs a
program, or speaks somebody's wire protocol had nowhere to live except a fork of
the runner.

`registerEventHookHandler(kind, handler)` opens it. A hook's `type` selects the
handler and `options` carries whatever that handler needs, opaque to core — the
same open-selector-plus-options-bag shape `tasks.backend` and `sandbox.backend`
use, so no built-in is privileged over a plugin. Core registers `tool` through
the same call rather than special-casing it, so the built-in cannot quietly
depend on being first.

A handler returns `output` for `denyIf` to match against, or `deny` directly
when its dialect has its own refusal vocabulary — an exit code, a decision
field — rather than encoding a refusal back into text for a regex to find.

**A handler that spawns a process is deliberately not here.** It hands config
the ability to run arbitrary code with the agent's privileges, and that is a
decision someone should make by installing a plugin, not one inherited from the
module every deployment loads. This is the seam that makes such a plugin
possible without core knowing it exists.

Also sharpens a distinction the runner was making implicitly. A target that is
*absent* — an unregistered tool, a `type` nobody claimed — is logged and skipped,
because a disabled plugin should not take an unrelated operation down. A hook
that *ran and threw* still refuses on a refusable event: a check with an unknown
verdict has not passed. A hook that was never wired never had a verdict to lose.

Existing `hooks.on` entries are unchanged: no `type` means `tool`, which is what
they already did.
