---
"@tailored-ai/core": patch
---

permissions: rules can reach an absent argument, and headless approval says so (#7, #8)

Two gaps that made the permission system quieter than it looked.

- **`matchesRule` returned false for any missing argument**, so a rule could only
  describe what the model *did* pass. The dangerous call is often the one that
  passes nothing and takes a default — an unscoped write, an unfiltered query —
  and no rule could reach it. A `null` pattern now means "this argument must be
  absent". An empty string counts as absent, because models emit `scope: ""` for
  "unset" and the tools here already read it that way; a rule that disagreed with
  the tool it governs would be worse than no rule.

- **A call needing approval with no approval handler ran anyway, silently.**
  Cron, rooms, the task watcher and webhooks all take that branch, which was an
  empty block with a comment — so `approve` became `auto` exactly where nobody
  was watching. `permissions.noHandlerAction` now selects `auto` (default,
  unchanged) or `reject`. The default stays permissive deliberately: flipping it
  would stop autonomous runs that have worked for months. What changed is that
  the permissive branch logs once per tool per process rather than passing in
  silence, and a deployment that wants its `approve` rules to mean something on
  headless paths can now say so.

Together these are the generic seam that per-tool policy knobs were standing in
for — every tool gets it, including plugin-authored ones.
